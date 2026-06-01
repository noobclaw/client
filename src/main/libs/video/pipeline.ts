/**
 * pipeline — 本地出片总编排(一期 路线 A:文案 → 配音 → 画面 → 字幕 → 合成 mp4)。
 *
 * 流程:
 *   1. 拆解参考文案为逐句分镜
 *   2. 每句 edge-tts 配音(拿到每镜真实时长)
 *   3. 凑画面:参考图优先 → Pexels/Pixabay 素材图补 → 都没有上纯色文字卡
 *   4. ffmpeg 逐镜 Ken Burns + 烧字幕,concat 成竖屏 mp4
 *   5. 输出到 ~/Documents/NoobClaw/视频创作/<日期>/
 *
 * 全程 emit 进度(steps 数组)给渲染端 UI。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getHomePath } from '../platformAdapter';
import { isFfmpegAvailable } from './ffmpegRuntime';
import { synthesize } from './tts';
import { fetchStockImages } from './stockProvider';
import { composeVideo, type SceneSpec } from './compose';

export type VideoAspect = '9:16' | '16:9' | '1:1';
export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';

export interface VideoCreationInput {
  persona: string;
  track: string;
  keywords: string[];
  script: string;
  referenceImages: string[];
  aspect: VideoAspect;
  publishTarget: VideoPublishTarget;
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
}

export interface ProgressStep {
  key: string;
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface VideoCreationProgress {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: ProgressStep[];
  message?: string;
  outputPath?: string;
  error?: string;
}

export interface VideoCreationResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

export type ProgressEmitter = (p: VideoCreationProgress) => void;

const STEP_DEFS: { key: string; label: string }[] = [
  { key: 'split', label: '拆解文案分镜' },
  { key: 'tts', label: '生成 AI 配音' },
  { key: 'visuals', label: '准备画面素材' },
  { key: 'compose', label: '合成竖屏视频' },
];

class ProgressTracker {
  private steps: ProgressStep[];
  constructor(private jobId: string, private emit?: ProgressEmitter) {
    this.steps = STEP_DEFS.map((s) => ({ ...s, status: 'waiting' as const }));
  }
  private send(status: 'running' | 'done' | 'error', message?: string, extra?: Partial<VideoCreationProgress>) {
    this.emit?.({
      jobId: this.jobId,
      status,
      steps: this.steps.map((s) => ({ ...s })),
      message,
      ...extra,
    });
  }
  start(key: string, message?: string) {
    const s = this.steps.find((x) => x.key === key);
    if (s) s.status = 'running';
    this.send('running', message);
  }
  done(key: string, message?: string) {
    const s = this.steps.find((x) => x.key === key);
    if (s) s.status = 'done';
    this.send('running', message);
  }
  progress(message: string) {
    this.send('running', message);
  }
  fail(key: string | null, error: string) {
    if (key) {
      const s = this.steps.find((x) => x.key === key);
      if (s) s.status = 'error';
    }
    this.send('error', undefined, { error });
  }
  finish(outputPath: string) {
    this.steps.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    this.send('done', undefined, { outputPath });
  }
}

/** 把参考文案拆成逐句分镜。 */
export function splitScript(script: string): string[] {
  const raw = (script || '').replace(/\r\n/g, '\n');
  // 先按换行 + 句末标点切
  const rough = raw
    .split(/[\n。！？!?；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const scenes: string[] = [];
  for (let piece of rough) {
    // 过长的句子再按逗号切,单镜别太挤
    if (piece.length > 36) {
      const sub = piece.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
      let buf = '';
      for (const part of sub) {
        if ((buf + part).length > 36 && buf) {
          scenes.push(buf);
          buf = part;
        } else {
          buf = buf ? `${buf}，${part}` : part;
        }
      }
      if (buf) scenes.push(buf);
    } else {
      scenes.push(piece);
    }
  }

  // 合并过短碎句(<4 字)到上一镜
  const merged: string[] = [];
  for (const s of scenes) {
    if (s.length < 4 && merged.length > 0) {
      merged[merged.length - 1] += `，${s}`;
    } else {
      merged.push(s);
    }
  }

  return merged.slice(0, 40); // 安全上限
}

function outputDir(): string {
  let docs: string;
  try {
    docs = require('electron').app.getPath('documents');
  } catch {
    docs = path.join(getHomePath(), 'Documents');
  }
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dir = path.join(docs, 'NoobClaw', '视频创作', `${y}-${m}-${d}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function outputFileName(): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `video_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.mp4`;
}

/** 主入口:跑完整流水线,返回成片结果。 */
export async function generateVideo(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
): Promise<VideoCreationResult> {
  const jobId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit);

  // 前置:ffmpeg 必须可用
  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('split', err);
    return { ok: false, error: err };
  }

  // 临时素材目录(配音 + 下载的素材图)
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-vid-assets-'));

  try {
    // 1. 拆句
    tracker.start('split');
    const sentences = splitScript(input.script);
    if (sentences.length === 0) {
      const err = '参考文案为空或无法拆出有效分镜';
      tracker.fail('split', err);
      return { ok: false, error: err };
    }
    tracker.done('split', `共 ${sentences.length} 个分镜`);

    // 2. 逐句配音
    tracker.start('tts');
    const audios: { audioPath: string; durationSec: number }[] = [];
    let synthCount = 0;
    for (let i = 0; i < sentences.length; i++) {
      const outMp3 = path.join(assetDir, `narr_${String(i).padStart(3, '0')}.mp3`);
      const r = await synthesize(sentences[i], outMp3);
      audios.push({ audioPath: r.audioPath, durationSec: r.durationSec });
      if (r.synthesized) synthCount++;
      tracker.progress(`配音 ${i + 1}/${sentences.length}`);
    }
    tracker.done('tts', synthCount === sentences.length
      ? '配音完成'
      : `配音完成(${sentences.length - synthCount} 句用静音兜底)`);

    // 3. 画面:参考图 + 素材库
    tracker.start('visuals');
    const refImages = (input.referenceImages || []).filter((p) => p && fs.existsSync(p));
    const needStock = Math.max(0, Math.min(20, sentences.length - refImages.length));
    let stockImages: string[] = [];
    if (needStock > 0) {
      tracker.progress('搜索在线素材库…');
      stockImages = await fetchStockImages({
        keywords: input.keywords,
        count: needStock,
        destDir: assetDir,
      });
    }
    const visualPool = [...refImages, ...stockImages];
    tracker.done('visuals', visualPool.length > 0
      ? `画面就绪(参考图 ${refImages.length} + 素材 ${stockImages.length})`
      : '无可用图片,使用文字卡');

    // 4. 组装分镜 + 合成
    tracker.start('compose');
    const scenes: SceneSpec[] = sentences.map((sentence, i) => ({
      imagePath: visualPool.length > 0 ? visualPool[i % visualPool.length] : undefined,
      audioPath: audios[i].audioPath,
      durationSec: audios[i].durationSec,
      subtitle: sentence,
    }));

    const outPath = path.join(outputDir(), outputFileName());
    const bgmPath = input.bgmPath && fs.existsSync(input.bgmPath) ? input.bgmPath : undefined;
    await composeVideo({
      scenes,
      outputPath: outPath,
      bgmPath,
      onScene: (done, total) => tracker.progress(`合成分镜 ${done}/${total}`),
    });

    tracker.finish(outPath);
    return { ok: true, outputPath: outPath };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    tracker.fail('compose', err.slice(0, 300));
    return { ok: false, error: err.slice(0, 300) };
  } finally {
    // 清理临时素材(成片已落到 Documents)
    try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch {}
  }
}
