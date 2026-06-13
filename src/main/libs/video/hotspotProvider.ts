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
  keywords: string[];    // 实际用于检索的英文关键词
  keywordStats: { kw: string; searched: boolean; found: number }[]; // 逐词明细:查没查 / 返回几张
}

/**
 * 配图编排(后端决策 + 代下载):把【AI 出的英文关键词 + 时长 + 来源URL】给后端,后端按时长算 want,
 * 查 serper 收候选(优先小图),【在后端并发代下载成 base64】返回。客户端拿 base64 直接写文件,
 * 完全不碰海外图(国内/无 VPN/系统代理不生效都能配上图)。base64 不足时 url 兜底(海外客户端可下)。
 */
export async function fetchHotspotImagePlan(
  keywords: string[],
  targetSeconds: number,
  sourceUrl?: string,
): Promise<{ images: HotspotImage[]; want: number; diag: HotspotImageDiag }> {
  const json = await postJson('/api/video/hotspot/images', { keywords, targetSeconds, sourceUrl });
  const diag: HotspotImageDiag = {
    reached: !!json,
    hasKey: !!json?.hasKey,
    queries: Number(json?.queries) || 0,
    serperTotal: Number(json?.serperTotal) || 0,
    serperError: String(json?.serperError || ''),
    ogCount: Number(json?.ogCount) || 0,
    keywords: Array.isArray(json?.keywords) ? json.keywords.map((k: any) => String(k)) : [],
    keywordStats: Array.isArray(json?.keywordStats)
      ? json.keywordStats.map((s: any) => ({ kw: String(s?.kw || ''), searched: !!s?.searched, found: Number(s?.found) || 0 }))
      : [],
  };
  const raw = Array.isArray(json?.images) ? json.images : [];
  const images: HotspotImage[] = raw
    .map((im: any): HotspotImage => (typeof im === 'string'
      ? { url: im }
      : { base64: im?.base64 ? String(im.base64) : undefined, mimeType: im?.mimeType ? String(im.mimeType) : undefined, url: im?.url ? String(im.url) : undefined }))
    .filter((im: HotspotImage) => !!im.base64 || (typeof im.url === 'string' && /^https?:\/\//.test(im.url)));
  const want = Number(json?.want) || Math.max(8, Math.min(40, Math.ceil(targetSeconds / 4) + 2));
  return { images, want, diag };
}

/**
 * 把后端返回的图落地到本地,下到 want 张即停。返回本地路径。
 *   · base64(后端代下,主路径)→ 直接写文件,不碰网络。
 *   · url(兜底)→ 走 downloadImagesFromUrls(海外客户端 / 后端代下不足时)。
 */
export async function downloadHotspotImages(images: HotspotImage[], destDir: string, want: number): Promise<string[]> {
  if (!Array.isArray(images) || images.length === 0) return [];
  const results: string[] = [];
  const urlOnly: string[] = [];
  let idx = 0;
  for (const im of images) {
    if (results.length >= want) break;
    if (im.base64) {
      const mt = im.mimeType || '';
      const ext = mt.includes('png') ? 'png' : mt.includes('webp') ? 'webp' : 'jpg';
      const dest = path.join(destDir, `hotspot_${String(idx).padStart(3, '0')}.${ext}`);
      try { fs.writeFileSync(dest, Buffer.from(im.base64, 'base64')); results.push(dest); idx++; } catch { /* 写失败跳过 */ }
    } else if (im.url) {
      urlOnly.push(im.url);
    }
  }
  // base64 没凑够 want → url 兜底下载(海外客户端能直连;国内大概率也下不动,但不阻塞)。
  if (results.length < want && urlOnly.length > 0) {
    const more = await downloadImagesFromUrls(urlOnly, destDir, 200, want - results.length);
    results.push(...more);
  }
  return results;
}
