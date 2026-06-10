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
import { renderTemplate, type TemplateSpec } from './templateLibrary';
import { renderHtmlToVideo, resolveHeadlessBrowser } from './htmlVideoRenderer';
import { synthesize, getLastTtsError, getVoiceFallbacks } from './tts';
import { getTtsVoice } from './config';
import type { CaptionCue } from './templateAnim';

const TEMPLATE_STEPS = [
  { key: 'data', label: '生成动效数据' },
  { key: 'voice', label: '生成 AI 配音' },     // narration off 时仍存在,但秒过
  { key: 'render', label: '渲染 + 编码合成' },
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

  try {
    // ── STEP 1:AI 产数据 + 可选口播稿 ──────────────────────────────────
    throwIfAborted(signal);
    tracker.start('data', `输出目录:${taskDir}`);
    const lang = detectTemplateLang(`${tpl.dataText} ${tpl.title || ''}`);
    const wantNarration = tpl.narration === true;
    const vcfg = await getVideoConfig();
    const data = await generateTemplateData(
      {
        style: tpl.style,
        title: tpl.title,
        dataText: tpl.dataText,
        track: input.track,
        lang,
        needVoiceScript: wantNarration,
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
      // 字幕开关:默认 true,显式 false 时关
      if (tpl.subtitleEnabled !== false) captionCues = r.cues;
      tracker.done('voice', `✅ 配音已生成 · ${realDurationSec.toFixed(1)}s${captionCues ? ` · ${captionCues.length} 句字幕` : ''}`);
    } else {
      // 跳过这一步(UI 上仍显示但直接 done)
      tracker.done('voice', '⏭ 已跳过(未开配音)');
    }

    // ── STEP 3:渲染 + 编码合成(一步到位)────────────────────────────
    throwIfAborted(signal);
    tracker.start('render', '🎞️ 渲染 + 编码…');

    // 时长决策:有配音 → 真实音频时长 + 0.4s 尾留白;无配音 → 用户配置 / 自动估算
    const durationSec = wantNarration && realDurationSec > 0
      ? clamp(realDurationSec + 0.4, 3, 30)
      : clamp(tpl.durationSec || autoDuration(tpl.dataText), 3, 20);

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
    try { fs.rmSync(tmpAudioDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
