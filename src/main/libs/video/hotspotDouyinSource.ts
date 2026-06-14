/**
 * hotspotDouyinSource — 热搜成片【抖音混剪】素材源(路线 A:塞进现有热搜成片,不新建卡)。
 *
 * video pipeline(主进程)在配画面那步,若用户选「素材来源 = 抖音视频」,就调本模块:
 *   1. 确认抖音登录(没登录 → 开抖音 tab + 轮询等扫码,最多 3 分钟)
 *   2. 跑 backend 下发的 douyin_search 脚本(走 publish-drivers 热更新,放 video_drivers/
 *      douyin_search.js)——在浏览器里按标题搜抖音、进详情页 main world fetch 取【无水印】
 *      play_addr url,返回 url 列表
 *   3. 主进程 fetch 把这些 url 下到任务素材目录,返回本地 mp4 路径
 * 上层再把这些路径当作镜头 clips(开底部黑条盖原字幕)喂进 compose 混剪 + 配音。
 *
 * 全程「降级不报错」:没登录 / 没下发脚本 / 没取到源 → 返回空 paths,上层退回图片配图兜底。
 * 浏览器命令复用发布那套桥(pubCmd → sendBrowserCommand,按抖音 tabPattern 路由)。
 */

import fs from 'fs';
import path from 'path';
import { fetchPublishDrivers } from './publishers/remoteDrivers';
import { pubCmd, sleep } from './publishers/publisherUtils';
import { checkPlatformLogin, openPlatformLogin } from '../scenario/platformLoginDriver';

/** 真 async 函数沙箱(同 remoteDrivers.runRemoteDriver:无 require/fs/global,只能用注入的 ctx)。 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  (new (arg: string, body: string) => (ctx: any) => Promise<any>);

const LOGIN_WAIT_MS = 3 * 60 * 1000;

export interface DouyinClipsDiag {
  reached: boolean;       // 脚本是否跑起来并返回
  loggedIn: boolean;      // 抖音登录态
  gotUrls: number;        // 脚本取到的无水印 url 数
  downloaded: number;     // 实际下到本地的数量
  reason?: string;        // 失败原因(no_driver / not_logged_in / script_threw / no_urls / ...)
  scriptDiag?: unknown;   // 脚本自带诊断(搜了哪些词、命中几个、错误列表)
}

export interface DouyinClipsResult {
  paths: string[];
  diag: DouyinClipsDiag;
}

/** 主进程 fetch 下载单个无水印视频到本地(参考 phaseRunner.downloadVideoToDisk)。 */
async function downloadOne(url: string, dest: string): Promise<boolean> {
  try {
    if (!/^https?:\/\//i.test(url)) return false;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5 * 60 * 1000);
    let buf: Buffer;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0', Referer: 'https://www.douyin.com/' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!resp.ok) return false;
      buf = Buffer.from(await resp.arrayBuffer());
    } catch {
      clearTimeout(to);
      return false;
    }
    fs.writeFileSync(dest, buf);
    return buf.length > 10_000; // 太小基本是错误页/防盗链 HTML
  } catch {
    return false;
  }
}

/** 等抖音登录:先探一次,没登录就开抖音 tab + 轮询(最多 3 分钟)。 */
async function ensureDouyinLoggedIn(onLog: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  let st = await checkPlatformLogin('douyin').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
  if (st.loggedIn) return true;
  onLog('🌐 打开抖音,等待登录(请在窗口里扫码,最多 3 分钟)…');
  try { await openPlatformLogin('douyin'); } catch { /* 开 tab 失败也继续轮询 */ }
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    await sleep(2500);
    st = await checkPlatformLogin('douyin').catch(() => ({ loggedIn: false } as { loggedIn: boolean }));
    if (st.loggedIn) return true;
  }
  return false;
}

/**
 * 按关键词搜抖音、下素材到 destDir。mode='video' 下无水印视频(.mp4);'image' 下【图文笔记】的图(.jpg)。
 * 返回本地路径 + 诊断。绝不抛(降级返空)。
 */
export async function fetchDouyinClips(
  keywords: string[],
  wantCount: number,
  destDir: string,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  mode: 'video' | 'image' = 'video',
): Promise<DouyinClipsResult> {
  const diag: DouyinClipsDiag = { reached: false, loggedIn: false, gotUrls: 0, downloaded: 0 };

  // 1. 拉下发脚本(走发布 driver 同款 publish-drivers 热更新;key = 文件名 douyin_search)
  const pack = await fetchPublishDrivers();
  const code = pack?.drivers?.['douyin_search'];
  if (!code) {
    onLog('⚠️ 后端没下发抖音搜索脚本(video_drivers/douyin_search.js),无法取材');
    diag.reason = 'no_driver';
    return { paths: [], diag };
  }

  // 2. 抖音登录
  const ok = await ensureDouyinLoggedIn(onLog, signal);
  if (!ok) {
    onLog('⚠️ 抖音未登录,跳过抖音取材(退回图片配图)');
    diag.reason = 'not_logged_in';
    return { paths: [], diag };
  }
  diag.loggedIn = true;

  // 3. 跑搜+取源脚本
  onLog(mode === 'image' ? '🔎 按标题搜抖音图文、取图…' : '🔎 按标题搜抖音、取无水印源…');
  let ret: any;
  try {
    const fn = new AsyncFunction('ctx', code);
    const sctx = {
      input: { keywords, wantCount, mode },
      cmd: (command: string, params: any, timeoutMs: number) => pubCmd('douyin', command, params, timeoutMs),
      sleep,
      log: (m: string) => { try { onLog('   ' + m); } catch { /* ignore */ } },
    };
    ret = await fn(sctx);
  } catch (e: any) {
    onLog('⚠️ 抖音取材脚本异常:' + String(e?.message || e).slice(0, 100));
    diag.reason = 'script_threw';
    return { paths: [], diag };
  }
  diag.reached = true;
  diag.scriptDiag = ret?.diag;
  const urls: string[] = Array.isArray(ret?.urls) ? ret.urls.filter((u: any) => typeof u === 'string') : [];
  diag.gotUrls = urls.length;
  if (urls.length === 0) {
    onLog(mode === 'image' ? '⚠️ 抖音没取到可用图文图片' : '⚠️ 抖音没取到可用视频源');
    diag.reason = ret?.reason || 'no_urls';
    return { paths: [], diag };
  }

  // 4. 主进程下载到本地素材目录
  onLog(`⬇️ 下载 ${urls.length} 个抖音${mode === 'image' ? '图片' : '视频'}…`);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch { /* 已存在 */ }
  const ext = mode === 'image' ? 'jpg' : 'mp4';
  const base = mode === 'image' ? 'douyin_img' : 'douyin_clip';
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (signal?.aborted) break;
    const dest = path.join(destDir, `${base}_${String(i).padStart(2, '0')}.${ext}`);
    if (await downloadOne(urls[i], dest)) {
      paths.push(dest);
      diag.downloaded++;
    }
  }
  onLog(`✅ 抖音素材就绪:${paths.length}/${urls.length} 个`);
  return { paths, diag };
}
