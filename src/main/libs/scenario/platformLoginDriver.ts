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
import { sendBrowserCommand } from '../browserBridge';

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
  // 抖音 web — jingxuan / 推荐 / 视频详情都在 douyin.com 下,任意路径都算。
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
  try {
    await sendBrowserCommand('tab_create', { url }, 8000);
    return { ok: true };
  } catch {
    try {
      await sendBrowserCommand('navigate', { url }, 8000);
      return { ok: true };
    } catch (err2) {
      return { ok: false, reason: String(err2) };
    }
  }
}

// ── Backward-compat aliases ─────────────────────────────────────────
// Old callers imported `checkXhsLogin` / `openXhsLogin` from `./xhsDriver`.
// They now route here; the misleading-named exports are kept so any caller
// we didn't migrate still works. Delete after a release where main +
// preload + sidecar + renderer all use the new names.
export const checkXhsLogin = checkPlatformLogin;
export const openXhsLogin = openPlatformLogin;
