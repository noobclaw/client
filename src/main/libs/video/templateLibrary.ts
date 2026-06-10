/**
 * templateLibrary — 「模板速生」v2 的精品模板库(抄 Remotion/HyperFrames 的成熟范式)。
 *
 * 关键转变:v1 让 AI 从零现编整段 HTML(质量参差不稳);v2 改成【人工精品参数化模板 +
 * AI 只填结构化数据】—— AI 产 TemplateSpec(标题/条目/数值),这里把数据注入精心写好的
 * 模板,出确定性、稳定、高质量的动效 HTML。模板仍导出 window.renderFrame(t) 纯函数 +
 * window.DURATION,被 htmlVideoRenderer 逐帧渲染。
 *
 * 模板内置【字幕区】:spec.captions(配音后由 whisper 产的时间轴)非空时,renderFrame 里
 * 按当前帧时间显示当前句字幕(v2-B 音画块填充 captions;无配音时字幕区隐藏)。
 */

import type { TemplateStyle } from './templateHtmlWriter';

export interface TemplateItem {
  rank?: number;     // 名次(榜单/盘点)
  name: string;      // 主文字
  value?: string;    // 数值(如 "+18.96%" / "1.2亿")
  sub?: string;      // 副文字(英文名/说明)
}

export interface TemplateCaption {
  text: string;
  startMs: number;
  endMs: number;
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
  captions?: TemplateCaption[]; // 音画块填:句级字幕时间轴
}

const SAFE_FONT = "'Microsoft YaHei','PingFang SC','Hiragino Sans GB','Segoe UI',sans-serif";

/** 所有模板共享的 CSS reset + 字幕区样式。 */
function baseCss(brand: string): string {
  return `
*{margin:0;padding:0;box-sizing:border-box;font-family:${SAFE_FONT};-webkit-font-smoothing:antialiased}
html,body{width:1080px;height:1920px;overflow:hidden;background:#0b0e11;color:#fff}
#stage{width:1080px;height:1920px;position:relative;background:radial-gradient(120% 60% at 50% 0%,#1c2026 0%,#0b0e11 55%)}
.bg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:60px 60px;pointer-events:none}
.bg-glow{position:absolute;width:1000px;height:1000px;border-radius:50%;left:40px;top:-280px;filter:blur(50px);background:radial-gradient(circle,${brand}33,transparent 70%);pointer-events:none}
#caption{position:absolute;left:60px;right:60px;bottom:150px;text-align:center;font-size:46px;font-weight:800;line-height:1.3;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,0.9),0 0 2px #000;opacity:0}
#watermark{position:absolute;bottom:70px;width:100%;text-align:center;font-size:26px;color:#5e6673;letter-spacing:2px}
`;
}

/** 共享:字幕高亮 JS(句级;captions 为空则隐藏字幕区)。注入到每个模板的 <script>。 */
const CAPTION_JS = `
function renderCaption(t){
  var el=document.getElementById('caption'); if(!el) return;
  var caps=(window.SPEC&&window.SPEC.captions)||[];
  if(!caps.length){el.style.opacity=0;return;}
  var ms=t/(window.FPS||30)*1000, cur=null;
  for(var i=0;i<caps.length;i++){ if(ms>=caps[i].startMs && ms<caps[i].endMs){cur=caps[i];break;} }
  if(!cur){el.style.opacity=0;return;}
  if(el.textContent!==cur.text) el.textContent=cur.text;
  el.style.opacity=1;
}
`;

const ease = `function ease(x){return 1-Math.pow(1-x,3);}`; // easeOutCubic
const easeBack = `function easeBack(x){var c=1.70158;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2);}`;

function esc(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** 把 spec + body + renderFrame 体拼成完整 HTML 文档。 */
function wrapHtml(spec: TemplateSpec, bodyHtml: string, css: string, frameBodyJs: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(spec.brandColor)}${css}</style></head>
<body><div id="stage">
<div class="bg-grid"></div><div class="bg-glow"></div>
${bodyHtml}
<div id="caption"></div>
<div id="watermark">NoobClaw · 自动生成</div>
</div>
<script>
window.SPEC=${JSON.stringify(spec)};
window.FPS=${spec.fps};
window.DURATION=${spec.durationSec};
${ease}${easeBack}${CAPTION_JS}
window.renderFrame=function(t){
${frameBodyJs}
renderCaption(t);
};
window.renderFrame(0);
</script></body></html>`;
}

// ── 精品模板:排行榜 / 榜单(rank_list)─────────────────────────────────
function renderRankList(spec: TemplateSpec): string {
  const accent = spec.accentColor || '#0ecb81';
  const css = `
#title{position:absolute;top:170px;left:80px;right:80px;text-align:center}
#title .t1{font-size:78px;font-weight:900;color:${spec.brandColor};letter-spacing:1px;text-shadow:0 6px 24px ${spec.brandColor}40}
#title .t2{font-size:34px;color:#848e9c;margin-top:18px;letter-spacing:8px;font-weight:600}
#list{position:absolute;top:440px;left:70px;right:70px}
.row{height:178px;margin-bottom:26px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);display:flex;align-items:center;padding:0 46px;position:relative;overflow:hidden;transform-origin:center}
.row .bar{position:absolute;left:0;top:0;bottom:0;width:8px;background:${spec.brandColor};opacity:0.9}
.rank{width:104px;display:flex;align-items:center;justify-content:center}
.rank b{display:inline-flex;align-items:center;justify-content:center;width:74px;height:74px;border-radius:50%;background:${spec.brandColor}1a;border:2px solid ${spec.brandColor};color:${spec.brandColor};font-size:42px;font-weight:900}
.coin{flex:1;min-width:0;padding-left:8px}
.coin .nm{font-size:54px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.coin .sb{font-size:28px;color:#848e9c;margin-top:6px}
.val{font-size:62px;font-weight:900;text-align:right;white-space:nowrap}
`;
  const rows = spec.items.slice(0, 6).map((it, i) => {
    const r = it.rank ?? (i + 1);
    return `<div class="row" data-i="${i}"><div class="bar"></div>`
      + `<div class="rank"><b>${r}</b></div>`
      + `<div class="coin"><div class="nm">${esc(it.name)}</div>${it.sub ? `<div class="sb">${esc(it.sub)}</div>` : ''}</div>`
      + `<div class="val" data-v="${esc(it.value || '')}"></div></div>`;
  }).join('');
  const body = `<div id="title"><div class="t1">${esc(spec.title || '榜单速览')}</div>${spec.subtitle ? `<div class="t2">${esc(spec.subtitle)}</div>` : ''}</div><div id="list">${rows}</div>`;
  const frameJs = `
var tt=Math.min(1,t/0.6), ti=document.getElementById('title');
ti.style.opacity=ease(tt); ti.style.transform='translateY('+((1-ease(tt))*-40)+'px)';
var rows=document.querySelectorAll('.row');
for(var i=0;i<rows.length;i++){
  var start=0.5+i*0.16, p=Math.max(0,Math.min(1,(t-start)/0.7)), e=ease(p);
  var row=rows[i];
  row.style.opacity=e;
  row.style.transform='translateX('+((1-e)*760)+'px)';
  var raw=row.querySelector('.val').getAttribute('data-v'), m=raw&&raw.match(/-?\\d+(?:\\.\\d+)?/);
  var vEl=row.querySelector('.val');
  if(m){
    var n=parseFloat(m[0]), suffix=/%/.test(raw)?'%':raw.replace(m[0],'').trim();
    var sign=(n>0&&/^\\s*\\+/.test(raw))?'+':'';
    var dec=/\\./.test(raw)?2:0;
    vEl.textContent=sign+(n*e).toFixed(dec)+suffix;
    vEl.style.color=(n>0)?'${accent}':(n<0)?'#f6465d':'#eaecef';
  } else { vEl.textContent=raw||''; vEl.style.color='#eaecef'; }
}
`;
  return wrapHtml(spec, body, css, frameJs);
}

// ── 精品模板:金句 / 语录(quote)──────────────────────────────────────
function renderQuote(spec: TemplateSpec): string {
  const quote = spec.items[0]?.name || spec.title || '';
  const author = spec.items[0]?.sub || spec.subtitle || '';
  const css = `
#quote{position:absolute;left:110px;right:110px;top:50%;transform:translateY(-50%);text-align:center}
#quote .mark{font-size:200px;line-height:0.6;color:${spec.brandColor};opacity:0.35;font-family:Georgia,serif}
#quote .q{font-size:72px;font-weight:800;line-height:1.5;margin-top:30px}
#quote .a{font-size:36px;color:#848e9c;margin-top:50px;letter-spacing:2px}
`;
  const body = `<div id="quote"><div class="mark">"</div><div class="q">${esc(quote)}</div>${author ? `<div class="a">— ${esc(author)}</div>` : ''}</div>`;
  const frameJs = `
var q=document.getElementById('quote');
var p=Math.min(1,t/0.9), e=ease(p);
q.style.opacity=e;
q.style.transform='translateY(-50%) scale('+(0.94+0.06*e)+')';
`;
  return wrapHtml(spec, body, css, frameJs);
}

// ── 通用兜底模板:要点卡片(news_cards / stat_board / countdown 暂用)───────
function renderGenericCards(spec: TemplateSpec): string {
  const accent = spec.accentColor || spec.brandColor;
  const css = `
#title{position:absolute;top:180px;left:80px;right:80px;text-align:center;font-size:72px;font-weight:900;color:${spec.brandColor}}
#cards{position:absolute;top:440px;left:80px;right:80px}
.card{margin-bottom:34px;border-radius:28px;background:linear-gradient(135deg,#181b21,#1f2329);border:1px solid #2b2f36;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:42px 48px}
.card .h{font-size:50px;font-weight:800;color:${accent}}
.card .b{font-size:38px;color:#c7ccd4;margin-top:16px;line-height:1.45}
.card .v{font-size:64px;font-weight:900;color:${accent};margin-top:10px}
`;
  const cards = spec.items.slice(0, 4).map((it, i) =>
    `<div class="card" data-i="${i}"><div class="h">${esc(it.name)}</div>${it.value ? `<div class="v">${esc(it.value)}</div>` : ''}${it.sub ? `<div class="b">${esc(it.sub)}</div>` : ''}</div>`,
  ).join('');
  const body = `<div id="title">${esc(spec.title || '')}</div><div id="cards">${cards}</div>`;
  const frameJs = `
var tt=Math.min(1,t/0.6), ti=document.getElementById('title');
ti.style.opacity=ease(tt);
var cards=document.querySelectorAll('.card');
for(var i=0;i<cards.length;i++){
  var start=0.5+i*0.2, p=Math.max(0,Math.min(1,(t-start)/0.7)), e=ease(p);
  cards[i].style.opacity=e;
  cards[i].style.transform='translateY('+((1-e)*60)+'px) scale('+(0.96+0.04*e)+')';
}
`;
  return wrapHtml(spec, body, css, frameJs);
}

/** 按 style 渲染精品模板 → 完整 HTML。未单独精修的 style 走通用精品兜底。 */
export function renderTemplate(spec: TemplateSpec): string {
  switch (spec.style) {
    case 'rank_list':
    case 'countdown':
      return renderRankList(spec);
    case 'quote':
      return renderQuote(spec);
    case 'news_cards':
    case 'stat_board':
    default:
      return renderGenericCards(spec);
  }
}
