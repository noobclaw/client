/**
 * freeformWriter — 「AI 自由排版」(ai_freeform)的画面生成层。
 *
 * 跟 5 套固定模板的根本区别:这里【AI 写整个画面的 HTML + CSS(+ 可选 GSAP 时间线)】,
 * 不再只填数据。这是「无限接近 HyperFrames」的核心 —— 表现力不再被锁死在固定版式里。
 *
 * 但 DeepSeek 看不了图,所以配套一个【确定性体检闭环】(htmlVideoRenderer.auditHtml +
 * 本文件的 fix 重写):渲染 → 无头浏览器自查溢出/重叠/空白/动画没接上 → 把问题喂回来
 * 重写,2~3 轮。等于把 HyperFrames「人看预览」换成「机器 linter」。
 *
 * 产物契约(严格 JSON):{ css, bodyHtml, setupScript }
 *   · bodyHtml 注入 <div id="stage">(已是 1080×1920 暗底+网格+辉光)
 *   · 动画两条路:① data-* 声明式(templateAnim 协议,首选,稳)② GSAP paused 时间线
 *     (setupScript 里建,存 window.__timelines,我们逐帧 totalTime(t))
 *   · 全程禁壁钟(Date/Math.random/setInterval/raf/CSS animation/transition)—— 否则
 *     逐帧 seek 渲染会糊
 *
 * 计费:复用 templateHtmlWriter.callNoobclawChat(同 DeepSeek 代理口径)。
 */

import { callNoobclawChat } from './templateHtmlWriter';
import type { ContentLang } from './scriptWriter';

export interface FreeformFixHint {
  prevCss: string;
  prevBodyHtml: string;
  prevSetupScript?: string;
  issues: string[];
}

export interface FreeformInput {
  dataText: string;
  title?: string;
  lang: ContentLang;
  brandColor: string;
  accentColor?: string;
  durationSec: number;
  /** 字幕是否开(开了要给底部留安全区,别让画面元素压到字幕)。 */
  captionsOn: boolean;
  /** GSAP 是否可用(随包文件存在)。false 时禁止 AI 用 gsap,只能 data-*。 */
  gsapAvailable: boolean;
  /** 体检不通过时的修复上下文:带上一版 + 问题清单,让 AI 改而不是重起炉灶。 */
  fixHint?: FreeformFixHint;
}

export interface FreeformResult {
  css: string;
  bodyHtml: string;
  setupScript?: string;
  source: 'ai' | 'fallback';
  tokens: number;
  costUsd: number;
}

const SYSTEM_PROMPT = [
  '你是资深动态图形(motion graphics)工程师。把用户内容做成【一条 1080×1920 竖屏短视频画面】,用 HTML+CSS(+可选 GSAP)实现,动画必须【确定性、可逐帧 seek】。',
  '只输出严格 JSON(json),不要任何解释、不要 markdown 围栏:',
  '{"css":"<style 内的纯 CSS>","bodyHtml":"<注入 #stage 的 HTML>","setupScript":"<可选:建 GSAP 时间线的 JS,没有就给空串>"}',
  '',
  '【画布】',
  '- #stage 已是 1080(宽)×1920(高),已有暗色渐变底 + 网格 + 辉光,你可叠自己的背景层。',
  '- 四周留 ≥60px 安全边。内容不许溢出 1080×1920。文字别被裁(给足行高/换行)。',
  '',
  '【时长 & 编排】',
  '- 整片精确 {{DURATION}} 秒。所有【进场动画】的 data-start 必须 ≥0,且 data-start+data-duration ≤ {{DURATION}}。',
  '- 设计节奏:开头 ~1s 出主标题,内容错峰登场(stagger),结尾几秒画面稳定不动(别在最后一刻还在飞元素)。',
  '',
  '【动画 —— 只能用这两套机制,二选一或混用;严禁 CSS @keyframes / animation / transition / setInterval / setTimeout / requestAnimationFrame / Date / Math.random(全是壁钟,会让逐帧渲染糊)】',
  '① 首选 data-* 声明式(写在任意元素上,稳、好懂):',
  '   data-start(秒) data-duration(秒,默认0.6) data-anim(取值:fade/fade-up/fade-down/fade-left/fade-right/slide-in-left/slide-in-right/scale-in/pop/rise/wipe-right/wipe-left)',
  '   data-ease(可选:cubic/expo/back/elastic/bounce/quad/linear) 退场(可选:data-exit-start data-exit-duration)',
  '   循环环境动画:data-loop(float/pulse/sweep/spin/glitch)+ data-loop-period data-loop-amp data-loop-phase',
  '   数字滚动:data-anim 任意 + data-count-from data-count-to data-count-decimals data-count-prefix data-count-suffix(元素文本会被滚动数值覆盖)',
  '② 进阶 GSAP 时间线(做形变/路径/复杂 stagger 等 data-* 做不到的英雄动效),写在 setupScript:',
  '   window.__timelines = window.__timelines || {};',
  "   var tl = gsap.timeline({paused:true}); tl.from('.hero',{opacity:0,y:60,duration:0.8,ease:'power3.out'},0);",
  '   window.__timelines.main = tl;',
  '   规则:时间线【必须 paused:true】(我们靠 totalTime(t) 逐帧驱动,你绝不能 .play());时间线总时长 ≤ {{DURATION}};',
  '   被 GSAP 控制的元素【不要】再带 data-anim(避免两套机制打架);只能引用你在 bodyHtml 里写的 class/id。',
  '{{GSAP_AVAIL}}',
  '',
  '【视觉质量】要专业、广播级、高对比。主色 {{BRAND}}、强调色 {{ACCENT}}。大号粗体标题、清晰信息层级。',
  '可用渐变/阴影/模糊,以及已注入的 fx 工具类:.fx-grain(颗粒) .fx-vignette(暗角) .fx-scanlines(扫描线) .fx-blob(极光球,配 data-loop=float) .fx-sheen(光泽扫过,配 data-loop=sweep)。',
  '只用系统字体(已全局设好,中日韩+Latin 都覆盖)—— 严禁 @font-face / web font / @import / 任何外链(http/https 图片、CDN 一律禁止,离线渲染会失败)。',
  '',
  '【内容】忠实呈现下方用户内容,按内容类型自选最合适的版式(榜单/卡片/金句/数据看板/头条快讯…);绝不编造用户没给的数据。保持用户内容语言。',
  '【字幕】{{CAPTIONS}}',
  '',
  '再次强调:输出纯 JSON,bodyHtml 里【不许有 <script>】(JS 只能放 setupScript),不许 on 事件属性,不许外链。',
].join('\n');

function buildSystem(input: FreeformInput): string {
  return SYSTEM_PROMPT
    .replace(/\{\{DURATION\}\}/g, input.durationSec.toFixed(1))
    .replace('{{BRAND}}', input.brandColor)
    .replace('{{ACCENT}}', input.accentColor || '#0ecb81')
    .replace('{{GSAP_AVAIL}}', input.gsapAvailable
      ? '   GSAP 3 已就绪 = window.gsap,可直接用。'
      : '   ⚠️ 本次 GSAP 不可用 —— 只能用 ① data-* 机制,setupScript 给空串,绝不能引用 gsap。')
    .replace('{{CAPTIONS}}', input.captionsOn
      ? '本片会烧字幕(底部),请给画面底部留出 ≥240px 安全区,别让任何内容元素落到那里被字幕压住。'
      : '本片无字幕,可用满整屏(仍留 60px 安全边)。');
}

function buildUser(input: FreeformInput): string {
  const parts: string[] = [];
  if (input.title) parts.push(`标题倾向:${input.title}`);
  parts.push(`主色 ${input.brandColor} / 强调色 ${input.accentColor || '#0ecb81'} / 时长 ${input.durationSec.toFixed(1)}s`);
  if (input.fixHint) {
    parts.push('');
    parts.push('【上一版有以下问题,请修复后重新输出完整 JSON(在上一版基础上改,别推倒重来)】');
    input.fixHint.issues.slice(0, 12).forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push('');
    parts.push('上一版 css:');
    parts.push(input.fixHint.prevCss.slice(0, 6000));
    parts.push('上一版 bodyHtml:');
    parts.push(input.fixHint.prevBodyHtml.slice(0, 8000));
    if (input.fixHint.prevSetupScript) {
      parts.push('上一版 setupScript:');
      parts.push(input.fixHint.prevSetupScript.slice(0, 3000));
    }
  }
  parts.push('');
  parts.push('用户内容(json):');
  parts.push(input.dataText.slice(0, 2200));
  return parts.join('\n');
}

/** 从夹带文字/围栏的输出里抠出第一个 JSON 对象。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
      }
    }
  }
  return t;
}

const BANNED_JS = /\b(setInterval|setTimeout|requestAnimationFrame|XMLHttpRequest|fetch|WebSocket|eval|Function|Date|Math\.random|while\s*\(|location|document\.cookie|localStorage)\b|import\s*\(/;

/** 体检前的纯代码消毒:剥掉外链 / <script> / on事件 / 非确定性 JS。绝不抛。 */
function sanitizeBody(html: string): string {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')        // body 里禁脚本(JS 只走 setupScript)
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')            // 行内事件
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(src|href)\s*=\s*("|')\s*https?:\/\/[^"']*\2/gi, '$1=$2#$2') // 外链置空
    .replace(/url\(\s*https?:\/\/[^)]*\)/gi, 'none');   // CSS 内联外链背景
}
function sanitizeCss(css: string): string {
  return (css || '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\(\s*['"]?https?:\/\/[^)]*\)/gi, 'none')
    .replace(/@font-face[\s\S]*?\}/gi, '');
}
/** setupScript 含任何壁钟/外链/危险调用 → 整段丢弃(降级为只用 data-*)。 */
function sanitizeSetup(js: string | undefined): string | undefined {
  const s = (js || '').trim();
  if (!s) return undefined;
  if (BANNED_JS.test(s)) return undefined;
  return s.slice(0, 8000);
}

/** 纯代码兜底:AI 全挂时产一个朴素但能看的标题+列表画面(data-* 错峰登场)。 */
function fallbackScene(input: FreeformInput): FreeformResult {
  const lines = (input.dataText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const title = esc(input.title || (lines[0] || '热点速览').slice(0, 18));
  const rows = lines.map((l, i) =>
    `<div class="ff-row" data-anim="fade-up" data-start="${(0.8 + i * 0.25).toFixed(2)}" data-duration="0.5" data-ease="expo">${esc(l.slice(0, 50))}</div>`,
  ).join('');
  const css = `
#ff-title{position:absolute;top:220px;left:80px;right:80px;text-align:center;font-size:84px;font-weight:900;color:${input.brandColor};line-height:1.15}
#ff-list{position:absolute;top:480px;left:80px;right:80px;bottom:${input.captionsOn ? 280 : 120}px}
.ff-row{font-size:50px;font-weight:700;line-height:1.3;margin-bottom:34px;padding-left:28px;border-left:8px solid ${input.accentColor || '#0ecb81'}}`;
  const bodyHtml = `<div id="ff-title" data-anim="fade-up" data-start="0.1" data-duration="0.6" data-ease="expo">${title}</div><div id="ff-list">${rows}</div>`;
  return { css, bodyHtml, source: 'fallback', tokens: 0, costUsd: 0 };
}

/**
 * 让 AI 写一版自由排版画面。失败 → 纯代码兜底(永远返回可渲染产物)。
 * temperature 拉到 0.9 提升排版多样性(数据准确性由「忠实呈现/不编造」硬约束兜)。
 */
export async function generateFreeformScene(input: FreeformInput): Promise<FreeformResult> {
  try {
    const { content, tokens, costUsd } = await callNoobclawChat(
      buildSystem(input), buildUser(input), { temperature: 0.9, maxTokens: 4096 },
    );
    const parsed = JSON.parse(extractJsonObject(content));
    const bodyHtml = sanitizeBody(typeof parsed?.bodyHtml === 'string' ? parsed.bodyHtml : '');
    const css = sanitizeCss(typeof parsed?.css === 'string' ? parsed.css : '');
    if (bodyHtml.trim().length > 20) {
      const setupScript = input.gsapAvailable ? sanitizeSetup(parsed?.setupScript) : undefined;
      return { css, bodyHtml, setupScript, source: 'ai', tokens, costUsd };
    }
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // 鉴权/余额类错误向上抛(跟 templateHtmlWriter 同口径,让 pipeline 显式失败)
    if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
  }
  return fallbackScene(input);
}
