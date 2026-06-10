/**
 * templateHtmlWriter — 「模板速生」的脑子:让 DeepSeek(Pro)现编一个【自包含动画 HTML】,
 *   经静态 + 动态双重校验,失败回灌重试,仍失败用内置参数化兜底模板,保证【永远出片】。
 *
 * 产出的 HTML 契约(htmlVideoRenderer 消费):画布 1080×1920、定义 window.renderFrame(t)
 *   纯函数(按 t 算行内样式,不用 CSS transition/animation/rAF/Date.now)、定义 window.DURATION。
 *
 * 计费:走 NoobClaw 服务端 DeepSeek 代理(/api/ai/chat/completions),token 服务端实时扣,
 *   口径与 scriptWriter 一致(_noobclaw.billableTokens / costUsd)。降级用兜底模板时不计 AI 费。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import { detectLang, type ContentLang } from './scriptWriter';

export type { ContentLang };

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

/** 模板版式枚举(card 向导让用户选;喂给 AI 当版式意图)。 */
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

export interface TemplateHtmlInput {
  style: TemplateStyle;
  title?: string;
  dataText: string;          // 用户粘贴的榜单/要点/金句(喂 AI,也是兜底模板的数据源)
  track?: string;
  persona?: string;
  brandColor?: string;       // 主品牌色 #RRGGBB
  accentColor?: string;      // 强调色
  lang: ContentLang;
  durationSec: number;       // 目标时长(已 clamp)
}

export interface TemplateHtmlResult {
  html: string;
  durationSec: number;
  fps: number;
  source: 'ai' | 'fallback';
  tokens: number;
  costUsd: number;
}

/** 动态校验器(由 template-pipeline 注入 htmlVideoRenderer.probeHtml,避免循环依赖)。 */
export type HtmlValidator = (html: string) => Promise<{ ok: boolean; reason?: string; durationSec?: number; fps?: number }>;

const STYLE_DESC: Record<TemplateStyle, string> = {
  rank_list: '排行榜/榜单:逐条展示【名次 + 名称 + 数值】,每行错峰从一侧飞入,数值数字从 0 滚到目标值',
  news_cards: '资讯卡片:2-4 张要点卡片依次淡入/滑入,每张一个小标题 + 一句话说明',
  quote: '金句/语录:一句大字居中呈现,逐句或整段淡入 + 轻微放大,背景有缓动光晕',
  countdown: '盘点倒数:从最后一名倒数揭晓到第一名,逐个强调放大',
  stat_board: '数据看板:几个关键指标做成大数字 + 标签卡,数字滚动到目标值',
};

const SAFE_FONT = "'Microsoft YaHei','PingFang SC','Hiragino Sans GB','Segoe UI',sans-serif";

const SYSTEM_PROMPT = [
  '你是一名把数据/资讯做成【竖屏动效短视频画面】的前端工程师。你输出的 HTML 会被无头浏览器逐帧截图编码成视频。',
  '严格遵守以下硬约束,任何一条违反都会导致渲染失败:',
  '1. 只输出【一个完整的 HTML 文档】,用 ```html 围栏包裹,不要任何解释文字。',
  '2. 画布固定:html,body{width:1080px;height:1920px;margin:0;overflow:hidden}。根容器 #stage 同尺寸。竖屏 9:16。',
  '3. 全部自包含:CSS 写在 <style>、JS 写在 <script> 内联。【禁止】任何外链:不许 <link>、不许 <script src=...>、不许 src="http..."、不许 @import、不许 import、不许 fetch()、不许外链网络字体。需要图就用纯 CSS 画(渐变/圆/形状),不要 <img> 外链。',
  `4. 字体只用系统安全字体族:${SAFE_FONT}。`,
  '5. 【必须】定义全局纯函数 window.renderFrame(t):入参 t 是秒(从 0 到时长),函数根据 t 计算并设置元素的行内样式(opacity / transform / textContent 等),把画面摆成"那一刻该有的样子"。renderFrame 必须幂等无副作用,【禁止】使用 CSS transition / CSS animation / requestAnimationFrame / setTimeout / Date.now —— 所有动画都由 renderFrame 按 t 计算(用缓动函数如 easeOutCubic)。',
  '6. 【必须】定义全局常量 window.DURATION = 总时长秒数(数字,3~20 之间),可选 window.FPS(默认 30)。',
  '7. 页面加载末尾立即调用一次 window.renderFrame(0)。',
  '8. 所有数据【硬编码】进 JS 里的 const DATA = [...](不要运行时拉取)。',
  '9. 视觉要精致有设计感:深色背景、品牌色点缀、留白、层次、错峰入场动画、数字滚动。像优质的财经/资讯短视频封面动画。',
].join('\n');

function buildUserMessage(input: TemplateHtmlInput, retryReason?: string): string {
  const lines = [
    `版式:${STYLE_DESC[input.style]}`,
    input.title ? `大标题:${input.title}` : '',
    input.track ? `内容赛道:${input.track}` : '',
    input.persona ? `账号人设:${input.persona}` : '',
    input.brandColor ? `主品牌色:${input.brandColor}` : '主品牌色:#f0b90b(金黄)',
    input.accentColor ? `强调色:${input.accentColor}` : '',
    `内容语言:${input.lang}`,
    `目标时长:约 ${input.durationSec} 秒(请把 window.DURATION 设成这个值)`,
    '',
    '【数据/内容(请解析后硬编码进 DATA,自行设计成上面的版式)】:',
    input.dataText.slice(0, 2000),
    '',
    retryReason
      ? `上一次产出的 HTML 渲染校验失败,原因:「${retryReason}」。请修正后重新输出完整 HTML(尤其确认 window.renderFrame(t) 会随 t 真实改变画面、window.DURATION 是数字、无任何外链)。`
      : '现在请输出完整的 HTML(```html 围栏)。',
  ];
  return lines.filter(Boolean).join('\n');
}

interface ChatResult { content: string; tokens: number; costUsd: number; }

/** 调 DeepSeek 代理(Pro,写 HTML 是创作活)。口径同 scriptWriter。 */
async function callDeepSeekHtml(system: string, user: string): Promise<ChatResult> {
  const token = getNoobClawAuthToken();
  if (!token) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'noobclawai-reasoner',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
        max_tokens: 8000,
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

/** 从模型输出里抠出 HTML 文档(剥 ```html``` 围栏 / 取 <!doctype…</html>)。 */
function extractHtml(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const di = t.search(/<!doctype html/i);
  if (di >= 0) {
    const end = t.lastIndexOf('</html>');
    if (end > di) return t.slice(di, end + 7);
    return t.slice(di);
  }
  // 没 doctype 但有 <html>
  const hi = t.search(/<html[\s>]/i);
  if (hi >= 0) {
    const end = t.lastIndexOf('</html>');
    return end > hi ? t.slice(hi, end + 7) : t.slice(hi);
  }
  return t;
}

/** 静态校验:必含契约,无外链黑名单。返回 {ok,reason}。 */
function staticValidate(html: string): { ok: boolean; reason?: string } {
  if (!/<!doctype html/i.test(html) && !/<html[\s>]/i.test(html)) return { ok: false, reason: '不是完整 HTML 文档' };
  if (!/window\.renderFrame/.test(html)) return { ok: false, reason: '缺少 window.renderFrame' };
  if (!/window\.DURATION/.test(html)) return { ok: false, reason: '缺少 window.DURATION' };
  const blacklist: Array<[RegExp, string]> = [
    [/<link[\s>]/i, '含 <link> 外链'],
    [/<script[^>]+\bsrc\s*=/i, '含 <script src> 外链'],
    [/\bsrc\s*=\s*["']?https?:/i, '含 http(s) 外链资源'],
    [/url\(\s*["']?https?:/i, '含 http(s) 外链 url()'],
    [/@import/i, '含 @import'],
    [/\bimport\s+[\w{*]/, '含 ES import'],
    [/\bfetch\s*\(/, '含 fetch()'],
    [/\brequestAnimationFrame\b/, '含 requestAnimationFrame(动画必须由 renderFrame 按 t 驱动)'],
  ];
  for (const [re, why] of blacklist) if (re.test(html)) return { ok: false, reason: why };
  return { ok: true };
}

/**
 * 生成模板 HTML:AI 出稿 → 静态校验 → 动态校验(validate 注入)→ 失败回灌重试(总 3 次)
 * → 仍失败用内置兜底模板。保证永远返回一份可渲染的 HTML。
 */
export async function generateTemplateHtml(
  input: TemplateHtmlInput,
  validate: HtmlValidator,
): Promise<TemplateHtmlResult> {
  let tokens = 0, costUsd = 0;
  let lastReason = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const user = buildUserMessage(input, attempt > 0 ? lastReason : undefined);
      const res = await callDeepSeekHtml(SYSTEM_PROMPT, user);
      tokens += res.tokens; costUsd += res.costUsd;
      const html = extractHtml(res.content);
      const sv = staticValidate(html);
      if (!sv.ok) { lastReason = sv.reason || '静态校验失败'; continue; }
      const dv = await validate(html);
      if (!dv.ok) { lastReason = dv.reason || '动态校验失败'; continue; }
      return {
        html,
        durationSec: dv.durationSec || input.durationSec,
        fps: dv.fps || 30,
        source: 'ai',
        tokens, costUsd,
      };
    } catch (e) {
      lastReason = String((e as Error)?.message || e);
      // 鉴权/余额类错误直接抛(重试无意义)
      if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(lastReason)) throw e;
    }
  }
  // 兜底:内置参数化模板,保证出片。降级不计 AI 费(token 仍累计上面真实消耗)。
  const html = buildFallbackHtml(input);
  return { html, durationSec: input.durationSec, fps: 30, source: 'fallback', tokens, costUsd };
}

// ── 内置兜底模板(基于 POC scene.html 参数化)──────────────────────────────
//  把 dataText 按行拆成条目,做成「标题 + 逐条错峰飞入 + 数值滚动」的通用榜单/要点动画。
//  对所有 style 都能出一个像样的成片,确保 AI 失败时永远有片。

function parseRows(dataText: string): Array<{ name: string; value: string }> {
  return (dataText || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => {
      // 支持 "名称 +12.3%" / "名称：值" / "名称,值" / 纯文字
      const m = line.match(/^(.*?)[\s:：,，\-—]+([+\-]?\d[\d.,%]*)\s*$/);
      if (m) return { name: m[1].trim(), value: m[2].trim() };
      return { name: line, value: '' };
    });
}

function esc(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function buildFallbackHtml(input: TemplateHtmlInput): string {
  const rows = parseRows(input.dataText);
  const title = esc(input.title || (input.track ? input.track : '榜单速览'));
  const brand = /^#[0-9a-f]{6}$/i.test(input.brandColor || '') ? input.brandColor! : '#f0b90b';
  const dur = Math.max(3, Math.min(20, input.durationSec || 6));
  const data = JSON.stringify(rows);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:${SAFE_FONT}}
html,body{width:1080px;height:1920px;overflow:hidden;background:#0b0e11;color:#fff}
#stage{width:1080px;height:1920px;position:relative;background:radial-gradient(circle at 50% 18%,#1a1d24 0%,#0b0e11 60%)}
.glow{position:absolute;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,${brand}33,transparent 70%);left:90px;top:-220px;filter:blur(40px)}
#title{position:absolute;top:200px;width:100%;text-align:center;font-size:72px;font-weight:800;color:${brand}}
#list{position:absolute;top:430px;left:80px;right:80px}
.row{height:170px;margin-bottom:26px;border-radius:26px;background:linear-gradient(135deg,#181a20,#1e2026);border:1px solid #2b2f36;display:flex;align-items:center;padding:0 52px;overflow:hidden}
.rank{font-size:54px;font-weight:800;color:${brand};width:92px}
.name{flex:1;font-size:52px;font-weight:700}
.val{font-size:60px;font-weight:800;color:#0ecb81;text-align:right}
</style></head><body><div id="stage">
<div class="glow" id="glow"></div>
<div id="title">${title}</div>
<div id="list"></div>
</div><script>
const DATA=${data};
const list=document.getElementById('list');
const rows=DATA.map((d,i)=>{const r=document.createElement('div');r.className='row';
r.innerHTML='<div class="rank">'+(i+1)+'</div><div class="name">'+String(d.name).replace(/[<>]/g,'')+'</div><div class="val"></div>';
list.appendChild(r);return r;});
const ease=t=>1-Math.pow(1-t,3);
function parseNum(v){const m=String(v).match(/-?\\d+(?:\\.\\d+)?/);return m?parseFloat(m[0]):null;}
window.FPS=30;
window.DURATION=${dur};
window.renderFrame=function(t){
 const tt=Math.min(1,t/0.6);const ti=document.getElementById('title');
 ti.style.opacity=ease(tt);ti.style.transform='scale('+(0.9+0.1*ease(tt))+')';
 rows.forEach((r,i)=>{const start=0.4+i*0.16;const p=Math.max(0,Math.min(1,(t-start)/0.7));const e=ease(p);
  r.style.opacity=e;r.style.transform='translateX('+((1-e)*720)+'px)';
  const raw=DATA[i].value;const n=parseNum(raw);const vEl=r.querySelector('.val');
  if(n!==null){const suffix=/%/.test(raw)?'%':'';const sign=n>0&&/^\\s*\\+/.test(raw)?'+':'';vEl.textContent=sign+(n*e).toFixed(/\\./.test(raw)?2:0)+suffix;}
  else vEl.textContent=raw||'';});
 document.getElementById('glow').style.transform='translateX('+(Math.sin(t*0.8)*120)+'px)';
};
window.renderFrame(0);
</script></body></html>`;
}

/** 内容语言探测(给 pipeline 用,复用 scriptWriter.detectLang)。 */
export function detectTemplateLang(text: string): ContentLang {
  return detectLang(text);
}
