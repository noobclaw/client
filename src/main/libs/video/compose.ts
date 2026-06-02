/**
 * compose — 把「画面 + 配音 + 字幕」逐镜合成,再拼成一条竖屏 mp4。
 *
 * 每个分镜单独出一段 scene_NNN.mp4(画面 = 参考图/素材图做 Ken Burns 运镜,
 * 或纯色文字卡;音频 = 该句配音;底部烧录字幕),最后用 concat 拼起来。
 * 逐镜出片的好处:每段时长 = 该句音频时长,天然对齐,流水线也容错(某镜挂了好定位)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFfmpeg, probeDuration } from './ffmpegRuntime';

const W = 1080;
const H = 1920;
const FPS = 30;

/** 找一个系统里的中文字体给 drawtext 用。 */
function resolveCjkFont(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        'C:/Windows/Fonts/Deng.ttf',
      ]
    : process.platform === 'darwin'
      ? [
          '/System/Library/Fonts/PingFang.ttc',
          '/System/Library/Fonts/STHeiti Medium.ttc',
          '/Library/Fonts/Arial Unicode.ttf',
        ]
      : [
          '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 把一句话按 ~maxPerLine 个字符折行(中文友好)。 */
function wrapSubtitle(text: string, maxPerLine = 14): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const lines: string[] = [];
  let cur = '';
  for (const ch of clean) {
    cur += ch;
    if (cur.length >= maxPerLine) {
      lines.push(cur);
      cur = '';
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).join('\n'); // 最多 3 行,别糊满屏
}

/**
 * 把一镜的整句切成「短语」做逐句渐进字幕。
 *
 * edge-tts 中文音色只发 SentenceBoundary(没有逐词 WordBoundary),所以这里抄
 * MoneyPrinterTurbo 无词边界时的兜底:先按标点切,过长的再按 ~PHRASE_MAX 字硬切,
 * 时长按各短语字数比例分配(start/end 相对该镜音频起点,单位秒)。
 */
const PHRASE_MAX = 12;
function splitPhrases(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const rough = clean.split(/[,，、;；:：]+/).map((s) => s.trim()).filter(Boolean);
  const phrases: string[] = [];
  for (const r of rough) {
    if (r.length <= PHRASE_MAX) {
      phrases.push(r);
    } else {
      for (let i = 0; i < r.length; i += PHRASE_MAX) {
        phrases.push(r.slice(i, i + PHRASE_MAX));
      }
    }
  }
  return phrases;
}

interface PhraseCue {
  text: string;
  start: number;
  end: number;
}

/** 按字数比例把 durationSec 分配给各短语。 */
function allocatePhraseCues(phrases: string[], durationSec: number): PhraseCue[] {
  const totalChars = phrases.reduce((n, p) => n + p.length, 0) || 1;
  const cues: PhraseCue[] = [];
  let acc = 0;
  for (let i = 0; i < phrases.length; i++) {
    const start = (acc / totalChars) * durationSec;
    acc += phrases[i].length;
    // 最后一个短语吃到结尾,避免浮点误差留缝
    const end = i === phrases.length - 1 ? durationSec : (acc / totalChars) * durationSec;
    cues.push({ text: phrases[i], start, end });
  }
  return cues;
}

export interface SceneSpec {
  /**
   * 画面视频素材绝对路径(优先于 imagePath)。会循环/裁剪填满该镜时长。
   * 抄 MoneyPrinterTurbo:有视频素材就用视频,效果远好过图片 Ken Burns。
   */
  videoPath?: string;
  /** 画面图片绝对路径;videoPath 为空时用;再为空 = 纯色文字卡。 */
  imagePath?: string;
  /** 该镜配音绝对路径(mp3)。 */
  audioPath: string;
  /** 时长(秒)。 */
  durationSec: number;
  /** 字幕文案(原句)。 */
  subtitle: string;
}

/**
 * 给某一镜生成字幕滤镜串(可能多段 drawtext,逐短语渐进显示)。
 * 关键:font / textfile 都用【相对文件名】(ffmpeg cwd 设为 workDir),
 * 彻底绕开 Windows 盘符冒号 `C:` 在 filtergraph 里的转义地狱。
 * 每个短语用 enable='between(t,start,end)' 控制显隐 → 字幕跟着旁白往前走。
 * @param fontRel workDir 内的字体相对文件名(如 font.ttc);无字体传 null。
 * @returns drawtext 滤镜数组(直接塞进 vChain);无字幕返回 []。
 */
function buildDrawtext(
  workDir: string,
  idx: number,
  subtitle: string,
  durationSec: number,
  fontRel: string | null,
): string[] {
  const phrases = splitPhrases(subtitle);
  if (phrases.length === 0) return [];
  const cues = allocatePhraseCues(phrases, Math.max(0.8, durationSec));

  const filters: string[] = [];
  cues.forEach((cue, j) => {
    const wrapped = wrapSubtitle(cue.text);
    if (!wrapped) return;
    const txtName = `sub_${String(idx).padStart(3, '0')}_${String(j).padStart(2, '0')}.txt`;
    fs.writeFileSync(path.join(workDir, txtName), wrapped, 'utf8');

    const parts = [
      fontRel ? `fontfile=${fontRel}` : '',
      `textfile=${txtName}`,
      'fontcolor=white',
      'fontsize=52',
      'line_spacing=14',
      'box=1',
      'boxcolor=black@0.45',
      'boxborderw=24',
      'x=(w-text_w)/2',
      'y=h-text_h-200',
      // 单短语时整镜常显,enable 仍写上无害;多短语时只在自己时间片显示
      `enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'`,
    ].filter(Boolean);
    filters.push(`drawtext=${parts.join(':')}`);
  });
  return filters;
}

/** 合成单镜 → scene mp4,返回路径。失败抛错。fontRel = workDir 内字体相对名。 */
async function renderScene(workDir: string, idx: number, scene: SceneSpec, fontRel: string | null): Promise<string> {
  const out = path.join(workDir, `scene_${String(idx).padStart(3, '0')}.mp4`);
  const dur = Math.max(1.2, scene.durationSec);
  const durFrames = Math.round(dur * FPS);
  const drawtextFilters = buildDrawtext(workDir, idx, scene.subtitle, dur, fontRel);

  const vChain: string[] = [];
  const args: string[] = ['-y'];

  if (scene.videoPath && fs.existsSync(scene.videoPath)) {
    // 视频素材 → 循环到够长(-stream_loop -1)再 scale-cover-crop 填满竖屏。
    // 不做 Ken Burns(视频本身在动)。-t / -shortest 把它裁到该镜音频时长。
    args.push('-stream_loop', '-1', '-i', scene.videoPath);
    vChain.push(
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      `fps=${FPS}`,
      'setsar=1',
    );
  } else if (scene.imagePath && fs.existsSync(scene.imagePath)) {
    // 图片 → Ken Burns 缓慢推近
    args.push('-loop', '1', '-i', scene.imagePath);
    vChain.push(
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      // 先放大再 zoompan,减少抖动
      `scale=${W * 2}:${H * 2}`,
      `zoompan=z='min(zoom+0.0012,1.18)':d=${durFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
    );
  } else {
    // 纯色文字卡
    args.push('-f', 'lavfi', '-i', `color=c=0x14142a:s=${W}x${H}:r=${FPS}`);
  }

  args.push('-i', scene.audioPath);

  if (drawtextFilters.length > 0) vChain.push(...drawtextFilters);
  vChain.push('format=yuv420p');

  // 输入 0 = 画面(图片/纯色),输入 1 = 音频,两种分支都一样
  args.push(
    '-filter_complex', `[0:v]${vChain.join(',')}[v]`,
    '-map', '[v]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-r', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-t', dur.toFixed(2),
    '-shortest',
    out,
  );

  // cwd = workDir,这样 filtergraph 里 font/textfile 用相对名,绕开盘符冒号转义
  const r = await runFfmpeg(args, { timeoutMs: 120_000, cwd: workDir });
  if (!r.ok || !fs.existsSync(out)) {
    throw new Error(`scene ${idx} render failed: ${r.stderr.slice(-400)}`);
  }
  return out;
}

export interface ComposeOptions {
  scenes: SceneSpec[];
  outputPath: string;
  /** 可选背景音乐(本地音频文件路径)。低音量混入旁白、循环到片长、结尾淡出。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18,别盖过旁白。 */
  bgmVolume?: number;
  /** 每合成完一镜回调(用于进度)。 */
  onScene?: (done: number, total: number) => void;
}

/**
 * 把 BGM 混进已合成好旁白的视频。
 * BGM 循环到片长、整体压到 bgmVolume、结尾 2s 淡出;旁白原样保留。
 * 失败(无 BGM / 文件不存在 / 混音报错)→ 回退用原视频。
 */
async function mixBgm(
  mergedPath: string,
  bgmPath: string,
  outputPath: string,
  bgmVolume: number,
): Promise<boolean> {
  if (!fs.existsSync(bgmPath)) return false;
  const dur = await probeDuration(mergedPath);
  if (dur <= 0) return false;
  const fadeStart = Math.max(0, dur - 2);
  const vol = Math.min(1, Math.max(0, bgmVolume));

  const r = await runFfmpeg([
    '-y',
    '-i', mergedPath,
    '-stream_loop', '-1', '-i', bgmPath, // BGM 循环到够长
    '-filter_complex',
    `[1:a]volume=${vol.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(2)}:d=2[bg];` +
      `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-t', dur.toFixed(2),
    '-movflags', '+faststart',
    outputPath,
  ], { timeoutMs: 180_000 });

  return r.ok && fs.existsSync(outputPath);
}

/** 主合成入口:逐镜渲染 → concat 拼接 → 输出到 outputPath。 */
export async function composeVideo(opts: ComposeOptions): Promise<string> {
  const { scenes, outputPath } = opts;
  if (scenes.length === 0) throw new Error('no scenes to compose');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-video-'));

  // 把系统中文字体拷进 workDir,filtergraph 里只用相对名(避开 C: 转义)
  let fontRel: string | null = null;
  const fontSrc = resolveCjkFont();
  if (fontSrc) {
    try {
      fontRel = `font${path.extname(fontSrc) || '.ttf'}`;
      fs.copyFileSync(fontSrc, path.join(workDir, fontRel));
    } catch {
      fontRel = null;
    }
  }

  try {
    const scenePaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = await renderScene(workDir, i, scenes[i], fontRel);
      scenePaths.push(p);
      opts.onScene?.(i + 1, scenes.length);
    }

    // concat 列表(路径用正斜杠,单引号包裹)
    const listFile = path.join(workDir, 'concat.txt');
    const listContent = scenePaths
      .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listFile, listContent + '\n', 'utf8');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // 有 BGM 时先 concat 到 workDir 的临时文件,再混音落地 outputPath;
    // 无 BGM 时直接 concat 到 outputPath。
    const wantBgm = !!(opts.bgmPath && fs.existsSync(opts.bgmPath));
    const mergedPath = wantBgm ? path.join(workDir, 'merged.mp4') : outputPath;

    const r = await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      mergedPath,
    ], { timeoutMs: 120_000 });

    if (!r.ok || !fs.existsSync(mergedPath)) {
      // copy 拼接偶发时间戳问题 → 退回重编码再拼一次
      const r2 = await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        mergedPath,
      ], { timeoutMs: 180_000 });
      if (!r2.ok || !fs.existsSync(mergedPath)) {
        throw new Error(`concat failed: ${r2.stderr.slice(-400)}`);
      }
    }

    // 混 BGM。失败就降级用无 BGM 的成片(把 merged 搬到 outputPath)。
    if (wantBgm) {
      const ok = await mixBgm(mergedPath, opts.bgmPath!, outputPath, opts.bgmVolume ?? 0.18);
      if (!ok || !fs.existsSync(outputPath)) {
        try { fs.copyFileSync(mergedPath, outputPath); } catch {}
      }
    }

    return outputPath;
  } finally {
    // 清理临时目录(留点容错:失败时也清,scene 已拷进 output)
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}
