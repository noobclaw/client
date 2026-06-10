/**
 * htmlVideoRenderer — 「模板速生」的画面引擎:把一个【自包含动画 HTML】用无头浏览器
 *   逐帧截图,产出 PNG 序列(编码成 mp4 交给 template-pipeline 的 ffmpeg)。
 *
 * 抄 HyperFrames 的核心做法 + 复用本项目 cdpBrowser 的「检测 Chrome/Edge + CDP over ws」
 * 范式,但【独立实例】:随机调试端口(绝不碰 cowork 常驻的 9222)、独立临时 user-data-dir、
 * 禁网(Network.setBlockedURLs)、file:// 临时页。渲染的是 AI 生成的 HTML,所以离线 + 沙箱。
 *
 * HTML 契约(templateHtmlWriter 产出、本模块消费):
 *   · 画布固定 1080×1920;
 *   · 定义全局纯函数 window.renderFrame(t)  —— t 秒,按 t 算画面(不依赖真实时间/rAF);
 *   · 定义全局常量 window.DURATION(秒)、可选 window.FPS。
 * 渲染 = 把 t 从 0 一格一格喂给 renderFrame,每格 captureScreenshot。POC 已验证可行。
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RenderHtmlOptions {
  html: string;
  width?: number;          // 默认 1080
  height?: number;         // 默认 1920
  fps?: number;            // 默认 30
  durationSec: number;     // 总时长(秒)
  framesDir: string;       // PNG 落地目录(frame_%04d.png)
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMsPerFrame?: number; // 单帧超时,默认 8000
}

export interface RenderHtmlResult {
  framesDir: string;
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

// ── 无头浏览器检测(抄 cdpBrowser.detectChromePath,但带 kind + 可覆盖)──

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

// ── 独立无头会话(自管 ws + 进程 + 临时 profile,与 cdpBrowser 的全局单例隔离)──

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
    // 禁网:渲染的是 AI 生成的 HTML,二次兜底封死任何外链外泄/卡死(静态校验已剥外链)
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

  /** 等页面 + 字体就绪(参考 HyperFrames frameCapture 的媒体就绪轮询)。 */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const r = await this.cmd('Runtime.evaluate', {
          expression: 'document.readyState === "complete" && typeof window.renderFrame === "function"',
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

  async evalAt(t: number): Promise<void> {
    await this.cmd('Runtime.evaluate', { expression: `window.renderFrame(${t})` });
  }

  /** 读 window.DURATION / window.FPS / renderFrame 是否合法。 */
  async readContract(): Promise<{ ok: boolean; durationSec?: number; fps?: number; reason?: string }> {
    try {
      const r = await this.cmd('Runtime.evaluate', {
        expression:
          '(function(){try{if(typeof window.renderFrame!=="function")return{ok:false,reason:"no renderFrame"};'
          + 'if(typeof window.DURATION!=="number"||!(window.DURATION>0))return{ok:false,reason:"no DURATION"};'
          + 'window.renderFrame(0);return{ok:true,durationSec:window.DURATION,fps:(typeof window.FPS==="number"&&window.FPS>0)?window.FPS:0};}'
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

// ── 公开 API ──

/**
 * 逐帧渲染:把动画 HTML 截成 frame_0000.png … 序列。返回帧目录 + 帧数。
 * 仅产 PNG;编码成 mp4 由调用方(template-pipeline)用 ffmpeg 完成。
 */
export async function renderHtmlToFrames(opts: RenderHtmlOptions): Promise<RenderHtmlResult> {
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const dur = Math.max(0.5, opts.durationSec);
  const total = Math.max(1, Math.round(fps * dur));
  const perFrameTimeout = opts.timeoutMsPerFrame || 8000;

  fs.mkdirSync(opts.framesDir, { recursive: true });
  const session = new HeadlessSession();
  try {
    await session.launch(width, height);
    await session.navigateHtml(opts.html);
    await session.waitReady();
    for (let f = 0; f < total; f++) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const t = f / fps;
      await session.evalAt(t);
      const png = await session.shot(width, height, perFrameTimeout);
      fs.writeFileSync(path.join(opts.framesDir, `frame_${String(f).padStart(4, '0')}.png`), png);
      opts.onProgress?.(f + 1, total);
    }
    return { framesDir: opts.framesDir, frameCount: total, fps, width, height };
  } finally {
    await session.close();
  }
}

/**
 * 动态预检:启一个短命无头实例,验证 HTML 契约 + t=0 与 t=DUR/2 两帧像素必须不同
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
    await session.evalAt(0);
    const a = await session.shot(width, height, 8000);
    await session.evalAt(dur / 2);
    const b = await session.shot(width, height, 8000);
    if (a.length === b.length && a.equals(b)) {
      return { ok: false, reason: '动画无变化(renderFrame 未按 t 改变画面)' };
    }
    return { ok: true, durationSec: dur, fps: contract.fps || 30 };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e) };
  } finally {
    await session.close();
  }
}
