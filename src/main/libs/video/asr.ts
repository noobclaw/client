/**
 * 本地语音转写(ASR)—— 视频搬运/二创 用。
 *
 * 选型:faster-whisper(CTranslate2 实现的 whisper,CPU int8 比官方 whisper 快很多),
 *      跑在【edge-tts 已经在用的那套 Python 运行时】里 —— 本地、免费、无需 key、跨平台。
 *      不选 whisper.cpp 二进制:跨平台预编译(尤其 mac)很麻烦,而我们已经有可用的
 *      Python 基建(见 tts.ts / pythonRuntime.ts),复用最省事。
 *
 * 模型:默认 small(~480MB)【首次用时下载】到 userData/runtimes/whisper-models,
 *      不进安装包(安装包只大几 KB 的脚本)。卸载/清缓存即清模型。
 *
 * 流程:ffmpeg 抽 16k 单声道 wav → faster-whisper 转写 → {lang, segments, text}。
 *      语言自动识别(info.language),供 orchestrator 判断要不要翻译。
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getUserDataPath } from '../platformAdapter';
import { getUserPythonRoot, ensurePythonPipReady, appendPythonRuntimeToEnv } from '../pythonRuntime';
import { runFfmpeg } from './ffmpegRuntime';

export interface AsrSegment {
  start: number;   // 秒
  end: number;     // 秒
  text: string;
}
export interface AsrResult {
  ok: boolean;
  lang?: string;          // 识别出的语言码,如 'en' / 'zh' / 'ja'
  duration?: number;      // 音频时长(秒)
  text?: string;          // 全文(segments 拼接)
  segments?: AsrSegment[];
  reason?: string;        // 失败诊断
}

let _lastAsrError: string | null = null;
export function getLastAsrError(): string | null { return _lastAsrError; }

// ─────────────────────────── 模型缓存目录 ───────────────────────────
function modelRoot(): string {
  return path.join(getUserDataPath(), 'runtimes', 'whisper-models');
}

// ─────────────────────────── Python 解析(复用 tts.ts 同款套路)───────────────────────────
// 国内镜像:huggingface.co 在国内常被墙,faster-whisper 经 huggingface_hub 下模型;
// hf-mirror.com 是社区镜像(全球可达),huggingface_hub 原生认 HF_ENDPOINT。
// 用户自己设了 HF_ENDPOINT 就尊重其设置。
const HF_MIRROR = 'https://hf-mirror.com';
// pip 清华镜像(国内快;非国内也可达,只是稍慢),失败回退默认 PyPI。
const PIP_MIRROR_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PIP_MIRROR_HOST = 'pypi.tuna.tsinghua.edu.cn';

function pythonEnv(): NodeJS.ProcessEnv {
  // Windows 走内置 runtime(把 runtime 目录拼进 PATH);mac/linux 用 venv,无需改 PATH。
  const base: NodeJS.ProcessEnv = process.platform === 'win32'
    ? (appendPythonRuntimeToEnv({ ...process.env }) as NodeJS.ProcessEnv)
    : { ...process.env };
  if (!base.HF_ENDPOINT) base.HF_ENDPOINT = HF_MIRROR;
  return base;
}

/** pip 装 faster-whisper:先清华镜像,失败回退默认 PyPI。返回是否成功 + 诊断。 */
function pipInstallWhisper(pyExe: string): { ok: boolean; detail: string } {
  const baseArgs = ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check'];
  const spawnOpts = { env: pythonEnv(), timeout: 900_000, encoding: 'utf-8' as const };
  // 1) 清华镜像
  let r = spawnSync(pyExe, [...baseArgs, '-i', PIP_MIRROR_URL, '--trusted-host', PIP_MIRROR_HOST, 'faster-whisper'], spawnOpts);
  if (r.status === 0) return { ok: true, detail: 'mirror' };
  const mErr = (r.stderr || r.stdout || `exit ${r.status}`).toString().slice(-160);
  // 2) 回退默认 PyPI
  r = spawnSync(pyExe, [...baseArgs, 'faster-whisper'], spawnOpts);
  if (r.status === 0) return { ok: true, detail: 'pypi' };
  const pErr = (r.stderr || r.stdout || `exit ${r.status}`).toString().slice(-160);
  return { ok: false, detail: `镜像失败(${mErr}) / PyPI 失败(${pErr})` };
}

function findWinPythonExe(): string {
  const root = getUserPythonRoot();
  for (const name of ['python.exe', 'python3.exe']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return 'python';
}

function whisperImportable(pyExe: string): boolean {
  try {
    const r = spawnSync(pyExe, ['-c', 'import faster_whisper'], {
      env: pythonEnv(), timeout: 30_000, stdio: 'ignore',
    });
    return r.status === 0;
  } catch { return false; }
}

// ─────────────────────────── mac/linux:专用 venv(隔离,不污染 edge-tts venv)───────────────────────────
function venvDir(): string {
  return path.join(getUserDataPath(), 'runtimes', 'whisper-venv');
}
function venvPython(): string {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python3');
}
function findSystemPython3(): string | null {
  const cands = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', 'python']
    : ['/usr/bin/python3', '/usr/local/bin/python3', 'python3', 'python'];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 10_000, stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

/** 准备 mac/linux 的 faster-whisper venv,返回可用 python;失败返回 null。 */
function ensureUnixWhisper(): string | null {
  const vpy = venvPython();
  if (fs.existsSync(vpy) && whisperImportable(vpy)) return vpy;

  const sys = findSystemPython3();
  if (!sys) {
    _lastAsrError = '系统未找到 python3(mac 可执行 `brew install python3` 或安装 Xcode 命令行工具)';
    return null;
  }
  // 系统 python 自己就能 import(用户全局装过)→ 直接用
  if (whisperImportable(sys)) return sys;

  // 建 venv(已存在则跳过创建)
  if (!fs.existsSync(vpy)) {
    try { fs.mkdirSync(path.dirname(venvDir()), { recursive: true }); } catch {}
    const mk = spawnSync(sys, ['-m', 'venv', venvDir()], { timeout: 120_000, encoding: 'utf-8' });
    if (mk.status !== 0 || !fs.existsSync(vpy)) {
      _lastAsrError = `创建 venv 失败:${(mk.stderr || mk.stdout || `exit ${mk.status}`).toString().slice(0, 200)}`;
      return null;
    }
  }
  spawnSync(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', PIP_MIRROR_URL, '--trusted-host', PIP_MIRROR_HOST], { timeout: 120_000, stdio: 'ignore' });
  const inst = pipInstallWhisper(vpy);
  if (!inst.ok || !whisperImportable(vpy)) {
    _lastAsrError = `venv 内安装 faster-whisper 失败:${inst.detail}`;
    return null;
  }
  return vpy;
}

let _resolvedPython: string | null | undefined = undefined;

/** 解析出一个【已装好 faster-whisper】的 python 可执行;失败返回 null。 */
async function resolveAsrPython(): Promise<string | null> {
  if (_resolvedPython !== undefined) return _resolvedPython;

  if (process.platform === 'win32') {
    const pyExe = findWinPythonExe();
    if (whisperImportable(pyExe)) { _resolvedPython = pyExe; return pyExe; }
    try { await ensurePythonPipReady(); } catch {}
    const inst = pipInstallWhisper(pyExe);
    if (inst.ok && whisperImportable(pyExe)) {
      _resolvedPython = pyExe;
      return pyExe;
    }
    _lastAsrError = `Windows 安装 faster-whisper 失败:${inst.detail}`;
    _resolvedPython = null;
    return null;
  }

  _resolvedPython = ensureUnixWhisper();
  return _resolvedPython;
}

// ─────────────────────────── 转写脚本(写到磁盘复用)───────────────────────────
const TRANSCRIBE_PY = `
import sys, json
wav, model_name, lang, dl_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
from faster_whisper import WhisperModel
model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=dl_root)
kw = {} if lang in ("auto", "") else {"language": lang}
segments, info = model.transcribe(wav, beam_size=5, vad_filter=True, **kw)
segs = [{"start": round(s.start, 3), "end": round(s.end, 3), "text": (s.text or "").strip()} for s in segments]
sys.stdout.write(json.dumps({"language": info.language, "duration": round(info.duration, 3), "segments": segs}, ensure_ascii=False))
`.trimStart();

function transcribeScriptPath(): string {
  const dir = path.join(getUserDataPath(), 'runtimes');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const p = path.join(dir, 'whisper_transcribe.py');
  try {
    // 内容变了才写,避免每次 IO
    const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (cur !== TRANSCRIBE_PY) fs.writeFileSync(p, TRANSCRIBE_PY, 'utf8');
  } catch {}
  return p;
}

// ─────────────────────────── ffmpeg 抽 16k 单声道 wav ───────────────────────────
async function extractWav(mediaPath: string): Promise<string | null> {
  const wav = mediaPath.replace(/\.[^.\\/]+$/, '') + '.asr16k.wav';
  const r = await runFfmpeg([
    '-y', '-i', mediaPath,
    '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wav,
  ], { timeoutMs: 300_000 });
  if (r.ok && fs.existsSync(wav)) return wav;
  _lastAsrError = 'ffmpeg 抽音轨失败:' + (r.stderr || '').slice(-200);
  return null;
}

/**
 * 转写一个媒体文件(视频/音频均可)。
 * @param mediaPath 绝对路径
 * @param opts.model  whisper 模型名,默认 'small'(可 'base'/'medium')
 * @param opts.language 强制语言('en'/'zh'/...);默认 'auto' 自动识别
 * @param opts.onProgress 进度日志回调
 */
export async function transcribe(
  mediaPath: string,
  opts?: { model?: string; language?: string; onProgress?: (msg: string) => void },
): Promise<AsrResult> {
  const log = (m: string) => { try { opts?.onProgress?.(m); } catch {} };
  _lastAsrError = null;

  if (!mediaPath || !fs.existsSync(mediaPath)) {
    return { ok: false, reason: 'media_not_found:' + mediaPath };
  }

  const py = await resolveAsrPython();
  if (!py) {
    return { ok: false, reason: 'python_setup_failed:' + (_lastAsrError || 'unknown') };
  }

  log('🎙️ 抽取音轨...');
  const wav = await extractWav(mediaPath);
  if (!wav) return { ok: false, reason: _lastAsrError || 'extract_wav_failed' };

  const model = (opts?.model || 'small').trim();
  const lang = (opts?.language || 'auto').trim();
  const dlRoot = modelRoot();
  try { fs.mkdirSync(dlRoot, { recursive: true }); } catch {}
  const script = transcribeScriptPath();

  log(`🧠 whisper(${model})转写中,首次会下载模型(~480MB)...`);

  const result = await new Promise<AsrResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(py, [script, wav, model, lang, dlRoot], { env: pythonEnv() });
    // 首次下载模型 + 较长音视频转写都可能很久,给 60 分钟上限。
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, reason: 'asr_timeout' });
    }, 3600_000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      // faster-whisper 下载/转写进度走 stderr,挑关键字回传
      const line = s.trim().split(/\r?\n/).pop() || '';
      if (line && /%|download|Downloading|model/i.test(line)) log('   ' + line.slice(0, 120));
    });
    child.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn_error:' + String((err as any)?.message || err).slice(0, 150) });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, reason: 'whisper_exit_' + code + ':' + stderr.slice(-300) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const segments: AsrSegment[] = Array.isArray(parsed.segments) ? parsed.segments : [];
        const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
        resolve({ ok: true, lang: parsed.language, duration: parsed.duration, segments, text });
      } catch (e: any) {
        resolve({ ok: false, reason: 'parse_failed:' + String(e?.message || e).slice(0, 120) + '|out:' + stdout.slice(0, 200) });
      }
    });
  });

  // 清理临时 wav
  try { fs.unlinkSync(wav); } catch {}

  if (!result.ok) _lastAsrError = result.reason || _lastAsrError;
  return result;
}
