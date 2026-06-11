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
  /**
   * 外部传入的【每页时间窗】(秒),由 pipeline 根据 voiceSegments 在 TTS 真实时长上反算。
   * 长度必须 == 分页后 page 数;为空时各模板按 durationSec 均分。
   * 实现「音画同步」:配音念到第 N 段时,画面正好在第 N 页。
   */
  pageTimings?: Array<{ startSec: number; durSec: number }>;
}

/** 计算分页的 pageCount(给 pipeline 算 pageMeta 用)。 */
export function calcPageCount(itemsLen: number, pageSize: number): number {
  return Math.max(1, Math.ceil(itemsLen / pageSize));
}

/** 计算每页的 items 索引范围(给 pipeline 喂给 AI 的 pageRanges 用)。 */
export function calcPageRanges(itemsLen: number, pageSize: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let p = 0; p * pageSize < itemsLen; p++) {
    const a = p * pageSize;
    const b = Math.min(itemsLen - 1, a + pageSize - 1);
    ranges.push([a, b]);
  }
  return ranges.length ? ranges : [[0, Math.max(0, itemsLen - 1)]];
}

/** 把 items 分页 + 计算每页时间窗。最后一页不退场(留到片尾)。 */
interface PageSlot {
  items: TemplateItem[];
  /** 本页元素的【建议 data-start 起点秒】 —— 子元素在此基础上 +0.1, +0.25... 错开。 */
  pageStartSec: number;
  /** 本页持续多久(秒)。 */
  pageDurationSec: number;
  /** 本页是不是最后一页(最后一页不退场,留到 video 结束)。 */
  isLast: boolean;
  pageIndex: number;
  pageCount: number;
}
function paginate(items: TemplateItem[], pageSize: number, totalSec: number, pageTimings?: Array<{ startSec: number; durSec: number }>): PageSlot[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  // 优先用外部传入的 pageTimings(配音同步模式):pipeline 已经根据 voiceSegments
  // 在 TTS 真实时长上算好每段时间窗,跟配音 100% 对齐。
  if (pageTimings && pageTimings.length === pageCount) {
    const slots: PageSlot[] = [];
    for (let p = 0; p < pageCount; p++) {
      slots.push({
        items: items.slice(p * pageSize, (p + 1) * pageSize),
        pageStartSec: pageTimings[p].startSec,
        pageDurationSec: pageTimings[p].durSec,
        isLast: p === pageCount - 1,
        pageIndex: p,
        pageCount,
      });
    }
    return slots;
  }
  // 兜底:按 totalSec 均分(纯视觉模式 / TTS 失败时走这条)。
  // 留 0.5s 入场缓冲 + 0.5s 尾留白
  const usable = Math.max(2.0, totalSec - 1.0);
  const perPage = usable / pageCount;
  const slots: PageSlot[] = [];
  for (let p = 0; p < pageCount; p++) {
    slots.push({
      items: items.slice(p * pageSize, (p + 1) * pageSize),
      pageStartSec: 0.5 + p * perPage,
      pageDurationSec: perPage,
      isLast: p === pageCount - 1,
      pageIndex: p,
      pageCount,
    });
  }
  return slots;
}

/** 各模板的【每页容量】导出,供 pipeline 算 pageMeta 用(不重复硬编码)。 */
export function pageSizeFor(style: TemplateStyle): number {
  switch (style) {
    case 'rank_list': return 6;
    case 'news_cards': return 4;
    case 'countdown': return 6;
    case 'stat_board': return 4;
    case 'quote': return 1; // 金句只展示 items[0],分页无意义
    default: return 4;
  }
}

/** 给 page wrapper 拼 data-* 属性 —— fade 进场 + 末尾退场(最后一页不退)。 */
function pageDataAttrs(slot: PageSlot): string {
  const enterDur = 0.35;
  const exitDur = 0.4;
  const attrs = [
    `data-anim="fade"`,
    `data-start="${slot.pageStartSec.toFixed(2)}"`,
    `data-duration="${enterDur}"`,
  ];
  if (!slot.isLast) {
    const exitStart = slot.pageStartSec + slot.pageDurationSec - exitDur;
    attrs.push(`data-exit-start="${exitStart.toFixed(2)}"`);
    attrs.push(`data-exit-duration="${exitDur.toFixed(2)}"`);
  }
  return attrs.join(' ');
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
// 每页 6 行;数据超过 6 条自动分页轮播,每页占 totalSec/pageCount 秒。
function renderRankList(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const PAGE = 6;
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:78px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:34px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list-area{position:absolute;top:440px;left:70px;right:70px;bottom:140px}
.page{position:absolute;inset:0}
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

  const titleBlock = `<div id="title">
    <div class="t1" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '榜单速览')}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.1" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
  </div>`;

  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const rows = slot.items.map((it, i) => {
      const r = it.rank ?? (slot.pageIndex * PAGE + i + 1);
      const start = slot.pageStartSec + 0.2 + i * 0.12;
      const dur = 0.6;
      const valParsed = parseNumeric(it.value);
      let valNode: string;
      if (valParsed) {
        const colorCls = valParsed.positive ? 'up' : (it.value && it.value.startsWith('-') ? 'down' : 'flat');
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
    return `<div class="page" ${pageDataAttrs(slot)}>${rows}</div>`;
  }).join('');

  const body = `${titleBlock}<div id="list-area">${pages}</div>`;
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
// 每页 4 张卡;数据多自动分页轮播(避免用户的 8 条要点只显示前 4 条)。
function renderNewsCards(spec: TemplateSpec): string {
  const accent = spec.accentColor || spec.brandColor;
  const PAGE = 4;
  const css = `
#title{position:absolute;top:180px;left:80px;right:80px;text-align:center;font-size:72px;font-weight:900;color:${spec.brandColor}}
#subtitle{position:absolute;top:300px;left:80px;right:80px;text-align:center;font-size:32px;color:#848e9c;letter-spacing:6px}
#cards-area{position:absolute;top:440px;left:80px;right:80px;bottom:140px}
.page{position:absolute;inset:0}
.card{margin-bottom:34px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:42px 48px;position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:8px;background:${accent}}
.card .h{font-size:48px;font-weight:800;color:#fff;line-height:1.3}
.card .b{font-size:32px;color:#c7ccd4;margin-top:14px;line-height:1.45}
.card .v{font-size:54px;font-weight:900;color:${accent};margin-top:10px}
.pager{position:absolute;bottom:96px;left:0;right:0;text-align:center;font-size:24px;color:#5e6673;letter-spacing:6px}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const cards = slot.items.map((it, i) => {
      const start = slot.pageStartSec + 0.2 + i * 0.18;
      return `<div class="card" data-anim="fade-up" data-start="${start.toFixed(2)}" data-duration="0.6">
        <div class="h">${esc(it.name)}</div>
        ${it.value ? `<div class="v">${esc(it.value)}</div>` : ''}
        ${it.sub ? `<div class="b">${esc(it.sub)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${cards}</div>`;
  }).join('');
  // 多页时底部显示「1 / 2」「2 / 2」 翻页提示(单页不显)
  const pager = slots.length > 1
    ? slots.map((slot) =>
      `<div class="pager" ${pageDataAttrs(slot)}>${slot.pageIndex + 1} / ${slot.pageCount}</div>`
    ).join('')
    : '';
  const body = `<div id="title" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '今日要点')}</div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.15" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="cards-area">${pages}</div>
    ${pager}`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 4:盘点倒数(countdown)── 排行榜的「倒序揭晓」变体 ─────────
// 每页 6 行;倒数语义保留(每页内最低名次先,最高名次最后揭晓)。
function renderCountdown(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#f0b90b';
  const PAGE = 6;
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:74px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:32px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list-area{position:absolute;top:430px;left:70px;right:70px;bottom:140px}
.page{position:absolute;inset:0}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden}
.row .big{font-size:120px;font-weight:900;color:${accent};line-height:1;width:160px;text-shadow:0 4px 18px ${accent}40}
.row .body{flex:1;padding-left:30px;min-width:0}
.row .nm{font-size:50px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .sb{font-size:28px;color:#848e9c;margin-top:6px}
.row .val{font-size:42px;font-weight:800;color:${accent};white-space:nowrap;margin-left:18px}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const totalN = spec.items.length;
  const pages = slots.map((slot) => {
    const N = slot.items.length;
    const rows = slot.items.map((it, i) => {
      const r = it.rank ?? (slot.pageIndex * PAGE + i + 1);
      // 倒序:本页内最高 i 先出,i=0 最后出。每条间隔 = (页时长-1) / N。
      const reverseIdx = N - 1 - i;
      const stagger = Math.min(0.6, Math.max(0.2, (slot.pageDurationSec - 1.0) / Math.max(1, N)));
      const start = slot.pageStartSec + 0.2 + reverseIdx * stagger;
      return `<div class="row" data-anim="pop" data-start="${start.toFixed(2)}" data-duration="0.55" data-ease="back">
        <div class="big">${r}</div>
        <div class="body"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>
        ${it.value ? `<div class="val">${esc(it.value)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${rows}</div>`;
  }).join('');
  const body = `<div id="title">
    <div class="t1" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || 'Top ' + totalN)}</div>
    ${spec.subtitle ? `<div class="t2" data-anim="fade-up" data-start="0.1" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
  </div>
  <div id="list-area">${pages}</div>`;
  return wrapTemplateHtml({
    bodyHtml: body, css, brandColor: spec.brandColor,
    durationSec: spec.durationSec, fps: spec.fps, captionCues: spec.captions,
  });
}

// ── 精品模板 5:数据看板(stat_board)── 大数字 + 关键指标 ────────────────
// 每页 4 格(2×2);数据多自动分页。1 条时占满宽。
function renderStatBoard(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const PAGE = 4;
  const css = `
#title{position:absolute;top:160px;left:80px;right:80px;text-align:center;font-size:62px;font-weight:900;color:${spec.brandColor}}
#subtitle{position:absolute;top:270px;left:80px;right:80px;text-align:center;font-size:30px;color:#848e9c;letter-spacing:8px}
#grid-area{position:absolute;top:400px;left:60px;right:60px;bottom:140px}
.page{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:34px;align-content:start}
.cell{border-radius:32px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:56px 36px;text-align:center;min-height:340px;display:flex;flex-direction:column;justify-content:center;align-items:center}
.cell .lbl{font-size:30px;color:#848e9c;font-weight:700;letter-spacing:2px}
.cell .num{font-size:118px;font-weight:900;color:${accent};line-height:1.05;margin-top:20px;text-shadow:0 4px 20px ${accent}30}
.cell .sub{font-size:26px;color:#c7ccd4;margin-top:14px;line-height:1.4}
.cell.full{grid-column:span 2;min-height:200px}
.cell.full .num{font-size:96px}
`;
  const slots = paginate(spec.items, PAGE, spec.durationSec, spec.pageTimings);
  const pages = slots.map((slot) => {
    const cells = slot.items.map((it, i) => {
      const start = slot.pageStartSec + 0.2 + i * 0.15;
      const parsed = parseNumeric(it.value);
      const fullCls = slot.items.length === 1 ? ' full' : '';
      let numNode: string;
      if (parsed) {
        const signedPrefix = it.value && it.value.startsWith('-') ? '-' : parsed.prefix;
        numNode = `<div class="num" data-anim="fade" data-start="${start.toFixed(2)}" data-duration="0.8" data-count-from="0" data-count-to="${parsed.num}" data-count-decimals="${parsed.decimals}" data-count-prefix="${signedPrefix}" data-count-suffix="${esc(parsed.suffix)}">${esc(parsed.prefix + parsed.num.toFixed(parsed.decimals) + parsed.suffix)}</div>`;
      } else {
        numNode = `<div class="num" data-anim="fade-up" data-start="${start.toFixed(2)}" data-duration="0.6">${esc(it.value || it.name)}</div>`;
      }
      return `<div class="cell${fullCls}" data-anim="rise" data-start="${start.toFixed(2)}" data-duration="0.6">
        <div class="lbl">${esc(it.name)}</div>
        ${numNode}
        ${it.sub ? `<div class="sub">${esc(it.sub)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="page" ${pageDataAttrs(slot)}>${cells}</div>`;
  }).join('');
  const body = `<div id="title" data-anim="fade-up" data-start="0" data-duration="0.6">${esc(spec.title || '数据看板')}</div>
    ${spec.subtitle ? `<div id="subtitle" data-anim="fade" data-start="0.15" data-duration="0.6">${esc(spec.subtitle)}</div>` : ''}
    <div id="grid-area">${pages}</div>`;
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
