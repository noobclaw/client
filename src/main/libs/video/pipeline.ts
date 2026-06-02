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
import { synthesize, getLastTtsError } from './tts';
import { fetchStockImages, fetchStockVideosByTerms, type StockVideoAsset, type StockVideoByTerm } from './stockProvider';
import { composeVideo, type SceneSpec } from './compose';
import { generateScript, generateSearchTerms } from './scriptWriter';

export type VideoAspect = '9:16' | '16:9' | '1:1';
export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';

export interface VideoCreationInput {
  persona: string;
  track: string;
  keywords: string[];
  /** 口播旁白文案。为空时用 DeepSeek 按 targetSeconds 自动生成。 */
  script: string;
  referenceImages: string[];
  aspect: VideoAspect;
  publishTarget: VideoPublishTarget;
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
  /** 目标视频时长(秒),仅在自动生成文案时用于控制长度。默认 45。 */
  targetSeconds?: number;
  /**
   * 是否用在线素材【视频】(优先于图片)。默认 true。视频效果远好过图片
   * Ken Burns(抄 MoneyPrinterTurbo)。下载失败/无匹配时自动降级到图片/文字卡。
   */
  useStockVideo?: boolean;
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
  /** 本次出片累计消耗的 DeepSeek token(写稿 + 搜索词);TTS/ffmpeg 免费不计。 */
  tokensUsed?: number;
  /** 成片输出目录(开跑即确定,供详情页顶部展示)。 */
  outputDir?: string;
}

export interface VideoCreationResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

export type ProgressEmitter = (p: VideoCreationProgress) => void;

const STEP_DEFS: { key: string; label: string }[] = [
  { key: 'script', label: 'AI 撰写旁白脚本' },
  { key: 'split', label: '拆解文案分镜' },
  { key: 'tts', label: '生成 AI 配音' },
  { key: 'visuals', label: '准备画面素材' },
  { key: 'compose', label: '合成竖屏视频' },
];

class ProgressTracker {
  private steps: ProgressStep[];
  // 累计 token + 输出目录随每次 emit 带回,渲染端无需自己算。
  private tokensUsed = 0;
  private outputDir?: string;
  constructor(private jobId: string, private emit?: ProgressEmitter) {
    this.steps = STEP_DEFS.map((s) => ({ ...s, status: 'waiting' as const }));
  }
  private send(status: 'running' | 'done' | 'error', message?: string, extra?: Partial<VideoCreationProgress>) {
    this.emit?.({
      jobId: this.jobId,
      status,
      steps: this.steps.map((s) => ({ ...s })),
      message,
      tokensUsed: this.tokensUsed,
      outputDir: this.outputDir,
      ...extra,
    });
  }
  /** 累加本步 token,并立即把最新累计值 emit 回去。 */
  addTokens(n: number) {
    this.tokensUsed += Math.max(0, Number(n) || 0);
  }
  /** 出片目录开跑即确定,设一次即可,后续每次 emit 都会带上。 */
  setOutputDir(dir: string) {
    this.outputDir = dir;
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

  // 出片目录开跑即确定,emit 一次让详情页顶部立刻能显示「输出目录」。
  const destDir = outputDir();
  tracker.setOutputDir(destDir);

  try {
    // 0. 文案:用户没给就用 DeepSeek 按目标时长写一段口播旁白
    tracker.start('script', `输出目录:${destDir}`);
    let script = (input.script || '').trim();
    if (!script) {
      const topic = (input.keywords || []).filter(Boolean).join('、') || input.track || '生活方式';
      tracker.progress(`AI 正在撰写旁白脚本（目标约 ${input.targetSeconds ?? 45}s）…`);
      try {
        const r = await generateScript({
          topic,
          persona: input.persona,
          track: input.track,
          keywords: input.keywords,
          targetSeconds: input.targetSeconds ?? 45,
        });
        script = r.script;
        tracker.addTokens(r.tokens);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        tracker.fail('script', `AI 写脚本失败:${err.slice(0, 200)}`);
        return { ok: false, error: err.slice(0, 300) };
      }
      tracker.done('script', `AI 已生成约 ${script.length} 字旁白`);
      // 把 AI 写的完整口播文案打到日志里(用户点详情页能看到 AI 到底写了啥)。
      tracker.progress(`📝 口播文案:${script}`);
    } else {
      tracker.done('script', '使用用户提供的文案');
      tracker.progress(`📝 口播文案:${script}`);
    }

    // 1. 拆句
    tracker.start('split');
    const sentences = splitScript(script);
    if (sentences.length === 0) {
      const err = '文案为空或无法拆出有效分镜';
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
    if (synthCount === sentences.length) {
      tracker.done('tts', '配音完成');
    } else {
      const reason = getLastTtsError();
      tracker.done('tts',
        `配音完成(${sentences.length - synthCount} 句用静音兜底` +
        (reason ? `:${reason.slice(0, 120)}` : '') + ')');
    }

    // 3. 画面:每镜 AI 搜索词 → 该镜对应的在线视频 → 素材图 → 参考图 → 文字卡
    tracker.start('visuals');

    // 3a. 让 DeepSeek 给每个分镜配 1-3 个英文搜索词(画面跟着内容走)
    tracker.progress('AI 规划每镜画面关键词…');
    const termsResult = await generateSearchTerms(sentences, input.keywords);
    const perSceneTerms = termsResult.terms.map((arr) => (arr || []).map((s) => s.toLowerCase()));
    tracker.addTokens(termsResult.tokens);

    // 要去搜的词集:每镜首词优先(保证每个分镜的主画面词一定被搜到),
    // 再补其余词,整体封顶 12 个,避免逐词搜请求过多拖慢。
    const primaryTerms = Array.from(new Set(perSceneTerms.map((t) => t[0]).filter(Boolean)));
    const extraTerms = Array.from(new Set(perSceneTerms.flat().filter(Boolean)))
      .filter((t) => !primaryTerms.includes(t));
    let searchTerms = [...primaryTerms, ...extraTerms].slice(0, 12);
    if (searchTerms.length === 0) {
      searchTerms = (input.keywords || []).map((s) => s.toLowerCase()).filter(Boolean);
    }
    if (searchTerms.length > 0) {
      tracker.progress(`🔍 画面搜索词:${searchTerms.join(', ')}`);
    }

    const refImages = (input.referenceImages || []).filter((p) => p && fs.existsSync(p));
    const wantVideo = input.useStockVideo !== false;

    // 3b. 逐词拉视频,保留「词 → 素材」归属(进度逐词回报,不再"没动静")
    let videoByTerm: StockVideoByTerm[] = [];
    if (wantVideo && searchTerms.length > 0) {
      tracker.progress(`搜索在线视频素材(共 ${searchTerms.length} 组关键词)…`);
      videoByTerm = await fetchStockVideosByTerms({
        terms: searchTerms,
        perTermCount: 4,
        destDir: assetDir,
        onProgress: ({ done, total, term, totalGot }) =>
          tracker.progress(`搜索在线视频素材 ${done}/${total}:「${term}」(累计 ${totalGot} 段)`),
      });
    }

    // 建「词 → 该词的视频队列」+ 全局视频列表;分配时各镜按自己的词取,用尽再借全局。
    const poolByTerm = new Map<string, StockVideoAsset[]>();
    for (const g of videoByTerm) poolByTerm.set(g.term.toLowerCase(), [...g.assets]);
    const allVideos: StockVideoAsset[] = videoByTerm.flatMap((g) => g.assets);
    const usedVideo = new Set<string>();
    const pickVideoForScene = (i: number): string | undefined => {
      // 1. 优先吃本镜搜索词命中的、还没被别的镜用过的视频
      for (const term of perSceneTerms[i] || []) {
        const q = poolByTerm.get(term);
        if (q) {
          const v = q.find((a) => !usedVideo.has(a.path));
          if (v) { usedVideo.add(v.path); return v.path; }
        }
      }
      // 2. 本镜词都没命中/用尽 → 从全局未用视频借一段(总比退回图片强)
      const any = allVideos.find((a) => !usedVideo.has(a.path));
      if (any) { usedVideo.add(any.path); return any.path; }
      return undefined;
    };

    const sceneVideos: (string | undefined)[] = sentences.map((_, i) => pickVideoForScene(i));
    const scenesWithoutVideo = sceneVideos.filter((v) => !v).length;

    // 3c. 视频没覆盖到的分镜,用参考图 + 在线素材图补齐(图片仍走聚合搜,影响小)
    const needImages = Math.max(0, Math.min(20, scenesWithoutVideo - refImages.length));
    let stockImages: string[] = [];
    if (needImages > 0 && searchTerms.length > 0) {
      tracker.progress('补充在线图片素材…');
      stockImages = await fetchStockImages({
        keywords: searchTerms.slice(0, 8),
        count: needImages,
        destDir: assetDir,
      });
    }
    const imagePool = [...refImages, ...stockImages];

    tracker.done('visuals',
      (allVideos.length > 0 || imagePool.length > 0)
        ? `画面就绪(视频 ${allVideos.length} 段 → 覆盖 ${sentences.length - scenesWithoutVideo}/${sentences.length} 镜,图片 ${imagePool.length} 张补位)`
        : '无可用素材,使用文字卡');

    // 4. 组装分镜 + 合成。每镜先用分配到的视频,没有则轮转图片,再退文字卡
    tracker.start('compose');
    let imgCursor = 0;
    const scenes: SceneSpec[] = sentences.map((sentence, i) => {
      const video = sceneVideos[i];
      const image = !video && imagePool.length > 0 ? imagePool[imgCursor++ % imagePool.length] : undefined;
      return {
        videoPath: video,
        imagePath: image,
        audioPath: audios[i].audioPath,
        durationSec: audios[i].durationSec,
        subtitle: sentence,
      };
    });

    const outPath = path.join(destDir, outputFileName());
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
