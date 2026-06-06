/**
 * seedanceProvider — 「AI 自动成片」的视频片段生成(走 NoobClaw 服务端代理 Seedance）。
 *
 * 架构(对齐 stockProvider / billing 的"重活在服务端、key 不下发"原则):
 *   · ARK key 在服务端(backend/src/routes/video.ts 的 /api/video/seedance/*)。
 *   · 客户端只发 { prompt, imageUrls(参考图 base64), duration, ratio, resolution },
 *     由服务端【先扣费再提交】Ark 异步任务,返回 taskId + chargeId;失败服务端幂等退款。
 *   · 客户端轮询 /status/:taskId 拿 succeeded 的 video_url,直接从公网 CDN 下载到本地
 *     (mp4 字节不经我们服务器,省带宽,跟 stock 下载一个路子)。
 *
 * 计费:每个片段在服务端按【时长 × 分辨率档】扣积分(seedance_price_cny_per_sec)。
 *   片段失败(Ark 拒绝/任务 failed)服务端按 chargeId 自动退款,客户端无需补偿。
 *
 * 成本控制(对齐用户"以最低成本生成最好视频"):
 *   · 默认 720p(分辨率倍率 1×),关键镜才上 1080p。
 *   · 每镜时长按该镜配音时长 clamp 到 [minDur, 12],不无脑拉满。
 *   · 限并发(Ark 账号级限流),逐镜失败优雅降级(交给 pipeline 用参考图/邻镜兜底)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export type SeedanceResolution = '480p' | '720p' | '1080p';
export type SeedanceRatio = '9:16' | '16:9' | '1:1' | 'adaptive';

export interface SeedanceSceneSpec {
  /** 该镜的画面 prompt(英文/中文均可,Seedance 双语)。 */
  prompt: string;
  /** 该镜目标时长(秒);内部 clamp 到 [4,12](1.5-pro 下限 4)。 */
  durationSec: number;
}

export interface SeedanceClipResult {
  /** 该镜成片本地路径;失败为 null(pipeline 据此降级)。 */
  path: string | null;
  /** 失败原因(供日志)。 */
  error?: string;
}

export interface GenerateSeedanceOptions {
  scenes: SeedanceSceneSpec[];
  /** 参考图本地绝对路径(≤2),做风格/人设统一。会读成 data URL 发给服务端。 */
  referenceImages?: string[];
  resolution?: SeedanceResolution;
  ratio?: SeedanceRatio;
  /** 片段下载落地目录(临时素材目录)。 */
  destDir: string;
  /** 并发上限(Ark 账号级限流,默认 2)。 */
  concurrency?: number;
  /** 单镜最大等待秒数(轮询超时,默认 240)。 */
  perClipTimeoutSec?: number;
  onProgress?: (msg: string) => void;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 本地图片读成 data URL(服务端 image_url 接受 http(s) 或 data:image/*)。 */
function imageToDataUrl(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/jpeg';
    const b64 = fs.readFileSync(absPath).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> | null {
  const token = getNoobClawAuthToken();
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

interface CreateResult { taskId: string; chargeId: string; chargedTokens: number; }

/** 提交一个 Seedance 片段任务。返回 taskId+chargeId,或抛错(含 402 余额不足)。 */
async function createClip(
  prompt: string, imageUrls: string[], duration: number, ratio: string, resolution: string,
): Promise<CreateResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const resp = await fetch(`${apiBase()}/api/video/seedance/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, imageUrls, duration, ratio, resolution }),
      signal: ctrl.signal,
    });
    if (resp.status === 402) throw new Error('余额不足');
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`提交失败(${resp.status})${t ? ': ' + t.slice(0, 120) : ''}`);
    }
    const json: any = await resp.json();
    if (!json?.taskId) throw new Error('服务端未返回 taskId');
    return { taskId: json.taskId, chargeId: json.chargeId || '', chargedTokens: Number(json.chargedTokens) || 0 };
  } finally {
    clearTimeout(timer);
  }
}

interface StatusResult { status: 'queued' | 'running' | 'succeeded' | 'failed'; videoUrl?: string | null; error?: string; }

/** 查一次任务状态。 */
async function pollClipOnce(taskId: string, chargeId: string): Promise<StatusResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const url = `${apiBase()}/api/video/seedance/status/${encodeURIComponent(taskId)}`
      + (chargeId ? `?chargeId=${encodeURIComponent(chargeId)}` : '');
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return { status: 'running' }; // 暂时性查询失败 → 当还在跑,下轮再试
    const json: any = await resp.json();
    return { status: json?.status || 'running', videoUrl: json?.videoUrl, error: json?.error };
  } finally {
    clearTimeout(timer);
  }
}

/** 把 CDN 上的成片下载到本地 mp4(片段小,直接 buffer 落盘)。 */
async function downloadVideo(url: string, outPath: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 生成单镜:create → 轮询 → 下载。失败返回 {path:null,error}(不抛,交给上层降级)。 */
async function generateOne(
  idx: number, scene: SeedanceSceneSpec, imageUrls: string[],
  ratio: string, resolution: string, destDir: string, timeoutSec: number,
  onProgress?: (m: string) => void,
): Promise<SeedanceClipResult> {
  const duration = Math.max(4, Math.min(12, Math.round(scene.durationSec || 5)));
  try {
    const { taskId, chargeId } = await createClip(scene.prompt, imageUrls, duration, ratio, resolution);
    onProgress?.(`🎬 第 ${idx + 1} 镜 AI 生成中…`);
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const st = await pollClipOnce(taskId, chargeId);
      if (st.status === 'succeeded') {
        if (!st.videoUrl) return { path: null, error: '成片无 video_url' };
        const outPath = path.join(destDir, `seedance_${idx + 1}_${taskId.slice(-8)}.mp4`);
        await downloadVideo(st.videoUrl, outPath);
        onProgress?.(`✅ 第 ${idx + 1} 镜 AI 片段就绪`);
        return { path: outPath };
      }
      if (st.status === 'failed') return { path: null, error: st.error || 'Ark 任务失败' };
    }
    return { path: null, error: '生成超时' };
  } catch (e) {
    return { path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 批量生成各镜 Seedance 片段(限并发)。返回与 scenes 等长的结果数组(失败项 path:null）。
 * 服务端逐片段计费 + 失败自动退款,所以这里只管生成 + 收集,不处理钱。
 */
export async function generateSeedanceClips(opts: GenerateSeedanceOptions): Promise<SeedanceClipResult[]> {
  const { scenes, destDir } = opts;
  const resolution = opts.resolution || '720p';
  const ratio = opts.ratio || '9:16';
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  const timeoutSec = Math.max(60, Math.min(600, opts.perClipTimeoutSec ?? 240));

  // 参考图读成 data URL(≤2),所有镜共用 → 风格统一。
  const imageUrls = (opts.referenceImages || [])
    .slice(0, 2)
    .map(imageToDataUrl)
    .filter((u): u is string => !!u);

  const results = new Array<SeedanceClipResult>(scenes.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < scenes.length) {
      const i = next++;
      results[i] = await generateOne(i, scenes[i], imageUrls, ratio, resolution, destDir, timeoutSec, opts.onProgress);
    }
  };
  const n = Math.max(1, Math.min(concurrency, scenes.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
