/**
 * scriptWriter — 用 DeepSeek 写视频旁白脚本 + 为每个分镜生成素材搜索词。
 *
 * 抄 MoneyPrinterTurbo 的两步 LLM 套路:
 *   1. generateScript(): 没给文案时,按【主题 + 人设 + 赛道 + 目标时长】生成一段
 *      连贯的中文口播旁白。时长靠字数控制(中文约 4.5 字/秒)。
 *   2. generateSearchTerms(): 把已拆好的逐句分镜,各自映射成 1-3 个英文搜索词
 *      (Pexels/Pixabay 是英文库),让画面跟着内容走,而不是所有镜头复用同一张图。
 *
 * 两步都走 NoobClaw 服务端的 DeepSeek 代理(/api/ai/chat/completions)。
 * 模型分两档(服务端 MODEL_MAP):
 *   - generateScript() 写旁白是创作活 → noobclawai-reasoner(=deepseek-v4-pro,
 *     质量更好,但服务端按 ~3x credits 计费,所以只在这一步用)。
 *   - generateSearchTerms() 是机械映射 → noobclawai-chat(=deepseek-v4-flash,1x)。
 * 鉴权用 NoobClaw JWT。
 *
 * 任何环节失败都【不抛】(脚本生成除外):搜索词失败 → 退回用全局 keywords,
 * 上层照常出片。脚本生成失败才抛,因为没文案没法继续。
 */

import { getNoobClawAuthToken } from '../claudeSettings';

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
  if (jsonMode && /json/i.test(systemPrompt + userMessage)) {
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
export async function generateScript(input: GenerateScriptInput): Promise<GenerateScriptResult> {
  const targetSec = input.targetSeconds ?? 45;
  const targetChars = targetCharCount(targetSec);
  const kw = (input.keywords || []).filter(Boolean).join('、');

  const system = [
    '你是一名专业的短视频口播脚本撰稿人,擅长写竖屏短视频(抖音/小红书风格)的旁白。',
    input.persona ? `账号人设:${input.persona}。` : '',
    input.track ? `内容赛道:${input.track}。` : '',
    '要求:',
    `1. 围绕主题写一段【连贯的口播旁白】,目标约 ${targetChars} 个中文字符(对应约 ${targetSec} 秒)。`,
    '2. 开头一句要有钩子,中间分点讲清楚,结尾有行动号召或金句收尾。',
    '3. 口语化、节奏紧凑,适合配音朗读;不要出现"大家好""今天给大家"这类套话开场。',
    '4. 只输出旁白正文本身,不要加任何标题、序号、分镜标记、emoji、引号包裹。',
  ].filter(Boolean).join('\n');

  const user = [
    `主题:${input.topic}`,
    kw ? `关键词:${kw}` : '',
    `请直接输出约 ${targetChars} 字的口播旁白正文。`,
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
  /** 本步消耗 token(flash 档,1x);兜底时为 0。 */
  tokens: number;
  /** 本步服务端权威 USD 成本(兜底 / 老后端时为 0)。 */
  costUsd: number;
}

/**
 * 为每个分镜生成 1-3 个英文素材搜索词。返回与 scenes 等长的数组;某项失败用
 * 全局 keywords 兜底。绝不抛错。同时返回本步 token 消耗(兜底时为 0)。
 */
export async function generateSearchTerms(
  scenes: string[],
  fallbackKeywords: string[],
): Promise<GenerateSearchTermsResult> {
  const fallback = (fallbackKeywords || []).filter(Boolean);
  const fallbackEach = scenes.map(() => fallback.slice(0, 3));
  if (scenes.length === 0) return { terms: [], tokens: 0, costUsd: 0 };

  const system = [
    'You map short-video narration lines to stock-footage search terms.',
    'For EACH input line, output 1-3 ENGLISH search terms (each 1-3 words) that',
    'best describe concrete, filmable VISUALS for that line (places, objects,',
    'actions, scenery) — NOT abstract concepts. Prefer terms that exist in stock',
    'video libraries (Pexels/Pixabay).',
    'Return ONLY a JSON object of this exact shape:',
    '{"terms": [["term a","term b"], ["term c"], ...]}',
    'The "terms" array length MUST equal the number of input lines, in order.',
  ].join('\n');

  const numbered = scenes.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `Input lines (${scenes.length}):\n${numbered}\n\nReturn the JSON now.`;

  try {
    const { content, tokens, costUsd } = await callDeepSeek(system, user, true, 60_000);
    const parsed = JSON.parse(content);
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
