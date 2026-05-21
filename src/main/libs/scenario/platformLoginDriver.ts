/**
 * platformLoginDriver.ts — multi-platform login utilities.
 *
 * Originally lived in xhsDriver.ts back when only XHS existed. As X / Binance /
 * TikTok / YouTube were added, the login check + open-login-page logic stayed
 * one shared driver branched by `platform` parameter — but the file name
 * still said xhs and so did the function names, which misled readers
 * ("why is YouTube going through xhsDriver?"). v5.x split: login lives here
 * under platform-neutral names; xhsDriver.ts keeps only the truly XHS-only
 * draft upload.
 *
 * Adding a new platform requires entries in ALL THREE Records below
 * (LoginPlatform union, TAB_PATTERNS, NOT_REACHABLE_REASON, PLATFORM_LOGIN_URL).
 * Missing any of them silently falls back to xhs (Record[undefined] → xhs)
 * — that fallback is the bug the v5.1 YouTube launch hit.
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';

export interface PlatformLoginStatus {
  loggedIn: boolean;
  reason?: string;
}

// Backward-compat type alias — old callers imported `XhsLoginStatus` from
// xhsDriver. Re-exported here so the move is non-breaking; new code should
// use PlatformLoginStatus.
export type XhsLoginStatus = PlatformLoginStatus;

export type LoginPlatform = 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin';

const TAB_PATTERNS: Record<LoginPlatform, RegExp> = {
  xhs: /xiaohongshu\.com/i,
  // ⚠️ The previous attempt was `(?:^|\.)(?:twitter|x)\.com` — required the
  // domain to be preceded by start-of-string or a literal dot. That broke on
  // real URLs like `https://x.com/home` (the char before `x` is `/`, neither).
  // `\b` (word boundary) handles every case: `/` before `x` is a boundary;
  // `https://www.x.com` has `.` before `x` which is also a boundary; meanwhile
  // `https://mybox.com` doesn't get a false-positive because there's no word
  // boundary between `o` and `x`.
  x: /\b(?:twitter|x)\.com\b/i,
  // Binance Square lives under binance.com/*/square (locale prefix like
  // /zh-CN/square, /en/square). Match the path segment to avoid false
  // positives from other binance.com subsites (spot trading, futures etc.).
  binance: /binance\.com\/[a-z-]+\/square/i,
  // TikTok web — match anywhere on tiktok.com (Explore, video pages, profile).
  tiktok: /tiktok\.com/i,
  // YouTube — main domain + m.youtube.com mobile + youtube-nocookie embeds.
  youtube: /(?:^|\.)(?:youtube|youtube-nocookie)\.com/i,
  // 抖音 web — jingxuan / 推荐 / 视频详情 / creator.* 都在 douyin.com 下,
  // 任意子域路径都算。图文创作场景跟 auto_engage 共用同一个 platform 代码:
  // SSO 跨子域共享,登一次哪都通;任务跑时 ctx.navigate(creator.* URL) 会
  // 把这个匹配 tab 的 URL 直接更新成 creator URL,无需单独路由。
  douyin: /douyin\.com/i,
};

const NOT_REACHABLE_REASON: Record<LoginPlatform, string> = {
  xhs: 'xhs_tab_not_reachable',
  x: 'x_tab_not_reachable',
  binance: 'binance_tab_not_reachable',
  tiktok: 'tiktok_tab_not_reachable',
  youtube: 'youtube_tab_not_reachable',
  douyin: 'douyin_tab_not_reachable',
};

const PLATFORM_LOGIN_URL: Record<LoginPlatform, string> = {
  xhs: 'https://www.xiaohongshu.com',
  x: 'https://x.com/home',
  binance: 'https://www.binance.com/square',
  tiktok: 'https://www.tiktok.com/explore',
  youtube: 'https://www.youtube.com',
  douyin: 'https://www.douyin.com/jingxuan',
};

/** v2.6+: chrome-extension tab-group label/color per platform.
 *
 *  Used to be hardcoded inside chrome-extension/background.js (function
 *  `platformLabelForPattern`), which forced an extension republish on
 *  every new platform. Moved here so adding a new platform is a pure
 *  client change. The browser bridge attaches this to every command's
 *  envelope; chrome-extension v1.2.21+ uses it for grouping. Older
 *  extensions ignore the field and fall back to their internal hardcoded
 *  mapping (which still covers xhs / x / binance / youtube / tiktok /
 *  douyin if their last release had them).
 *
 *  Colors are Chrome's tabGroup color enum:
 *    grey, blue, red, yellow, green, pink, purple, cyan, orange.
 */
export const PLATFORM_TAB_GROUPS: Record<LoginPlatform, { title: string; color: string }> = {
  xhs:     { title: '🤖 XHS · NoobClaw',     color: 'green'  },
  x:       { title: '🤖 X · NoobClaw',       color: 'blue'   },
  binance: { title: '🤖 Binance · NoobClaw', color: 'yellow' },
  youtube: { title: '🤖 YouTube · NoobClaw', color: 'purple' },
  tiktok:  { title: '🤖 TikTok · NoobClaw',  color: 'cyan'   },
  douyin:  { title: '🤖 Douyin · NoobClaw',  color: 'pink'   },
};

/** Single source of truth for "which platform does this regex string target".
 *  Used by phaseRunner (to pick the right tabGroup / platform-specific
 *  cleanup target) and anywhere else that needs to map a manifest's
 *  tab_url_pattern back to a LoginPlatform key. Keeping this in one place
 *  means adding a new platform doesn't risk drifting two parallel lists. */
export function inferPlatformFromPattern(pattern: string | undefined): LoginPlatform | undefined {
  if (!pattern) return undefined;
  if (/xiaohongshu/i.test(pattern)) return 'xhs';
  if (/binance/i.test(pattern)) return 'binance';
  if (/youtube/i.test(pattern)) return 'youtube';
  if (/tiktok/i.test(pattern)) return 'tiktok';
  if (/douyin/i.test(pattern)) return 'douyin';
  if (/twitter|x\\?\.com/i.test(pattern)) return 'x';
  return undefined;
}

export async function checkPlatformLogin(platform: LoginPlatform = 'xhs'): Promise<PlatformLoginStatus> {
  // Always do a live check — don't trust cached connection status
  let tabs: any[] = [];
  try {
    // Short timeout: if browser is closed, this will fail fast
    const res = await sendBrowserCommand('tab_list', {}, 3000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
    if (!res || (!res.tabs && !Array.isArray(res))) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch (err) {
    coworkLog('WARN', 'platformLoginDriver', 'tab_list failed — browser likely closed', { err: String(err) });
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  const pattern = TAB_PATTERNS[platform] || TAB_PATTERNS.xhs;
  const matchTab = tabs.find(
    (t: any) => typeof t.url === 'string' && pattern.test(t.url)
  );
  if (!matchTab || typeof matchTab.id !== 'number') {
    return { loggedIn: false, reason: NOT_REACHABLE_REASON[platform] || 'tab_not_reachable' };
  }

  return { loggedIn: true };
}

export async function openPlatformLogin(platform: LoginPlatform = 'xhs'): Promise<{ ok: boolean; reason?: string }> {
  const url = PLATFORM_LOGIN_URL[platform] || PLATFORM_LOGIN_URL.xhs;
  // v2.8+: 极简 — 只发 tab_create 带路由 envelope,extension 1.4.22+ 自治
  // (mutex 内 enforce + reuse-or-open),不需要 client 主动 tab_list 兜底。
  // 用户多点这个按钮:ext 端 mutex 串行,只会 reuse 已有 NoobClaw managed
  // tab 或开 1 个新窗口,绝不累积。
  const tabPattern = TAB_PATTERNS[platform]?.source;
  const tabGroup = PLATFORM_TAB_GROUPS[platform];
  const routeOpts: any = {};
  if (tabPattern) routeOpts.tabPattern = tabPattern;
  if (tabGroup) routeOpts.tabGroup = tabGroup;
  if (tabPattern && connectionHasCapability(tabPattern, 'isolated_windows')) {
    routeOpts.isolate = true;
  }
  if (url) routeOpts.anchor_url = url;
  try {
    await sendBrowserCommand('tab_create', { url }, 8000, routeOpts);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// ── Creator-center secondary check ──────────────────────────────────
// 抖音 / 小红书 的图文创作任务要发到 creator.*.com 子域,主站登录态不等于
// 创作者中心登录态(虽然 SSO 跨子域共享 cookie,但用户得真打开过 creator
// tab 浏览器才认这个 origin)。LoginRequiredModal 跑预检时除了首页 tab 还要
// 额外确认 creator.* tab 存在 + URL 不是登录重定向页 → 才能保证任务跑起
// 来能直接进发布流程,不会卡在"请先登录"。
//
// 只有抖音 / 小红书有这层 secondary check;其他平台没有独立 creator 子域
// (X/Binance 在主站发,TikTok/YouTube 的 creator URL 跟主站 SSO 共享更紧),
// 不需要这个 gate。

const CREATOR_TAB_PATTERNS: Partial<Record<LoginPlatform, RegExp>> = {
  xhs: /creator\.xiaohongshu\.com/i,
  douyin: /creator\.douyin\.com/i,
};

const CREATOR_URLS: Partial<Record<LoginPlatform, string>> = {
  xhs: 'https://creator.xiaohongshu.com/',
  douyin: 'https://creator.douyin.com/',
};

// 抖音 creator 未登录会 302 到 /passport/login;小红书会 hash 路由到 #/login。
// URL 命中这些 → 视为未登录(tab 在,但还没认证)。
const CREATOR_LOGIN_REDIRECT = /\/passport\/login|\/login(\?|#|\/|$)|#\/login/i;

export function platformHasCreatorCenter(platform: LoginPlatform): boolean {
  return !!CREATOR_TAB_PATTERNS[platform];
}

export async function checkCreatorCenter(platform: LoginPlatform): Promise<PlatformLoginStatus> {
  const pattern = CREATOR_TAB_PATTERNS[platform];
  // 没 creator 子域的平台 → 视为 no-op pass,避免 LoginRequiredModal 这边
  // 调用方还得自己 if (platform === 'xhs' || ...)。
  if (!pattern) return { loggedIn: true };

  let tabs: any[] = [];
  try {
    const res = await sendBrowserCommand('tab_list', {}, 3000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
    if (!res || (!res.tabs && !Array.isArray(res))) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch (err) {
    coworkLog('WARN', 'platformLoginDriver', 'creator tab_list failed — browser likely closed', { err: String(err) });
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  const matchTab = tabs.find(
    (t: any) => typeof t.url === 'string' && pattern.test(t.url)
  );
  if (!matchTab || typeof matchTab.id !== 'number') {
    return { loggedIn: false, reason: 'creator_tab_not_reachable' };
  }
  if (typeof matchTab.url === 'string' && CREATOR_LOGIN_REDIRECT.test(matchTab.url)) {
    return { loggedIn: false, reason: 'creator_not_logged_in' };
  }
  return { loggedIn: true };
}

export async function openCreatorCenter(platform: LoginPlatform): Promise<{ ok: boolean; reason?: string }> {
  const url = CREATOR_URLS[platform];
  if (!url) return { ok: false, reason: 'no_creator_center' };
  const tabPattern = CREATOR_TAB_PATTERNS[platform]?.source;
  const tabGroup = PLATFORM_TAB_GROUPS[platform];
  const routeOpts: any = {};
  if (tabPattern) routeOpts.tabPattern = tabPattern;
  if (tabGroup) routeOpts.tabGroup = tabGroup;
  if (tabPattern && connectionHasCapability(tabPattern, 'isolated_windows')) {
    routeOpts.isolate = true;
  }
  if (url) routeOpts.anchor_url = url;
  try {
    await sendBrowserCommand('tab_create', { url }, 8000, routeOpts);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// ── Backward-compat aliases ─────────────────────────────────────────
// Old callers imported `checkXhsLogin` / `openXhsLogin` from `./xhsDriver`.
// They now route here; the misleading-named exports are kept so any caller
// we didn't migrate still works. Delete after a release where main +
// preload + sidecar + renderer all use the new names.
export const checkXhsLogin = checkPlatformLogin;
export const openXhsLogin = openPlatformLogin;
