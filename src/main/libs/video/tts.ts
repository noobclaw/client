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
 * 可靠性:edge-tts 在线接口偶发抖动/限流,synthesize() 内置最多 3 次重试(指数退避)。
 * 仍合成不出真人声时返回 synthesized:false(并把 stderr 诊断写进 _lastTtsError),
 * 静音 mp3 只作为占位返回 —— 由 pipeline 判定为配音失败、终止出片并退费,
 * 绝不把「无配音的视频」当成片交付。
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

interface EdgeTtsRun {
  ok: boolean;
  /** 失败诊断(进程 stderr / 超时 / 空输出),给上层拼进 _lastTtsError。 */
  detail: string;
}

function runEdgeTts(pyExe: string, text: string, voice: string, outPath: string, rate?: number, subtitlePath?: string): Promise<EdgeTtsRun> {
  return new Promise((resolve) => {
    const env = pythonEnv();
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outPath];
    if (subtitlePath) args.push('--write-subtitles', subtitlePath);
    const rateArg = normalizeRate(rate);
    if (rateArg) args.push('--rate', rateArg);
    // 每次重试前清掉上轮可能残留的半截输出,避免「旧文件 >256 字节」骗过校验。
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    const child = spawn(pyExe, args, { env, windowsHide: true });
    let stderr = '';
    try { child.stderr?.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString(); }); } catch {}
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, detail: '合成超时(60s,可能是网络到微软 TTS 端点不通)' }); }
    }, 60_000);
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, detail: `进程启动失败:${e instanceof Error ? e.message : String(e)}` }); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hasOut = fs.existsSync(outPath) && fs.statSync(outPath).size > 256;
      if (code === 0 && hasOut) { resolve({ ok: true, detail: '' }); return; }
      const err = stderr.trim().replace(/\s+/g, ' ').slice(-200);
      const why = code !== 0 ? `退出码 ${code}` : '退出码 0 但无有效音频输出';
      resolve({ ok: false, detail: err ? `${why}:${err}` : why });
    });
  });
}

/** 重试间隔休眠(edge-tts 网络抖动,退避一下再试)。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
        // edge-tts 走在线接口,偶发网络抖动/限流 → 重试最多 5 次再判失败(指数退避)。
        // 2026-04 起微软上游按 voice 间歇性拒发音频(rany2/edge-tts#473),
        // 单纯加重试次数仍有限,真正救场要靠调用方做 voice fallback(见 getVoiceFallbacks)。
        const MAX_ATTEMPTS = 5;
        let lastDetail = '';
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const run = await runEdgeTts(pyExe, clean, useVoice, outPath, rate, subPath);
          if (run.ok) {
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
          lastDetail = run.detail || lastDetail;
          if (attempt < MAX_ATTEMPTS) await sleep(800 * attempt);
        }
        _lastTtsError = lastDetail
          ? `edge-tts 合成失败(已重试 ${MAX_ATTEMPTS} 次):${lastDetail.slice(0, 160)}`
          : `edge-tts 运行失败(已装好但合成无输出,已重试 ${MAX_ATTEMPTS} 次)`;
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

/**
 * 同语种同性别的 voice fallback 链(整片重做用)。数组首位 = primary,后续是同语种同性别备选。
 * 表里没有就只返回 [primary] — 不切 voice,只靠 synthesize() 内部 MAX_ATTEMPTS=5 次重试救场。
 *
 * 背景:edge-tts 2026-04 起出现【按 voice 间歇性拒发音频】的上游问题(rany2/edge-tts#473 至今 open),
 *   单 voice 多次重试也救不回时,**换 voice 整片重做**是上游用户实测有效的 workaround
 *   (评论:"I tried to use another voice, and then it worked again")。
 *
 * 设计规则:
 *   - 只在【同语种 + 同性别】之间 fallback,避免音色 / 语种突变让用户体验更糟。
 *   - 调用方(pipeline)拿到链后,要的是【整片重头合】,不是单句切,这样音色全篇统一。
 *   - 没列进表的 voice(方言、独子 voice、跨性别没法救)→ 走单 voice 重试,失败就退费。
 *   - HsiaoYu(台湾女声第二个)只用作 HsiaoChen 的后台 fallback,UI 不暴露。
 */
export function getVoiceFallbacks(primary: string): string[] {
  const M: Record<string, string[]> = {
    // —— 中文标准女声 ——
    'zh-CN-XiaoxiaoNeural':  ['zh-CN-XiaoxiaoNeural',  'zh-CN-XiaoyiNeural'],
    'zh-CN-XiaoyiNeural':    ['zh-CN-XiaoyiNeural',    'zh-CN-XiaoxiaoNeural'],
    // —— 中文男声(3 互救) ——
    'zh-CN-YunxiNeural':     ['zh-CN-YunxiNeural',     'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural'],
    'zh-CN-YunyangNeural':   ['zh-CN-YunyangNeural',   'zh-CN-YunxiNeural',   'zh-CN-YunjianNeural'],
    'zh-CN-YunjianNeural':   ['zh-CN-YunjianNeural',   'zh-CN-YunxiNeural',   'zh-CN-YunyangNeural'],
    // —— 粤语女声(HiuGaai / HiuMaan 互救;WanLung 男声唯一,不 fallback) ——
    'zh-HK-HiuGaaiNeural':   ['zh-HK-HiuGaaiNeural',   'zh-HK-HiuMaanNeural'],
    'zh-HK-HiuMaanNeural':   ['zh-HK-HiuMaanNeural',   'zh-HK-HiuGaaiNeural'],
    // —— 台湾国语女声(HsiaoChen → HsiaoYu 后台备胎) ——
    'zh-TW-HsiaoChenNeural': ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'],
    // —— 英文女声(3 互救) ——
    'en-US-JennyNeural':     ['en-US-JennyNeural',     'en-US-AriaNeural',    'en-US-EmmaNeural'],
    'en-US-AriaNeural':      ['en-US-AriaNeural',      'en-US-JennyNeural',   'en-US-EmmaNeural'],
    'en-US-EmmaNeural':      ['en-US-EmmaNeural',      'en-US-AriaNeural',    'en-US-JennyNeural'],
    // —— 英文男声(3 互救) ——
    'en-US-GuyNeural':       ['en-US-GuyNeural',       'en-US-AndrewNeural',  'en-US-BrianNeural'],
    'en-US-AndrewNeural':    ['en-US-AndrewNeural',    'en-US-GuyNeural',     'en-US-BrianNeural'],
    'en-US-BrianNeural':     ['en-US-BrianNeural',     'en-US-AndrewNeural',  'en-US-GuyNeural'],
    // —— 以下 voice 不做 voice 切换 fallback,只靠 5 次重试: ——
    //   zh-CN-liaoning-XiaobeiNeural(东北方言独子)、zh-TW-YunJheNeural(台湾男声独子)、
    //   ja/ko/fr/es-MX/pt-BR/id/vi/ar 各只配了一对 voice,跨性别会让音色跳变,体验不如失败退费让用户重试。
  };
  return M[primary] || [primary];
}
