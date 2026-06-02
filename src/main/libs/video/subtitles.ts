/**
 * subtitles — 用 faster-whisper 把【已合成的整条旁白音频】转成带精确时间戳的字幕 cue。
 *
 * 为什么要 Whisper:edge-tts 中文音色只发 SentenceBoundary(没有逐词 WordBoundary),
 * 按字数比例估时长会和真实语速错位。Whisper 直接听音频出逐段时间戳,字幕跟旁白严丝合缝
 * (抄 MoneyPrinterTurbo 的字幕方案)。
 *
 * 复用 tts.ts 里那个【已确定可用】的 python(Windows 内置 runtime / mac-linux venv),
 * 没装 faster-whisper 就懒加载 pip 装一次。任何环节失败(没 python / 装不上 / 模型下不动 /
 * 转写超时)→ 返回 null,compose 自动退回「按各镜已知时长估算的 cue」,字幕照样有,只是
 * 时间没那么准。绝不让出片因为 Whisper 挂掉而失败。
 */

import { spawn, spawnSync } from 'child_process';
import { resolveTtsPython } from './tts';

export interface SubtitleCue {
  text: string;
  /** 相对整条音频起点的秒。 */
  start: number;
  end: number;
}

let _whisperReady: boolean | undefined = undefined;

/** import faster_whisper 能否跑通。 */
function whisperImportable(pyExe: string): boolean {
  try {
    const r = spawnSync(pyExe, ['-c', 'import faster_whisper'], {
      timeout: 30_000,
      stdio: 'ignore',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 确保 faster-whisper 装好;装不上返回 false(上层降级)。装一次缓存结果。 */
function ensureWhisper(pyExe: string): boolean {
  if (_whisperReady !== undefined) return _whisperReady;
  if (whisperImportable(pyExe)) {
    _whisperReady = true;
    return true;
  }
  // CPU int8 推理用 faster-whisper(ctranslate2 后端,无需 torch,体积/速度都友好)。
  const install = spawnSync(
    pyExe,
    ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', 'faster-whisper'],
    { timeout: 600_000, encoding: 'utf-8' },
  );
  _whisperReady = install.status === 0 && whisperImportable(pyExe);
  return _whisperReady;
}

/**
 * 内嵌的转写脚本:加载 base 模型(CPU int8),逐段输出 {text,start,end} 的 JSON 数组。
 * 用 word_timestamps 让分段更细(短句更跟手),没词级时间也能退回段级。
 */
const TRANSCRIBE_PY = `
import sys, json
audio = sys.argv[1]
try:
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(audio, word_timestamps=True, vad_filter=True)
    cues = []
    for seg in segments:
        words = getattr(seg, "words", None)
        if words:
            # 逐词攒成短 cue(~12 字一段),时间用词级时间戳,最跟手
            buf, bs, be = "", None, None
            for w in words:
                wt = (w.word or "").strip()
                if not wt:
                    continue
                if bs is None:
                    bs = w.start
                buf += wt
                be = w.end
                if len(buf) >= 12:
                    cues.append({"text": buf, "start": float(bs), "end": float(be)})
                    buf, bs, be = "", None, None
            if buf and bs is not None:
                cues.append({"text": buf, "start": float(bs), "end": float(be)})
        else:
            t = (seg.text or "").strip()
            if t:
                cues.append({"text": t, "start": float(seg.start), "end": float(seg.end)})
    print(json.dumps(cues, ensure_ascii=False))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

function runTranscribe(pyExe: string, audioPath: string): Promise<SubtitleCue[] | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(pyExe, ['-c', TRANSCRIBE_PY, audioPath], { windowsHide: true });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} resolve(null); }
    }, 300_000); // 模型推理给 5min,首跑还要下模型
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      try {
        const parsed = JSON.parse(out.trim());
        if (!Array.isArray(parsed)) { resolve(null); return; }
        const cues = parsed
          .filter((c: any) => c && typeof c.text === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
          .map((c: any) => ({ text: String(c.text).trim(), start: Number(c.start), end: Number(c.end) }))
          .filter((c: SubtitleCue) => c.text.length > 0);
        resolve(cues.length > 0 ? cues : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * 把整条旁白音频转成带时间戳的字幕 cue;任何失败返回 null(compose 会用估算 cue 兜底)。
 */
export async function transcribeToCues(masterAudioPath: string): Promise<SubtitleCue[] | null> {
  try {
    const pyExe = await resolveTtsPython();
    if (!pyExe) return null;
    if (!ensureWhisper(pyExe)) return null;
    return await runTranscribe(pyExe, masterAudioPath);
  } catch {
    return null;
  }
}
