/**
 * bgm — 解析背景音乐路径(本地内置 / 云端曲库 / 用户上传)。
 *
 * 向导把选中的 BGM 用 token 传进来,这里在【合成前】还原成一个本地绝对路径:
 *   · `builtin:<id>`   → 随包 bundle 的 resources/bgm/<id>.mp3(8 首本地内置)。
 *   · `remote:<url>`   → 云端曲库。首次合成时从 url 下载并缓存到
 *                        <userData>/bgm-cache/,之后命中缓存直接复用,绝不重复下载。
 *   · 其它绝对路径      → 用户自己上传的 BGM,原样返回。
 *   · 空 / undefined    → undefined(不加 BGM)。
 *
 * 内置曲库来源:MoneyPrinterTurbo 自带 resource/songs(重命名 bgm-01..bgm-08)。
 * 云端曲库:我们手动传 R2、把「中英标题 + 下载链接」配在客户端清单里(REMOTE_BGM),
 * 用户选中后在出片时按需下载 —— 不随安装包发,装机体积小。
 *
 * 多根探测套用 compose.ts.bundledFontDirs 的同款逻辑,覆盖 Win/mac/dev。
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

/** 本地内置 BGM token 前缀。 */
export const BUILTIN_BGM_PREFIX = 'builtin:';
/** 云端曲库 token 前缀(后接完整下载 URL)。 */
export const REMOTE_BGM_PREFIX = 'remote:';

/** 已下载云端曲目的本地缓存目录。 */
function bgmCacheDir(): string {
  return path.join(getUserDataPath(), 'bgm-cache');
}

/** 内置 BGM 可能落地的目录集合(同 compose.bundledFontDirs 的多根探测)。 */
function bundledBgmDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string): number => dirs.push(path.join(root, 'bgm'));
  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  } else {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    pushRoot(path.join(projectRoot, 'resources'));
  }
  // Dev / non-CI fallback: prepare-tauri-resources.js (a CI-only step) is what
  // copies bgm into the bundled resources dir, and isPackaged() is ALWAYS true
  // in the sidecar binary — so under `tauri:dev` the packaged branch above can
  // never find the built-in songs. Always also probe the committed source
  // `client/resources/bgm` by walking up from this file and from cwd. These
  // dirs don't exist in a real install, so existsSync() just skips them.
  for (const base of [
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    process.cwd(),
    path.join(process.cwd(), 'client'),
  ]) {
    pushRoot(path.join(base, 'resources'));
  }
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

/** 内置 token → 随包 bundle 的绝对路径(找不到返回 undefined)。 */
function resolveBuiltin(id: string): string | undefined {
  const safeId = path.basename(id.trim()); // 挡路径穿越
  if (!safeId) return undefined;
  for (const dir of bundledBgmDirs()) {
    const p = path.join(dir, `${safeId}.mp3`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** 给一个下载 URL 算出稳定、防碰撞、可读的缓存文件名(<10位hash>-<basename>)。 */
function cacheFileFor(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = 'bgm';
  try {
    const b = path.basename(new URL(url).pathname);
    if (b) base = b;
  } catch { /* 非法 URL 时用默认 base */ }
  base = base.replace(/[^\w.\-]/g, '_').slice(-40);
  if (!/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(base)) base += '.mp3';
  return path.join(bgmCacheDir(), `${hash}-${base}`);
}

/** 下载到 dest(先写 .part 再原子改名,避免半截文件污染缓存)。失败返回 false,绝不抛。 */
async function downloadTo(url: string, dest: string, onLog?: (m: string) => void): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    onLog?.('☁️ 正在下载云端背景音乐…');
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) { onLog?.(`⚠️ 背景音乐下载失败(HTTP ${resp.status})`); return false; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) { onLog?.('⚠️ 背景音乐下载为空'); return false; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    onLog?.(`✅ 背景音乐已缓存(${(buf.length / 1024 / 1024).toFixed(1)}MB),下次复用不再下载`);
    return true;
  } catch {
    onLog?.('⚠️ 背景音乐下载异常');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把向导传来的 bgmPath 解析成可用的本地绝对路径。云端曲目会在此按需下载并缓存。
 * 失败(下载不到 / 内置缺失)返回 undefined,由 pipeline 兜底为「不加 BGM」。绝不抛。
 */
export async function resolveBgmPath(
  bgmPath?: string,
  onLog?: (m: string) => void,
): Promise<string | undefined> {
  if (!bgmPath) return undefined;

  if (bgmPath.startsWith(BUILTIN_BGM_PREFIX)) {
    return resolveBuiltin(bgmPath.slice(BUILTIN_BGM_PREFIX.length));
  }

  if (bgmPath.startsWith(REMOTE_BGM_PREFIX)) {
    const url = bgmPath.slice(REMOTE_BGM_PREFIX.length).trim();
    if (!/^https?:\/\//i.test(url)) return undefined;
    const dest = cacheFileFor(url);
    // 命中缓存(且非空)→ 直接复用,不重复下载。
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    const ok = await downloadTo(url, dest, onLog);
    return ok ? dest : undefined;
  }

  // 用户上传的绝对路径,原样返回(pipeline 再 existsSync 兜底)。
  return bgmPath;
}
