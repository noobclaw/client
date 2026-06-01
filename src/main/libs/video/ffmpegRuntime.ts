/**
 * ffmpegRuntime — 解析并运行 ffmpeg / ffprobe。
 *
 * 解析顺序(第一个能跑通的胜出):
 *   1. 环境变量 NOOBCLAW_FFMPEG_PATH / NOOBCLAW_FFPROBE_PATH(显式覆盖)
 *   2. 打包后的 bundled 目录(resources/ffmpeg-<platform>/bin/…)—— M0 里塞进来
 *   3. userData/runtimes/ffmpeg-<platform>/bin/…(从 bundled 同步出来的)
 *   4. 系统 PATH 上的 ffmpeg / ffprobe(开发机直接用)
 *
 * 一期(开发/自测)走第 4 条:本机 choco 装的 ffmpeg 8.1。打包分发再补 M0 的
 * 资源内置(参考 pythonRuntime 的 bundle → 同步 → resolve 套路)。
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

const PLATFORM_DIR = process.platform === 'win32'
  ? 'ffmpeg-win'
  : process.platform === 'darwin'
    ? 'ffmpeg-mac'
    : 'ffmpeg-linux';

const EXE = process.platform === 'win32' ? '.exe' : '';

function bundledBinDirs(): string[] {
  const dirs: string[] = [];
  if (isPackaged()) {
    dirs.push(path.join(getResourcesPath(), PLATFORM_DIR, 'bin'));
    dirs.push(path.join(getResourcesPath(), PLATFORM_DIR));
  } else {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    dirs.push(path.join(projectRoot, 'resources', PLATFORM_DIR, 'bin'));
    dirs.push(path.join(projectRoot, 'resources', PLATFORM_DIR));
  }
  // userData synced copy
  dirs.push(path.join(getUserDataPath(), 'runtimes', PLATFORM_DIR, 'bin'));
  dirs.push(path.join(getUserDataPath(), 'runtimes', PLATFORM_DIR));
  return dirs;
}

function probeOnPath(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let _ffmpegPath: string | null = null;
let _ffprobePath: string | null = null;

function resolveBinary(
  name: 'ffmpeg' | 'ffprobe',
  envVar: string,
): string {
  const envOverride = process.env[envVar];
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  for (const dir of bundledBinDirs()) {
    const candidate = path.join(dir, `${name}${EXE}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // System PATH — verify it actually runs before committing to it.
  if (probeOnPath(name)) {
    return name;
  }

  // Last resort: return the bare name; callers surface the spawn error.
  return name;
}

export function getFfmpegPath(): string {
  if (!_ffmpegPath) _ffmpegPath = resolveBinary('ffmpeg', 'NOOBCLAW_FFMPEG_PATH');
  return _ffmpegPath;
}

export function getFfprobePath(): string {
  if (!_ffprobePath) _ffprobePath = resolveBinary('ffprobe', 'NOOBCLAW_FFPROBE_PATH');
  return _ffprobePath;
}

/** ffmpeg 是否可用(spawn 能跑通 -version)。UI 不可用时给友好提示。 */
export function isFfmpegAvailable(): boolean {
  const p = getFfmpegPath();
  try {
    const r = spawnSync(p, ['-version'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface RunFfmpegOptions {
  /** 每行 stderr 回调(ffmpeg 的进度都打在 stderr)。 */
  onStderr?: (line: string) => void;
  /** 超时毫秒,默认 5 分钟。 */
  timeoutMs?: number;
  cwd?: string;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

/** 跑一条 ffmpeg 命令。args 不含可执行名本身。 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<RunResult> {
  const bin = getFfmpegPath();
  return runProcess(bin, args, opts);
}

function runProcess(bin: string, args: string[], opts: RunFfmpegOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ ok: false, code: null, stderr: stderr + '\n[timeout]' });
      }
    }, opts.timeoutMs ?? 300_000);

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      if (opts.onStderr) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onStderr(line);
        }
      }
      // keep memory bounded
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stderr: `${stderr}\n[spawn error] ${String(err)}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
  });
}

/** ffprobe 出图片/视频首个视频流的宽高。失败返回 {width:0,height:0}。 */
export function probeImageSize(filePath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const bin = getFfprobePath();
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      filePath,
    ];
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', () => resolve({ width: 0, height: 0 }));
    child.on('close', () => {
      const m = out.trim().match(/^(\d+)x(\d+)/);
      if (!m) return resolve({ width: 0, height: 0 });
      resolve({ width: parseInt(m[1], 10) || 0, height: parseInt(m[2], 10) || 0 });
    });
  });
}

/** ffprobe 出媒体时长(秒)。失败返回 0。 */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const bin = getFfprobePath();
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ];
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    });
  });
}
