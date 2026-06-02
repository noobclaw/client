/**
 * stockProvider — 按关键词取免费在线素材库(Pexels + Pixabay)的竖屏图片。
 *
 * ⚠️ key 必须留在服务端:搜索走 NoobClaw 服务端代理(/api/video/stock/search),
 * 服务端用自己持有的 key 搜好,返回【公开 CDN 图片 URL】列表;客户端直接下载这些
 * URL(图片 URL 本身不需要 key)。客户端不持有、也不打包任何素材库 key。
 *
 * 一期画面策略:用户参考图优先 → 不够的用这里的素材库图补 → 再不够上文字卡。
 * 只取图片(配 Ken Burns 运镜假装动起来),素材库视频留到后续。
 *
 * 没网 / 服务端没配 key → 返回空数组,上层自动降级到文字卡。
 */

import fs from 'fs';
import path from 'path';
import { probeImageSize } from './ffmpegRuntime';

const REQ_TIMEOUT_MS = 15_000;
/** 视频素材下载超时放宽:文件大。 */
const VIDEO_REQ_TIMEOUT_MS = 60_000;
/** 低于这个边长的素材图拉伸到 1080×1920 会糊,直接拒收(抄 MoneyPrinterTurbo 的 480 门槛)。 */
const MIN_IMAGE_EDGE = 480;
/** 太短的素材视频(<2s)拼起来太碎,拒收。 */
const MIN_VIDEO_SEC = 2;

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* token 取不到就裸调,服务端会 401 */ }
  return headers;
}

async function downloadTo(url: string, destPath: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return false; // junk / error page
    fs.writeFileSync(destPath, buf);
    // 分辨率门槛:太小的图拉满竖屏会糊,拒收并删文件
    const { width, height } = await probeImageSize(destPath);
    if (width > 0 && height > 0 && (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE)) {
      try { fs.unlinkSync(destPath); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 调服务端代理搜图,返回公开 CDN 图片 URL 列表(服务端持有 key)。 */
async function searchViaServer(keywords: string[], count: number): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({
      keywords: keywords.join(','),
      count: String(count),
      orientation: 'portrait',
    });
    // 服务端 /stock/search 现在挂了 authMiddleware,必须带 NoobClaw JWT。
    // 没登录 → 没 token → 服务端 401 → 这里 catch 返空 → 上层降级文字卡。
    const res = await fetch(`${apiBase()}/api/video/stock/search?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const images = json?.images;
    return Array.isArray(images) ? images.filter((u: any): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchStockOptions {
  keywords: string[];
  /** 需要的图片张数。 */
  count: number;
  /** 下载目录(需已存在)。 */
  destDir: string;
}

/**
 * 经服务端代理搜图并下载到本地,返回本地绝对路径数组(长度 ≤ count)。
 * 服务端没 key / 没网时返回 []。
 */
export async function fetchStockImages(opts: FetchStockOptions): Promise<string[]> {
  const { keywords, count, destDir } = opts;
  if (count <= 0) return [];

  // 服务端会多返一些候选(下载可能失败/是错误页),这里多要点冗余
  const urls = await searchViaServer(keywords, count);
  if (urls.length === 0) return [];

  const results: string[] = [];
  let idx = 0;
  for (const url of urls) {
    if (results.length >= count) break;
    const ext = (url.split('?')[0].match(/\.(jpg|jpeg|png|webp)$/i)?.[1] || 'jpg').toLowerCase();
    const dest = path.join(destDir, `stock_${String(idx).padStart(3, '0')}.${ext}`);
    idx++;
    const ok = await downloadTo(url, dest);
    if (ok) results.push(dest);
  }

  return results;
}

// ─────────────────────────── 视频素材 ───────────────────────────

interface StockVideoMeta {
  url: string;
  durationSec: number;
  width: number;
  height: number;
}

/** 调服务端代理搜视频(type=video),返回公开 CDN 视频 URL + 元数据。 */
async function searchVideosViaServer(keywords: string[], count: number): Promise<StockVideoMeta[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({
      keywords: keywords.join(','),
      count: String(count),
      orientation: 'portrait',
      type: 'video',
    });
    const res = await fetch(`${apiBase()}/api/video/stock/search?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const videos = json?.videos;
    if (!Array.isArray(videos)) return [];
    return videos
      .filter((v: any) => v && typeof v.url === 'string')
      .map((v: any) => ({
        url: v.url as string,
        durationSec: Number(v.durationSec) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 下载一个视频文件;太短的(<MIN_VIDEO_SEC)拒收。 */
async function downloadVideoTo(url: string, destPath: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIDEO_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 16 * 1024) return false; // junk / error page
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface StockVideoAsset {
  /** 本地绝对路径。 */
  path: string;
  /** 时长(秒),服务端 ffprobe/库元数据给的,可能为 0(未知)。 */
  durationSec: number;
  width: number;
  height: number;
}

/**
 * 经服务端代理搜视频并下载到本地,返回本地视频资源数组(长度 ≤ count)。
 * 服务端没 key / 没网 / 没匹配时返回 []。
 */
export async function fetchStockVideos(opts: FetchStockOptions): Promise<StockVideoAsset[]> {
  const { keywords, count, destDir } = opts;
  if (count <= 0) return [];

  const metas = await searchVideosViaServer(keywords, count);
  if (metas.length === 0) return [];

  const results: StockVideoAsset[] = [];
  let idx = 0;
  for (const meta of metas) {
    if (results.length >= count) break;
    // 元数据里时长太短的直接跳过(0 = 未知,放行)
    if (meta.durationSec > 0 && meta.durationSec < MIN_VIDEO_SEC) continue;
    const ext = (meta.url.split('?')[0].match(/\.(mp4|mov|webm|m4v)$/i)?.[1] || 'mp4').toLowerCase();
    const dest = path.join(destDir, `stockvid_${String(idx).padStart(3, '0')}.${ext}`);
    idx++;
    const ok = await downloadVideoTo(meta.url, dest);
    if (ok) {
      results.push({
        path: dest,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
      });
    }
  }

  return results;
}
