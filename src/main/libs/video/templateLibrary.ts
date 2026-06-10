/**
 * templateLibrary — 「模板速生」HF 派精品模板库(5 套,改造自 v2)。
 *
 * 关键转变:v2 用 `window.renderFrame(t)` 命令式逐帧手算 opacity(壁钟无关但难扩展);
 * v3 改成【声明式 data-* 属性 + 共享 paused seek 协议】(`window.__nbc.seek(t)`),
 * 抄 HyperFrames 的 GSAP timeline 派思维 —— 每个元素自带 `data-start` / `data-duration` /
 * `data-anim`,渲染时 seek 一次性把整张画面推到时间 t,确定性、可任意倒带、可任意倒推。
 *
 * 跟 v2 的区别:
 *   · 模板 body 里【不再有任何 JS】—— 动画完全靠 data-* 声明
 *   · seek 协议在 templateAnim.NBC_RUNTIME_JS 里统一注入,本文件不重复
 *   · 字幕节点也是声明式 `[data-caption-start/end]`,跟动画同一引擎,无对齐误差
 *
 * 仍是 5 套(rank_list/news_cards/quote/countdown/stat_board)的产品差异化:
 *   · 用户向导选「版式」依然是按内容类型挑(HF 不按内容类型分,是我们的产品优势)
 *   · AI 只填结构化数据,保证质量稳定(LLM 不写 HTML,不会画风跑偏)
 */

import type { TemplateStyle } from './templateHtmlWriter';
import {
  wrapTemplateHtml, escapeHtml as esc, type CaptionCue,
} from './templateAnim';

export interface TemplateItem {
  rank?: number;     // 名次(榜单/盘点)
  name: string;      // 主文字
  value?: string;    // 数值(如 "+18.96%" / "1.2亿")
  sub?: string;      // 副文字(英文名/说明)
}

export interface TemplateSpec {
  style: TemplateStyle;
  title?: string;
  subtitle?: string;
  items: TemplateItem[];
  brandColor: string;       // 主品牌色 #RRGGBB
  accentColor?: string;     // 强调色(默认绿 #0ecb81)
  durationSec: number;
  fps: number;
  captions?: CaptionCue[];  // TTS 出的句级时间戳;空 = 纯视觉,字幕轨隐藏
}

/** 解析「+18.96%」「-2.3%」「1.2亿」「12345」这类显示串,拆出数值/符号/前后缀。
 *  用于 count-up 动画:从 0 滚到目标数,完整保留前后缀。返回 null 表示无法解析。 */
function parseNumeric(raw: string | undefined): null | {
  num: number; decimals: number; prefix: string; suffix: string; positive: boolean;
} {
  if (!raw) return null;
  const m = raw.match(/(-?\+?)(\d+(?:\.\d+)?)(.*)/);
  if (!m) return null;
  const signRaw = m[1];
  const numStr = m[2];
  const num = parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  const positive = signRaw === '+' || (signRaw === '' && num >= 0);
  const prefix = signRaw === '+' ? '+' : signRaw === '-' ? '-' : '';
  const suffix = (m[3] || '').trim();
  const decimals = numStr.includes('.') ? (numStr.split('.')[1].length) : 0;
  return { num: Math.abs(num), decimals, prefix, suffix, positive };
}

// ── 精品模板 1:排行榜 / 榜单(rank_list)──────────────────────────────────
function renderRankList(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:78px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:34px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list{position:absolute;top:440px;left:70px;right:70px}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden}
.row .bar{position:absolute;left:0;top:0;bottom:0;width:8px;background:${spec.brandColor};opacity:0.9}
.rank{width:104px;display:flex;align-items:center;justify-content:center}
.rank b{display:inline-flex;align-items:center;justify-content:center;width:74px;height:74px;border-radius:50%;background:${spec.brandColor}1a;border:2px solid ${spec.brandColor};color:${spec.brandColor};font-size:42px;font-weight:900}
.coin{flex:1;min-width:0;padding-left:8px}
.coin .nm{font-size:54px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.coin .sb{font-size:28px;color:#848e9c;margin-top:6px}
.val{font-size:62px;font-weight:900;text-align:right;white-space:nowrap}
.val.up{color:${accent}} .val.down{color:#f6465d} .val.flat{color:#eaecef}
`;

  // 标题区:进场 0~0.6s,fade-up;副标题晚 0.1s
  const titleBlock = `<div id="title">
    <div class="t1" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '榜单速览')}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.1" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
  </div>`;

  // 列表行:逐行右滑入,数值滚动到目标值
  const rows = spec.items.slice(0, 6).map((it, i) => {
    const r = it.rank ?? (i + 1);
    const start = 0.5 + i * 0.16;
    const dur = 0.7;
    const valParsed = parseNumeric(it.value);
    let valNode: string;
    if (valParsed) {
      const colorCls = valParsed.positive ? 'up' : (it.value && it.value.startsWith('-') ? 'down' : 'flat');
      // count-up:从 0 滚到 abs(num);前后缀完整保留,负号在 prefix 里
      const signedPrefix = it.value && it.value.startsWith('-') ? '-' : valParsed.prefix;
      valNode = `<div class="val ${colorCls}" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="${dur}" data-count-from="0" data-count-to="${valParsed.num}" data-count-decimals="${valParsed.decimals}" data-count-prefix="${signedPrefix}" data-count-suffix="${esc(valParsed.suffix)}">${esc(valParsed.prefix + valParsed.num.toFixed(valParsed.decimals) + valParsed.suffix)}</div>`;
    } else {
      valNode = `<div class="val flat" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="${dur}">${esc(it.value || '')}</div>`;
    }
    return `<div class="row" data-anim="slide-in-right" data-start="${start.toFixed(2)}" data-duration="${dur}">
      <div class="bar"></div>
      <div class="rank"><b>${r}</b></div>
      <div class="coin"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>
      ${valNode}
    </div>`;
  }).join('');

  const body = `${titleBlock}<div id="list">${rows}</div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 2:金句 / 语录(quote)───────────────────────────────────────
function renderQuote(spec: TemplateSpec): string {
  const quote = spec.items[0]?.name || spec.title || '';
  const author = spec.items[0]?.sub || spec.subtitle || '';
  const css = `
#quote{position:absolute;left:110px;right:110px;top:50%;transform:translate(0,-50%);text-align:center}
#quote .mark{font-size:200px;line-height:0.6;color:${spec.brandColor};opacity:0.35;font-family:Georgia,serif}
#quote .q{font-size:72px;font-weight:800;line-height:1.5;margin-top:30px}
#quote .a{font-size:36px;color:#848e9c;margin-top:50px;letter-spacing:2px}
`;
  // 引号→正文→作者依次浮现
  const body = `<div id="quote">
    <div class="mark" data-anim="scale-in" data-start="0" data-duration="0.7">"</div>
    <div class="q" data-anim="fade-up" data-start="0.3" data-duration="0.9">${esc(quote)}</div>
    ${author ? `<div class="a" data-anim="fade" data-start="0.9" data-duration="0.7">— ${esc(author)}</div>` : ''}
  </div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 3:资讯快讯(news_cards)──────────────────────────────────────
function renderNewsCards(spec: TemplateSpec): string {
  const accent = spec.accentColor || spec.brandColor;
  const css = `
#title{position:absolute;top:180px;left:80px;right:80px;text-align:center;font-size:72px;font-weight:900;color:${spec.brandColor}}
#subtitle{position:absolute;top:300px;left:80px;right:80px;text-align:center;font-size:32px;color:#848e9c;letter-spacing:6px}
#cards{position:absolute;top:440px;left:80px;right:80px}
.card{margin-bottom:34px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:42px 48px;position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:8px;background:${accent}}
.card .h{font-size:48px;font-weight:800;color:#fff;line-height:1.3}
.card .b{font-size:32px;color:#c7ccd4;margin-top:14px;line-height:1.45}
.card .v{font-size:54px;font-weight:900;color:${accent};margin-top:10px}
`;
  const cards = spec.items.slice(0, 4).map((it, i) => {
    const start = 0.5 + i * 0.2;
    return `<div class="card" data-anim="fade-up" data-start="${start.toFixed(2)}" data-duration="0.7">
      <div class="h">${esc(it.name)}</div>
      ${it.value ? `<div class="v">${esc(it.value)}</div>` : ''}
      ${it.sub ? `<div class="b">${esc(it.sub)}</div>` : ''}
    </div>`;
  }).join('');
  const body = `<div id="title" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '今日要点')}</div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.15" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="cards">${cards}</div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 4:盘点倒数(countdown)── 排行榜的「倒序揭晓」变体 ─────────
function renderCountdown(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#f0b90b';
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:74px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:32px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list{position:absolute;top:430px;left:70px;right:70px}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden}
.row .big{font-size:120px;font-weight:900;color:${accent};line-height:1;width:160px;text-shadow:0 4px 18px ${accent}40}
.row .body{flex:1;padding-left:30px;min-width:0}
.row .nm{font-size:50px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .sb{font-size:28px;color:#848e9c;margin-top:6px}
.row .val{font-size:42px;font-weight:800;color:${accent};white-space:nowrap;margin-left:18px}
`;
  // 倒数:第 N 名先出(最低名次先,最高名次最后揭晓),所以反序入场
  const items = spec.items.slice(0, 6);
  const N = items.length;
  const rows = items.map((it, i) => {
    const r = it.rank ?? (i + 1);
    // 倒序时间:第一名最后出
    const reverseIdx = N - 1 - i;
    const start = 0.5 + reverseIdx * 0.4;
    return `<div class="row" data-anim="pop" data-start="${start.toFixed(2)}" data-duration="0.6" data-ease="back">
      <div class="big">${r}</div>
      <div class="body"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>
      ${it.value ? `<div class="val">${esc(it.value)}</div>` : ''}
    </div>`;
  }).join('');
  const body = `<div id="title">
    <div class="t1" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || 'Top ' + N)}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.1" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
  </div>
  <div id="list">${rows}</div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 5:数据看板(stat_board)── 大数字 + 关键指标 ────────────────
function renderStatBoard(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const css = `
#title{position:absolute;top:160px;left:80px;right:80px;text-align:center;font-size:62px;font-weight:900;color:${spec.brandColor}}
#subtitle{position:absolute;top:270px;left:80px;right:80px;text-align:center;font-size:30px;color:#848e9c;letter-spacing:8px}
#grid{position:absolute;top:400px;left:60px;right:60px;display:grid;grid-template-columns:1fr 1fr;gap:34px}
.cell{border-radius:32px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:56px 36px;text-align:center;min-height:340px;display:flex;flex-direction:column;justify-content:center;align-items:center}
.cell .lbl{font-size:30px;color:#848e9c;font-weight:700;letter-spacing:2px}
.cell .num{font-size:118px;font-weight:900;color:${accent};line-height:1.05;margin-top:20px;text-shadow:0 4px 20px ${accent}30}
.cell .sub{font-size:26px;color:#c7ccd4;margin-top:14px;line-height:1.4}
.cell.full{grid-column:span 2;min-height:200px}
.cell.full .num{font-size:96px}
`;
  // 4 个格子(2x2);超过 4 个忽略;只有 1 个时占满宽
  const items = spec.items.slice(0, 4);
  const cells = items.map((it, i) => {
    const start = 0.5 + i * 0.18;
    const parsed = parseNumeric(it.value);
    const fullCls = items.length === 1 ? ' full' : '';
    let numNode: string;
    if (parsed) {
      const signedPrefix = it.value && it.value.startsWith('-') ? '-' : parsed.prefix;
      numNode = `<div class="num" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="0.9" data-count-from="0" data-count-to="${parsed.num}" data-count-decimals="${parsed.decimals}" data-count-prefix="${signedPrefix}" data-count-suffix="${esc(parsed.suffix)}">${esc(parsed.prefix + parsed.num.toFixed(parsed.decimals) + parsed.suffix)}</div>`;
    } else {
      numNode = `<div class="num" data-anim="fade-up" data-start="${start.toFixed(2)}" data-duration="0.7">${esc(it.value || it.name)}</div>`;
    }
    return `<div class="cell${fullCls}" data-anim="rise" data-start="${start.toFixed(2)}" data-duration="0.7">
      <div class="lbl">${esc(it.name)}</div>
      ${numNode}
      ${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}
    </div>`;
  }).join('');
  const body = `<div id="title" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '数据看板')}</div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.15" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="grid">${cells}</div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

/** 按 style 渲染精品模板 → 完整 HTML(含 paused seek 协议)。 */
export function renderTemplate(spec: TemplateSpec): string {
  switch (spec.style) {
    case 'rank_list':
      return renderRankList(spec);
    case 'quote':
      return renderQuote(spec);
    case 'news_cards':
      return renderNewsCards(spec);
    case 'countdown':
      return renderCountdown(spec);
    case 'stat_board':
      return renderStatBoard(spec);
    default:
      return renderNewsCards(spec);
  }
}
