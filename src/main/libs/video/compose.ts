/**
 * compose — 把「画面 + 配音 + 字幕」合成成一条 mp4。
 *
 * 升级到 MoneyPrinterTurbo 风格的「多片段换镜」:
 *   1. 每个分镜先出一段【无声背景】scene_bg_NNN.mp4 —— 时长 = 该句配音时长,但画面
 *      由【多段素材】拼成(每段封顶 maxClipSeconds 秒),所以画面一直在换,不再「一句话
 *      盯着一个空镜几秒」。素材不够就循环复用。
 *   2. 所有 scene_bg concat 成 master_bg(无声);所有配音 concat 成 master_audio。
 *   3. 字幕:优先用上层传入的精确 cue(edge-tts 词边界),没有则按各镜已知时长估算;
 *      再把全部 cue 用【一遍 drawtext】烧到 master_bg 上(font/textfile 用相对名,
 *      绕开 Windows 盘符冒号转义),最后 mux 上 master_audio。字幕关 → 直接 mux。
 *   4. 可选 BGM 低音量混入。
 *
 * 字体:优先用打包内置的思源黑体(Source Han Sans SC Bold,开源 SIL OFL,商用 OK),
 * 保证任何用户机器上中文字幕都不会变成「豆腐块」;内置找不到才退回系统字体。
 *
 * 画幅(W×H)由上层按 aspect 传入(9:16 / 16:9 / 1:1),不再写死竖屏。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFfmpeg, probeDuration } from './ffmpegRuntime';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

const FPS = 30;
/** 每段素材最长秒数(换镜节奏);上层不传时的默认值。 */
const DEFAULT_MAX_CLIP_SEC = 4;

/** 内置 CJK 字体文件名(随包 bundle 在 resources/fonts/ 下)。 */
const BUNDLED_FONT_FILE = 'SourceHanSansSC-Bold.otf';

/**
 * 内置字体可能落地的目录集合 —— 套用 ffmpegRuntime.bundledBinDirs 的多根探测,
 * 覆盖 Windows(<install>/resources/fonts)/ macOS(Contents/Resources[/resources]/fonts)
 * / 开发态(client/resources/fonts)。
 */
function bundledFontDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string) => dirs.push(path.join(root, 'fonts'));
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
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

/** 解析内置思源黑体路径;找不到返回 null(退回系统字体)。 */
function resolveBundledFont(): string | null {
  for (const dir of bundledFontDirs()) {
    const p = path.join(dir, BUNDLED_FONT_FILE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 找一个系统里的中文字体给 drawtext 用(内置字体缺失时的兜底)。 */
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
 * 把整句切成「短语」做逐句渐进字幕(无 Whisper 词边界时的兜底)。
 * 先按标点切,过长的再按 ~PHRASE_MAX 字硬切。
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

export interface SubtitleCue {
  text: string;
  start: number;
  end: number;
}

/** 按字数比例把 [startSec,endSec] 这段时间分配给各短语,返回绝对时间 cue。 */
function allocateCues(phrases: string[], startSec: number, endSec: number): SubtitleCue[] {
  const span = Math.max(0.4, endSec - startSec);
  const totalChars = phrases.reduce((n, p) => n + p.length, 0) || 1;
  const cues: SubtitleCue[] = [];
  let acc = 0;
  for (let i = 0; i < phrases.length; i++) {
    const s = startSec + (acc / totalChars) * span;
    acc += phrases[i].length;
    const e = i === phrases.length - 1 ? endSec : startSec + (acc / totalChars) * span;
    cues.push({ text: phrases[i], start: s, end: e });
  }
  return cues;
}

export interface SubtitleStyle {
  /** 是否烧字幕。false = 完全不烧。 */
  enabled: boolean;
  /** 字号(在成片原始分辨率下的像素)。 */
  fontSize: number;
  /** 位置。 */
  position: 'top' | 'center' | 'bottom';
}

export interface SceneSpec {
  /**
   * 该镜的多段画面视频素材(绝对路径,按顺序拼,每段封顶 maxClipSeconds)。
   * 优先于 imagePath。素材不够该镜时长就循环复用。
   */
  clips?: string[];
  /** 单段画面视频(兼容老调用;clips 为空时用)。 */
  videoPath?: string;
  /** 画面图片绝对路径;clips/videoPath 都空时用;再为空 = 纯色文字卡。 */
  imagePath?: string;
  /** 该镜配音绝对路径(mp3)。 */
  audioPath: string;
  /** 时长(秒)。 */
  durationSec: number;
  /** 字幕文案(原句),用于无 Whisper 时估算 cue。 */
  subtitle: string;
}

/** 把绝对路径转成 concat list 里的安全行。 */
function concatLine(p: string): string {
  return `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/**
 * 合成单镜的【无声背景】→ scene_bg_NNN.mp4,返回路径。
 * 多段视频:把 dur 切成 N 段(每段 ≤ maxClip),逐段取一个 clip(循环复用),
 * 每段 trim+scale-cover-crop+fps,concat 成该镜背景。无 clips 用图片 Ken Burns,
 * 再无则纯色卡。全程 -an(无声),音频在 master 阶段统一拼。
 */
async function renderSceneBg(
  workDir: string,
  idx: number,
  scene: SceneSpec,
  W: number,
  H: number,
  maxClip: number,
): Promise<string> {
  const out = path.join(workDir, `scene_bg_${String(idx).padStart(3, '0')}.mp4`);
  const dur = Math.max(1.2, scene.durationSec);

  const clips = (scene.clips && scene.clips.length > 0)
    ? scene.clips.filter((c) => c && fs.existsSync(c))
    : (scene.videoPath && fs.existsSync(scene.videoPath) ? [scene.videoPath] : []);

  const args: string[] = ['-y'];

  if (clips.length > 0) {
    // 切成 N 段,每段 ≤ maxClip;素材不够循环复用
    const segCount = Math.max(1, Math.min(8, Math.ceil(dur / Math.max(1, maxClip))));
    const segDur = dur / segCount;
    const filters: string[] = [];
    for (let s = 0; s < segCount; s++) {
      const clip = clips[s % clips.length];
      // 每段单独一个输入,-stream_loop -1 保证够长
      args.push('-stream_loop', '-1', '-i', clip);
      filters.push(
        `[${s}:v]trim=0:${segDur.toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `fps=${FPS},setsar=1[v${s}]`,
      );
    }
    const concatInputs = Array.from({ length: segCount }, (_, s) => `[v${s}]`).join('');
    const fc = `${filters.join(';')};${concatInputs}concat=n=${segCount}:v=1:a=0,format=yuv420p[v]`;
    args.push(
      '-filter_complex', fc,
      '-map', '[v]',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-r', String(FPS), '-pix_fmt', 'yuv420p',
      '-t', dur.toFixed(2),
      out,
    );
  } else if (scene.imagePath && fs.existsSync(scene.imagePath)) {
    const durFrames = Math.round(dur * FPS);
    args.push('-loop', '1', '-i', scene.imagePath);
    const vChain = [
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      `scale=${W * 2}:${H * 2}`,
      `zoompan=z='min(zoom+0.0012,1.18)':d=${durFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
      'format=yuv420p',
    ];
    args.push(
      '-filter_complex', `[0:v]${vChain.join(',')}[v]`,
      '-map', '[v]',
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-r', String(FPS), '-pix_fmt', 'yuv420p',
      '-t', dur.toFixed(2),
      out,
    );
  } else {
    args.push(
      '-f', 'lavfi', '-i', `color=c=0x14142a:s=${W}x${H}:r=${FPS}`,
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-t', dur.toFixed(2),
      out,
    );
  }

  const r = await runFfmpeg(args, { timeoutMs: 180_000, cwd: workDir });
  if (!r.ok || !fs.existsSync(out)) {
    throw new Error(`scene ${idx} bg render failed: ${r.stderr.slice(-400)}`);
  }
  return out;
}

/** concat 一组 mp4(优先 copy,失败重编码)。 */
async function concatVideos(workDir: string, paths: string[], outPath: string): Promise<void> {
  const listFile = path.join(workDir, `vlist_${Date.now()}.txt`);
  fs.writeFileSync(listFile, paths.map(concatLine).join('\n') + '\n', 'utf8');
  const copyR = await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath,
  ], { timeoutMs: 180_000 });
  if (copyR.ok && fs.existsSync(outPath)) return;
  const reR = await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    outPath,
  ], { timeoutMs: 240_000 });
  if (!reR.ok || !fs.existsSync(outPath)) {
    throw new Error(`concat videos failed: ${reR.stderr.slice(-400)}`);
  }
}

/** 把多段配音 concat 成一条 aac 音频(用 concat 滤镜,鲁棒于不同 mp3 参数)。 */
async function concatAudios(workDir: string, audioPaths: string[], outPath: string): Promise<void> {
  const args: string[] = ['-y'];
  for (const a of audioPaths) args.push('-i', a);
  const inputs = audioPaths.map((_, i) => `[${i}:a]`).join('');
  args.push(
    '-filter_complex', `${inputs}concat=n=${audioPaths.length}:v=0:a=1[a]`,
    '-map', '[a]',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    outPath,
  );
  const r = await runFfmpeg(args, { timeoutMs: 180_000 });
  if (!r.ok || !fs.existsSync(outPath)) {
    throw new Error(`concat audios failed: ${r.stderr.slice(-400)}`);
  }
}

/** 由各镜已知时长 + 文案估算 cue(无 Whisper 时兜底)。 */
function deriveCuesFromScenes(scenes: SceneSpec[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let t = 0;
  for (const sc of scenes) {
    const dur = Math.max(0.8, sc.durationSec);
    const phrases = splitPhrases(sc.subtitle);
    if (phrases.length > 0) {
      cues.push(...allocateCues(phrases, t, t + dur));
    }
    t += dur;
  }
  return cues;
}

/** 把过长的 cue 文案再按短语细分到它自己的时间窗内,保证字幕可读。 */
function refineCues(cues: SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const phrases = splitPhrases(c.text);
    if (phrases.length <= 1) {
      if (c.text.trim()) out.push(c);
    } else {
      out.push(...allocateCues(phrases, c.start, c.end));
    }
  }
  return out;
}

/** 字幕 y 坐标表达式(随位置与画高)。 */
function subtitleY(position: SubtitleStyle['position'], H: number): string {
  switch (position) {
    case 'top': return String(Math.round(H * 0.10));
    case 'center': return '(h-text_h)/2';
    case 'bottom':
    default: return `h-text_h-${Math.round(H * 0.12)}`;
  }
}

/** 由 cue 列表生成一遍 drawtext 滤镜串(font/textfile 用相对名)。 */
function buildDrawtextChain(
  workDir: string,
  cues: SubtitleCue[],
  style: SubtitleStyle,
  fontRel: string | null,
  H: number,
): string[] {
  const yExpr = subtitleY(style.position, H);
  const filters: string[] = [];
  cues.forEach((cue, j) => {
    const wrapped = wrapSubtitle(cue.text);
    if (!wrapped) return;
    const txtName = `cue_${String(j).padStart(4, '0')}.txt`;
    fs.writeFileSync(path.join(workDir, txtName), wrapped, 'utf8');
    const parts = [
      fontRel ? `fontfile=${fontRel}` : '',
      `textfile=${txtName}`,
      'fontcolor=white',
      `fontsize=${Math.max(16, Math.round(style.fontSize))}`,
      'line_spacing=14',
      'box=1',
      'boxcolor=black@0.45',
      'boxborderw=24',
      'x=(w-text_w)/2',
      `y=${yExpr}`,
      `enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'`,
    ].filter(Boolean);
    filters.push(`drawtext=${parts.join(':')}`);
  });
  return filters;
}

export interface ComposeOptions {
  scenes: SceneSpec[];
  outputPath: string;
  /** 成片宽高(上层按 aspect 算)。默认 1080×1920。 */
  width?: number;
  height?: number;
  /** 每段素材最长秒数(换镜节奏)。默认 4。 */
  maxClipSeconds?: number;
  /** 字幕样式 + 开关。不传 = 底部白字常规字号。 */
  subtitle?: SubtitleStyle;
  /** 可选背景音乐(本地音频文件路径)。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18。 */
  bgmVolume?: number;
  /** 每合成完一镜背景回调(用于进度)。 */
  onScene?: (done: number, total: number) => void;
  /**
   * 字幕精确 cue(edge-tts 词边界,时间已对齐到总时间轴)。传入则直接用;
   * 为空/未传 → 自动退回按各镜时长估算的 cue。
   */
  cues?: SubtitleCue[];
}

/**
 * 把 BGM 混进已合成好旁白的视频。
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
    '-stream_loop', '-1', '-i', bgmPath,
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

/** 主合成入口。 */
export async function composeVideo(opts: ComposeOptions): Promise<string> {
  const { scenes, outputPath } = opts;
  if (scenes.length === 0) throw new Error('no scenes to compose');

  const W = opts.width && opts.width > 0 ? Math.round(opts.width) : 1080;
  const H = opts.height && opts.height > 0 ? Math.round(opts.height) : 1920;
  const maxClip = opts.maxClipSeconds && opts.maxClipSeconds > 0 ? opts.maxClipSeconds : DEFAULT_MAX_CLIP_SEC;
  const style: SubtitleStyle = opts.subtitle ?? { enabled: true, fontSize: 52, position: 'bottom' };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-video-'));

  // 字体拷进 workDir,filtergraph 里只用相对名(避开 C: 转义)。
  // 优先内置思源黑体(任何机器中文都不豆腐),缺失才退回系统字体。
  let fontRel: string | null = null;
  const fontSrc = resolveBundledFont() ?? resolveCjkFont();
  if (fontSrc) {
    try {
      fontRel = `font${path.extname(fontSrc) || '.ttf'}`;
      fs.copyFileSync(fontSrc, path.join(workDir, fontRel));
    } catch {
      fontRel = null;
    }
  }

  try {
    // 1. 逐镜出无声背景
    const bgPaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = await renderSceneBg(workDir, i, scenes[i], W, H, maxClip);
      bgPaths.push(p);
      opts.onScene?.(i + 1, scenes.length);
    }

    // 2. master_bg + master_audio
    const masterBg = path.join(workDir, 'master_bg.mp4');
    await concatVideos(workDir, bgPaths, masterBg);

    const masterAudio = path.join(workDir, 'master_audio.m4a');
    await concatAudios(workDir, scenes.map((s) => s.audioPath), masterAudio);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // 3. 字幕 cue(开了字幕才算):优先用上层传入的精确 cue,空则按各镜时长估算
    let drawtext: string[] = [];
    if (style.enabled) {
      const cues = (opts.cues && opts.cues.length > 0) ? opts.cues : deriveCuesFromScenes(scenes);
      drawtext = buildDrawtextChain(workDir, refineCues(cues), style, fontRel, H);
    }

    // 4. 烧字幕(或直接 mux)→ merged
    const wantBgm = !!(opts.bgmPath && fs.existsSync(opts.bgmPath));
    const mergedPath = wantBgm ? path.join(workDir, 'merged.mp4') : outputPath;

    if (drawtext.length > 0) {
      const r = await runFfmpeg([
        '-y',
        '-i', masterBg,
        '-i', masterAudio,
        '-filter_complex', `[0:v]${drawtext.join(',')},format=yuv420p[v]`,
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-r', String(FPS), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest', '-movflags', '+faststart',
        mergedPath,
      ], { timeoutMs: 300_000, cwd: workDir });
      if (!r.ok || !fs.existsSync(mergedPath)) {
        throw new Error(`burn subtitle failed: ${r.stderr.slice(-400)}`);
      }
    } else {
      // 不烧字幕:画面 copy,只 mux 音频
      const r = await runFfmpeg([
        '-y',
        '-i', masterBg,
        '-i', masterAudio,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest', '-movflags', '+faststart',
        mergedPath,
      ], { timeoutMs: 180_000 });
      if (!r.ok || !fs.existsSync(mergedPath)) {
        throw new Error(`mux failed: ${r.stderr.slice(-400)}`);
      }
    }

    // 5. 混 BGM(失败降级用无 BGM 成片)
    if (wantBgm) {
      const ok = await mixBgm(mergedPath, opts.bgmPath!, outputPath, opts.bgmVolume ?? 0.18);
      if (!ok || !fs.existsSync(outputPath)) {
        try { fs.copyFileSync(mergedPath, outputPath); } catch {}
      }
    }

    return outputPath;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}
