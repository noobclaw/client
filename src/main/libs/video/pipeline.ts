/**
 * pipeline — 本地出片总编排(一期 路线 A:文案 → 配音 → 画面 → 字幕 → 合成 mp4)。
 *
 * 流程:
 *   1. 拆解参考文案为逐句分镜
 *   2. 每句 edge-tts 配音(拿到每镜真实时长)
 *   3. 凑画面:参考图优先 → Pexels/Pixabay 素材图补 → 都没有上纯色文字卡
 *   4. ffmpeg 逐镜 Ken Burns + 烧字幕,concat 成竖屏 mp4
 *   5. 输出到 ~/Documents/NoobClaw/视频创作/<任务ID前8位>_<任务名>/<日期>/<批次号>/
 *      (同一任务同一天每跑一次 +1:1/、2/、3/…;无任务上下文的老调用退回 视频创作/<日期>/<批次号>/)
 *
 * 全程 emit 进度(steps 数组)给渲染端 UI。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getHomePath } from '../platformAdapter';
import { isFfmpegAvailable, setVideoAbortSignal } from './ffmpegRuntime';
import { synthesize, getLastTtsError } from './tts';
import { fetchStockImages, fetchStockVideosByTerms, type StockVideoAsset, type StockVideoByTerm, type StockOrientation } from './stockProvider';
import { composeVideo, type SceneSpec, type SubtitleStyle, type SubtitleCue } from './compose';
import { generateScript, generateSearchTerms, detectLang } from './scriptWriter';
import { getVideoConfig, localeFor } from './videoConfig';
import { chargeMode1Video, refundMode1Video } from './billing';
import { resolveBgmPath } from './bgm';
import { generateSeedanceClips, generateStoryboard, type SeedanceClipResult, type SeedanceSceneSpec } from './seedanceProvider';
import type { TemplateOptions } from './templateHtmlWriter';
import { runTemplatePipeline } from './template-pipeline';

export type VideoAspect = '9:16' | '16:9' | '1:1';
export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';
export type SubtitlePosition = 'top' | 'center' | 'bottom';

/** aspect → 成片宽高(短边 1080)。 */
function aspectToSize(aspect: VideoAspect): { width: number; height: number } {
  switch (aspect) {
    case '16:9': return { width: 1920, height: 1080 };
    case '1:1': return { width: 1080, height: 1080 };
    case '9:16':
    default: return { width: 1080, height: 1920 };
  }
}

/** aspect → 素材库搜索方向。 */
function aspectToOrientation(aspect: VideoAspect): StockOrientation {
  switch (aspect) {
    case '16:9': return 'landscape';
    case '1:1': return 'square';
    case '9:16':
    default: return 'portrait';
  }
}

/** aspect → Seedance ratio 字段。 */
function aspectToSeedanceRatio(aspect: VideoAspect): '9:16' | '16:9' | '1:1' {
  if (aspect === '16:9') return '16:9';
  if (aspect === '1:1') return '1:1';
  return '9:16';
}

/**
 * 给一句口播稿构造 Seedance 画面 prompt —— 套 Seedance 官方 6 步公式(主体/动作 → 环境/光
 * → 单一运镜 → 风格 → 本地化 → 负向约束),提质不加钱。要点(来自官方/社区最佳实践):
 *   · 只给一个运镜(多运镜会抖);逐镜轮换不同运镜避免全片雷同。
 *   · 物理光源 + 写实风格;ROI 最高。
 *   · 负向约束:无文字/水印 + 避免抖动/肢体扭曲/闪烁。
 *   · 图生视频(有参考图)时不复述图里已有内容,只描述运动/运镜(否则主体漂移)。
 *   · 本地化:中文/日韩内容,人物按亚洲/对应国家、实景按当代城市风格;通用物体保持中性。
 */
function buildSeedancePrompt(
  sentence: string,
  opts: { track?: string; persona?: string; lang?: string; isI2V?: boolean; shotIndex?: number },
): string {
  const REGION: Record<string, string> = { zh: '中国', ja: '日本', ko: '韩国' };
  const region = REGION[(opts.lang || '').slice(0, 2).toLowerCase()];
  const styleBits = [opts.track, opts.persona].filter(Boolean).join('、');
  const CAMS = ['镜头缓慢推近', '镜头缓慢左移跟随', '镜头缓慢上摇', '固定机位、主体自然轻微动作', '镜头缓慢环绕'];
  const cam = CAMS[(opts.shotIndex ?? 0) % CAMS.length];

  const parts: string[] = [];
  if (opts.isI2V) {
    parts.push(`保持参考图的主体、构图与配色不变,只为画面添加自然、轻微的运动。`);
  } else {
    parts.push(`电影感竖屏空镜,画面贴合这句旁白(具体、可拍,有明确主体与单一动作):「${sentence}」。`);
  }
  parts.push(`环境真实、自然光、有空间层次与景深。`);
  parts.push(`运镜:${cam}(全程只用这一种,平稳不抖)。`);
  parts.push(`风格:电影感、纪实写实、画质清晰${styleBits ? `,贴合「${styleBits}」` : ''}。`);
  if (region) {
    parts.push(`本地化:若出现人物,为亚洲/${region}人面孔与气质;若为街景/室内/餐厅/商店/交通等实景,呈现当代${region}城市的环境与风格;通用物体、纯自然风景保持中性。`);
  }
  parts.push(`不要任何文字、字幕、水印、logo;避免画面抖动、肢体扭曲、时间闪烁。`);
  return parts.join('');
}

/**
 * AI 大分镜:把逐句碎分镜合并成更长的段(每段旁白约 8–12s),减少切刀、更连贯,
 * 也减少 Seedance"单镜最短时长"带来的浪费。按字数估时长(CJK ~4.5 字/秒):
 * 累加到 ≥MIN 就出一段,超过 MAX 先把当前段收尾再起新段。Seedance(1.x/lite)单次
 * 上限 12s,所以 MAX 字数对应 ≤~12s。
 */
function mergeSentencesForAi(sents: string[]): string[] {
  const hasCJK = sents.some((s) => /[぀-ヿ㐀-鿿가-힯]/.test(s));
  const MIN = hasCJK ? 36 : 90;   // ≈8s
  const MAX = hasCJK ? 54 : 135;  // ≈12s(Seedance 单镜上限)
  const out: string[] = [];
  let buf = '';
  for (const s of sents) {
    if (buf && (buf.length + 1 + s.length) > MAX) { out.push(buf); buf = s; }
    else buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= MIN) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out.length ? out : sents;
}

/** 失败镜降级:借最近(左右就近)一个成功生成的片段路径;都没有返回 null。 */
function findNearestClip(results: SeedanceClipResult[], i: number): string | null {
  for (let d = 1; d < results.length; d++) {
    const a = results[i - d];
    if (a && a.path) return a.path;
    const b = results[i + d];
    if (b && b.path) return b.path;
  }
  return null;
}

export interface VideoCreationInput {
  persona: string;
  track: string;
  keywords: string[];
  /**
   * 视频文案。语义随 scriptMode 变:
   *   · strict → 逐字朗读的成片文案(必填),视频长度由其字数决定。
   *   · ai     → 仅作 AI 写稿的参考方向(可空),最终文案由 DeepSeek 生成。
   */
  script: string;
  /**
   * 文案模式。'strict' = 严格按用户文案逐字出片;'ai' = AI 写稿(用户文案作参考)。
   * 缺省时按老逻辑兼容:有 script → strict,无 → ai。
   */
  scriptMode?: 'strict' | 'ai';
  /**
   * 画面引擎(成片方式):
   *   · 'stock'(默认) → AI 分镜 + 在线素材库空镜(+可选本地上传混拼)。
   *   · 'ai'           → Seedance AI 自动成片:逐镜用 Seedance 生成视频片段,
   *                      参考图(≤2)做风格/人设统一;失败镜降级到参考图静帧/邻镜。
   *                      走服务端代理(/api/video/seedance/*),逐片段计费 + 失败退款。
   */
  engine?: 'stock' | 'ai' | 'template';
  /** AI 引擎分辨率档(成本敏感):'480p'|'720p'(默认)|'1080p'。 */
  seedanceResolution?: '480p' | '720p' | '1080p';
  /** AI 引擎模型档位:'lite'(1.0 Lite) | 'pro'(1.0 Pro) | 'pro15'(1.5 Pro,默认) | 'v2'(2.0)。 */
  seedanceModel?: 'lite' | 'pro' | 'pro15' | 'v2';
  /** engine==='template'(模板速生)专属配置;其它 engine 忽略。 */
  template?: TemplateOptions;
  referenceImages: string[];
  /**
   * 用户上传的本地视频素材绝对路径(画面来源 = 本地上传)。非空时直接拿这些
   * 片段循环拼成片,跳过在线素材库搜索(连 DeepSeek 搜索词也省了)。
   */
  localVideos?: string[];
  aspect: VideoAspect;
  publishTarget: VideoPublishTarget;
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18。 */
  bgmVolume?: number;
  /** 目标视频时长(秒),仅在自动生成文案时用于控制长度。默认 45。 */
  targetSeconds?: number;
  /**
   * 是否用在线素材【视频】(优先于图片)。默认 true。视频效果远好过图片
   * Ken Burns(抄 MoneyPrinterTurbo)。下载失败/无匹配时自动降级到图片/文字卡。
   */
  useStockVideo?: boolean;
  /** edge-tts 音色,空 = 用配置默认(zh-CN-XiaoxiaoNeural)。 */
  voice?: string;
  /** 语速档(-50~+50,单位%),0/空 = 正常语速。 */
  voiceRate?: number;
  /**
   * 是否生成口播旁白 + 字幕。默认 true。
   * 仅在 engine==='ai'(Seedance)下可设 false = 纯画面片:跳过 TTS、不烧字幕,
   * 镜头时长按分镜稿字数估算,音频只用 BGM(没选则静音)。其它模式忽略此字段。
   */
  narrationEnabled?: boolean;
  /** 是否烧字幕。默认 true。 */
  subtitleEnabled?: boolean;
  /** 字幕字号(成片原始分辨率下像素)。默认 52。 */
  subtitleFontSize?: number;
  /** 字幕位置。默认 bottom。 */
  subtitlePosition?: SubtitlePosition;
  /** 字幕文字颜色(#RRGGBB)。空 = 白色。 */
  subtitleColor?: string;
  /** 字幕描边颜色(#RRGGBB)。空 = 不描边(用半透明黑底盒)。 */
  subtitleStrokeColor?: string;
  /** 字幕字体文件名(resources/fonts/ 下,如 SmileySans-Oblique.ttf)。空 = 默认思源黑体。 */
  subtitleFont?: string;
  /** 每段素材最长秒数(换镜节奏)。默认 4,越小换镜越快。 */
  maxClipSeconds?: number;
  /**
   * 一次出片数量(1~5)。抄 MoneyPrinterTurbo:复用同一份脚本 + 配音,
   * 只对每条做不同的素材片段组合,平台费按条数 ×N。默认 1。
   */
  videoCount?: number;
  /**
   * v6.x: 所属视频任务 id。传入时,成片输出到【按任务】的文件夹
   * (视频创作/<id前8位>_<任务名>/<日期>/<批次号>/),详情页顶部「输出目录」稳定指向
   * 任务总目录(视频创作/<id前8位>_<任务名>/),每次运行在其下按 日期/批次号 分桶
   * (对齐涨粉任务 getTaskDirPath/getNextBatch 的按任务+批次分目录)。
   * 缺省(无任务上下文的老调用)退回按日期+批次分桶。
   */
  taskId?: string;
  /** v6.x: 任务标题,派生输出文件夹名用(配合 taskId)。 */
  taskTitle?: string;
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
  /** 本次出片累计 USD 成本(服务端权威 _noobclaw.costUsd 之和);老后端时为 0。 */
  costUsd?: number;
  /** 成片输出目录(开跑即确定,供详情页顶部展示)。 */
  outputDir?: string;
  /** 本次实际产出的成片条数(批量出片时>1,随终态 done 事件带回供渲染端计数)。 */
  videoCount?: number;
}

export interface VideoCreationResult {
  ok: boolean;
  /** 首条成片路径(兼容老调用 / 单条场景)。 */
  outputPath?: string;
  /** 批量出片时的全部成片路径(videoCount>1 时长度>1)。 */
  outputPaths?: string[];
  error?: string;
  /** 用户主动停止(非失败):渲染端据此显示「已停止」而非红色报错。 */
  aborted?: boolean;
}

export type ProgressEmitter = (p: VideoCreationProgress) => void;

// v2: 「拆解文案分镜」原是独立一步,但它只是本地纯文本 splitScript()(无 AI、无
// 耗时),单列一步徒增噪音 → 合并进「脚本」步(脚本生成完顺手拆句,同一步内完成)。
const STEP_DEFS: { key: string; label: string }[] = [
  { key: 'script', label: '生成脚本 · 拆解分镜' },
  { key: 'tts', label: '生成 AI 配音' },
  { key: 'visuals', label: '准备画面素材' },
  { key: 'compose', label: '合成视频' },
];

export class ProgressTracker {
  private steps: ProgressStep[];
  // 累计 token + USD 成本 + 输出目录随每次 emit 带回,渲染端无需自己算。
  private tokensUsed = 0;
  private costUsd = 0;
  private outputDir?: string;
  // stepDefs 可定制:stock/ai 用默认 4 步;template 速生传自己的步骤集。
  constructor(private jobId: string, private emit?: ProgressEmitter, stepDefs: { key: string; label: string }[] = STEP_DEFS) {
    this.steps = stepDefs.map((s) => ({ ...s, status: 'waiting' as const }));
  }
  private send(status: 'running' | 'done' | 'error', message?: string, extra?: Partial<VideoCreationProgress>) {
    this.emit?.({
      jobId: this.jobId,
      status,
      steps: this.steps.map((s) => ({ ...s })),
      message,
      tokensUsed: this.tokensUsed,
      costUsd: this.costUsd,
      outputDir: this.outputDir,
      ...extra,
    });
  }
  /** 累加本步 token + USD 成本,并随下次 emit 把最新累计值带回去。 */
  addTokens(n: number, costUsd = 0) {
    this.tokensUsed += Math.max(0, Number(n) || 0);
    this.costUsd += Math.max(0, Number(costUsd) || 0);
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
  finish(outputPath: string, videoCount = 1) {
    this.steps.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    this.send('done', undefined, { outputPath, videoCount });
  }
}

/** 把参考文案拆成逐句分镜。 */
export function splitScript(script: string): string[] {
  const raw = (script || '').replace(/\r\n/g, '\n');
  // 语言自适应:CJK 文本字符密度高(中文约 4.5 字/秒),拉丁文本同样秒数字符多得多。
  // 阈值/合并按是否含 CJK 切换,避免英文/日文被按中文阈值切得过碎、撞到 40 镜上限被截断。
  const hasCJK = /[぀-ヿ㐀-鿿가-힯]/.test(raw);
  const longLimit = hasCJK ? 36 : 110;   // 单镜过长再按逗号细切的阈值
  const shortLimit = hasCJK ? 4 : 12;    // 过短碎句并入上一镜的阈值
  const sep = hasCJK ? '，' : ', ';       // 细切后回拼用的分隔符

  // 先按换行 + 句末标点切(英文句号 `. ` / 句末句号也算一刀)
  const rough = raw
    .split(/[\n。！？!?；;]+|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const scenes: string[] = [];
  for (const piece of rough) {
    // 过长的句子再按逗号切,单镜别太挤(中英文逗号 + 顿号都算)
    if (piece.length > longLimit) {
      const sub = piece.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
      let buf = '';
      for (const part of sub) {
        if ((buf + part).length > longLimit && buf) {
          scenes.push(buf);
          buf = part;
        } else {
          buf = buf ? `${buf}${sep}${part}` : part;
        }
      }
      if (buf) scenes.push(buf);
    } else {
      scenes.push(piece);
    }
  }

  // 合并过短碎句到上一镜
  const merged: string[] = [];
  for (const s of scenes) {
    if (s.length < shortLimit && merged.length > 0) {
      merged[merged.length - 1] += `${sep}${s}`;
    } else {
      merged.push(s);
    }
  }

  return merged.slice(0, 40); // 安全上限
}

/** 文件夹名清洗:剔除路径非法字符 + 折叠空白,限长(中文标题照样可用)。 */
function sanitizeFolderName(s: string): string {
  return (s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** 本地日期串 年-月-日(对齐 scenario artifactWriter.todayStr)。 */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 当天目录里下一个运行批次号(扫已有数字子目录取 max+1)。同一任务同一天每跑一次 +1。
 * 算法照搬 scenario artifactWriter.getNextBatch,让视频与涨粉任务的批次目录规范一致。
 */
function getNextBatch(dayDir: string): number {
  try {
    if (!fs.existsSync(dayDir)) return 1;
    let max = 0;
    for (const e of fs.readdirSync(dayDir)) {
      const n = parseInt(e, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * 成片目录,对齐 scenario 的「任务总目录 + 日期 + 批次号」规范:
 *   · taskDir(详情页顶部「输出目录」指向它,稳定不随运行变):
 *       - 有 taskId → 视频创作/<id前8位>_<任务名>/
 *       - 无 taskId(老调用)→ 视频创作/<年-月-日>/(日期桶充当任务根)
 *   · runDir(本次运行实际写成片的目录)= taskDir/<年-月-日>/<批次号>/
 *       同一任务同一天每手动跑一次新建 1/、2/、3/…(无 taskId 时任务根已是日期,不再套一层)。
 *   一次批量出片(videoCount>1)只调一次 → N 条成片同落一个 <批次号>/,靠文件名 _N 后缀区分。
 */
export function resolveOutputDirs(input?: { taskId?: string; taskTitle?: string }): { taskDir: string; runDir: string } {
  let docs: string;
  try {
    docs = require('electron').app.getPath('documents');
  } catch {
    docs = path.join(getHomePath(), 'Documents');
  }
  const root = path.join(docs, 'NoobClaw', '视频创作');
  let taskDir: string;
  let dayDir: string;
  if (input?.taskId) {
    const folder = sanitizeFolderName(`${input.taskId.slice(0, 8)}_${input.taskTitle || ''}`) || input.taskId.slice(0, 8);
    taskDir = path.join(root, folder);
    dayDir = path.join(taskDir, todayStr());
  } else {
    // 无任务上下文:日期桶既当任务根(UI 显示)又当当天目录,批次号直接挂其下,避免 日期/日期 套娃。
    taskDir = path.join(root, todayStr());
    dayDir = taskDir;
  }
  const runDir = path.join(dayDir, String(getNextBatch(dayDir)));
  fs.mkdirSync(runDir, { recursive: true });
  return { taskDir, runDir };
}

export function outputFileName(index = 0): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  // 批量出片在同一秒内循环写多条 → 时间戳会撞;index>0 时加序号后缀避免覆盖。
  const suffix = index > 0 ? `_${index + 1}` : '';
  return `video_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}${suffix}.mp4`;
}

/** 主入口:跑完整流水线,返回成片结果。 */
/**
 * 出片总入口。在内部实现 runVideoPipeline 外包一层,出片结束(成功/失败)后
 * 异步 fire-and-forget 上报到后端 user_task_runs(admin 巡检视频创作任务)。
 *
 * ⚠️ 上报绝不 await、绝不 throw、绝不阻塞出片(用户硬约束)。这里截一份 emit
 * 来记录最后一次累计 token / 成本(VideoCreationResult 本身不带),仅用于上报,
 * 不改变任何对渲染端的行为。
 */
/** 用户点「停止」时,signal 被 abort → 在步骤边界抛出,让 pipeline 干净退出。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('VIDEO_ABORTED:已停止');
}

export async function generateVideo(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  let lastTokens = 0;
  let lastCost = 0;
  const wrappedEmit: ProgressEmitter | undefined = (p) => {
    if (typeof p?.tokensUsed === 'number') lastTokens = p.tokensUsed;
    if (typeof p?.costUsd === 'number') lastCost = p.costUsd;
    emit?.(p);
  };

  // 设当前任务中断信号 → 本次出片期间 ffmpegRuntime 所有 runFfmpeg(合成/探测)abort 时自动 SIGKILL。
  setVideoAbortSignal(signal);
  let result: VideoCreationResult;
  try {
    result = await runVideoPipeline(input, wrappedEmit, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 用户主动停止 → 标准化为「已停止」结果(渲染端据此显示停止态,不当报错)。
    result = msg.startsWith('VIDEO_ABORTED')
      ? { ok: false, error: '已停止', aborted: true }
      : { ok: false, error: msg };
  } finally {
    setVideoAbortSignal(undefined);
  }

  try {
    const { scheduleVideoRunReport } = require('../scenario/taskRunReporter');
    scheduleVideoRunReport({
      runId,
      input: { track: input.track, keywords: input.keywords, publishTarget: input.publishTarget },
      result,
      startedAt,
      finishedAt: Date.now(),
      tokensUsed: lastTokens,
      costUsd: lastCost,
    });
  } catch { /* non-fatal */ }

  return result;
}

async function runVideoPipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  // engine==='template'(模板速生):AI 现编动效 HTML → 逐帧渲染 → 编码。完全独立的
  // 流水线(template-pipeline.ts),早分流出去,不与 stock/ai 共用下面的步骤。
  if (input.engine === 'template') return runTemplatePipeline(input, emit, signal);

  const jobId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit);

  // 前置:ffmpeg 必须可用
  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('script', err);
    return { ok: false, error: err };
  }

  // 计费:模式一(AI 分镜 + 在线素材)预扣平台基础费(随机 $0.09~$0.18)。
  // 为什么预扣而不是成片后扣:并发任务可能在本任务跑的过程里把余额扣光,等成片做完
  // 再扣就成了「视频做出来了、钱却扣不到」= 我们亏。预扣 = 原子锁住这笔费用;成片失败
  // 再按 chargeId 幂等退回(refundMode1Video)。
  // 判定口径 = 是否用到在线素材(useStockVideo!==false):只要走在线素材库就收平台费,
  // 哪怕用户同时上传了自己的本地视频混拼也照收(在线搜索/下载 + AI 搜索词都是真实成本);
  // 仅当纯本地素材(useStockVideo===false,老任务路径)才不收平台费,只耗已实时扣过的 AI token。
  // 批量出片(videoCount>1):脚本/配音/素材池复用一次,N 条画面并发合成。计费随条数走
  // (服务端 /charge 按 videoCount + aiCostUsd 算):平台费向上限靠拢 + AI 费按条数线性叠加,
  // 在下面 compose 阶段开跑前【一次性】预扣这笔(含全部条数)总费。chargeId/refundOnExit
  // 跟踪这笔在途预扣,供「全部条目失败 / 异常」时 finally 兜底整笔退回。
  // engine==='ai'(Seedance 自动成片)的钱在服务端【逐片段】扣(/seedance/create,
  // 含 markup),且失败自动退款 —— 不再走这里的"平台基础费"预扣,避免重复收费。
  const isMode1 = input.engine !== 'ai' && input.useStockVideo !== false;
  let chargeId: string | undefined;
  let refundOnExit = false;

  // 临时素材目录(配音 + 下载的素材图)
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-vid-assets-'));

  // 出片目录开跑即确定,emit 一次让详情页顶部立刻能显示「输出目录」。
  // taskDir = 任务总目录(详情页顶部稳定指向它);destDir = 本次运行 <日期>/<批次号>/(实际写成片)。
  const { taskDir, runDir: destDir } = resolveOutputDirs(input);
  tracker.setOutputDir(taskDir);

  try {
    // 0. 文案:strict = 逐字用用户文案;ai = DeepSeek 写稿(用户文案作参考)。
    //    缺省兼容老任务:有 script → strict,无 → ai。
    throwIfAborted(signal);
    tracker.start('script', `输出目录:${taskDir}`);
    // 拉服务端可调配置(prompt 模板 + 各阈值)。拉不到 / 没登录 → 用内置默认,出片照常。
    const vcfg = await getVideoConfig();
    const userText = (input.script || '').trim();
    const scriptMode = input.scriptMode || (userText ? 'strict' : 'ai');
    // 内容语言:口播稿 + 素材搜索词都用它。规则(用户指定):有视频文案就按文案语言走,
    // 否则按关键词语言。空白时退化为中文。strict 模式逐字朗读用户文案,语言天然就是文案语言。
    const contentLang = detectLang(userText || (input.keywords || []).join(' '));
    // 本任务【写稿 + 搜索词】已扣的权威 USD 之和(含 reasoner ×3),供下面平台费预扣时
    // 按 videoCount 让服务端补收剩余 (count-1) 份 AI 费。AI 只调一次,各步累加进来。
    let aiCostUsd = 0;
    let script = userText;
    if (scriptMode === 'ai') {
      const topic = (input.keywords || []).filter(Boolean).join('、') || input.track || '生活方式';
      tracker.progress(userText
        ? `AI 正在参考你的文案撰写旁白（目标约 ${input.targetSeconds ?? 45}s）…`
        : `AI 正在撰写旁白脚本（目标约 ${input.targetSeconds ?? 45}s）…`);
      try {
        const r = await generateScript({
          topic,
          persona: input.persona,
          track: input.track,
          keywords: input.keywords,
          targetSeconds: input.targetSeconds ?? 45,
          referenceScript: userText || undefined,
          lang: contentLang,
        }, vcfg.scriptSystemTemplate);
        script = r.script;
        aiCostUsd += r.costUsd;
        tracker.addTokens(r.tokens, r.costUsd);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        tracker.fail('script', `AI 写脚本失败:${err.slice(0, 200)}`);
        return { ok: false, error: err.slice(0, 300) };
      }
      // 把 AI 写的完整口播文案打到日志里(用户点详情页能看到 AI 到底写了啥)。
      // 注意:不在这里 done('script') —— 拆句已并入本步,拆完再 done。
      tracker.progress(`📝 口播文案(约 ${script.length} 字):${script}`);
    } else {
      // strict:严格逐字用用户文案。空文案直接判错(理论上客户端已挡)。
      if (!script) {
        const err = '严格模式下视频文案不能为空';
        tracker.fail('script', err);
        return { ok: false, error: err };
      }
      tracker.progress(`📝 视频文案(约 ${script.length} 字 ≈ ${Math.round(script.length / 4.5)}s):${script}`);
    }

    // 拆句(并入「脚本」步:本地纯文本切分,无 AI、瞬时完成)。
    let sentences = splitScript(script);
    if (sentences.length === 0) {
      const err = '文案为空或无法拆出有效分镜';
      tracker.fail('script', err);
      return { ok: false, error: err };
    }
    // AI 自动成片(Seedance):把碎句合并成更长的「大分镜」(每段 ~8–12s 旁白)再 TTS,
    // 这样每段配一个 8–12s 的连续片段 → 切刀少、更流畅,且少踩 Seedance 单镜最短时长的浪费。
    // 在 TTS 之前合并,音频/字幕(词边界 cue)自然按合并后的段走,不破坏。
    if (input.engine === 'ai') {
      sentences = mergeSentencesForAi(sentences);
      // 硬上限 45s:targetSeconds 只是给 AI 的提示,AI 可能写超 → 这里按字数估时长(CJK ~4.5
      // 字/秒、拉丁 ~2.2)累加截断,保证纯 AI 成片【实际】不超 45s,杜绝写超长稿烧钱。
      const AI_MAX_SEC = 45;
      const cps = /[぀-ヿ㐀-鿿가-힯]/.test(sentences.join('')) ? 4.5 : 2.2;
      const maxChars = Math.round(AI_MAX_SEC * cps);
      let acc = 0;
      const capped: string[] = [];
      for (const s of sentences) { if (acc >= maxChars) break; capped.push(s); acc += s.length; }
      if (capped.length > 0 && capped.length < sentences.length) {
        tracker.progress(`✂️ 纯 AI 成片时长上限 ${AI_MAX_SEC}s:超出部分已截断(保留 ${capped.length} 段)`);
        sentences = capped;
      }
      tracker.progress(`🎬 AI 大分镜:合并为 ${sentences.length} 段(每段约 8–12 秒,更连贯)`);
    }

    // 文案本地留一份(txt):全文 + 分镜,放成片输出目录,方便用户复用/二改/存档。
    try {
      const txt = [
        `# ${input.taskTitle || '视频文案'}`,
        `生成时间: ${new Date().toLocaleString()}`,
        '',
        '【完整口播文案】',
        script,
        '',
        `【分镜 ${sentences.length} 句】`,
        ...sentences.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n');
      fs.writeFileSync(path.join(destDir, '文案.txt'), txt, 'utf8');
    } catch { /* 写文案 txt 失败不影响出片 */ }
    tracker.done('script', `脚本约 ${script.length} 字,拆出 ${sentences.length} 个分镜`);

    // 2. 逐句配音。同时收集 edge-tts 词边界字幕 cue,按各句在总时间轴上的累计起点
    //    偏移后合并成全局 cue(离线、精确,抄 MoneyPrinterTurbo);拿不到就让 compose 估算。
    // v6.x: 纯画面模式(仅 Seedance 可开)— 跳过 TTS、不烧字幕,镜头时长按分镜稿
    //   字数估算(5~10s,对 Seedance 片段硬限 [4,12] 友好)。其它模式恒为有旁白。
    const wantNarration = !(input.engine === 'ai' && input.narrationEnabled === false);
    // 每镜时长来源:有旁白 → 各句真实配音时长;纯画面 → 分镜稿字数估算。下游(Seedance
    //   生成 / 本地拼接 / compose)统一读 sceneDurations,不再直接摸 audios[i].durationSec。
    const sceneDurations: number[] = [];
    throwIfAborted(signal);
    tracker.start('tts');
    const audios: { audioPath: string; durationSec: number }[] = [];
    const subtitleCues: SubtitleCue[] = [];
    if (wantNarration) {
      let timelineOffset = 0;
      let synthCount = 0;
      for (let i = 0; i < sentences.length; i++) {
        const outMp3 = path.join(assetDir, `narr_${String(i).padStart(3, '0')}.mp3`);
        const r = await synthesize(sentences[i], outMp3, input.voice, input.voiceRate);
        if (!r.synthesized) {
          // 硬约束:必须有真人配音。某句重试 3 次仍合不出 → 立即终止(别再耗时间硬磨剩余句),
          // 判任务失败。pre-charge 预扣的平台基础费会在 finally 里自动退回(不交付无配音的视频)。
          const reason = getLastTtsError();
          const err = `配音失败:第 ${i + 1}/${sentences.length} 句无法合成语音`
            + (reason ? `(${reason.slice(0, 160)})` : '')
            + '。已终止出片,不会生成无配音的视频;平台基础费将自动退回。'
            + '常见原因:网络无法访问微软在线 TTS 接口,请检查网络/代理后重试。';
          tracker.fail('tts', err);
          return { ok: false, error: err };
        }
        audios.push({ audioPath: r.audioPath, durationSec: r.durationSec });
        sceneDurations.push(r.durationSec);
        synthCount++;
        if (r.cues && r.cues.length > 0) {
          for (const c of r.cues) {
            subtitleCues.push({ text: c.text, start: c.start + timelineOffset, end: c.end + timelineOffset });
          }
        }
        timelineOffset += r.durationSec;
        tracker.progress(`配音 ${i + 1}/${sentences.length}`);
      }
      tracker.done('tts', `配音完成(${synthCount} 句全部真人语音)`);
    } else {
      // 纯画面:每镜时长 = clamp(字数 / 4.5, 5, 10) 秒,跟着分镜稿内容走。
      for (let i = 0; i < sentences.length; i++) {
        sceneDurations.push(Math.max(5, Math.min(10, Math.ceil((sentences[i] || '').length / 4.5))));
      }
      tracker.done('tts', `纯画面模式 · 跳过配音,按分镜稿定时长(${sentences.length} 镜)`);
    }

    // 3. 画面:在线素材库(可叠加用户本地素材混拼);纯本地(老任务)走循环拼接。
    throwIfAborted(signal);
    tracker.start('visuals');

    // 用户上传的本地视频素材(已在 UI 限制格式 + 大小,这里再 existsSync 兜底)。
    const localVideos = (input.localVideos || []).filter((p) => p && fs.existsSync(p));
    // 是否用在线素材库:在线模式(useStockVideo!==false)即走在线 + 本地混拼;
    // 仅当明确关闭在线(纯本地,老任务路径)才完全离线循环拼本地素材。
    const usesStock = input.useStockVideo !== false;
    const maxClip = input.maxClipSeconds && input.maxClipSeconds > 0 ? input.maxClipSeconds : 4;
    // 一次出片条数(1~5)。抄 MPT:脚本/配音/素材池只做一次,每条只换片段组合。
    // AI 自动成片(Seedance)逐片段真金白银生成,批量没意义且翻倍烧钱 → 强制单条。
    const videoCount = input.engine === 'ai'
      ? 1
      : Math.max(1, Math.min(5, Math.round(input.videoCount ?? 1)));

    // Fisher–Yates 洗牌(不改原数组),用于批量出片时让每条的片段组合各不相同。
    const shuffled = <T,>(arr: T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // 画面分配器:给定第几条视频(0-based),产出该条的 { sceneClips, imagePool }。
    // 第 0 条按原顺序;后续条把素材池打乱再分配 → 同脚本/配音、不同画面。
    let assignVisuals: (videoIdx: number) => { sceneClips: string[][]; imagePool: string[]; imageByScene?: Map<number, string> };

    if (input.engine === 'ai') {
      // ── AI 自动成片(Seedance):逐镜生成视频片段,参考图(≤2)统一风格 ──
      // 服务端逐片段计费(时长×分辨率)+ 失败自动退款。失败镜降级:就近复用成功片段,
      // 再不行用参考图静帧;一条都没成则整任务失败(钱已被服务端退回)。
      const refImagesAi = (input.referenceImages || []).filter((p) => p && fs.existsSync(p)).slice(0, 2);
      // 档位/分辨率不在客户端定:透传(可能 undefined)→ 服务端 seedance create 端点决定。
      const resolution = input.seedanceResolution;
      const aiScenes = sentences.map((s, i) => ({
        prompt: buildSeedancePrompt(s, {
          track: input.track, persona: input.persona,
          lang: contentLang, isI2V: refImagesAi.length > 0, shotIndex: i,
        }),
        // Seedance 单镜上限 12s(1.x/lite),大分镜合并后某段可能超过 → clamp 到 [4,12]。
        durationSec: Math.max(4, Math.min(12, Math.ceil(sceneDurations[i]))),
      }));
      // ── 故事板模式:先用 Seedream 组图出每镜【首帧】(同角色/画风),再图生视频(i2v,更稳)──
      //   首帧也存一份到本次输出目录的「故事板」文件夹(用户要的本地存档)。
      //   故事板失败/未配置 → 退化为纯文生视频(不挂首帧),不阻塞。
      try {
        tracker.progress('🎨 生成故事板首帧(Seedream 组图,保持角色一致)…');
        const storyboard = await generateStoryboard({
          shots: aiScenes.map((sc) => sc.prompt),
          character: [input.persona, input.track].filter(Boolean).join(' · '),
          count: aiScenes.length,
        });
        const keyframes = storyboard.images;
        // 故事板首帧也是真金白银(Seedream 按张扣)—— 计入「本次消耗」,
        // 否则进度里图扣了费、总额却只剩 DeepSeek 写稿那几百,严重对不上。
        if (storyboard.chargedTokens > 0) {
          tracker.addTokens(storyboard.chargedTokens, storyboard.chargedTokens / 1_000_000);
        }
        if (keyframes.length > 0) {
          const sbDir = path.join(destDir, '故事板');
          try { fs.mkdirSync(sbDir, { recursive: true }); } catch { /* ignore */ }
          keyframes.forEach((dataUrl, i) => {
            if (i < aiScenes.length) (aiScenes[i] as SeedanceSceneSpec).keyframeDataUrl = dataUrl;
            try {
              const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
              if (m) {
                const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
                fs.writeFileSync(path.join(sbDir, `镜${i + 1}.${ext}`), Buffer.from(m[2], 'base64'));
              }
            } catch { /* 单张存盘失败不影响 */ }
          });
          tracker.progress(`🎨 故事板已生成 ${keyframes.length} 张首帧(已存「故事板」文件夹),转图生视频…`);
        } else {
          tracker.progress('🎨 故事板未生成,退化为文生视频…');
        }
      } catch { /* 故事板异常 → 退化文生视频 */ }
      tracker.progress(`🎬 AI 自动成片:逐镜生成 ${aiScenes.length} 个片段${resolution ? `(${resolution})` : ''}${refImagesAi.length ? ` · ${refImagesAi.length} 张参考图统一风格` : ''}…`);
      const clipResults = await generateSeedanceClips({
        scenes: aiScenes,
        referenceImages: refImagesAi,
        resolution,
        tier: input.seedanceModel,
        ratio: aspectToSeedanceRatio(input.aspect),
        destDir: assetDir,
        onProgress: (m) => tracker.progress(m),
        signal,
      });
      // Seedance 逐镜扣费计入「本次消耗」—— 否则只统计了 DeepSeek 写稿(几百积分),
      // 用户看到「本次消耗 435」却实际被逐镜扣了上百万积分,严重对不上。只计【成功镜】
      // (失败镜服务端已退);costUsd 按 1 USDT=1M tokens 折算(= 积分/1e6)供 $ 展示。
      const seedanceCharged = clipResults.filter((r) => r.path).reduce((s, r) => s + (r.chargedTokens || 0), 0);
      if (seedanceCharged > 0) tracker.addTokens(seedanceCharged, seedanceCharged / 1_000_000);
      const okCount = clipResults.filter((r) => r.path).length;
      if (okCount === 0) {
        // 原始 sample(如 "fetch failed")只打到 console 供排查,不展示给用户;
        // 用户面只给通用文案(退费由服务端按计费政策处理:有 token 输出不退、0 输出才退,不在文案里承诺)。
        const sample = clipResults.find((r) => r.error)?.error || '';
        if (sample) { try { console.error('[seedance] all shots failed, sample error:', sample); } catch { /* ignore */ } }
        const err = 'AI 自动成片暂时没出片,请稍后重试。';
        tracker.fail('visuals', err);
        return { ok: false, error: err };
      }
      assignVisuals = () => {
        const sceneClips = clipResults.map((r, i) => {
          if (r.path) return [r.path];
          const near = findNearestClip(clipResults, i);
          return near ? [near] : [];
        });
        // 既无本镜片段又借不到邻镜的(极端)→ 用参考图静帧兜底。
        const imageByScene = new Map<number, string>();
        if (refImagesAi.length > 0) {
          clipResults.forEach((r, i) => {
            if (!r.path && !findNearestClip(clipResults, i)) imageByScene.set(i, refImagesAi[i % refImagesAi.length]);
          });
        }
        return { sceneClips, imagePool: refImagesAi, imageByScene };
      };
      // AI 生成的片段本地留一份:assetDir 是临时目录(结尾会清掉),拷到成片输出目录的
      // 「素材」子文件夹,供用户复用/二剪/排查(对齐"成片+文案+素材"一起留档)。
      try {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        let saved = 0;
        clipResults.forEach((r, i) => {
          if (r.path && fs.existsSync(r.path)) {
            try { fs.copyFileSync(r.path, path.join(matDir, `第${i + 1}镜_${path.basename(r.path)}`)); saved++; } catch { /* 单个拷贝失败忽略 */ }
          }
        });
        if (saved > 0) tracker.progress(`📁 已在「素材」子目录留存 ${saved} 个 AI 片段(可复用/二剪)`);
      } catch { /* 留存失败不影响出片 */ }
      // 不向用户暴露「X/Y 镜 + 其余就近降级」(失败镜回退是内部兜底,用户不需要知道)。
      tracker.done('visuals', `🎬 AI 画面就绪(${aiScenes.length} 镜)`);
    } else if (!usesStock && localVideos.length > 0) {
      // 纯本地素材:不搜在线、不花 DeepSeek 搜索词钱,按换镜节奏循环拼接,素材少就复用。
      tracker.progress(`使用本地视频素材 ${localVideos.length} 个,按换镜节奏循环拼接…`);
      assignVisuals = (videoIdx: number) => {
        // 每条错开起始游标 → 同样的本地素材排出不同组合。
        let localCursor = videoIdx;
        const sceneClips = sentences.map((_, i) => {
          const dur = Math.max(1.2, sceneDurations[i]);
          const want = Math.max(1, Math.min(8, Math.ceil(dur / maxClip)));
          const clips: string[] = [];
          for (let k = 0; k < want; k++) clips.push(localVideos[localCursor++ % localVideos.length]);
          return clips;
        });
        return { sceneClips, imagePool: [] };
      };
      tracker.done('visuals', `画面就绪(本地素材 ${localVideos.length} 个${videoCount > 1 ? ` · ${videoCount} 条各不同组合` : ''})`);
    } else {
      // 在线素材库(若有本地上传则混拼:本地片段优先露出 + 在线空镜补满)。
      // 素材池只建一次,assign(shuffle) 供每条按需取片段。
      const pool = await buildStockPool();
      assignVisuals = (videoIdx: number) => ({
        sceneClips: pool.assign(videoIdx > 0),
        imagePool: pool.imagePool,
        imageByScene: pool.imageByScene,
      });
    }

    // 在线素材库分支:AI 搜索词 → 逐词拉视频 → 图片补位 → 返回 { assign, imagePool }。
    // 抽成闭包是为了让本地上传时整段跳过(省时间 + 省 DeepSeek token);
    // assign(shuffle) 可被批量出片重复调用,每次用 fresh usedVideo 集分配。
    async function buildStockPool(): Promise<{ assign: (shuffle: boolean) => string[][]; imagePool: string[]; imageByScene: Map<number, string> }> {
    // 3a. 让 DeepSeek 给每个分镜配 1-3 个英文搜索词(画面跟着内容走)
    tracker.progress('AI 规划每镜画面关键词…');
    // A:把整条视频的主题/赛道/人设/关键词当语境喂给映射模型,让每镜的词锁定选题。
    const termsTopic = (input.keywords || []).filter(Boolean).join('、') || input.track || '';
    const termsResult = await generateSearchTerms(sentences, input.keywords, vcfg.termsSystemPrompt, {
      topic: termsTopic,
      persona: input.persona,
      track: input.track,
      keywords: input.keywords,
      lang: contentLang,  // 让人物镜头按内容语言加地区人种倾向(中文→asian),免得搜出全是老外
    });
    const perSceneTerms = termsResult.terms.map((arr) => (arr || []).map((s) => s.toLowerCase()));
    aiCostUsd += termsResult.costUsd;
    tracker.addTokens(termsResult.tokens, termsResult.costUsd);

    // 要去搜的词集:每镜首词优先(保证每个分镜的主画面词一定被搜到),再补其余词。
    const primaryTerms = Array.from(new Set(perSceneTerms.map((t) => t[0]).filter(Boolean)));
    const extraTerms = Array.from(new Set(perSceneTerms.flat().filter(Boolean)))
      .filter((t) => !primaryTerms.includes(t));
    // C:有效上限至少容得下【所有去重首词】(否则首词被砍的镜只能借全局 → 跑题),
    // 再封个硬顶 24 防极端长稿逐词搜请求过多;config 的 maxSearchTerms 作下限基线。
    const HARD_TERM_CAP = 24;
    const effectiveTermCap = Math.max(vcfg.maxSearchTerms, Math.min(primaryTerms.length, HARD_TERM_CAP));
    let searchTerms = [...primaryTerms, ...extraTerms].slice(0, effectiveTermCap);
    if (searchTerms.length === 0) {
      searchTerms = (input.keywords || []).map((s) => s.toLowerCase()).filter(Boolean);
    }
    if (searchTerms.length > 0) {
      tracker.progress(`🔍 画面搜索词:${searchTerms.join(', ')}`);
    }

    const refImages = (input.referenceImages || []).filter((p) => p && fs.existsSync(p));
    const wantVideo = input.useStockVideo !== false;
    const orientation = aspectToOrientation(input.aspect);

    // 3b. 逐词拉视频,保留「词 → 素材」归属(进度逐词回报,不再"没动静")
    // 每词下载几段【随出片条数缩放】:单条只需 ~1 段/词,多条才需多备(N 条不重复靠
    // 同词下的不同段轮流分配)。videoCount=1→2 段/词(够覆盖且最快),videoCount=5→封顶
    // vcfg.perTermCount(=6)。这是搜索耗时的主因——以前不论出几条都按 6 段/词下载,
    // 单条视频会白下 3 倍素材;按需缩放后单条下载量直接砍半。
    // C:每词至少备 3 段(原 2)。本镜词够用就不必借全局,关联更稳;多条出片再按需上探。
    const perTermCount = Math.max(3, Math.min(vcfg.perTermCount, videoCount + 2));
    let videoByTerm: StockVideoByTerm[] = [];
    if (wantVideo && searchTerms.length > 0) {
      tracker.progress(`搜索在线视频素材(共 ${searchTerms.length} 组关键词)…`);
      videoByTerm = await fetchStockVideosByTerms({
        terms: searchTerms,
        perTermCount,
        destDir: assetDir,
        orientation,
        // 英文词 + 内容语言 locale 兜底;size 让 Pexels 源头按档过滤(默认 small=HD≥720),省下白下白删。
        locale: localeFor(vcfg, contentLang),
        videoSize: vcfg.stockVideoSize,
        minVideoEdge: vcfg.minVideoEdge,
        minVideoSec: vcfg.minVideoSec,
        onProgress: ({ phase, done, total, term, totalGot, clip }) =>
          tracker.progress(phase === 'search'
            // 搜索阶段(并发):done=已搜完词数。
            ? `搜索关键词 ${done}/${total}「${term}」…`
            : clip
              // 下载阶段段级心跳:done=已完成词数,当前是第 done+1 个词下载中,段 index/count。
              ? `下载视频素材 词 ${done + 1}/${total}「${term}」· 段 ${clip.index}/${clip.count}(累计 ${totalGot} 段)`
              : `下载视频素材 ${done}/${total}:「${term}」(累计 ${totalGot} 段)`),
      });
    }

    // 建「词 → 该词的视频队列」(持久池)+ 全局视频列表;分配时各镜按自己的词取,用尽再借全局。
    const poolByTerm = new Map<string, StockVideoAsset[]>();
    for (const g of videoByTerm) poolByTerm.set(g.term.toLowerCase(), [...g.assets]);
    const allVideos: StockVideoAsset[] = videoByTerm.flatMap((g) => g.assets);

    // 用户本地素材混拼:把本地片段【均匀铺】到各分镜(每段大致出现一次),作为该镜
    // 的首选片段,其余位置再用在线空镜补满 → 本地 + 在线混着拼。无本地素材时此 map 为空,
    // 行为与纯在线完全一致。本地片段数 > 分镜数时,多出的会落到同一镜(成为该镜的额外段)。
    const localForScene = new Map<number, string[]>();
    if (localVideos.length > 0 && sentences.length > 0) {
      localVideos.forEach((clip, j) => {
        const idx = Math.min(sentences.length - 1, Math.round((j * sentences.length) / localVideos.length));
        const arr = localForScene.get(idx) || [];
        arr.push(clip);
        localForScene.set(idx, arr);
      });
      tracker.progress(`混入本地视频素材 ${localVideos.length} 个(优先露出,在线空镜补满)`);
    }

    // 单条视频的片段分配:每次用 fresh usedVideo 集 + (批量时)打乱后的素材队列,
    // 让批量出片的每条画面组合都不同。同一份持久池,各条互不影响。
    const assignOnce = (shuffle: boolean): string[][] => {
      const usedVideo = new Set<string>();
      const workByTerm = new Map<string, StockVideoAsset[]>();
      for (const [k, v] of poolByTerm) workByTerm.set(k, shuffle ? shuffled(v) : [...v]);
      const workAll = shuffle ? shuffled(allVideos) : [...allVideos];

      // 取一段【本条还没用过】的素材:先本镜搜索词命中,再借全局。都没有返 undefined。
      const takeFreshClip = (i: number): string | undefined => {
        for (const term of perSceneTerms[i] || []) {
          const q = workByTerm.get(term);
          if (q) {
            const v = q.find((a) => !usedVideo.has(a.path));
            if (v) { usedVideo.add(v.path); return v.path; }
          }
        }
        const any = workAll.find((a) => !usedVideo.has(a.path));
        if (any) { usedVideo.add(any.path); return any.path; }
        return undefined;
      };

      // 该镜要几段素材 = ceil(时长 / maxClip),换镜节奏越快段数越多(封顶 8)。
      // 先放用户本地素材(优先露出),再尽量取新鲜在线素材补满;都没有则上层退图片/文字卡。
      const pickClipsForScene = (i: number): string[] => {
        const dur = Math.max(1.2, audios[i].durationSec);
        const want = Math.max(1, Math.min(8, Math.ceil(dur / maxClip)));
        const clips: string[] = [];
        for (const lc of localForScene.get(i) || []) {
          if (clips.length >= want) break;
          clips.push(lc);
        }
        while (clips.length < want) {
          const fresh = takeFreshClip(i);
          if (fresh) clips.push(fresh);
          else break;
        }
        return clips; // 可能为空(无任何素材)→ 上层退图片/文字卡
      };

      return sentences.map((_, i) => pickClipsForScene(i));
    };

    // 用第一条(不打乱)的分配统计覆盖率 + 决定补位图片数量(各条覆盖率相近,算一次即可)。
    const probe = assignOnce(false);
    const scenesWithoutVideo = probe.filter((c) => c.length === 0).length;
    const totalClipsUsed = probe.reduce((n, c) => n + c.length, 0);
    const localUsed = localVideos.length > 0
      ? probe.reduce((n, c) => n + c.filter((p) => localVideos.includes(p)).length, 0)
      : 0;

    // 3c. 视频没覆盖到的分镜补图。D:按【该镜自己的搜索词】分组搜图,让补位图也贴该镜内容,
    //     而不是从全局词汤里随便挑一张。建 imageByScene(镜号→图)精确回填;另留扁平
    //     imagePool 兜底(批量出片打乱后,某条里没覆盖的镜可能不在 map 内,用它顶上)。
    const uncoveredIdx = probe.map((c, i) => (c.length === 0 ? i : -1)).filter((i) => i >= 0);
    const imageByScene = new Map<number, string>();
    const flatImages: string[] = [];
    if (uncoveredIdx.length > 0 && (searchTerms.length > 0 || refImages.length > 0)) {
      tracker.progress('补充在线图片素材(按各镜内容)…');
      // 先把用户参考图按顺序铺给最前面没覆盖的镜(参考图本就是用户想露出的画面)。
      let ri = 0;
      for (const idx of uncoveredIdx) {
        if (ri >= refImages.length) break;
        imageByScene.set(idx, refImages[ri++]);
      }
      // 其余没覆盖的镜:按各自首词(空则退全局首词/keywords)分组,逐词搜图后回填。
      const byTerm = new Map<string, number[]>();
      for (const idx of uncoveredIdx) {
        if (imageByScene.has(idx)) continue;
        const term = (perSceneTerms[idx] && perSceneTerms[idx][0])
          || searchTerms[0] || (input.keywords || []).map((s) => s.toLowerCase())[0] || '';
        if (!term) continue;
        const arr = byTerm.get(term) || [];
        arr.push(idx);
        byTerm.set(term, arr);
      }
      // 逐词搜图,总量封顶 20(避免长稿请求过多)。每词要够覆盖该词下的所有镜。
      let budget = 20;
      for (const [term, idxs] of byTerm) {
        if (budget <= 0) break;
        const want = Math.min(idxs.length, budget);
        const imgs = await fetchStockImages({
          keywords: [term],
          count: want,
          destDir: assetDir,
          orientation,
          minImageEdge: vcfg.minImageEdge,
        });
        budget -= imgs.length;
        imgs.forEach((p, k) => { if (idxs[k] !== undefined) imageByScene.set(idxs[k], p); });
        flatImages.push(...imgs);
      }
    }
    const imagePool = [...flatImages, ...refImages];

    tracker.done('visuals',
      (totalClipsUsed > 0 || imageByScene.size > 0 || imagePool.length > 0)
        ? `画面就绪(视频 ${totalClipsUsed} 段${localUsed > 0 ? `（含本地 ${localUsed} 段）` : ''} → 覆盖 ${sentences.length - scenesWithoutVideo}/${sentences.length} 镜,图片 ${imageByScene.size} 张按镜补位${videoCount > 1 ? ` · ${videoCount} 条各不同组合` : ''})`
        : '无可用素材,使用文字卡');

    // 在线素材原文件本地留一份(对齐 AI 分支):assetDir 是临时目录、结尾会清掉,把下载的
    // 在线视频/图片拷到成片输出目录的「素材」子文件夹,供用户复用 / 二剪 / 排查。
    // 只存下载的在线素材(allVideos + flatImages),不含用户自己的本地上传/参考图。
    try {
      const stockFiles = [...allVideos.map((v) => v.path), ...flatImages]
        .filter((p) => p && fs.existsSync(p));
      if (stockFiles.length > 0) {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        let saved = 0;
        const seen = new Set<string>();
        stockFiles.forEach((src, i) => {
          if (seen.has(src)) return;
          seen.add(src);
          try { fs.copyFileSync(src, path.join(matDir, `${String(i + 1).padStart(3, '0')}_${path.basename(src)}`)); saved++; } catch { /* 单个拷贝失败忽略 */ }
        });
        if (saved > 0) tracker.progress(`📁 已在「素材」子目录留存 ${saved} 个在线素材(可复用 / 二剪)`);
      }
    } catch { /* 留档失败不影响出片 */ }

    return { assign: assignOnce, imagePool, imageByScene };
    } // end buildStockPool

    // 4. 组装分镜 + 合成。批量出片时并发跑 videoCount 条(封顶 2 条同时跑):同脚本/配音、每条不同画面组合。
    //    费用(平台费向上限靠拢 + AI 按条数叠加)开跑前【一次性】整笔预扣,全部失败才整笔退回。
    throwIfAborted(signal);
    tracker.start('compose');

    const { width, height } = aspectToSize(input.aspect);
    // 纯画面模式(无旁白)→ 无旁白文本时间轴,强制关字幕。
    const subtitleEnabled = wantNarration && input.subtitleEnabled !== false;
    const subtitle: SubtitleStyle = {
      enabled: subtitleEnabled,
      fontSize: input.subtitleFontSize && input.subtitleFontSize > 0 ? input.subtitleFontSize : 52,
      position: input.subtitlePosition || 'bottom',
      color: input.subtitleColor,
      strokeColor: input.subtitleStrokeColor,
      fontFile: input.subtitleFont,
    };

    // BGM 解析(全条共用,只解析一次):builtin:<id> → 随包路径;remote:<url> → 按需下载
    // 并缓存(命中缓存不重下);用户上传的绝对路径原样返回。再统一过 existsSync 兜底
    // (取不到 = 不加 BGM,不挡出片)。
    const resolvedBgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m));
    const bgmPath = resolvedBgm && fs.existsSync(resolvedBgm) ? resolvedBgm : undefined;
    if (input.bgmPath && !bgmPath) tracker.progress('⚠️ 背景音乐获取失败，本条将不加 BGM');
    if (subtitleEnabled) {
      tracker.progress(subtitleCues.length > 0
        ? `字幕时间轴就绪(edge-tts 词边界,共 ${subtitleCues.length} 段)`
        : '字幕按各镜时长估算(未取到词边界时间轴)');
    }

    // 费用预扣:开跑前【一次性】整笔预扣(在线模式),金额由服务端按 videoCount + aiCostUsd 算
    // (平台费向上限靠拢 + AI 费按条数叠加)。全部条目都失败时才在 finally 按 chargeId 整笔退回(幂等)。
    if (isMode1) {
      const charge = await chargeMode1Video(input.targetSeconds ?? 45, { videoCount, aiCostUsd });
      if (!charge.ok) {
        let err: string;
        if (charge.reason === 'insufficient') err = '余额不足,无法生成(模式一需先预扣平台基础费,请充值后重试)';
        else if (charge.reason === 'no_auth') err = '未登录 NoobClaw,无法生成';
        else err = '平台基础费预扣失败,请稍后重试';
        tracker.fail('compose', err);
        return { ok: false, error: err };
      }
      chargeId = charge.chargeId;
      refundOnExit = true;
      tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);
      tracker.progress(videoCount > 1
        ? `💎 已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}，准备生成 ${videoCount} 条视频），失败将自动退回`
        : `💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}），失败将自动退回`);
    }

    // 单条合成:组装本条画面组合(第 0 条原序、之后打乱)→ composeVideo,成功返回成片路径,失败抛错。
    const composeOne = async (v: number): Promise<string> => {
      const label = videoCount > 1 ? `第 ${v + 1}/${videoCount} 条` : '';
      const { sceneClips, imagePool, imageByScene } = assignVisuals(v);
      let imgCursor = 0;
      const scenes: SceneSpec[] = sentences.map((sentence, i) => {
        const clips = sceneClips[i];
        const hasVideo = clips.length > 0;
        // D:无视频的镜优先用「按本镜内容搜来的图」(imageByScene);没有再退扁平池轮转。
        const image = hasVideo ? undefined
          : (imageByScene?.get(i)
            ?? (imagePool.length > 0 ? imagePool[imgCursor++ % imagePool.length] : undefined));
        return {
          clips: hasVideo ? clips : undefined,
          imagePath: image,
          audioPath: wantNarration ? audios[i].audioPath : undefined,
          durationSec: sceneDurations[i],
          subtitle: sentence,
        };
      });
      const outPath = path.join(destDir, outputFileName(v));
      await composeVideo({
        scenes,
        outputPath: outPath,
        width,
        height,
        maxClipSeconds: maxClip,
        subtitle,
        narration: wantNarration,
        bgmPath,
        bgmVolume: input.bgmVolume !== undefined && input.bgmVolume >= 0 ? input.bgmVolume : undefined,
        // edge-tts 词边界出的精确 cue;为空时 compose 内部退回按各镜时长估算。
        cues: subtitleEnabled && subtitleCues.length > 0 ? subtitleCues : undefined,
        onScene: (done, total) => tracker.progress(`${label ? label + ' · ' : ''}合成分镜 ${done}/${total}`),
      });
      if (videoCount > 1) tracker.progress(`✅ ${label} 合成完成`);
      return outPath;
    };

    // 并发出片但【封顶 2 条同时合成】:ffmpeg 是重 CPU/内存活,5 条全开会互相抢资源、
    // 反而整体更慢甚至 OOM。顺序保留 + allSettled 语义(个别失败不拖累其余):用固定
    // 2 个 worker 轮流领下一条,结果按下标回填,与原 Promise.allSettled 收集行为一致。
    const runWithLimit = async <T,>(
      count: number,
      limit: number,
      task: (i: number) => Promise<T>,
    ): Promise<PromiseSettledResult<T>[]> => {
      const results = new Array<PromiseSettledResult<T>>(count);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < count) {
          const i = next++;
          try {
            results[i] = { status: 'fulfilled', value: await task(i) };
          } catch (e) {
            results[i] = { status: 'rejected', reason: e };
          }
        }
      };
      const n = Math.max(1, Math.min(limit, count));
      await Promise.all(Array.from({ length: n }, () => worker()));
      return results;
    };

    // 跑全部条目(并发封顶 2),收集成功的成片路径。
    const settled = await runWithLimit(videoCount, 2, (v) => composeOne(v));
    const outputPaths: string[] = [];
    let failCount = 0;
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        outputPaths.push(r.value);
      } else {
        failCount++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        tracker.progress(`⚠️ 有一条合成失败:${msg.slice(0, 160)}`);
      }
    }

    if (outputPaths.length === 0) {
      // 全部失败:保持 refundOnExit=true,finally 整笔退回预扣的费用(平台 + AI 叠加份)。
      const err = '所有视频合成失败,未生成任何成片';
      tracker.fail('compose', err);
      return { ok: false, error: err };
    }

    // 至少一条成功 → 整笔费用照收(已按 videoCount 预扣),不退回。
    refundOnExit = false;
    // 结尾把【本次实际写片的目录】打出来,方便用户直接点过去(destDir = 任务/日期/批次号)。
    tracker.progress(videoCount > 1 && failCount > 0
      ? `🎉 已生成 ${outputPaths.length}/${videoCount} 条（${failCount} 条失败,费用已按 ${videoCount} 条预扣） · 📂 输出目录:${destDir}`
      : `🎉 已生成 ${outputPaths.length} 条 · 📂 输出目录:${destDir}`);
    tracker.finish(outputPaths[0], outputPaths.length);
    return { ok: true, outputPath: outputPaths[0], outputPaths };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    tracker.fail('compose', err.slice(0, 300));
    return { ok: false, error: err.slice(0, 300) };
  } finally {
    // 成片失败 → 退回开跑前预扣的平台基础费(幂等,按 chargeId;退不掉只记日志不影响清理)。
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded
          ? '↩️ 成片失败，已退回预扣的平台基础费'
          : '⚠️ 成片失败，平台基础费退回请求未成功（稍后可联系客服核对）');
      } catch { /* 退款失败仅忽略,不影响清理 */ }
    }
    // 清理临时素材(成片已落到 Documents)
    try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch {}
  }
}
