/**
 * tts — 文案配音。
 *
 * 首选 edge-tts(微软 Edge 在线 TTS,免费、无需 key),通过内置 Python 跑:
 *   python -m edge_tts --voice <voice> --text <文案> --write-media out.mp3
 * edge-tts 没装就懒加载 pip install 一次。
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
import { runFfmpeg, probeDuration } from './ffmpegRuntime';
import { getTtsVoice } from './config';

export interface TtsResult {
  ok: boolean;
  /** 音频文件路径(成功是真人声,失败是静音兜底)。 */
  audioPath: string;
  durationSec: number;
  /** true = 真 TTS;false = 静音兜底。 */
  synthesized: boolean;
}

function findPythonExe(): string {
  if (process.platform === 'win32') {
    const root = getUserPythonRoot();
    for (const name of ['python.exe', 'python3.exe']) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return p;
    }
    return 'python';
  }
  return 'python3';
}

function pythonEnv(): NodeJS.ProcessEnv {
  return appendPythonRuntimeToEnv({ ...process.env }) as NodeJS.ProcessEnv;
}

let _edgeTtsReady: boolean | null = null;

/** edge-tts 是否可 import;没有就尝试 pip 安装一次。 */
async function ensureEdgeTts(pyExe: string): Promise<boolean> {
  if (_edgeTtsReady !== null) return _edgeTtsReady;

  const env = pythonEnv();
  const check = spawnSync(pyExe, ['-c', 'import edge_tts'], { env, timeout: 20_000, stdio: 'ignore' });
  if (check.status === 0) {
    _edgeTtsReady = true;
    return true;
  }

  // 确保 pip 可用,再装 edge-tts
  if (process.platform === 'win32') {
    try { await ensurePythonPipReady(); } catch {}
  }
  const install = spawnSync(
    pyExe,
    ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'edge-tts'],
    { env, timeout: 180_000, stdio: 'ignore' },
  );
  if (install.status !== 0) {
    _edgeTtsReady = false;
    return false;
  }
  const recheck = spawnSync(pyExe, ['-c', 'import edge_tts'], { env, timeout: 20_000, stdio: 'ignore' });
  _edgeTtsReady = recheck.status === 0;
  return _edgeTtsReady;
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

function runEdgeTts(pyExe: string, text: string, voice: string, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const env = pythonEnv();
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outPath];
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
export async function synthesize(text: string, outPath: string, voice?: string): Promise<TtsResult> {
  const clean = (text || '').trim();
  const estDur = estimateDuration(clean || '。');
  const useVoice = voice || getTtsVoice();

  if (clean) {
    try {
      const pyExe = findPythonExe();
      const ready = await ensureEdgeTts(pyExe);
      if (ready) {
        const ok = await runEdgeTts(pyExe, clean, useVoice, outPath);
        if (ok) {
          const dur = await probeDuration(outPath);
          return {
            ok: true,
            audioPath: outPath,
            durationSec: dur > 0 ? dur : estDur,
            synthesized: true,
          };
        }
      }
    } catch {
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
