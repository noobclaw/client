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

import { downloadImagesFromUrls } from './stockProvider';

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

/** 配图:Serper /images(英文词)+ og:image 来源页兜底,返回公开图片 URL 列表。失败返空数组。 */
export async function fetchHotspotImageUrls(queryEn: string, sourceUrl?: string, count = 15): Promise<string[]> {
  const json = await postJson('/api/video/hotspot/images', { queryEn, sourceUrl, count });
  const imgs = json?.images;
  if (!Array.isArray(imgs)) return [];
  return imgs
    .map((im: any) => (typeof im === 'string' ? im : im?.url))
    .filter((u: any): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
}

/** 配图一条龙:查 URL → 下载到本地。返回本地路径数组(长度 ≤ count)。 */
export async function fetchAndDownloadHotspotImages(
  queryEn: string,
  sourceUrl: string | undefined,
  count: number,
  destDir: string,
): Promise<string[]> {
  const urls = await fetchHotspotImageUrls(queryEn, sourceUrl, count);
  if (urls.length === 0) return [];
  return downloadImagesFromUrls(urls, destDir);
}
