/**
 * tts — 文案配音 + 字幕时间轴(抄 MoneyPrinterTurbo 的离线字幕方案)。
 *
 * 首选 edge-tts(微软 Edge 在线 TTS,免费、无需 key),通过内置 Python 跑:
 *   python -m edge_tts --voice <voice> --text <文案> --write-media out.mp3 \
 *                      --write-subtitles out.vtt
 * edge-tts 没装就懒加载 pip install 一次。
 *
 * 字幕:--write-subtitles 让 edge-tts 在合成的同时吐出【词边界时间戳】字幕(SRT/VTT
 * 两种格式都可能,按版本而定),完全离线、不下任何模型、国内可用。我们解析它再按 ~12 字
 * 攒成短语 cue 返回给 compose 烧字幕,字幕和旁白严丝合缝。解析失败不影响出片(compose
 * 会退回按各镜时长估算的 cue)。
 *
 * 任何环节失败 → 退化成「按字数估算时长的静音 mp3」,保证流水线总能出片(方便自测)。
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  getUserPythonRoot,
  appendPythonRuntimeToEnv,
  ensurePythonPipReady,
} from '../pythonRuntime';
import { getUserDataPath } from '../platformAdapter';
import { runFfmpeg, probeDuration } from './ffmpegRuntime';
import { getTtsVoice } from './config';

/** 一条字幕 cue(时间相对【本句配音】起点,秒)。 */
export interface TtsCue {
  text: string;
  start: number;
  end: number;
}

export interface TtsResult {
  ok: boolean;
  /** 音频文件路径(成功是真人声,失败是静音兜底)。 */
  audioPath: string;
  durationSec: number;
  /** true = 真 TTS;false = 静音兜底。 */
  synthesized: boolean;
  /**
   * edge-tts 词边界出的短语级字幕 cue(相对本句起点)。真 TTS 且字幕解析成功才有;
   * 静音兜底 / 解析失败为 undefined,上层退回估算。
   */
  cues?: TtsCue[];
}

/** 最近一次 TTS 失败原因(给上层/日志用,避免静默)。 */
let _lastTtsError: string | null = null;
export function getLastTtsError(): string | null {
  return _lastTtsError;
}

function pythonEnv(): NodeJS.ProcessEnv {
  // Windows 走内置 runtime;mac/linux 用 venv,无需改 PATH。
  return appendPythonRuntimeToEnv({ ...process.env }) as NodeJS.ProcessEnv;
}

/** import edge_tts 能否跑通。 */
function edgeTtsImportable(pyExe: string): boolean {
  try {
    const r = spawnSync(pyExe, ['-c', 'import edge_tts'], {
      env: pythonEnv(), timeout: 20_000, stdio: 'ignore',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────── Windows:内置 runtime ───────────────────────────

function findWinPythonExe(): string {
  const root = getUserPythonRoot();
  for (const name of ['python.exe', 'python3.exe']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return 'python';
}

// ─────────────────────────── mac/linux:专用 venv ───────────────────────────
//
// 关键背景:本仓库的 pythonRuntime 只内置了 Windows 版 Python(python-win)。
// mac/linux 上以前直接 `python3 -m pip install edge-tts` —— 新版 macOS / Homebrew
// 的系统 Python 是「externally-managed-environment」,直接 pip 装会被 PEP 668 拒绝,
// 于是 edge-tts 永远装不上 → 每句都静音兜底 → 用户看到「没有配音」。
//
// 修法:用系统 python3 建一个隔离 venv(userData/runtimes/edge-tts-venv),
// 往 venv 里装 edge-tts。venv 不受 PEP 668 限制,一次装好后续复用。

function venvDir(): string {
  return path.join(getUserDataPath(), 'runtimes', 'edge-tts-venv');
}

function venvPython(): string {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python3');
}

/** 找一个能跑通的系统 python3(mac/linux)。找不到返回 null。 */
function findSystemPython(): string | null {
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', 'python']
    : ['/usr/bin/python3', '/usr/local/bin/python3', 'python3', 'python'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 10_000, stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * 准备 mac/linux 的 edge-tts 环境,返回可用的 venv python 路径;失败返回 null
 * 并把原因写进 _lastTtsError。
 */
function ensureUnixEdgeTts(): string | null {
  const vpy = venvPython();
  // 1. venv 已就绪且能 import → 直接用
  if (fs.existsSync(vpy) && edgeTtsImportable(vpy)) return vpy;

  // 2. 找系统 python3
  const sys = findSystemPython();
  if (!sys) {
    _lastTtsError = '系统未找到 python3(mac 可执行 `brew install python3` 或安装 Xcode 命令行工具)';
    return null;
  }
  // 2a. 系统 python 本身就能 import edge_tts(用户已全局装过)→ 直接用
  if (edgeTtsImportable(sys)) return sys;

  // 3. 建 venv(已存在则跳过创建)
  if (!fs.existsSync(vpy)) {
    try { fs.mkdirSync(path.dirname(venvDir()), { recursive: true }); } catch {}
    const mk = spawnSync(sys, ['-m', 'venv', venvDir()], { timeout: 120_000, encoding: 'utf-8' });
    if (mk.status !== 0 || !fs.existsSync(vpy)) {
      _lastTtsError = `创建 venv 失败:${(mk.stderr || mk.stdout || `exit ${mk.status}`).toString().slice(0, 200)}`;
      return null;
    }
  }

  // 4. venv 内装 edge-tts(venv 不受 PEP 668 限制)
  spawnSync(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 120_000, stdio: 'ignore' });
  const install = spawnSync(
    vpy,
    ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'edge-tts'],
    { timeout: 240_000, encoding: 'utf-8' },
  );
  if (install.status !== 0) {
    _lastTtsError = `venv 内安装 edge-tts 失败:${(install.stderr || install.stdout || `exit ${install.status}`).toString().slice(0, 200)}`;
    return null;
  }
  if (edgeTtsImportable(vpy)) return vpy;

  _lastTtsError = '安装完成但仍无法 import edge_tts';
  return null;
}

// venv / runtime 解析结果缓存(进程内只跑一次重活)。
let _resolvedPython: string | null | undefined = undefined;

/**
 * 解析出一个【已装好 edge-tts】的 python 可执行;失败返回 null。
 */
async function resolveTtsPython(): Promise<string | null> {
  if (_resolvedPython !== undefined) return _resolvedPython;

  if (process.platform === 'win32') {
    const pyExe = findWinPythonExe();
    if (edgeTtsImportable(pyExe)) { _resolvedPython = pyExe; return pyExe; }
    try { await ensurePythonPipReady(); } catch {}
    const install = spawnSync(
      pyExe,
      ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'edge-tts'],
      { env: pythonEnv(), timeout: 180_000, encoding: 'utf-8' },
    );
    if (install.status === 0 && edgeTtsImportable(pyExe)) {
      _resolvedPython = pyExe;
      return pyExe;
    }
    _lastTtsError = `Windows 安装 edge-tts 失败:${(install.stderr || install.stdout || `exit ${install.status}`).toString().slice(0, 200)}`;
    _resolvedPython = null;
    return null;
  }

  _resolvedPython = ensureUnixEdgeTts();
  return _resolvedPython;
}

function estimateDuration(text: string): number {
  // 中文约 4.5 字/秒,英文按词粗算;给点首尾留白。
  const chars = text.replace(/\s+/g, '').length;
  return Math.max(1.8, chars / 4.5 + 0.4);
}

/** 生成静音 mp3 兜底。 */
async function makeSilence(outPath: string, durationSec: number): Promise<boolean> {
  const r = await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
    '-t', durationSec.toFixed(2),
    '-c:a', 'libmp3lame', '-q:a', '6',
    outPath,
  ], { timeoutMs: 30_000 });
  return r.ok && fs.existsSync(outPath);
}

/** 把语速档(-50~+50,单位%)归一成 edge-tts 的 `--rate=+N%` 串;0/非法 → 不传。 */
function normalizeRate(rate?: number): string | null {
  const n = Math.round(Number(rate) || 0);
  if (!Number.isFinite(n) || n === 0) return null;
  const clamped = Math.max(-50, Math.min(50, n));
  return clamped >= 0 ? `+${clamped}%` : `${clamped}%`;
}

/**
 * 解析 edge-tts 写出的字幕文件 —— 同时兼容 SRT(`HH:MM:SS,mmm`)与 VTT(`HH:MM:SS.mmm`)
 * 两种格式(edge-tts 版本不同输出不同)。返回逐条词边界 cue(时间相对本句起点)。
 */
function parseSubtitleFile(filePath: string): TtsCue[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const lines = raw.split(/\r?\n/);
  // 毫秒分隔符 [.,] 同时吃 VTT 的点和 SRT 的逗号。
  const re = /(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  const cues: TtsCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const toSec = (h: string, mi: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    // 时间行之后到空行之间都是文本(通常一行一个词)。
    const textLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) break;
      textLines.push(lines[j].trim());
    }
    i = j;
    const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
    if (text && end > start) cues.push({ text, start, end });
  }
  return cues;
}

/**
 * 把逐词 cue 攒成 ~maxChars 字一段的短语 cue(用真实词级时间戳,不估算)。
 * 短语 start = 首词 start,end = 末词 end。中文按字,英文按词长累加。
 */
function groupWordCues(words: TtsCue[], maxChars = 12): TtsCue[] {
  const out: TtsCue[] = [];
  let buf = '';
  let start: number | null = null;
  let end = 0;
  const hasCjk = (s: string) => /[　-鿿＀-￯]/.test(s);
  for (const w of words) {
    if (start === null) start = w.start;
    // 英文词之间加空格,中文不加。
    buf = buf && !hasCjk(w.text) && !hasCjk(buf.slice(-1)) ? `${buf} ${w.text}` : `${buf}${w.text}`;
    end = w.end;
    if (buf.length >= maxChars) {
      out.push({ text: buf, start, end });
      buf = '';
      start = null;
    }
  }
  if (buf && start !== null) out.push({ text: buf, start, end });
  return out;
}

function runEdgeTts(pyExe: string, text: string, voice: string, outPath: string, rate?: number, subtitlePath?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const env = pythonEnv();
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outPath];
    if (subtitlePath) args.push('--write-subtitles', subtitlePath);
    const rateArg = normalizeRate(rate);
    if (rateArg) args.push('--rate', rateArg);
    const child = spawn(pyExe, args, { env, windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} resolve(false); }
    }, 60_000);
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 256);
    });
  });
}

/**
 * 给一句文案配音,输出 mp3 到 outPath。失败自动退化为静音 mp3。
 */
export async function synthesize(text: string, outPath: string, voice?: string, rate?: number): Promise<TtsResult> {
  const clean = (text || '').trim();
  const estDur = estimateDuration(clean || '。');
  const useVoice = voice || getTtsVoice();

  if (clean) {
    try {
      const pyExe = await resolveTtsPython();
      if (pyExe) {
        // 字幕和音频同名,扩展名 .vtt(edge-tts 按版本写 VTT/SRT,我们的解析器都吃)。
        const subPath = outPath.replace(/\.[^.]+$/, '') + '.vtt';
        const ok = await runEdgeTts(pyExe, clean, useVoice, outPath, rate, subPath);
        if (ok) {
          const dur = await probeDuration(outPath);
          let cues: TtsCue[] | undefined;
          try {
            const words = parseSubtitleFile(subPath);
            if (words.length > 0) cues = groupWordCues(words);
          } catch { /* 解析失败 → 上层估算兜底 */ }
          try { fs.unlinkSync(subPath); } catch {}
          return {
            ok: true,
            audioPath: outPath,
            durationSec: dur > 0 ? dur : estDur,
            synthesized: true,
            cues,
          };
        }
        _lastTtsError = _lastTtsError || 'edge-tts 运行失败(已装好但合成无输出)';
      }
    } catch (e) {
      _lastTtsError = e instanceof Error ? e.message : String(e);
      // fall through to silence
    }
  }

  // 兜底:静音
  const silenceOk = await makeSilence(outPath, estDur);
  return {
    ok: silenceOk,
    audioPath: outPath,
    durationSec: estDur,
    synthesized: false,
  };
}
