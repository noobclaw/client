/**
 * template-pipeline — 「模板速生」HF 派出片流水线(engine==='template')。
 *
 * v3 改动(抄 HyperFrames 核心 insight):
 *   1. **TTS 先出,HTML 跟着音频时长走**(不做 ffmpeg 拉伸对齐)
 *   2. **渲染+编码合一**(htmlVideoRenderer.renderHtmlToVideo 一步出 mp4,不落盘 PNG)
 *   3. **字幕走 HTML 内渲染**(声明式 data-caption-start/end,跟动画同引擎无对齐误差)
 *
 * 步骤:
 *   ① AI 解析 dataText → {title,subtitle,items[,voiceScript]}(narration 时同时产口播稿)
 *   ② [narration 时] edge-tts 出 wav,拿真实 durationSec + 词级 cues(短语)
 *   ③ 用真实时长 + cues 构造 TemplateSpec,渲染 HTML(含字幕轨)
 *   ④ renderHtmlToVideo:逐帧 seek + 截图 → ffmpeg stdin → 同时混 narration + BGM → 出 mp4
 *
 * 全程不落盘中间 PNG,音画对齐误差 = 0(字幕跟动画同 seek 协议)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFfmpegAvailable } from './ffmpegRuntime';
import { resolveBgmPath } from './bgm';
import {
  ProgressTracker, resolveOutputDirs, outputFileName, throwIfAborted,
  type VideoCreationInput, type VideoCreationResult, type ProgressEmitter,
} from './pipeline';
import { generateTemplateData, detectTemplateLang } from './templateHtmlWriter';
import { getVideoConfig } from './videoConfig';
import { renderTemplate, pageSizeFor, calcPageCount, calcPageRanges, type TemplateSpec } from './templateLibrary';
import { renderHtmlToVideo, resolveHeadlessBrowser } from './htmlVideoRenderer';
import { synthesize, getLastTtsError, getVoiceFallbacks } from './tts';
import { getTtsVoice } from './config';
import { chargeMode1Video, refundMode1Video } from './billing';
import type { CaptionCue } from './templateAnim';

const TEMPLATE_STEPS = [
  { key: 'data', label: '生成动效数据' },
  { key: 'voice', label: '生成 AI 配音' },     // narration off 时仍存在,但秒过
  { key: 'render', label: '渲染 + 编码合成' },
  // 跟 stock/ai pipeline 对齐:publish 步骤 —— 出片完成后发到用户勾选的平台。
  //   publishPlatforms 为空时秒过,日志推「📂 未选发布平台 · 仅存本地」。
  { key: 'publish', label: '发布到各大平台' },
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 没给时长时按数据行数估个合理时长(标题 2s + 每行约 0.9s),clamp[4,14]。 */
function autoDuration(dataText: string): number {
  const rows = (dataText || '').split(/\r?\n/).filter((s) => s.trim()).length;
  return clamp(Math.round(2 + rows * 0.9), 4, 14);
}

/** edge-tts 的 cue(相对本句起点) → templateAnim 的 CaptionCue(秒,相对成片起点)。 */
function ttsCuesToCaption(cues: { text: string; start: number; end: number }[] | undefined): CaptionCue[] | undefined {
  if (!cues || cues.length === 0) return undefined;
  return cues.map((c) => ({
    text: c.text,
    startSec: Math.max(0, c.start),
    endSec: Math.max(c.start + 0.05, c.end),
  }));
}

/** 抠净文案给 TTS:去 emoji + 多余空白(不动中文标点;edge-tts 自己处理停顿)。 */
function cleanForTts(s: string): string {
  return (s || '')
    .replace(/[☀-➿\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跑一次 TTS(带 voice fallback 链),返回 audio + 时长 + cues 或 null。 */
async function ttsWithFallback(
  text: string, primary: string, outPath: string, rate?: number,
): Promise<{ audioPath: string; durationSec: number; cues?: CaptionCue[]; voice: string } | null> {
  const chain = getVoiceFallbacks(primary);
  for (const v of chain) {
    const r = await synthesize(text, outPath, v, rate);
    if (r.ok && r.synthesized) {
      return {
        audioPath: r.audioPath,
        durationSec: r.durationSec,
        cues: ttsCuesToCaption(r.cues),
        voice: v,
      };
    }
  }
  return null;
}

export async function runTemplatePipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  const jobId = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit, TEMPLATE_STEPS);

  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }
  if (!resolveHeadlessBrowser()) {
    const err = '未检测到 Chrome / Edge。模板速生需要其一来渲染画面(Windows 自带 Edge 即可,请确认未被卸载)。';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }
  const tpl = input.template;
  if (!tpl || !(tpl.dataText || '').trim()) {
    const err = '请先填写榜单/要点内容(模板速生靠这些内容生成画面)。';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }

  const { taskDir, runDir: destDir } = resolveOutputDirs(input);
  tracker.setOutputDir(taskDir);
  const tmpAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-tpl-audio-'));
  const narrationPath = path.join(tmpAudioDir, 'narration.mp3');

  // 平台基础费(预扣);失败时 refund。对齐 stock 模式定价口径,口径在 billing.chargeMode1Video。
  let chargeId: string | undefined;
  let refundOnExit = false;

  try {
    // ── STEP 1:AI 产数据 + 可选口播稿(分段以便音画同步)──────────────
    throwIfAborted(signal);
    tracker.start('data', `输出目录:${taskDir}`);
    const lang = detectTemplateLang(`${tpl.dataText} ${tpl.title || ''}`);
    const wantNarration = tpl.narration === true;
    const vcfg = await getVideoConfig();
    // 估算 items 数量(就是 dataText 的非空行数,clamp 到模板上限 12),
    // 算 pageMeta 用 —— 让 AI 知道画面分几页、每页几条,据此分段输出 voiceSegments。
    const estItemCount = Math.min(12, Math.max(1,
      (tpl.dataText || '').split(/\r?\n/).filter((l) => l.trim()).length || 1));
    const pageSize = pageSizeFor(tpl.style);
    const estPageCount = calcPageCount(estItemCount, pageSize);
    const pageRanges = calcPageRanges(estItemCount, pageSize);
    const data = await generateTemplateData(
      {
        style: tpl.style,
        title: tpl.title,
        dataText: tpl.dataText,
        // 模板速生不再用 track —— 它对 AI 排版/口播稿都没指导意义(2026-06-12 删字段);
        // 编辑老任务时 input.track 可能还在,但生成不参考。
        lang,
        needVoiceScript: wantNarration,
        // 开了配音才传 pageMeta(让 AI 按页切分 voiceSegments);纯视觉不需要
        pageMeta: wantNarration ? { pageCount: estPageCount, pageRanges } : undefined,
      },
      // 服务端可调 prompt(只覆盖纯数据版;needVoiceScript 时仍用本地的强约束版,避免改坏)
      wantNarration ? undefined : vcfg.templateDataSystemPrompt,
    );
    tracker.addTokens(data.tokens, data.costUsd);
    tracker.done('data', data.source === 'ai' ? '✅ AI 已整理数据 · 精品模板' : '✅ 数据已整理 · 精品模板');

    // ── STEP 2:配音(开了才跑;关了直接跳过)──────────────────────────
    throwIfAborted(signal);
    let realNarrationPath: string | undefined;
    let realDurationSec = 0;
    let captionCues: CaptionCue[] | undefined;
    if (wantNarration) {
      tracker.start('voice', '🎤 正在合成配音…');
      const script = cleanForTts(tpl.voiceScript || data.voiceScript || '');
      if (!script) {
        tracker.fail('voice', '配音稿为空(AI 产稿失败,且未填自定义口播稿)');
        return { ok: false, error: '配音稿为空,请关闭配音或填写自定义口播稿' };
      }
      const voice = tpl.voice || input.voice || getTtsVoice();
      const rate = typeof tpl.voiceRate === 'number' ? tpl.voiceRate
        : typeof input.voiceRate === 'number' ? input.voiceRate : 0;
      const r = await ttsWithFallback(script, voice, narrationPath, rate);
      if (!r) {
        const why = getLastTtsError() || '请稍后再试';
        tracker.fail('voice', `配音失败:${why}`);
        return { ok: false, error: `配音失败:${why}` };
      }
      realNarrationPath = r.audioPath;
      realDurationSec = r.durationSec;
      // 荒谬值护栏:>10 分钟判 TTS 异常(正常口播 800 字 AI 稿 ≈ 3 分钟;用户自定义长稿
      //   也到不了这)。重点是【显式失败】而不是默默截断 —— 任何"砍音频凑上限"都会交付
      //   念一半戛然而止的废片(2026-06-11 的 60s clamp 截断事故就是这么来的)。
      //   此时平台基础费还没预扣(charge 在渲染前才调),直接 return 即可,与配音失败同路径。
      if (realDurationSec > 600) {
        const err = `配音时长异常(${Math.round(realDurationSec)}s > 600s 上限),疑似 TTS 异常或口播稿过长。请缩短稿子后重试。`;
        tracker.fail('voice', err);
        return { ok: false, error: err };
      }
      // 字幕开关:默认 true,显式 false 时关
      if (tpl.subtitleEnabled !== false) captionCues = r.cues;
      // 把口播稿存一份到任务目录(对齐 stock pipeline 的「文案.txt」)。失败不阻塞出片 ——
      //   只是供用户事后查看 / 复用稿子。voiceSegments 有就一并列出,标明每段对应哪一页画面。
      try {
        const segs = data.voiceSegments;
        const lines: string[] = [
          `📝 模板速生口播稿(共 ${script.length} 字 / 配音时长 ${realDurationSec.toFixed(1)}s)`,
          '',
          script,
        ];
        if (Array.isArray(segs) && segs.length > 0) {
          lines.push('', `── 分页朗读分段(共 ${segs.length} 页) ──`);
          segs.forEach((s, i) => lines.push(`[第 ${i + 1} 页] ${s}`));
        }
        fs.writeFileSync(path.join(destDir, '文案.txt'), lines.join('\n'), 'utf8');
      } catch { /* 写文案 txt 失败不影响出片 */ }
      tracker.done('voice', `✅ 配音已生成 · ${realDurationSec.toFixed(1)}s${captionCues ? ` · ${captionCues.length} 句字幕` : ''}`);
    } else {
      // 跳过这一步(UI 上仍显示但直接 done)
      tracker.done('voice', '⏭ 已跳过(未开配音)');
    }

    // ── STEP 3:渲染 + 编码合成(一步到位)────────────────────────────
    throwIfAborted(signal);
    tracker.start('render', '🎞️ 渲染 + 编码…');

    // 时长决策:
    //   · 有配音 → 真实音频时长 + 0.4s 尾留白,**不设上限**。配音是真理源,视频必须跟完
    //     整段音频 —— 任何"砍到上限"都会交付念一半戛然而止的废片(60s clamp 时代
    //     2026-06-11 实测截断)。荒谬值(>600s)已在 STEP 2 TTS 之后显式 fail,
    //     走到这里的时长一定是合法的,只兜个 3s 下限防 0/负值。
    //   · 无配音 → 用户配置 / 自动估算(clamp[3, 20])
    const durationSec = wantNarration && realDurationSec > 0
      ? Math.max(3, realDurationSec + 0.4)
      : clamp(tpl.durationSec || autoDuration(tpl.dataText), 3, 20);

    // 平台基础费预扣(对齐 stock 模式定价口径,单条约 $0.09~$0.18,服务端权威值)。
    // 在 AI 数据/配音已经实扣 token 之后、渲染【真起 ffmpeg】之前调:
    //   · 失败 → return + 不渲染(AI 部分已实扣无法退,与 stock 同行为)
    //   · 渲染失败 → catch 里 refundMode1Video 退回这笔(幂等)
    //   · videoCount=1(模板速生当前只出 1 条),aiCostUsd=本次 AI 已扣总额
    const charge = await chargeMode1Video(durationSec, { videoCount: 1, aiCostUsd: data.costUsd });
    if (!charge.ok) {
      let err: string;
      if (charge.reason === 'insufficient') err = '余额不足,无法生成(需先预扣平台基础费,请充值后重试)';
      else if (charge.reason === 'no_auth') err = '未登录 NoobClaw,无法生成';
      else err = '平台基础费预扣失败,请稍后重试';
      tracker.fail('render', err);
      return { ok: false, error: err };
    }
    chargeId = charge.chargeId;
    refundOnExit = true;
    tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);
    tracker.progress(`💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}），失败将自动退回`);

    // ── 音画同步:由 voiceSegments + 真实音频时长反算每页时间窗 ──
    //
    // 原理:edge-tts 朗读速度恒定 → 段字符数比例 ≈ 段时间比例。我们把 AI 切好的
    // voiceSegments(每段对应一页画面)按字符长度比例分配真实音频时长,得到每页
    // 的 [startSec, durSec],传给 templateLibrary 替代均分,实现配音念到第 N 段
    // 时画面正好在第 N 页。
    //
    // 触发条件(任一不满足就 fallback 到均分):
    //   1) 开了配音,且 TTS 成功(realDurationSec > 0)
    //   2) AI 返回了 voiceSegments(且长度等于实际 items 分页后的页数)
    //   3) 实际 items 的分页页数 == AI 给的 segments 数量
    const actualPageSize = pageSizeFor(tpl.style);
    const actualPageCount = calcPageCount(data.items.length, actualPageSize);
    let pageTimings: Array<{ startSec: number; durSec: number }> | undefined;
    if (wantNarration && realDurationSec > 0 && data.voiceSegments && data.voiceSegments.length === actualPageCount) {
      const segs = data.voiceSegments;
      const totalChars = segs.reduce((s, x) => s + x.length, 0);
      if (totalChars > 0) {
        // 留 0.3s 入场 + 0.3s 尾留白(跟 paginate 兜底分支同口径)
        const usable = Math.max(2.0, realDurationSec - 0.6);
        let cursor = 0.3;
        pageTimings = segs.map((seg) => {
          const dur = (seg.length / totalChars) * usable;
          const startSec = cursor;
          cursor += dur;
          return { startSec, durSec: dur };
        });
        tracker.progress(`🎬 音画同步就绪 · ${actualPageCount} 页配上 ${segs.length} 段配音`);
      }
    } else if (wantNarration && actualPageCount > 1) {
      // 开了配音但 segments 没拿到/对不上 → 提示用户后会走均分,画面跟配音不严格对齐
      tracker.progress(`⚠️ AI 未按页切分配音,画面将按时长均分(${actualPageCount} 页 × ${(durationSec / actualPageCount).toFixed(1)}s)`);
    }

    const spec: TemplateSpec = {
      style: tpl.style,
      title: data.title || tpl.title,
      subtitle: data.subtitle,
      items: data.items,
      brandColor: /^#[0-9a-f]{6}$/i.test(tpl.brandColor || '') ? tpl.brandColor! : '#f0b90b',
      accentColor: tpl.accentColor,
      durationSec,
      fps: tpl.fps && tpl.fps > 0 ? tpl.fps : 30,
      captions: captionCues,
      pageTimings,
    };
    const html = renderTemplate(spec);
    try { fs.writeFileSync(path.join(destDir, '模板.html'), html, 'utf8'); } catch { /* non-fatal */ }

    // BGM 解析(本地 / 内置 / 云端;失败兜底为无 BGM,绝不阻塞出片)
    const bgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m)).catch(() => undefined);

    const outPath = path.join(destDir, outputFileName(0));
    // 渲染进度:每秒推一次,避免 ffmpeg 编码阶段假死
    let lastPush = 0;
    await renderHtmlToVideo({
      html,
      width: 1080, height: 1920,
      fps: spec.fps, durationSec: spec.durationSec,
      outPath,
      narrationPath: realNarrationPath,
      narrationVolume: 1.0,
      bgmPath: bgm,
      bgmVolume: typeof input.bgmVolume === 'number' ? input.bgmVolume : 0.18,
      signal,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - lastPush < 700 && done !== total) return;
        lastPush = now;
        tracker.progress(`🎞️ 渲染 ${done}/${total} 帧`);
      },
    });

    tracker.progress(`✅ 已生成 ${path.basename(outPath)}`);
    // 结尾把【本次实际写片的目录】绝对路径推一条 —— 渲染端 renderVideoLog 会自动把含 NoobClaw
    // 的路径转成可点击 button(点一下用 Finder/资源管理器打开),跟 stock 模式日志末尾的口径一致。
    tracker.progress(`📂 输出目录:${destDir}`);
    // 渲染编码成功 = 不再退款(用户拿到了成片,平台费名正言顺收下)
    refundOnExit = false;

    // ── Step 4: 发布到各大平台(同 stock/ai pipeline 口径) ──────────────────
    // 视觉/口播稿 都已经稳了,放心调 publisher。未登录的平台自动跳过,日志会说明。
    tracker.start('publish');
    const wantPublish = Array.isArray(input.publishPlatforms) && input.publishPlatforms.length > 0;
    try {
      const { resolvePublishCaption } = require('./publishCaptionWriter');
      const titleHint = tpl.title || (tpl.dataText || '').split(/\r?\n/).filter(Boolean)[0]?.slice(0, 40);
      // 平台发布文案:AI 据 voiceScript/dataText 写钩人文案(不再把口播稿/榜单原样当 caption)。
      const cap = await resolvePublishCaption({
        wantPublish,
        summary: tpl.voiceScript || tpl.dataText || titleHint || '',
        title: titleHint,
        keywords: [],
        track: input.track,
        lang,
        userTitle: input.publishTitle,
        userCaption: input.publishCaption,
        userTags: input.hashtags,
        onLog: (m: string) => tracker.progress(m),
        onCost: (tk: number, usd: number) => tracker.addTokens(tk, usd),
      });
      const { runPublishStep } = require('./publishers/runPublish');
      await runPublishStep({
        platforms: Array.isArray(input.publishPlatforms) ? input.publishPlatforms : [],
        videoPath: outPath,
        title: cap.title,
        description: cap.description,
        tags: cap.tags,
        onLog: (msg: string) => tracker.progress(msg),
        signal,
      });
    } catch (e) {
      tracker.progress(`⚠️ 发布步骤异常:${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    tracker.finish(outPath, 1);
    return { ok: true, outputPath: outPath, outputPaths: [outPath] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('VIDEO_ABORTED') || msg === 'aborted') {
      return { ok: false, error: '已停止', aborted: true };
    }
    tracker.fail(null, msg);
    return { ok: false, error: msg };
  } finally {
    // 平台基础费失败退款(成片失败时;成功路径走完 refundOnExit=false 不退)。幂等,失败仅记日志。
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded
          ? '↩️ 成片失败，已退回预扣的平台基础费'
          : '⚠️ 成片失败，平台基础费退回请求未成功（稍后可联系客服核对）');
      } catch { /* 退款失败不抛,仅日志 */ }
    }
    try { fs.rmSync(tmpAudioDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
