/**
 * hotspotProvider — 热搜成片:调 NoobClaw 服务端的三个 hotspot API。
 *
 * key(Serper)全留服务端,客户端只拿结果:
 *   · pickHotspotTopic            选题(从用户勾选的热点源最新 N 条随机 1 条)
 *   · fetchHotspotMaterial        Serper /news 联网取这条热点的最新资料(给 scriptWriter 当 material)
 *   · fetchAndDownloadHotspotImages  Serper /images(英文词)+ og:image,返回下载好的本地图片路径
 *
 * 全部"降级不报错":服务端没配 serper key / 没网 → 选题返 null、material 返空、图片返空,
 * 上层据此走纯文案 / 文字卡兜底,不让整条任务崩。
 */

import fs from 'fs';
import path from 'path';
import { downloadImagesFromUrls } from './stockProvider';

/** 后端代下回来的一张图:base64(国内主路径,客户端不碰海外)或 url(海外兜底)。 */
export interface HotspotImage {
  base64?: string;
  mimeType?: string;
  url?: string;
}

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* 取不到 token 就裸调,服务端会 401 → 下面 catch 返空降级 */ }
  return headers;
}

const REQ_TIMEOUT_MS = 20_000;

async function postJson(apiPath: string, body: unknown): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase()}${apiPath}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface HotspotTopic {
  id: string;
  title: string;
  url: string;
  source: string;
  summary?: string;
  category: string;
  lang?: string;
}

/** 选题:从勾选源(hotsearch/web3/tech)最新 pool 条里随机 1 条。无可选 / 失败返回 null。 */
export async function pickHotspotTopic(sources: string[], pool = 20): Promise<HotspotTopic | null> {
  const json = await postJson('/api/video/hotspot/pick', { sources, pool });
  const t = json?.topic;
  if (!t || !t.title) return null;
  return {
    id: String(t.id || ''),
    title: String(t.title),
    url: String(t.url || ''),
    source: String(t.source || ''),
    summary: t.summary ? String(t.summary) : undefined,
    category: String(t.category || ''),
    lang: t.lang ? String(t.lang) : undefined,
  };
}

/** 取材:Serper /news 查该热点的最新报道,返回资料块(喂 scriptWriter 的 material)。失败返空串。 */
export async function fetchHotspotMaterial(title: string, lang = 'zh'): Promise<string> {
  const json = await postJson('/api/video/hotspot/material', { title, lang });
  return typeof json?.material === 'string' ? json.material : '';
}

export interface HotspotImageDiag {
  reached: boolean;      // 是否成功拿到 backend 响应(false=网络/404/认证挂了)
  hasKey: boolean;       // backend 读到 serper key 没
  queries: number;       // 后端实际发了几次 serper 请求
  serperTotal: number;   // serper 累计返回几张候选
  serperError: string;   // serper 报错/网络到不了的信息
  ogCount: number;       // og:image 兜底几张
  keywordsZh: string[];  // 实际用于检索的中文关键词(中文热点优先)
  keywordsEn: string[];  // 英文关键词(兜底 / 英文热点)
  keywordStats: { kw: string; lang: string; searched: boolean; found: number }[]; // 逐词明细
  blacklist: string[];   // 服务端下发的付费图库黑名单(客户端也用它过滤)
}

/**
 * 配图编排(后端决策):把【中英两份关键词 + 时长 + 来源URL】给后端,后端中文词优先搜(英文兜底)、
 * 只要大图、剔付费图库,返回【大图 URL 列表】+ 下发黑名单。客户端拿 URL 自己下(省服务端流量)。
 */
export async function fetchHotspotImagePlan(
  keywordsZh: string[],
  keywordsEn: string[],
  targetSeconds: number,
  sourceUrl?: string,
): Promise<{ images: HotspotImage[]; want: number; diag: HotspotImageDiag }> {
  const json = await postJson('/api/video/hotspot/images', { keywordsZh, keywordsEn, targetSeconds, sourceUrl });
  const arr = (a: any): string[] => (Array.isArray(a) ? a.map((k: any) => String(k)) : []);
  const diag: HotspotImageDiag = {
    reached: !!json,
    hasKey: !!json?.hasKey,
    queries: Number(json?.queries) || 0,
    serperTotal: Number(json?.serperTotal) || 0,
    serperError: String(json?.serperError || ''),
    ogCount: Number(json?.ogCount) || 0,
    keywordsZh: arr(json?.keywordsZh),
    keywordsEn: arr(json?.keywordsEn),
    keywordStats: Array.isArray(json?.keywordStats)
      ? json.keywordStats.map((s: any) => ({ kw: String(s?.kw || ''), lang: String(s?.lang || ''), searched: !!s?.searched, found: Number(s?.found) || 0 }))
      : [],
    blacklist: arr(json?.blacklist),
  };
  const raw = Array.isArray(json?.images) ? json.images : [];
  const images: HotspotImage[] = raw
    .map((im: any): HotspotImage => (typeof im === 'string' ? { url: im } : { url: im?.url ? String(im.url) : undefined }))
    .filter((im: HotspotImage) => typeof im.url === 'string' && /^https?:\/\//.test(im.url));
  const want = Number(json?.want) || Math.max(8, Math.min(100, Math.ceil(targetSeconds / 4) + 2));
  return { images, want, diag };
}

/** 服务端代下兜底:把客户端下不动的大图 URL 交给后端代下成 base64。返回 [{base64,mimeType,url}]。 */
export async function fetchHotspotProxyImages(urls: string[], want: number): Promise<{ base64: string; mimeType: string; url: string }[]> {
  if (!Array.isArray(urls) || urls.length === 0) return [];
  const json = await postJson('/api/video/hotspot/fetch-images', { urls, want });
  const raw = Array.isArray(json?.images) ? json.images : [];
  return raw
    .filter((im: any) => im?.base64)
    .map((im: any) => ({ base64: String(im.base64), mimeType: String(im.mimeType || 'image/jpeg'), url: String(im.url || '') }));
}

/**
 * 两阶段把后端返回的大图 URL 落地到本地,下到 want 张即停。返回本地路径 + 是否动用了云端代下。
 *   阶段1:客户端优先自己下(省服务端流量;海外客户端能直连)。
 *   阶段2:没凑够 → 把还没用过的 URL 交服务端代下 base64(国内客户端主走这条,服务端出海外稳)。
 *   两端都用【服务端下发的黑名单】再过滤一遍(双保险)。
 *   usedCloud:阶段2真写下了至少 1 张 → true(计费侧据此 ×2,且提示用户「会收少量流量费用」)。
 *   onProgress:'local'(开始客户端自下)/ 'cloud'(转云端代下)回调,供上层刷新进度文案。
 */
export async function downloadHotspotImages(
  images: HotspotImage[], destDir: string, want: number, blacklist: string[] = [],
  onProgress?: (stage: 'local' | 'cloud') => void,
): Promise<{ paths: string[]; usedCloud: boolean }> {
  const bl = blacklist.map((b) => b.toLowerCase());
  const urls = images
    .map((im) => im.url)
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)
      && !bl.some((b) => u.toLowerCase().includes(b)));
  if (urls.length === 0) return { paths: [], usedCloud: false };

  const results: string[] = [];
  let usedCloud = false;
  // 阶段1:客户端下前半(至少 want 个);海外客户端基本成功,国内大概率失败(下不动)。
  onProgress?.('local');
  const firstBatch = urls.slice(0, Math.max(want, Math.ceil(urls.length / 2)));
  const local = await downloadImagesFromUrls(firstBatch, destDir, 200, want);
  results.push(...local);

  // 阶段2:缺口 → 服务端代下。优先用客户端没碰过的后半 URL(避免重复);不够就全量。
  if (results.length < want) {
    const need = want - results.length;
    const rest = urls.slice(firstBatch.length);
    const proxyUrls = rest.length >= need ? rest : urls;
    if (proxyUrls.length > 0) onProgress?.('cloud');
    const proxied = await fetchHotspotProxyImages(proxyUrls, need);
    let idx = results.length;
    for (const im of proxied) {
      if (results.length >= want) break;
      const mt = im.mimeType || '';
      const ext = mt.includes('png') ? 'png' : mt.includes('webp') ? 'webp' : 'jpg';
      const dest = path.join(destDir, `hotspot_p${String(idx).padStart(3, '0')}.${ext}`);
      try { fs.writeFileSync(dest, Buffer.from(im.base64, 'base64')); results.push(dest); idx++; usedCloud = true; } catch { /* 写失败跳过 */ }
    }
  }
  return { paths: results, usedCloud };
}
