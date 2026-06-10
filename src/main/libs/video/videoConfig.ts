/**
 * videoConfig — 视频流水线的【服务端可调配置】。
 *
 * 目标:prompt 文案 + 各种参数阈值放服务端(system_config / admin 后台),
 * 调整这些不用再改客户端、不用重新打包。客户端每次出片前拉一次
 * GET /api/video/config:
 *   · 拉到 → 用服务端的值覆盖默认;
 *   · 没登录 / 没网 / 服务端没配 → 用下面这份内置默认(= 历史硬编码行为)。
 *
 * ⚠️ 契约:prompt 的【措辞】服务端可随便调,但【输出结构】不能动——
 *   · termsSystemPrompt 必须让模型返回 {"terms": [[...]]} 这个 JSON 形状,
 *     否则客户端 JSON.parse 后取不到 terms,搜索词会整步退回兜底。
 *   · scriptSystemTemplate 只认这几个占位符:{{LANG_NAME}} {{PERSONA_LINE}}
 *     {{TRACK_LINE}} {{LENGTH_LINE}};多写的占位符不会被替换、原样留在 prompt 里。
 */

const REQ_TIMEOUT_MS = 8_000;
/** 配置缓存时长:一次出片内只拉一次,避免脚本/搜索词两步各拉一遍。 */
const CACHE_TTL_MS = 60_000;

export interface VideoPipelineConfig {
  /** 口播稿 system 模板(含占位符,见文件头契约)。 */
  scriptSystemTemplate: string;
  /** 搜索词 system prompt(纯静态,必须保持 {"terms":[[...]]} 输出契约)。 */
  termsSystemPrompt: string;
  /** 模板速生「数据解析」system prompt(必须保持 {title,subtitle,items:[{rank,name,value,sub}]}
   *  这个 JSON 输出契约,否则客户端解析不到 items → 退回纯代码兜底)。服务端可调措辞,不可改结构。 */
  templateDataSystemPrompt: string;
  /** 内容语言 → 素材库 locale。 */
  localeMap: Record<string, string>;
  /** Pexels 视频最低分辨率档:small=HD / medium=Full HD / large=4K。 */
  stockVideoSize: string;
  /** 在线视频素材最低短边(像素),下载后真实 probe 卡这个。 */
  minVideoEdge: number;
  /** 太短的素材视频(秒)拒收。 */
  minVideoSec: number;
  /** 素材图最低边长(像素),低于则拉伸发糊,拒收。 */
  minImageEdge: number;
  /** 每个搜索词下载几段视频。 */
  perTermCount: number;
  /** 整体去搜的搜索词上限,避免逐词搜请求过多。 */
  maxSearchTerms: number;
}

/** 内置默认 = 历史硬编码行为。服务端拉不到时全靠这份兜底,保证离线也能跑。 */
export const DEFAULT_VIDEO_CONFIG: VideoPipelineConfig = {
  scriptSystemTemplate: [
    '你是一名专业的短视频口播脚本撰稿人,擅长写竖屏短视频(抖音/小红书风格)的旁白。',
    '【语言】全程只用 {{LANG_NAME}} 撰写口播正文,不要混入其它语言。',
    '{{PERSONA_LINE}}',
    '{{TRACK_LINE}}',
    '要求:',
    '{{LENGTH_LINE}}',
    '2. 开头一句要有钩子,中间分点讲清楚,结尾有行动号召或金句收尾。',
    '3. 口语化、节奏紧凑,适合配音朗读;不要出现套话开场。',
    '4. 只输出 {{LANG_NAME}} 旁白正文本身,不要加任何标题、序号、分镜标记、emoji、引号包裹。',
  ].join('\n'),
  termsSystemPrompt: [
    'You map short-video narration lines to stock-footage search terms.',
    'For EACH input line, output 1-3 English search terms (each 1-3 words) that',
    'best describe concrete, filmable VISUALS for that line (places, objects,',
    'actions, scenery) — NOT abstract concepts. Prefer terms that exist in stock',
    'video libraries (Pexels/Pixabay).',
    'Return ONLY a JSON object of this exact shape:',
    '{"terms": [["term a","term b"], ["term c"], ...]}',
    'The "terms" array length MUST equal the number of input lines, in order.',
  ].join('\n'),
  templateDataSystemPrompt: [
    '你把用户提供的内容整理成【结构化榜单/要点数据】,用于生成动效短视频。只输出严格 JSON(json),不要任何解释。',
    '输出结构:{"title":"大标题","subtitle":"副标题(可选)","items":[{"rank":1,"name":"主名称","value":"数值","sub":"副说明(可选)"}]}',
    '规则:',
    '1. title 简短有力(≤14 字);subtitle 可选(如 "BINANCE · 24H" / 日期 / 来源)。',
    '2. items 最多 8 条,从用户内容里提取;有数值(涨跌幅/数量/价格)就放 value(保留正负号、百分号、单位),没有就省略 value。',
    '3. 排行榜/盘点:按用户给的顺序或数值大小排序,逐条填 rank(1,2,3…)。',
    '4. 金句/语录:items 放一条 {"name":"金句正文","sub":"作者(可选)"}。',
    '5. 保持用户内容的语言;不要编造用户没给的数据。',
  ].join('\n'),
  localeMap: { zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', en: 'en-US' },
  stockVideoSize: 'small',
  minVideoEdge: 720,
  minVideoSec: 2,
  minImageEdge: 480,
  perTermCount: 6,
  maxSearchTerms: 12,
};

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* 取不到 token 就裸调,服务端 401 → 这里 catch → 用默认 */ }
  return headers;
}

let cache: { at: number; cfg: VideoPipelineConfig } | null = null;

/** 服务端返回的某个字段无效时回落到默认值的小工具。 */
function num(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function str(v: any, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/**
 * 拉服务端视频配置(带 60s 缓存)。任何异常 / 缺字段都按默认兜底,绝不抛错。
 * 出片主流程开头调一次即可,后续 scriptWriter / stockProvider 复用同一份。
 */
export async function getVideoConfig(): Promise<VideoPipelineConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}/api/video/config`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`config ${res.status}`);
    const json: any = await res.json();
    const c = (json && typeof json === 'object' && json.config) ? json.config : json;
    const d = DEFAULT_VIDEO_CONFIG;
    const localeMap = (c && typeof c.localeMap === 'object' && c.localeMap) ? c.localeMap : d.localeMap;
    const cfg: VideoPipelineConfig = {
      scriptSystemTemplate: str(c?.scriptSystemTemplate, d.scriptSystemTemplate),
      termsSystemPrompt: str(c?.termsSystemPrompt, d.termsSystemPrompt),
      templateDataSystemPrompt: str(c?.templateDataSystemPrompt, d.templateDataSystemPrompt),
      localeMap: { ...d.localeMap, ...localeMap },
      stockVideoSize: str(c?.stockVideoSize, d.stockVideoSize),
      minVideoEdge: num(c?.minVideoEdge, d.minVideoEdge),
      minVideoSec: num(c?.minVideoSec, d.minVideoSec),
      minImageEdge: num(c?.minImageEdge, d.minImageEdge),
      perTermCount: num(c?.perTermCount, d.perTermCount),
      maxSearchTerms: num(c?.maxSearchTerms, d.maxSearchTerms),
    };
    cache = { at: Date.now(), cfg };
    return cfg;
  } catch {
    // 拉不到就用默认(并短缓存,避免每步重试拖慢)。
    cache = { at: Date.now(), cfg: DEFAULT_VIDEO_CONFIG };
    return DEFAULT_VIDEO_CONFIG;
  } finally {
    clearTimeout(timer);
  }
}

/** 内容语言 → locale,走配置里的映射,缺则回落 en-US。 */
export function localeFor(cfg: VideoPipelineConfig, lang: string): string {
  return cfg.localeMap[lang] || cfg.localeMap.en || 'en-US';
}

/** 安全占位符替换:只替换已知 key,未知占位符原样保留。 */
export function interpolate(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}
