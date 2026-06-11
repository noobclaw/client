/**
 * templateAnim — 「模板速生」HF 派的【声明式 paused timeline】核心协议。
 *
 * 这是抄 HyperFrames 思维框架的产物 —— HTML 元素自带 `data-start` / `data-duration` /
 * `data-anim` 属性声明动画,渲染时引擎调 `window.__nbc.seek(t)` 把整张画面 seek 到
 * 时间 t,**完全确定性、无壁钟、无 setInterval / requestAnimationFrame、可任意倒带**。
 *
 * 为什么不直接引 GSAP:① 离线渲染下我们把网络封死了,GSAP 要 inline 或 bundle 一份
 * ~80KB;② 我们的动画类型不多(fade / fade-up / scale-in / count-up / wipe / pop),
 * 自己写一份 ~120 行的极简 seek 函数比集成 GSAP 简单稳。LLM 也更好懂 —— 只需要会写
 * `data-start` 数字,不需要懂 GSAP API。
 *
 * 协议:
 *   1. 元素属性:`data-start`(秒)、`data-duration`(秒,默认 0.6)、
 *      `data-anim`(动画名,默认 'fade')、`data-ease`(可选,默认 'cubic')
 *   2. 字幕节点:`data-caption-start`、`data-caption-end`(秒)+ 时间窗口内 display
 *   3. 计数器节点:`data-count-from`、`data-count-to`、`data-count-decimals`、
 *      `data-count-prefix`、`data-count-suffix`(可选)—— 配 `data-anim="count-up"` 用
 *   4. 全局:`window.__nbc.seek(t)` 接 seek;`window.DURATION` 暴露总时长(供引擎读);
 *      `window.__nbc.ready=true` 表示协议就绪,引擎据此判等就位
 *
 * 没碰 GSAP,不引外网,纯 vanilla JS + CSS transform/opacity。
 */

/** 共用字体(覆盖中/日/韩 + Latin)。 */
export const SAFE_FONT = "'Microsoft YaHei','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Segoe UI',sans-serif";

/**
 * 全模板共享的 base CSS。各模板 CSS 只写自己的布局/颜色,不重复 reset / background。
 */
export function templateBaseCss(brandColor: string): string {
  return `
*{margin:0;padding:0;box-sizing:border-box;font-family:${SAFE_FONT};-webkit-font-smoothing:antialiased}
html,body{width:1080px;height:1920px;overflow:hidden;background:#0b0e11;color:#fff}
#stage{width:1080px;height:1920px;position:relative;background:radial-gradient(120% 60% at 50% 0%,#1c2026 0%,#0b0e11 55%)}
.bg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px);background-size:60px 60px;pointer-events:none}
.bg-glow{position:absolute;width:1000px;height:1000px;border-radius:50%;left:40px;top:-280px;filter:blur(50px);background:radial-gradient(circle,${brandColor}33,transparent 70%);pointer-events:none}
#caption-track{position:absolute;left:60px;right:60px;bottom:60px;text-align:center;font-size:42px;font-weight:800;line-height:1.25;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,0.9),0 0 2px #000;pointer-events:none}
#caption-track .cap{display:inline-block;padding:10px 22px;border-radius:12px;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px)}
/* 字幕开启时给主内容区让出底部安全区,避免字幕跟列表/网格末尾重叠把最后一条遮住。
   各模板默认 bottom 140 是为没字幕时贴底用的,有字幕时整体上抬 ~60-80px。 */
.has-caption #list-area,.has-caption #grid-area,.has-caption #quote-area{bottom:220px}
#watermark{position:absolute;bottom:70px;width:100%;text-align:center;font-size:24px;color:#5e6673;letter-spacing:2px;pointer-events:none}
[data-anim]{will-change:opacity,transform}
`;
}

/**
 * 协议运行时:把这段 JS 内嵌到每个模板 HTML 末尾。给 window 上挂 `__nbc.seek(t)`。
 *
 * seek(t) 做的事:
 *   · 扫每个 `[data-anim]` 元素,按 progress 应用 opacity + transform
 *   · 扫每个 `[data-caption-start]` 元素,按时间窗显示当前一句字幕
 *   · 扫每个 `[data-count-from]` 元素,按 progress 插值数值并改 textContent
 *
 * 严格遵守 HF 硬规则:
 *   · 无 setInterval / setTimeout / requestAnimationFrame / Math.random / Date.now
 *   · seek(t) 同步、纯函数:同一 t 调多少次结果都相同(确定性)
 */
export const NBC_RUNTIME_JS = `(function(){
  function clamp(x,lo,hi){return x<lo?lo:x>hi?hi:x;}
  // 缓动函数:cubic(easeOutCubic) / linear / back(easeOutBack) / quad(easeOutQuad)
  function ease(p,kind){
    if(kind==='linear') return p;
    if(kind==='back'){var c=1.70158;return 1+(c+1)*Math.pow(p-1,3)+c*Math.pow(p-1,2);}
    if(kind==='quad') return 1-Math.pow(1-p,2);
    return 1-Math.pow(1-p,3); // cubic 默认
  }
  // 单个 [data-anim] 元素:按 progress 算 opacity + transform
  function applyAnim(el,p,kind,easeKind){
    var e = ease(p, easeKind);
    var op = e, tx = '';
    switch(kind){
      case 'fade': op = e; break;
      case 'fade-up': op = e; tx = 'translateY('+((1-e)*60)+'px)'; break;
      case 'fade-down': op = e; tx = 'translateY('+((1-e)*-60)+'px)'; break;
      case 'fade-left': op = e; tx = 'translateX('+((1-e)*60)+'px)'; break;
      case 'fade-right': op = e; tx = 'translateX('+((1-e)*-60)+'px)'; break;
      case 'slide-in-right': op = e; tx = 'translateX('+((1-e)*760)+'px)'; break;
      case 'slide-in-left': op = e; tx = 'translateX('+((1-e)*-760)+'px)'; break;
      case 'scale-in': op = e; tx = 'scale('+(0.85+0.15*e)+')'; break;
      case 'pop': op = e; tx = 'scale('+(0.6+0.4*e)+')'; break;
      case 'wipe-right': op = 1; el.style.clipPath = 'inset(0 '+((1-e)*100)+'% 0 0)'; break;
      case 'wipe-left':  op = 1; el.style.clipPath = 'inset(0 0 0 '+((1-e)*100)+'%)'; break;
      case 'rise': op = e; tx = 'translateY('+((1-e)*120)+'px) scale('+(0.94+0.06*e)+')'; break;
      default: op = e;
    }
    el.style.opacity = op;
    if(tx) el.style.transform = tx;
  }
  // 计数器:[data-count-from] [data-count-to] [data-count-decimals] [data-count-prefix] [data-count-suffix]
  function applyCount(el,p,easeKind){
    var e = ease(p, easeKind);
    var from = parseFloat(el.getAttribute('data-count-from'))||0;
    var to = parseFloat(el.getAttribute('data-count-to'))||0;
    var dec = parseInt(el.getAttribute('data-count-decimals'))||0;
    var pre = el.getAttribute('data-count-prefix')||'';
    var suf = el.getAttribute('data-count-suffix')||'';
    var v = from + (to-from)*e;
    el.textContent = pre + v.toFixed(dec) + suf;
  }
  // 字幕节点:[data-caption-start] [data-caption-end] (单位秒)
  function applyCaption(el,t){
    var s = parseFloat(el.getAttribute('data-caption-start'))||0;
    var e = parseFloat(el.getAttribute('data-caption-end'))||0;
    var show = (t>=s && t<e);
    el.style.display = show ? '' : 'none';
  }
  var nbc = {
    ready: false,
    seek: function(t){
      if(!isFinite(t)||t<0) t = 0;
      // 1. data-anim 元素:进场动画
      var nodes = document.querySelectorAll('[data-anim]');
      for(var i=0;i<nodes.length;i++){
        var n = nodes[i];
        var start = parseFloat(n.getAttribute('data-start'))||0;
        var dur = parseFloat(n.getAttribute('data-duration'))||0.6;
        var anim = n.getAttribute('data-anim') || 'fade';
        var easeKind = n.getAttribute('data-ease') || 'cubic';
        var p = clamp((t-start)/Math.max(0.01,dur), 0, 1);
        applyAnim(n, p, anim, easeKind);
        // 内含计数器 → 同步更新数值
        if(n.hasAttribute('data-count-to')) applyCount(n, p, easeKind);
        // 退场(可选):data-exit-start + data-exit-duration(都不写就默认不退场)
        var exitStart = parseFloat(n.getAttribute('data-exit-start'));
        if(isFinite(exitStart)){
          var exitDur = parseFloat(n.getAttribute('data-exit-duration'))||0.4;
          var ep = clamp((t-exitStart)/Math.max(0.01,exitDur), 0, 1);
          if(ep > 0) n.style.opacity = (1-ease(ep, easeKind)) * (parseFloat(n.style.opacity)||1);
        }
      }
      // 2. 独立计数器节点(不带 data-anim 的)
      var counters = document.querySelectorAll('[data-count-to]:not([data-anim])');
      for(var j=0;j<counters.length;j++){
        var c = counters[j];
        var cs = parseFloat(c.getAttribute('data-start'))||0;
        var cd = parseFloat(c.getAttribute('data-duration'))||0.8;
        var ce = c.getAttribute('data-ease') || 'cubic';
        var cp = clamp((t-cs)/Math.max(0.01,cd), 0, 1);
        applyCount(c, cp, ce);
      }
      // 3. 字幕节点
      var caps = document.querySelectorAll('[data-caption-start]');
      for(var k=0;k<caps.length;k++) applyCaption(caps[k], t);
    }
  };
  window.__nbc = nbc;
  nbc.ready = true;
})();`;

/**
 * 把字幕 cues(秒级时间戳)渲染成 HTML 节点数组,塞进 #caption-track。
 * 每条 cue 一个 `<span class="cap" data-caption-start data-caption-end>` —— 协议运行时
 * 会根据 t 切换 display。这样字幕跟动画同一引擎,无对齐误差(HF 派核心 insight)。
 */
export interface CaptionCue {
  text: string;
  startSec: number;
  endSec: number;
}

export function renderCaptionTrack(cues: CaptionCue[] | undefined): string {
  if (!cues || cues.length === 0) return '';
  const items = cues.map((c) => {
    const safe = escapeHtml(c.text);
    return `<span class="cap" data-caption-start="${c.startSec.toFixed(3)}" data-caption-end="${c.endSec.toFixed(3)}" style="display:none">${safe}</span>`;
  }).join('');
  return `<div id="caption-track">${items}</div>`;
}

/** 模板专用 HTML 转义(单字符替换,够用)。 */
export function escapeHtml(s: string): string {
  if (!s) return '';
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * 把 templateLibrary 各模板产的 bodyHtml + 自有 CSS 包成完整 HTML 文档。
 *   · 自动注入 base CSS、字幕轨道、watermark
 *   · 自动注入 __nbc.seek 协议运行时
 *   · 通过 window.DURATION / window.FPS 暴露时长/帧率给引擎读
 *
 * 设计上,模板的 body / css 不需要任何 JS —— 所有动画都靠 data-* 属性 + 共享 seek 协议。
 */
export interface WrapHtmlOptions {
  bodyHtml: string;
  css: string;
  brandColor: string;
  durationSec: number;
  fps: number;
  captionCues?: CaptionCue[];
  watermark?: string;
}

export function wrapTemplateHtml(opts: WrapHtmlOptions): string {
  // 水印:默认【不显示】,要露品牌需要显式传 opts.watermark 非空。原先默认会显示 "NoobClaw"
  //   作为兜底,但用户不希望成片上有这个 logo,改为只在显式配置时才渲染。
  const watermark = opts.watermark ? `<div id="watermark">${escapeHtml(opts.watermark)}</div>` : '';
  const captionTrack = renderCaptionTrack(opts.captionCues);
  // has-caption 状态类:有字幕时给 #stage 加 class,让模板里的 #list-area / #grid-area /
  //   #quote-area 自动让出底部安全区(见 templateBaseCss 里 .has-caption 选择器)。
  //   否则 caption-track 会跟列表/网格底部重叠,字幕把最后一条数据挡住。
  const stageClass = captionTrack ? ' class="has-caption"' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${templateBaseCss(opts.brandColor)}${opts.css}</style></head>
<body><div id="stage"${stageClass}>
<div class="bg-grid"></div><div class="bg-glow"></div>
${opts.bodyHtml}
${captionTrack}
${watermark}
</div>
<script>
window.FPS=${opts.fps};
window.DURATION=${opts.durationSec};
${NBC_RUNTIME_JS}
window.__nbc.seek(0);
</script></body></html>`;
}
