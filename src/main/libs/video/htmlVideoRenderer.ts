/**
 * htmlVideoRenderer — 「模板速生」HF 派的画面引擎。
 *
 * 抄 HyperFrames:把【自包含动效 HTML(带 paused seek 协议)】用无头浏览器逐帧 seek +
 * 截图,帧二进制直接 pipe 到 ffmpeg stdin 编码 mp4 —— **不落盘 PNG**,无需中转目录,
 * 无需第二次读盘。
 *
 * 跟 v2 的差异:
 *   · v2:Runtime.evaluate("renderFrame(t)") + Page.captureScreenshot → 写 PNG 到 framesDir
 *     → ffmpeg 二阶段读 PNG 序列编码
 *   · v3:Runtime.evaluate("__nbc.seek(t)") + Page.captureScreenshot → 帧 buffer 直接 pipe 给
 *     ffmpeg → ffmpeg 单一阶段完成编码。省一次磁盘 I/O,且过程中可同时混音轨/字幕轨。
 *
 * HF 原版用 HeadlessExperimental.beginFrame —— 那个 CDP 域在很多 Chromium 分支上不稳,
 * 我们走 Page.captureScreenshot(更普适)+ stdin pipe 也能拿到同样的「不落盘」收益。
 *
 * HTML 契约(由 templateLibrary 产、本模块消费):
 *   · 画布固定 1080×1920
 *   · 全局 `window.__nbc.seek(t)` —— 把页面 seek 到时间 t(秒),纯函数无壁钟
 *   · 全局常量 `window.DURATION`(秒),可选 `window.FPS`
 *   · `window.__nbc.ready === true` 表示协议就绪
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFfmpegPath } from './ffmpegRuntime';

export interface RenderHtmlToVideoOptions {
  html: string;
  width?: number;          // 默认 1080
  height?: number;         // 默认 1920
  fps?: number;            // 默认 30
  durationSec: number;     // 总时长(秒)
  outPath: string;         // 成片 mp4 路径
  /** 可选:背景音乐(本地路径)。空 = 不加。 */
  bgmPath?: string;
  bgmVolume?: number;      // 默认 0.18
  /** 可选:配音音频(本地路径)。空 = 无配音(纯视觉)。 */
  narrationPath?: string;
  narrationVolume?: number; // 默认 1.0
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMsPerFrame?: number; // 单帧超时,默认 8000
}

export interface RenderHtmlResult {
  outPath: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
}

export interface ProbeHtmlResult {
  ok: boolean;
  reason?: string;
  durationSec?: number;
  fps?: number;
}

export interface HeadlessBrowser {
  path: string;
  kind: 'chrome' | 'edge' | 'chromium';
}

// ── 无头浏览器检测 ────────────────────────────────────────────────────────

export function resolveHeadlessBrowser(): HeadlessBrowser | null {
  const env = process.env.NOOBCLAW_CHROME_PATH;
  if (env && fs.existsSync(env)) {
    const k = /edge/i.test(env) ? 'edge' : /chromium/i.test(env) ? 'chromium' : 'chrome';
    return { path: env, kind: k };
  }
  const cands: HeadlessBrowser[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    cands.push(
      { path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      { path: path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      { path: path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      // Windows 几乎必有 Edge(Chromium 内核,--headless=new + CDP 完全一致)→ 兜底
      { path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' },
      { path: path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' },
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
    );
  } else {
    cands.push(
      { path: '/usr/bin/google-chrome', kind: 'chrome' },
      { path: '/usr/bin/google-chrome-stable', kind: 'chrome' },
      { path: '/usr/bin/chromium-browser', kind: 'chromium' },
      { path: '/usr/bin/chromium', kind: 'chromium' },
    );
  }
  for (const c of cands) if (fs.existsSync(c.path)) return c;
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 独立无头会话(自管 ws + 进程 + 临时 profile,与 cdpBrowser 全局单例隔离)──

class HeadlessSession {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port = 0;
  private profileDir = '';
  private _id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async launch(width: number, height: number): Promise<void> {
    const browser = resolveHeadlessBrowser();
    if (!browser) throw new Error('未检测到 Chrome/Edge,模板速生需要其一(Windows 自带 Edge 即可)');
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-htmlrender-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',          // 系统分配,绝不复用 cowork 的 9222
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--disable-extensions', '--disable-background-networking',
      `--window-size=${width},${height}`, '--force-device-scale-factor=1',
      'about:blank',
    ];
    this.proc = spawn(browser.path, args, { stdio: 'ignore', windowsHide: true });
    this.proc.on('error', () => { /* surfaced via launch timeout below */ });

    // 读 DevToolsActivePort(Chrome 启动后写入 profile 目录,首行 = 真实端口)
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 60 && !this.port; i++) {
      await sleep(200);
      try {
        const txt = fs.readFileSync(portFile, 'utf8').trim();
        const p = parseInt(txt.split('\n')[0], 10);
        if (p > 0) this.port = p;
      } catch { /* not ready */ }
    }
    if (!this.port) { await this.close(); throw new Error('无头浏览器调试端口未就绪'); }

    // 连一个 page target
    let pageWsUrl = '';
    for (let i = 0; i < 30 && !pageWsUrl; i++) {
      try {
        const list: any[] = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) pageWsUrl = page.webSocketDebuggerUrl;
      } catch { /* retry */ }
      if (!pageWsUrl) await sleep(200);
    }
    if (!pageWsUrl) { await this.close(); throw new Error('无头浏览器页面目标未就绪'); }

    this.ws = new WebSocket(pageWsUrl);
    await new Promise<void>((res, rej) => {
      this.ws!.once('open', () => res());
      this.ws!.once('error', (e) => rej(e));
    });
    this.ws.on('message', (data) => {
      let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const h = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(h.timer);
        if (msg.error) h.reject(new Error(msg.error.message || 'CDP error'));
        else h.resolve(msg.result);
      }
    });

    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    // 禁网:渲染的是 AI 生成的 HTML,二次兜底封死任何外链外泄/卡死
    try {
      await this.cmd('Network.enable');
      await this.cmd('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
    } catch { /* Network 域不可用也不阻塞,file:// 本就离线 */ }
    await this.cmd('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false });
  }

  cmd(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    if (!this.ws) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigateHtml(html: string): Promise<string> {
    const htmlFile = path.join(this.profileDir, 'scene.html');
    fs.writeFileSync(htmlFile, html, 'utf8');
    const url = 'file:///' + htmlFile.replace(/\\/g, '/');
    await this.cmd('Page.navigate', { url });
    return htmlFile;
  }

  /** 等页面 + 字体 + __nbc 协议就绪。 */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const r = await this.cmd('Runtime.evaluate', {
          expression: 'document.readyState === "complete" && window.__nbc && window.__nbc.ready === true',
          returnByValue: true,
        });
        if (r?.result?.value === true) break;
      } catch { /* keep polling */ }
      await sleep(150);
    }
    // 字体就绪(promise);失败不阻塞
    try { await this.cmd('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }); } catch { /* ignore */ }
    await sleep(120);
  }

  /** Seek 页面到时间 t(秒)。这是 HF 派核心 —— 一次调用整张画面到目标时间点。 */
  async seekAt(t: number): Promise<void> {
    await this.cmd('Runtime.evaluate', { expression: `window.__nbc.seek(${t})` });
  }

  /** 读 window.DURATION / window.FPS / __nbc.seek 是否合法。 */
  async readContract(): Promise<{ ok: boolean; durationSec?: number; fps?: number; reason?: string }> {
    try {
      const r = await this.cmd('Runtime.evaluate', {
        expression:
          '(function(){try{if(!window.__nbc||typeof window.__nbc.seek!=="function")return{ok:false,reason:"no __nbc.seek"};'
          + 'if(typeof window.DURATION!=="number"||!(window.DURATION>0))return{ok:false,reason:"no DURATION"};'
          + 'window.__nbc.seek(0);return{ok:true,durationSec:window.DURATION,fps:(typeof window.FPS==="number"&&window.FPS>0)?window.FPS:0};}'
          + 'catch(e){return{ok:false,reason:String(e&&e.message||e)};}})()',
        returnByValue: true,
      });
      return r?.result?.value || { ok: false, reason: 'eval failed' };
    } catch (e) {
      return { ok: false, reason: String((e as Error)?.message || e) };
    }
  }

  async shot(width: number, height: number, timeoutMs: number): Promise<Buffer> {
    const r = await this.cmd('Page.captureScreenshot',
      { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, timeoutMs);
    return Buffer.from(r.data, 'base64');
  }

  async close(): Promise<void> {
    for (const h of this.pending.values()) { clearTimeout(h.timer); }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
    this.proc = null;
    const dir = this.profileDir;
    this.profileDir = '';
    // Windows:chrome 退出后文件锁释放有延迟,删太快会 EPERM → 延迟 + 重试 3 次。
    if (dir) {
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleep(300); }
      }
    }
  }
}

// ── ffmpeg pipe 编码器 ──────────────────────────────────────────────────

/**
 * 构造 ffmpeg 参数:PNG 序列从 stdin pipe(`-f image2pipe`),
 * 加 0~1 条配音 + 0~1 条 BGM,混音输出 mp4。
 *
 * 关键 ffmpeg 用法:
 *   · `-f image2pipe -framerate <fps> -i -`:从 stdin 读 PNG 序列(每帧一张 PNG)
 *   · BGM 用 `-stream_loop -1` 循环铺底
 *   · 音轨混音 = filter_complex 的 amix(narration:1.0, bgm:0.18)+ shortest
 */
function buildPipeEncodeArgs(opts: {
  fps: number;
  outPath: string;
  narrationPath?: string;
  narrationVolume: number;
  bgmPath?: string;
  bgmVolume: number;
  durationSec: number;
}): string[] {
  const args: string[] = ['-y'];
  // 0:v ← stdin PNG 序列
  args.push('-f', 'image2pipe', '-framerate', String(opts.fps), '-i', '-');
  // 1:a ← narration(可选)
  if (opts.narrationPath) {
    args.push('-i', opts.narrationPath);
  }
  // 2:a / 1:a ← bgm(可选,带 stream_loop)
  if (opts.bgmPath) {
    args.push('-stream_loop', '-1', '-i', opts.bgmPath);
  }

  const audioInputs: string[] = [];
  let nextIdx = 1;
  if (opts.narrationPath) {
    audioInputs.push(`[${nextIdx}:a]volume=${opts.narrationVolume.toFixed(2)}[an]`);
    nextIdx++;
  }
  if (opts.bgmPath) {
    audioInputs.push(`[${nextIdx}:a]volume=${opts.bgmVolume.toFixed(2)}[ab]`);
  }

  // 混音 filter_complex
  if (opts.narrationPath && opts.bgmPath) {
    const fc = `${audioInputs.join(';')};[an][ab]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    args.push('-filter_complex', fc);
    args.push('-map', '0:v', '-map', '[aout]');
  } else if (opts.narrationPath) {
    args.push('-filter_complex', audioInputs[0].replace('[an]', '[aout]'));
    args.push('-map', '0:v', '-map', '[aout]');
  } else if (opts.bgmPath) {
    args.push('-filter_complex', audioInputs[0].replace('[ab]', '[aout]'));
    args.push('-map', '0:v', '-map', '[aout]');
  } else {
    args.push('-map', '0:v');
  }

  // 视频编码
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart');
  // 音频编码(只在有音轨时设)
  if (opts.narrationPath || opts.bgmPath) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }
  // 总时长 = HTML 动画时长(避免 BGM 循环没尽头)
  args.push('-t', opts.durationSec.toFixed(3));
  args.push(opts.outPath);
  return args;
}

/** ffmpeg 进程包装:暴露 stdin 给逐帧 pipe,close 时等退出。 */
class FfmpegPipeEncoder {
  private proc: ChildProcess | null = null;
  private stderr = '';
  private exitPromise: Promise<{ ok: boolean; code: number | null; stderr: string }> = Promise.resolve({ ok: false, code: null, stderr: '' });

  start(args: string[], onStderrLine?: (line: string) => void): void {
    const bin = getFfmpegPath();
    this.proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      this.stderr += text;
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
      if (onStderrLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onStderrLine(line);
        }
      }
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc!.on('close', (code) => resolve({ ok: code === 0, code, stderr: this.stderr }));
      this.proc!.on('error', (e) => resolve({ ok: false, code: null, stderr: this.stderr + '\n[spawn error] ' + String(e) }));
    });
  }

  /** 写一帧 PNG 到 ffmpeg stdin。stdin 写满时等 drain,避免内存爆。 */
  writeFrame(buf: Buffer): Promise<void> {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return Promise.reject(new Error('ffmpeg stdin 已关闭'));
    return new Promise((resolve, reject) => {
      const stdin = this.proc!.stdin!;
      const ok = stdin.write(buf, (err) => err ? reject(err) : resolve());
      if (!ok) stdin.once('drain', () => { /* drain 触发就行,resolve 已经在 write 回调里 */ });
    });
  }

  endStdin(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
  }

  kill(): void {
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  waitExit(): Promise<{ ok: boolean; code: number | null; stderr: string }> {
    return this.exitPromise;
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────

/**
 * 渲染 HTML 动画 → mp4(直接出成片,不落盘 PNG)。
 *
 * 流程:
 *   1. 启无头浏览器,导航到 file://(HTML 写到临时 profile 目录)
 *   2. 等 `__nbc.ready === true` + 字体就绪
 *   3. 启 ffmpeg,stdin pipe;同步把 narration/bgm 当 -i 输入混音
 *   4. 逐帧:seek(t) → captureScreenshot → 写 ffmpeg stdin
 *   5. 关 stdin,等 ffmpeg 退出
 */
export async function renderHtmlToVideo(opts: RenderHtmlToVideoOptions): Promise<RenderHtmlResult> {
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const dur = Math.max(0.5, opts.durationSec);
  const total = Math.max(1, Math.round(fps * dur));
  const perFrameTimeout = opts.timeoutMsPerFrame || 8000;

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const session = new HeadlessSession();
  const encoder = new FfmpegPipeEncoder();
  let started = false;

  try {
    await session.launch(width, height);
    await session.navigateHtml(opts.html);
    await session.waitReady();

    // 拉起 ffmpeg(只在 HTML 就绪后启,避免空跑/超时窗口)
    const ffArgs = buildPipeEncodeArgs({
      fps, outPath: opts.outPath,
      narrationPath: opts.narrationPath,
      narrationVolume: typeof opts.narrationVolume === 'number' && opts.narrationVolume >= 0 ? opts.narrationVolume : 1.0,
      bgmPath: opts.bgmPath,
      bgmVolume: typeof opts.bgmVolume === 'number' && opts.bgmVolume >= 0 ? opts.bgmVolume : 0.18,
      durationSec: dur,
    });
    encoder.start(ffArgs);
    started = true;

    for (let f = 0; f < total; f++) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const t = f / fps;
      await session.seekAt(t);
      const png = await session.shot(width, height, perFrameTimeout);
      await encoder.writeFrame(png);
      opts.onProgress?.(f + 1, total);
    }

    encoder.endStdin();
    const r = await encoder.waitExit();
    if (!r.ok) {
      const tail = (r.stderr || '').replace(/\s+/g, ' ').trim().slice(-400);
      throw new Error(`ffmpeg 编码失败:${tail || '(无 stderr)'}`);
    }
    return { outPath: opts.outPath, frameCount: total, fps, width, height };
  } catch (err) {
    if (started) encoder.kill();
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * 动态预检:启短命无头实例,验证 HTML 契约 + t=0 与 t=DUR/2 两帧像素必须不同
 * (否则 = 动画没接 t,等于静态图,判不合格)。给 templateHtmlWriter 做重试/降级判定。
 */
export async function probeHtml(html: string): Promise<ProbeHtmlResult> {
  const width = 1080, height = 1920;
  const session = new HeadlessSession();
  try {
    await session.launch(width, height);
    await session.navigateHtml(html);
    await session.waitReady();
    const contract = await session.readContract();
    if (!contract.ok) return { ok: false, reason: contract.reason || 'contract invalid' };
    const dur = contract.durationSec || 5;
    // 两帧差异:t=0 vs t=DUR/2
    await session.seekAt(0);
    const a = await session.shot(width, height, 8000);
    await session.seekAt(dur / 2);
    const b = await session.shot(width, height, 8000);
    if (a.length === b.length && a.equals(b)) {
      return { ok: false, reason: '动画无变化(seek 未按 t 改变画面)' };
    }
    return { ok: true, durationSec: dur, fps: contract.fps || 30 };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e) };
  } finally {
    await session.close();
  }
}
