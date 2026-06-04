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
import { randomUUID } from 'crypto';
import { getHomePath } from '../platformAdapter';
import { isFfmpegAvailable } from './ffmpegRuntime';
import { synthesize, getLastTtsError } from './tts';
import { fetchStockImages, fetchStockVideosByTerms, type StockVideoAsset, type StockVideoByTerm, type StockOrientation } from './stockProvider';
import { composeVideo, type SceneSpec, type SubtitleStyle, type SubtitleCue } from './compose';
import { generateScript, generateSearchTerms, detectLang } from './scriptWriter';
import { getVideoConfig, localeFor } from './videoConfig';
import { chargeMode1Video, refundMode1Video } from './billing';
import { resolveBgmPath } from './bgm';

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
  /** 每段素材最长秒数(换镜节奏)。默认 4,越小换镜越快。 */
  maxClipSeconds?: number;
  /**
   * 一次出片数量(1~5)。抄 MoneyPrinterTurbo:复用同一份脚本 + 配音,
   * 只对每条做不同的素材片段组合,平台费按条数 ×N。默认 1。
   */
  videoCount?: number;
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
}

export interface VideoCreationResult {
  ok: boolean;
  /** 首条成片路径(兼容老调用 / 单条场景)。 */
  outputPath?: string;
  /** 批量出片时的全部成片路径(videoCount>1 时长度>1)。 */
  outputPaths?: string[];
  error?: string;
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

class ProgressTracker {
  private steps: ProgressStep[];
  // 累计 token + USD 成本 + 输出目录随每次 emit 带回,渲染端无需自己算。
  private tokensUsed = 0;
  private costUsd = 0;
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
  finish(outputPath: string) {
    this.steps.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    this.send('done', undefined, { outputPath });
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

function outputFileName(index = 0): string {
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
export async function generateVideo(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
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

  let result: VideoCreationResult;
  try {
    result = await runVideoPipeline(input, wrappedEmit);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
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
): Promise<VideoCreationResult> {
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
  const isMode1 = input.useStockVideo !== false;
  let chargeId: string | undefined;
  let refundOnExit = false;

  // 临时素材目录(配音 + 下载的素材图)
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-vid-assets-'));

  // 出片目录开跑即确定,emit 一次让详情页顶部立刻能显示「输出目录」。
  const destDir = outputDir();
  tracker.setOutputDir(destDir);

  try {
    // 0. 文案:strict = 逐字用用户文案;ai = DeepSeek 写稿(用户文案作参考)。
    //    缺省兼容老任务:有 script → strict,无 → ai。
    tracker.start('script', `输出目录:${destDir}`);
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
    const sentences = splitScript(script);
    if (sentences.length === 0) {
      const err = '文案为空或无法拆出有效分镜';
      tracker.fail('script', err);
      return { ok: false, error: err };
    }
    tracker.done('script', `脚本约 ${script.length} 字,拆出 ${sentences.length} 个分镜`);

    // 2. 逐句配音。同时收集 edge-tts 词边界字幕 cue,按各句在总时间轴上的累计起点
    //    偏移后合并成全局 cue(离线、精确,抄 MoneyPrinterTurbo);拿不到就让 compose 估算。
    tracker.start('tts');
    const audios: { audioPath: string; durationSec: number }[] = [];
    const subtitleCues: SubtitleCue[] = [];
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

    // 3. 画面:在线素材库(可叠加用户本地素材混拼);纯本地(老任务)走循环拼接。
    tracker.start('visuals');

    // 用户上传的本地视频素材(已在 UI 限制格式 + 大小,这里再 existsSync 兜底)。
    const localVideos = (input.localVideos || []).filter((p) => p && fs.existsSync(p));
    // 是否用在线素材库:在线模式(useStockVideo!==false)即走在线 + 本地混拼;
    // 仅当明确关闭在线(纯本地,老任务路径)才完全离线循环拼本地素材。
    const usesStock = input.useStockVideo !== false;
    const maxClip = input.maxClipSeconds && input.maxClipSeconds > 0 ? input.maxClipSeconds : 4;
    // 一次出片条数(1~5)。抄 MPT:脚本/配音/素材池只做一次,每条只换片段组合。
    const videoCount = Math.max(1, Math.min(5, Math.round(input.videoCount ?? 1)));

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
    let assignVisuals: (videoIdx: number) => { sceneClips: string[][]; imagePool: string[] };

    if (!usesStock && localVideos.length > 0) {
      // 纯本地素材:不搜在线、不花 DeepSeek 搜索词钱,按换镜节奏循环拼接,素材少就复用。
      tracker.progress(`使用本地视频素材 ${localVideos.length} 个,按换镜节奏循环拼接…`);
      assignVisuals = (videoIdx: number) => {
        // 每条错开起始游标 → 同样的本地素材排出不同组合。
        let localCursor = videoIdx;
        const sceneClips = sentences.map((_, i) => {
          const dur = Math.max(1.2, audios[i].durationSec);
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
      });
    }

    // 在线素材库分支:AI 搜索词 → 逐词拉视频 → 图片补位 → 返回 { assign, imagePool }。
    // 抽成闭包是为了让本地上传时整段跳过(省时间 + 省 DeepSeek token);
    // assign(shuffle) 可被批量出片重复调用,每次用 fresh usedVideo 集分配。
    async function buildStockPool(): Promise<{ assign: (shuffle: boolean) => string[][]; imagePool: string[] }> {
    // 3a. 让 DeepSeek 给每个分镜配 1-3 个英文搜索词(画面跟着内容走)
    tracker.progress('AI 规划每镜画面关键词…');
    const termsResult = await generateSearchTerms(sentences, input.keywords, vcfg.termsSystemPrompt);
    const perSceneTerms = termsResult.terms.map((arr) => (arr || []).map((s) => s.toLowerCase()));
    aiCostUsd += termsResult.costUsd;
    tracker.addTokens(termsResult.tokens, termsResult.costUsd);

    // 要去搜的词集:每镜首词优先(保证每个分镜的主画面词一定被搜到),
    // 再补其余词,整体封顶 12 个,避免逐词搜请求过多拖慢。
    const primaryTerms = Array.from(new Set(perSceneTerms.map((t) => t[0]).filter(Boolean)));
    const extraTerms = Array.from(new Set(perSceneTerms.flat().filter(Boolean)))
      .filter((t) => !primaryTerms.includes(t));
    let searchTerms = [...primaryTerms, ...extraTerms].slice(0, vcfg.maxSearchTerms);
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
    // 换镜节奏开了之后单镜要多段素材,多拉点冗余(perTermCount=6)。
    let videoByTerm: StockVideoByTerm[] = [];
    if (wantVideo && searchTerms.length > 0) {
      tracker.progress(`搜索在线视频素材(共 ${searchTerms.length} 组关键词)…`);
      videoByTerm = await fetchStockVideosByTerms({
        terms: searchTerms,
        perTermCount: vcfg.perTermCount,
        destDir: assetDir,
        orientation,
        // 英文词 + 内容语言 locale 兜底;size 让 Pexels 源头按档过滤(默认 small=HD≥720),省下白下白删。
        locale: localeFor(vcfg, contentLang),
        videoSize: vcfg.stockVideoSize,
        minVideoEdge: vcfg.minVideoEdge,
        minVideoSec: vcfg.minVideoSec,
        onProgress: ({ done, total, term, totalGot }) =>
          tracker.progress(`搜索在线视频素材 ${done}/${total}:「${term}」(累计 ${totalGot} 段)`),
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

    // 3c. 视频没覆盖到的分镜,用参考图 + 在线素材图补齐(图片仍走聚合搜,影响小)
    const needImages = Math.max(0, Math.min(20, scenesWithoutVideo - refImages.length));
    let stockImages: string[] = [];
    if (needImages > 0 && searchTerms.length > 0) {
      tracker.progress('补充在线图片素材…');
      stockImages = await fetchStockImages({
        keywords: searchTerms.slice(0, 8),
        count: needImages,
        destDir: assetDir,
        orientation,
        minImageEdge: vcfg.minImageEdge,
      });
    }
    const imagePool = [...refImages, ...stockImages];

    tracker.done('visuals',
      (totalClipsUsed > 0 || imagePool.length > 0)
        ? `画面就绪(视频 ${totalClipsUsed} 段${localUsed > 0 ? `（含本地 ${localUsed} 段）` : ''} → 覆盖 ${sentences.length - scenesWithoutVideo}/${sentences.length} 镜,图片 ${imagePool.length} 张补位${videoCount > 1 ? ` · ${videoCount} 条各不同组合` : ''})`
        : '无可用素材,使用文字卡');

    return { assign: assignOnce, imagePool };
    } // end buildStockPool

    // 4. 组装分镜 + 合成。批量出片时【并发】跑 videoCount 条:同脚本/配音、每条不同画面组合。
    //    费用(平台费向上限靠拢 + AI 按条数叠加)开跑前【一次性】整笔预扣,全部失败才整笔退回。
    tracker.start('compose');

    const { width, height } = aspectToSize(input.aspect);
    const subtitleEnabled = input.subtitleEnabled !== false;
    const subtitle: SubtitleStyle = {
      enabled: subtitleEnabled,
      fontSize: input.subtitleFontSize && input.subtitleFontSize > 0 ? input.subtitleFontSize : 52,
      position: input.subtitlePosition || 'bottom',
      color: input.subtitleColor,
      strokeColor: input.subtitleStrokeColor,
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
        ? `💎 已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}，${videoCount} 条:平台费向上限靠拢 + AI 费按条数叠加），失败将自动退回`
        : `💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}），失败将自动退回`);
    }

    // 单条合成:组装本条画面组合(第 0 条原序、之后打乱)→ composeVideo,成功返回成片路径,失败抛错。
    const composeOne = async (v: number): Promise<string> => {
      const label = videoCount > 1 ? `第 ${v + 1}/${videoCount} 条` : '';
      const { sceneClips, imagePool } = assignVisuals(v);
      let imgCursor = 0;
      const scenes: SceneSpec[] = sentences.map((sentence, i) => {
        const clips = sceneClips[i];
        const hasVideo = clips.length > 0;
        const image = !hasVideo && imagePool.length > 0 ? imagePool[imgCursor++ % imagePool.length] : undefined;
        return {
          clips: hasVideo ? clips : undefined,
          imagePath: image,
          audioPath: audios[i].audioPath,
          durationSec: audios[i].durationSec,
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
        bgmPath,
        bgmVolume: input.bgmVolume !== undefined && input.bgmVolume >= 0 ? input.bgmVolume : undefined,
        // edge-tts 词边界出的精确 cue;为空时 compose 内部退回按各镜时长估算。
        cues: subtitleEnabled && subtitleCues.length > 0 ? subtitleCues : undefined,
        onScene: (done, total) => tracker.progress(`${label ? label + ' · ' : ''}合成分镜 ${done}/${total}`),
      });
      if (videoCount > 1) tracker.progress(`✅ ${label} 合成完成`);
      return outPath;
    };

    // 并发跑全部条目(allSettled:个别失败不拖累其余),收集成功的成片路径。
    const settled = await Promise.allSettled(
      Array.from({ length: videoCount }, (_, v) => composeOne(v)),
    );
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
    if (videoCount > 1 && failCount > 0) {
      tracker.progress(`已生成 ${outputPaths.length}/${videoCount} 条（${failCount} 条失败,费用已按 ${videoCount} 条预扣）`);
    }
    tracker.finish(outputPaths[0]);
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
