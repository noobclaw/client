/**
 * templateHtmlWriter — 「模板速生」v2 的数据层。
 *
 * v1 让 AI 从零写整段 HTML(质量不稳);v2 改成【AI 只产结构化数据 JSON】,由
 * templateLibrary 的精品参数化模板渲染(质量稳定可控)。本文件只负责:把用户内容
 * (dataText/title)交给 DeepSeek 解析成 {title, subtitle, items[]},失败用纯代码兜底。
 *
 * 计费:走 NoobClaw 服务端 DeepSeek 代理(/api/ai/chat/completions),口径同 scriptWriter。
 * 数据解析用 chat(flash)即可,便宜。
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

/** 「模板速生」任务输入子对象(挂在 VideoCreationInput.template 下,与 stock/ai 字段物理隔离)。 */
export interface TemplateOptions {
  style: TemplateStyle;
  title?: string;
  dataText: string;          // 用户粘贴的榜单/要点/金句
  durationSec?: number;      // 目标时长(默认按数据量,clamp[3,20])
  fps?: number;              // 默认 30
  brandColor?: string;       // 主品牌色 #RRGGBB
  accentColor?: string;      // 强调色
  narration?: boolean;       // 是否叠加 AI 口播 + 字幕(默认 false=纯画面)
  voiceScript?: string;      // 口播稿(narration 时;可空)
}

export interface TemplateData {
  title?: string;
  subtitle?: string;
  items: TemplateItem[];
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
}

const SYSTEM_PROMPT = [
  '你把用户提供的内容整理成【结构化榜单/要点数据】,用于生成动效短视频。只输出严格 JSON(json),不要任何解释。',
  '输出结构:{"title":"大标题","subtitle":"副标题(可选)","items":[{"rank":1,"name":"主名称","value":"数值","sub":"副说明(可选)"}]}',
  '规则:',
  '1. title 简短有力(≤14 字);subtitle 可选(如 "BINANCE · 24H" / 日期 / 来源)。',
  '2. items 最多 8 条,从用户内容里提取;有数值(涨跌幅/数量/价格)就放 value(保留正负号、百分号、单位),没有就省略 value。',
  '3. 排行榜/盘点:按用户给的顺序或数值大小排序,逐条填 rank(1,2,3…)。',
  '4. 金句/语录:items 放一条 {"name":"金句正文","sub":"作者(可选)"}。',
  '5. 保持用户内容的语言;不要编造用户没给的数据。',
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
        max_tokens: 2000,
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

/**
 * 产模板数据:AI 解析 dataText → {title,subtitle,items},失败用纯代码兜底。永远返回可用数据。
 */
export async function generateTemplateData(input: TemplateDataInput): Promise<TemplateDataResult> {
  try {
    const user = [
      input.title ? `标题倾向:${input.title}` : '',
      input.track ? `赛道:${input.track}` : '',
      '用户内容(json):',
      input.dataText.slice(0, 2000),
    ].filter(Boolean).join('\n');
    const { content, tokens, costUsd } = await callDeepSeekData(SYSTEM_PROMPT, user);
    const parsed = JSON.parse(extractJsonObject(content));
    const items = cleanItems(parsed?.items);
    if (items.length > 0) {
      return {
        title: (typeof parsed?.title === 'string' && parsed.title.trim()) ? parsed.title.trim().slice(0, 28) : input.title,
        subtitle: (typeof parsed?.subtitle === 'string' && parsed.subtitle.trim()) ? parsed.subtitle.trim().slice(0, 40) : undefined,
        items, source: 'ai', tokens, costUsd,
      };
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
  }
  // 兜底:纯代码解析,保证永远出片(不计 AI 费)。
  const fb = parseDataText(input);
  return { ...fb, source: 'fallback', tokens: 0, costUsd: 0 };
}

/** 内容语言探测(复用 scriptWriter.detectLang)。 */
export function detectTemplateLang(text: string): ContentLang {
  return detectLang(text);
}
