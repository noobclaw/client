/**
 * deriveExtras — 视频下载的「派生输出」引擎(本地 ffmpeg + 可选 ASR)。
 *
 * 视频无水印下载拿到的是平台直链 mp4(音视频已混流、无字幕轨)。用户可勾选额外导出:
 *   · 无声视频  —— ffmpeg 去音轨、视频流拷贝不重编码(无损、秒级、免费)。
 *   · 音轨      —— 抽原始音频流到 .m4a(优先拷贝 AAC,非 AAC 源转码)。免费。
 *   · 字幕      —— 平台短视频不带字幕轨,只能对音频做 ASR 语音转写生成。抽 16k 单声道
 *                  wav → transcribeAudio(Whisper,response_format=srt 直接出带时间轴
 *                  SubRip)→ 写 .srt(或纯文字 .txt)。联网、付费(调 ASR)。
 *
 * 三者互相独立、单个失败不影响其它;全部把产物放在和原视频【同目录】、同 base 名,
 * 方便用户在「打开输出文件夹」里一眼看到一组文件:
 *   foo.mp4 / foo_无声.mp4 / foo.m4a / foo.srt
 */

import * as fs from 'fs';
import * as path from 'path';
import { runFfmpeg, isFfmpegAvailable } from './ffmpegRuntime';
import { transcribeAudio } from '../mediaUnderstanding';

export interface DeriveExtrasOpts {
  /** 导出去掉音轨的视频(= 无声无字幕视频:平台原片本就无字幕轨,去音轨即得干净底片)。 */
  mute?: boolean;
  /** 导出抽出来的音轨(.m4a)。 */
  audio?: boolean;
  /** 生成字幕:同时产出 .srt(带时间轴)+ .txt(纯文本,从 srt 去时间轴得来,不额外调 ASR)。 */
  subtitle?: boolean;
  /** ASR 语言提示(如 'zh' / 'en');不传则自动识别。 */
  language?: string;
}

export interface DeriveExtrasResult {
  mutePath?: string;
  audioPath?: string;
  /** 字幕 .srt(带时间轴)。 */
  subtitlePath?: string;
  /** 字幕文本 .txt(从 srt 去时间轴得到的纯文本稿)。 */
  subtitleTextPath?: string;
  /** 每个派生项失败的简短原因(不抛错,逐项收集)。 */
  errors: string[];
}

/** 把 ffmpeg stderr 末行抽成一句简短原因。 */
function lastErr(stderr: string): string {
  const lines = (stderr || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : 'failed';
}

/** 把 SubRip(.srt)去掉序号行 + 时间轴行,得到纯文本字幕稿(每条一行)。 */
function srtToPlainText(srt: string): string {
  return (srt || '')
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;            // 空行
      if (/^\d+$/.test(t)) return false; // 纯序号行
      if (/-->/.test(t)) return false;   // 时间轴行
      return true;
    })
    .join('\n')
    .trim();
}

export async function deriveVideoExtras(
  videoPath: string,
  opts: DeriveExtrasOpts,
): Promise<DeriveExtrasResult> {
  const res: DeriveExtrasResult = { errors: [] };
  const wantMute = !!opts.mute;
  const wantAudio = !!opts.audio;
  const wantSub = !!opts.subtitle;
  if (!wantMute && !wantAudio && !wantSub) return res;

  if (!videoPath || !fs.existsSync(videoPath)) {
    res.errors.push('源视频不存在');
    return res;
  }
  if (!isFfmpegAvailable()) {
    res.errors.push('ffmpeg 不可用,无法派生');
    return res;
  }

  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const out = (suffix: string, ext: string) => path.join(dir, `${base}${suffix}.${ext}`);

  // 1) 无声视频:去音轨,视频流拷贝不重编码(无损、秒级)。
  if (wantMute) {
    const p = out('_无声', 'mp4');
    const r = await runFfmpeg(['-y', '-i', videoPath, '-map', '0:v:0', '-c', 'copy', '-an', p], { timeoutMs: 120_000 });
    if (r.ok && fs.existsSync(p)) res.mutePath = p;
    else res.errors.push('无声视频: ' + lastErr(r.stderr));
  }

  // 2) 音轨:抽原始音频流 → .m4a。优先 -c:a copy(无损保留 AAC);非 AAC 源拷贝会失败,
  //    退回转码 aac。
  if (wantAudio) {
    const m4a = out('', 'm4a');
    let r = await runFfmpeg(['-y', '-i', videoPath, '-vn', '-c:a', 'copy', m4a], { timeoutMs: 120_000 });
    if (!(r.ok && fs.existsSync(m4a))) {
      r = await runFfmpeg(['-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '192k', m4a], { timeoutMs: 180_000 });
    }
    if (r.ok && fs.existsSync(m4a)) res.audioPath = m4a;
    else res.errors.push('音轨: ' + lastErr(r.stderr));
  }

  // 3) 字幕:抽 16k 单声道 wav(ASR 最佳输入)→ transcribeAudio(srt)→ 写 .srt,再从 srt
  //    去时间轴得纯文本写 .txt(只调一次 ASR,两份产物)。wav 是临时文件,转写后删掉。
  if (wantSub) {
    const wav = out('_asr_tmp', 'wav');
    try {
      const r = await runFfmpeg(['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeoutMs: 180_000 });
      if (!(r.ok && fs.existsSync(wav))) {
        res.errors.push('字幕: 抽音频失败 ' + lastErr(r.stderr));
      } else {
        const srt = await transcribeAudio(wav, opts.language, 'srt');
        if (srt && !/^Transcription not available|^Audio not found/.test(srt)) {
          const sp = out('', 'srt');
          fs.writeFileSync(sp, srt, 'utf8');
          res.subtitlePath = sp;
          // 纯文本字幕稿:从 srt 去序号/时间轴得到(不额外调 ASR)。
          const txt = srtToPlainText(srt);
          if (txt) {
            const tp = out('', 'txt');
            fs.writeFileSync(tp, txt, 'utf8');
            res.subtitleTextPath = tp;
          }
        } else {
          res.errors.push('字幕: 转写为空或 ASR 不可用(检查 AI 配置)');
        }
      }
    } catch (e: any) {
      res.errors.push('字幕: ' + String(e?.message || e).slice(0, 100));
    } finally {
      try { if (fs.existsSync(wav)) fs.unlinkSync(wav); } catch { /* 临时文件清理失败忽略 */ }
    }
  }

  return res;
}
