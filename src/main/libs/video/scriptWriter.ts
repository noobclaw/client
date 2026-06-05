/**
 * scriptWriter — 用 DeepSeek 写视频旁白脚本 + 为每个分镜生成素材搜索词。
 *
 * 抄 MoneyPrinterTurbo 的两步 LLM 套路:
 *   1. generateScript(): 没给文案时,按【主题 + 人设 + 赛道 + 目标时长】生成一段
 *      连贯的中文口播旁白。时长靠字数控制(中文约 4.5 字/秒)。
 *   2. generateSearchTerms(): 把已拆好的逐句分镜,各自映射成 1-3 个英文搜索词
 *      (Pexels/Pixabay 是英文库),让画面跟着内容走,而不是所有镜头复用同一张图。
 *      映射时会把整条视频的【主题/赛道/人设/关键词】当语境一并喂进去(见 ctx 参数),
 *      避免模型孤立看单句憋出跑题泛词。
 *
 * 两步都走 NoobClaw 服务端的 DeepSeek 代理(/api/ai/chat/completions)。
 * 两步都用 noobclawai-reasoner(=deepseek-v4-pro,质量更好,服务端按 ~3x credits 计费):
 *   - generateScript() 写旁白是创作活,理所当然走 Pro。
 *   - generateSearchTerms() 映射也升 Pro —— 实测语义更准、词更贴内容;reasoner 不支持
 *     response_format=json_object,故 JSON 契约改靠 prompt 强约束 + extractJsonObject 兜底。
 * 鉴权用 NoobClaw JWT。
 *
 * 任何环节失败都【不抛】(脚本生成除外):搜索词失败 → 退回用全局 keywords,
 * 上层照常出片。脚本生成失败才抛,因为没文案没法继续。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import { DEFAULT_VIDEO_CONFIG, interpolate } from './videoConfig';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

interface ChatResult {
  content: string;
  /** 本次调用消耗的 token 总数(prompt + completion)。服务端按此计费。 */
  tokens: number;
  /** 服务端权威 USD 成本(_noobclaw.costUsd = billable_tokens × token_price_per_million,
   *  含 cache-hit 折扣)。老后端不回该字段时为 0。 */
  costUsd: number;
}

/**
 * 调 DeepSeek 代理。jsonMode=true 时传 response_format=json_object —— prompt
 * 必须含 "json" 字眼(DeepSeek 文档硬要求,否则会无限输出空白卡死)。
 */
async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  jsonMode: boolean,
  timeoutMs = 60_000,
  model: 'noobclawai-chat' | 'noobclawai-reasoner' = 'noobclawai-chat',
): Promise<ChatResult> {
  const token = getNoobClawAuthToken();
  if (!token) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    max_tokens: 4000,
  };
  // response_format=json_object 这道「强制只能输出合法 JSON」的开关仅 chat(flash)支持;
  // reasoner(Pro 思考模型)不支持该开关(DeepSeek 官方限制),强行带上会被拒/失效。
  // 故 reasoner 不发此字段,改靠 prompt 约束 + 下游 extractJsonObject 宽松解析兜底。
  if (jsonMode && model === 'noobclawai-chat' && /json/i.test(systemPrompt + userMessage)) {
    body.response_format = { type: 'json_object' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效，请重新登录');
      if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足，请前往钱包充值');
      const errText = await resp.text().catch(() => '');
      throw new Error(`AI API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('AI_EMPTY_RESPONSE — AI 返回空内容');
    // usage.total_tokens 是服务端计费口径;没回 usage 时退化为 0(不影响出片)。
    const tokens = Number(json?.usage?.total_tokens) || 0;
    // _noobclaw.costUsd 是服务端按 token_price_per_million 算好的权威美元成本
    // (跟 scenario phaseRunner aiCall 同源)。老后端不回该扩展时退化为 0。
    const costUsd = Number(json?._noobclaw?.costUsd) || 0;
    return { content, tokens, costUsd };
  } finally {
    clearTimeout(timer);
  }
}

/** 中文约 4.5 字/秒;由目标秒数反推目标字数。 */
function targetCharCount(seconds: number): number {
  return Math.round(Math.max(10, seconds) * 4.5);
}

/** 内容语言:决定口播稿 + 素材搜索词用哪种语言。 */
export type ContentLang = 'zh' | 'ja' | 'ko' | 'en';

/**
 * 轻量语言探测:按字符脚本判别。日文同时含汉字,故先查假名;韩文查谚文;
 * 再查汉字判中文;都没有 → 当英文/拉丁。够覆盖中/日/韩/英四种主用语言。
 */
export function detectLang(text: string): ContentLang {
  const t = text || '';
  if (/[぀-ゟ゠-ヿ]/.test(t)) return 'ja'; // 平假名/片假名
  if (/[가-힯]/.test(t)) return 'ko'; // 谚文
  if (/[㐀-鿿豈-﫿]/.test(t)) return 'zh'; // 汉字
  return 'en';
}

/** 语言代码 → 给 LLM 用的英文语言名。 */
function langName(l: ContentLang): string {
  return l === 'zh' ? 'Chinese (Simplified)'
    : l === 'ja' ? 'Japanese'
    : l === 'ko' ? 'Korean'
    : 'English';
}

export interface GenerateScriptInput {
  /** 视频主题 / 选题(用户输入的关键词拼出来的也行)。 */
  topic: string;
  /** 账号人设(TRACK_PRESETS 里的 persona)。 */
  persona?: string;
  /** 赛道名。 */
  track?: string;
  /** 关键词(辅助 LLM 锁定方向)。 */
  keywords?: string[];
  /** 目标时长(秒)。默认 45s。 */
  targetSeconds?: number;
  /** 用户提供的参考文案(scriptMode='ai' 时):作为方向/素材参考,AI 据此再创作,
   *  不逐字照搬。空 / undefined 时按主题从零写。 */
  referenceScript?: string;
  /** 口播稿语言。缺省 'zh'。由上层按【视频文案语言(有则优先)/ 关键词语言】探测后传入。 */
  lang?: ContentLang;
}

export interface GenerateScriptResult {
  /** 生成的口播旁白正文。 */
  script: string;
  /** 本步消耗 token(reasoner 档,服务端按 ~3x 计费)。 */
  tokens: number;
  /** 本步服务端权威 USD 成本(老后端不回时为 0)。 */
  costUsd: number;
}

/**
 * 生成一段口播旁白(纯文本,不带分镜标记/序号)。供 splitScript 再拆分镜。
 * 失败抛错(上层提示用户手填文案)。返回正文 + 本步 token 消耗。
 */
export async function generateScript(
  input: GenerateScriptInput,
  scriptSystemTemplate?: string,
): Promise<GenerateScriptResult> {
  const targetSec = input.targetSeconds ?? 45;
  const targetChars = targetCharCount(targetSec);
  const kw = (input.keywords || []).filter(Boolean).join('、');
  const lang = input.lang || 'zh';
  const ln = langName(lang);

  // 长度提示:中文按「字符数」最直观;其它语言用「朗读秒数」更准(字符≠时长)。
  const lengthLine = lang === 'zh'
    ? `1. 围绕主题写一段【连贯的口播旁白】,目标约 ${targetChars} 个中文字符(对应约 ${targetSec} 秒)。`
    : `1. Write one coherent voice-over narration of about ${targetSec} seconds when read aloud.`;

  // system prompt 走模板(服务端可调措辞),只认 4 个占位符;空的人设/赛道行替换后被 filter 掉。
  const tpl = scriptSystemTemplate || DEFAULT_VIDEO_CONFIG.scriptSystemTemplate;
  const system = interpolate(tpl, {
    LANG_NAME: ln,
    PERSONA_LINE: input.persona ? `账号人设:${input.persona}。` : '',
    TRACK_LINE: input.track ? `内容赛道:${input.track}。` : '',
    LENGTH_LINE: lengthLine,
  }).split('\n').map((s) => s.trim()).filter(Boolean).join('\n');

  // 参考文案:作为方向/素材给 AI 参考,明确告知"可借鉴但不要逐字照搬",
  // 让 AI 重新组织成更适合口播的版本。
  const ref = (input.referenceScript || '').trim();
  const user = [
    `主题:${input.topic}`,
    kw ? `关键词:${kw}` : '',
    ref ? `【用户参考文案,仅供参考方向,请重新创作、不要逐字照搬】:\n${ref.slice(0, 1500)}` : '',
    lang === 'zh'
      ? `请直接输出约 ${targetChars} 字的口播旁白正文。`
      : `Now output ONLY the ${ln} narration body (about ${targetSec}s when read aloud).`,
  ].filter(Boolean).join('\n');

  // 旁白创作走 Pro(reasoner),质量明显优于 flash;服务端按 ~3x 计费,故仅此一处用。
  const { content, tokens, costUsd } = await callDeepSeek(system, user, false, 90_000, 'noobclawai-reasoner');
  // 去掉可能的包裹引号 / 多余空行
  const script = content.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
  return { script, tokens, costUsd };
}

export interface GenerateSearchTermsResult {
  /** 与 scenes 等长的逐镜搜索词数组。 */
  terms: string[][];
  /** 本步消耗 token(reasoner 档,~3x);兜底时为 0。 */
  tokens: number;
  /** 本步服务端权威 USD 成本(兜底 / 老后端时为 0)。 */
  costUsd: number;
}

/** 搜索词映射的整体语境:让模型按【这条视频在讲什么】给每镜配词,而不是孤立看单句。 */
export interface SearchTermsContext {
  /** 视频主题/选题(关键词拼出来的也行)。 */
  topic?: string;
  /** 账号人设。 */
  persona?: string;
  /** 内容赛道。 */
  track?: string;
  /** 关键词。 */
  keywords?: string[];
}

/**
 * 从可能夹带思考文字 / markdown 围栏的模型输出里,抠出第一个 JSON 对象再交给 JSON.parse。
 * reasoner 不支持 response_format=json_object,可能把 JSON 包在 ```json``` 或推理段落里,
 * 这里先剥围栏、再截取首个 {...} 平衡块,保证 chat(本就纯 JSON)与 reasoner 都能解析。
 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  // 剥 ```json ... ``` / ``` ... ``` 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  // 截取第一个完整的 {...}(按花括号配平,容忍前后多余文字)
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}') {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
  }
  return t;
}

/**
 * 为每个分镜生成 1-3 个英文素材搜索词。返回与 scenes 等长的数组;某项失败用
 * 全局 keywords 兜底。绝不抛错。同时返回本步 token 消耗(兜底时为 0)。
 *
 * ctx:整条视频的主题/赛道/人设/关键词语境。映射时把它当上下文喂给模型,
 * 让每镜的词锁定到该选题(否则模型孤立看单句,常憋出跑题的泛词)。
 */
export async function generateSearchTerms(
  scenes: string[],
  fallbackKeywords: string[],
  termsSystemPrompt?: string,
  ctx?: SearchTermsContext,
): Promise<GenerateSearchTermsResult> {
  const fallback = (fallbackKeywords || []).filter(Boolean);
  const fallbackEach = scenes.map(() => fallback.slice(0, 3));
  if (scenes.length === 0) return { terms: [], tokens: 0, costUsd: 0 };

  // 搜索词统一用英文:Pexels/Pixabay 库标注以英文为主,英文词召回最全最稳;
  // 区域语境靠 locale 参数兜底(由调用方按内容语言传)。
  // prompt 走服务端可调(默认见 videoConfig);务必保持 {"terms":[[...]]} 输出契约。
  const system = termsSystemPrompt || DEFAULT_VIDEO_CONFIG.termsSystemPrompt;

  // A:整体语境前置 —— 让模型据此消歧、把每镜的词钉在选题上(不再孤立看单句)。
  const ctxLines: string[] = [];
  if (ctx?.topic) ctxLines.push(`Overall video topic: ${ctx.topic}`);
  if (ctx?.track) ctxLines.push(`Content niche: ${ctx.track}`);
  if (ctx?.persona) ctxLines.push(`Creator persona: ${ctx.persona}`);
  const ctxKw = (ctx?.keywords || []).filter(Boolean);
  if (ctxKw.length) ctxLines.push(`Keywords: ${ctxKw.join(', ')}`);
  const ctxBlock = ctxLines.length
    ? `Context for the WHOLE video (use it to disambiguate each line and keep every term on-topic):\n${ctxLines.join('\n')}\n\n`
    : '';

  const numbered = scenes.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `${ctxBlock}Input lines (${scenes.length}):\n${numbered}\n\n`
    + 'Return ONLY the raw JSON object now (no markdown fences, no explanation, no reasoning).';

  try {
    // B:映射走 reasoner(Pro),语义更准 → 词更贴内容;服务端按 ~3x 计费。
    // reasoner 不吃 json_object 开关,故靠 prompt + extractJsonObject 兜住 JSON 契约。
    const { content, tokens, costUsd } = await callDeepSeek(system, user, true, 90_000, 'noobclawai-reasoner');
    const parsed = JSON.parse(extractJsonObject(content));
    const terms = parsed?.terms;
    if (!Array.isArray(terms)) return { terms: fallbackEach, tokens, costUsd };
    const mapped = scenes.map((_, i) => {
      const t = terms[i];
      if (Array.isArray(t)) {
        const cleaned = t
          .filter((x: any) => typeof x === 'string' && x.trim())
          .map((x: string) => x.trim())
          .slice(0, 3);
        if (cleaned.length > 0) return cleaned;
      }
      return fallbackEach[i];
    });
    return { terms: mapped, tokens, costUsd };
  } catch {
    return { terms: fallbackEach, tokens: 0, costUsd: 0 };
  }
}
