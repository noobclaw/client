/**
 * templateHtmlWriter — 「模板速生」HF 派的数据 + 口播稿层。
 *
 * v3 改动:在原有「AI 抽 dataText → {title,subtitle,items}」基础上,加一份「按 dataText
 * 写一段 ~6-12s 中文口播稿」的产物 —— 当用户在向导里开了「配音」时,pipeline 把口播稿
 * 喂 edge-tts 出 wav,拿到【真实音频时长 + 词级时间戳】,再用这个真实时长去渲染 HTML。
 * 这是抄 HF 的「TTS 先出,HTML 时长跟着音频走」核心 insight。
 *
 * 同时收紧 SYSTEM_PROMPT 加 HF SKILL.md 风格的硬规则(不让 AI 编数据、不让 voiceScript
 * 跨内容造谣)。
 *
 * 计费:走 NoobClaw 服务端 DeepSeek 代理(/api/ai/chat/completions),口径同 scriptWriter。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import { detectLang, type ContentLang } from './scriptWriter';
import type { TemplateItem } from './templateLibrary';

export type { ContentLang };

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

/** 模板版式枚举(card 向导让用户选)。 */
export type TemplateStyle = 'rank_list' | 'news_cards' | 'quote' | 'countdown' | 'stat_board';

/** 「模板速生」任务输入子对象。 */
export interface TemplateOptions {
  style: TemplateStyle;
  title?: string;
  dataText: string;          // 用户粘贴的榜单/要点/金句
  durationSec?: number;      // 目标时长(无配音时用;有配音时被真实音频时长覆盖)。clamp[3,20]
  fps?: number;              // 默认 30
  brandColor?: string;       // 主品牌色 #RRGGBB
  accentColor?: string;      // 强调色
  // ── HF 派新增 ──
  narration?: boolean;       // 是否生成 AI 口播 + 字幕(默认 false=纯画面)
  voice?: string;            // edge-tts 音色(如 zh-CN-XiaoxiaoNeural),空 = 用默认
  voiceRate?: number;        // 语速档(-50~+50,单位%),0/空 = 正常
  voiceScript?: string;      // 用户自定义口播稿;空 = AI 按 dataText 生成
  subtitleEnabled?: boolean; // 烧字幕开关(narration on 时才有意义)。默认 true
  watermark?: string;        // 右下角水印文案。空字符串 = 不显示
}

export interface TemplateData {
  title?: string;
  subtitle?: string;
  items: TemplateItem[];
  /** AI 顺手产的口播稿(中文短句,适合 TTS),narration 开启时用。 */
  voiceScript?: string;
}

export interface TemplateDataResult extends TemplateData {
  source: 'ai' | 'fallback';
  tokens: number;
  costUsd: number;
}

export interface TemplateDataInput {
  style: TemplateStyle;
  title?: string;
  dataText: string;
  track?: string;
  lang: ContentLang;
  /** 是否一并要求 AI 产口播稿(开了配音才要,省 token)。 */
  needVoiceScript?: boolean;
}

const SYSTEM_PROMPT_BASE = [
  '你把用户提供的内容整理成【结构化榜单/要点数据】,用于生成动效短视频。只输出严格 JSON(json),不要任何解释。',
  '输出结构:{"title":"大标题","subtitle":"副标题(可选)","items":[{"rank":1,"name":"主名称","value":"数值","sub":"副说明(可选)"}]}',
  '硬规则(违反任何一条 = 失败):',
  '1. title 简短有力(≤14 字);subtitle 可选(如 "BINANCE · 24H" / 日期 / 来源)。',
  '2. items 最多 8 条,从用户内容里提取;有数值(涨跌幅/数量/价格)就放 value(保留正负号、百分号、单位),没有就省略 value。',
  '3. 排行榜/盘点:按用户给的顺序或数值大小排序,逐条填 rank(1,2,3…)。',
  '4. 金句/语录:items 放一条 {"name":"金句正文","sub":"作者(可选)"}。',
  '5. 保持用户内容的语言;**绝不编造用户没给的数据**(没就留空);**绝不修改用户给的数值**(原样回传)。',
  '6. 不要输出 Markdown 围栏、不要解释、不要加 emoji。',
].join('\n');

const SYSTEM_PROMPT_WITH_VOICE = [
  SYSTEM_PROMPT_BASE,
  '',
  '【追加】同时产一段【中文口播稿】放在 "voiceScript" 字段(短视频 6-12 秒,大约 50-90 字),要求:',
  'A. 直接念用户给的内容要点,不要无关开场白(不要"大家好"/"今天给大家分享"),不要结尾煽情(不要"快来关注")。',
  'B. 数据/榜单:逐条念,数字+名称,简洁有节奏;金句:直接念金句,带作者。',
  'C. 跟 items 一致 —— **不许提 items 里没有的内容**,不许编 items 里没有的数据。',
  'D. 句子短,每句 8-16 字,适合 TTS 自然停顿;用中文标点(逗号、句号);不要英文标点。',
].join('\n');

interface ChatResult { content: string; tokens: number; costUsd: number; }

async function callDeepSeekData(system: string, user: string): Promise<ChatResult> {
  const token = getNoobClawAuthToken();
  if (!token) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'noobclawai-chat',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
        max_tokens: 2400,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效,请重新登录');
      if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足,请前往钱包充值');
      const t = await resp.text().catch(() => '');
      throw new Error(`AI API ${resp.status}: ${t.slice(0, 200)}`);
    }
    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('AI_EMPTY_RESPONSE');
    const costUsd = Number(json?._noobclaw?.costUsd) || 0;
    const price = Number(json?._noobclaw?.priceUsdPerMillion) || 0;
    let tokens = Number(json?._noobclaw?.billableTokens) || 0;
    if (!tokens && costUsd > 0 && price > 0) tokens = Math.round((costUsd / price) * 1_000_000);
    return { content, tokens, costUsd };
  } finally {
    clearTimeout(timer);
  }
}

/** 从夹带文字/围栏的输出里抠出第一个 JSON 对象。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
    }
  }
  return t;
}

function cleanItems(raw: any): TemplateItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((it: any, i: number) => {
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    if (!name) return null;
    const item: TemplateItem = { name: name.slice(0, 60) };
    if (typeof it?.rank === 'number') item.rank = it.rank; else item.rank = i + 1;
    if (typeof it?.value === 'string' && it.value.trim()) item.value = it.value.trim().slice(0, 24);
    if (typeof it?.sub === 'string' && it.sub.trim()) item.sub = it.sub.trim().slice(0, 60);
    return item;
  }).filter(Boolean) as TemplateItem[];
}

/** 纯代码兜底:把 dataText 按行解析成 items(AI 不可用时)。 */
function parseDataText(input: TemplateDataInput): TemplateData {
  const items: TemplateItem[] = (input.dataText || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
    .map((line, i) => {
      const m = line.match(/^(.*?)[\s:：,，\-—]+([+\-]?\d[\d.,%]*\S*)\s*$/);
      if (m) return { rank: i + 1, name: m[1].trim().slice(0, 60), value: m[2].trim().slice(0, 24) };
      return { rank: i + 1, name: line.slice(0, 60) };
    });
  return { title: input.title, items };
}

/** 从 items 兜底产口播稿(AI 配音稿失败时用),纯代码、不调 AI。 */
function fallbackVoiceScript(items: TemplateItem[], title?: string): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  for (const it of items.slice(0, 6)) {
    const seg = [it.name, it.value].filter(Boolean).join(' ');
    if (seg) parts.push(seg);
  }
  return parts.join('。') + '。';
}

/**
 * 产模板数据:AI 解析 dataText → {title,subtitle,items,voiceScript},失败用纯代码兜底。
 * 永远返回可用数据。needVoiceScript=true 时同时产口播稿(narration 开启专用,省 token)。
 */
export async function generateTemplateData(input: TemplateDataInput, systemPrompt?: string): Promise<TemplateDataResult> {
  const sys = systemPrompt
    || (input.needVoiceScript ? SYSTEM_PROMPT_WITH_VOICE : SYSTEM_PROMPT_BASE);
  try {
    const user = [
      input.title ? `标题倾向:${input.title}` : '',
      input.track ? `赛道:${input.track}` : '',
      input.needVoiceScript ? '需要 voiceScript:true(产中文口播稿)' : '',
      '用户内容(json):',
      input.dataText.slice(0, 2000),
    ].filter(Boolean).join('\n');
    const { content, tokens, costUsd } = await callDeepSeekData(sys, user);
    const parsed = JSON.parse(extractJsonObject(content));
    const items = cleanItems(parsed?.items);
    if (items.length > 0) {
      const voiceScript = (typeof parsed?.voiceScript === 'string' && parsed.voiceScript.trim())
        ? parsed.voiceScript.trim().slice(0, 400)
        : undefined;
      return {
        title: (typeof parsed?.title === 'string' && parsed.title.trim()) ? parsed.title.trim().slice(0, 28) : input.title,
        subtitle: (typeof parsed?.subtitle === 'string' && parsed.subtitle.trim()) ? parsed.subtitle.trim().slice(0, 40) : undefined,
        items, voiceScript,
        source: 'ai', tokens, costUsd,
      };
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
  }
  // 兜底:纯代码解析,保证永远出片(不计 AI 费)。
  const fb = parseDataText(input);
  const voiceScript = input.needVoiceScript ? fallbackVoiceScript(fb.items, fb.title) : undefined;
  return { ...fb, voiceScript, source: 'fallback', tokens: 0, costUsd: 0 };
}

/** 内容语言探测(复用 scriptWriter.detectLang)。 */
export function detectTemplateLang(text: string): ContentLang {
  return detectLang(text);
}
