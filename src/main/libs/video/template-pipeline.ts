/**
 * template-pipeline — 「模板速生」出片流水线(engine==='template')。
 *
 * 抄 HyperFrames:AI(DeepSeek)现编一个自包含动效 HTML → 无头浏览器逐帧截图 → ffmpeg
 * 编码成竖屏 mp4。画面零 AI 成本(只 DeepSeek 写 HTML 的 token),适合榜单/资讯/数据/金句。
 *
 * 与 stock/seedance 物理隔离:本文件是独立入口,经 pipeline.ts 的 runVideoPipeline 早分流
 * 调用,只复用 pipeline-common 的外壳(ProgressTracker / resolveOutputDirs / outputFileName)。
 *
 * 步骤:① 生成模板 HTML(校验+重试+兜底)② 逐帧渲染 ③ 编码(可选 BGM)。
 * 配音(template.narration)为后续迭代项(模板画面本身已含文字,首版先稳)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFfmpegAvailable, runFfmpeg } from './ffmpegRuntime';
import { resolveBgmPath } from './bgm';
import {
  ProgressTracker, resolveOutputDirs, outputFileName, throwIfAborted,
  type VideoCreationInput, type VideoCreationResult, type ProgressEmitter,
} from './pipeline';
import { generateTemplateHtml, detectTemplateLang } from './templateHtmlWriter';
import { renderHtmlToFrames, probeHtml, resolveHeadlessBrowser } from './htmlVideoRenderer';

const TEMPLATE_STEPS = [
  { key: 'html', label: '生成动效模板' },
  { key: 'render', label: '逐帧渲染画面' },
  { key: 'compose', label: '编码合成视频' },
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 没给时长时按数据行数估个合理时长(标题 2s + 每行约 0.9s),clamp[4,14]。 */
function autoDuration(dataText: string): number {
  const rows = (dataText || '').split(/\r?\n/).filter((s) => s.trim()).length;
  return clamp(Math.round(2 + rows * 0.9), 4, 14);
}

/** 编码 PNG 序列 → mp4(可选 BGM,循环铺底、按 -shortest 对齐画面时长)。 */
function buildEncodeArgs(framesDir: string, fps: number, outPath: string, bgm?: string, bgmVolume?: number): string[] {
  const inPattern = path.join(framesDir, 'frame_%04d.png');
  if (bgm) {
    const vol = typeof bgmVolume === 'number' && bgmVolume >= 0 ? bgmVolume : 0.18;
    return [
      '-y',
      '-framerate', String(fps), '-i', inPattern,
      '-stream_loop', '-1', '-i', bgm,
      '-filter_complex', `[1:a]volume=${vol}[a]`,
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-shortest', '-movflags', '+faststart',
      outPath,
    ];
  }
  return [
    '-y',
    '-framerate', String(fps), '-i', inPattern,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outPath,
  ];
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
    tracker.fail('html', err);
    return { ok: false, error: err };
  }
  if (!resolveHeadlessBrowser()) {
    const err = '未检测到 Chrome / Edge。模板速生需要其一来渲染画面(Windows 自带 Edge 即可,请确认未被卸载)。';
    tracker.fail('html', err);
    return { ok: false, error: err };
  }
  const tpl = input.template;
  if (!tpl || !(tpl.dataText || '').trim()) {
    const err = '请先填写榜单/要点内容(模板速生靠这些内容生成画面)。';
    tracker.fail('html', err);
    return { ok: false, error: err };
  }

  const { taskDir, runDir: destDir } = resolveOutputDirs(input);
  tracker.setOutputDir(taskDir);
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-tpl-frames-'));

  try {
    // STEP 1 — 生成动效 HTML(AI → 静态/动态双校验 → 重试 → 内置兜底,保证永远出片)
    throwIfAborted(signal);
    tracker.start('html', `输出目录:${taskDir}`);
    const lang = detectTemplateLang(`${tpl.dataText} ${tpl.title || ''}`);
    const durationSec = clamp(tpl.durationSec || autoDuration(tpl.dataText), 3, 20);
    const gen = await generateTemplateHtml({
      style: tpl.style,
      title: tpl.title,
      dataText: tpl.dataText,
      track: input.track,
      persona: input.persona,
      brandColor: tpl.brandColor,
      accentColor: tpl.accentColor,
      lang,
      durationSec,
    }, probeHtml);
    tracker.addTokens(gen.tokens, gen.costUsd);
    try { fs.writeFileSync(path.join(destDir, '模板.html'), gen.html, 'utf8'); } catch { /* non-fatal */ }
    tracker.done('html', gen.source === 'ai' ? '✅ AI 已生成动效模板' : '✅ 模板已就绪(内置版式)');

    // STEP 2 — 逐帧渲染(无头浏览器逐帧截图)
    throwIfAborted(signal);
    tracker.start('render', '逐帧渲染画面中…');
    await renderHtmlToFrames({
      html: gen.html,
      width: 1080, height: 1920,
      fps: gen.fps, durationSec: gen.durationSec,
      framesDir,
      signal,
      onProgress: (done, total) => {
        if (done % 10 === 0 || done === total) tracker.progress(`🎞️ 渲染 ${done}/${total} 帧`);
      },
    });
    tracker.done('render', '✅ 画面渲染完成');

    // STEP 3 — 编码成 mp4(可选 BGM)
    throwIfAborted(signal);
    tracker.start('compose', '编码合成视频…');
    const outPath = path.join(destDir, outputFileName(0));
    const bgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m)).catch(() => undefined);
    const args = buildEncodeArgs(framesDir, gen.fps, outPath, bgm, input.bgmVolume);
    const r = await runFfmpeg(args, { signal });
    if (!r.ok) {
      const err = '视频编码失败,请稍后重试。';
      try { console.error('[template] ffmpeg failed:', r.stderr.slice(-600)); } catch { /* ignore */ }
      tracker.fail('compose', err);
      return { ok: false, error: err };
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
    try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
