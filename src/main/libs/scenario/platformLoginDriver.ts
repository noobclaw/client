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
import { groupTitle as buildGroupTitle } from './subPlatformRegistry';

// platform → sub_platform mapping for v6 windowRegistry routing.
//   Main domain is what openPlatformLogin uses; creator domain (when
//   present) is what openCreatorCenter uses. Adding a new platform here
//   means: also add an entry to SUB_PLATFORM_REGISTRY + flag it from any
//   scenario manifest's platforms array. Pre-run check then automatically
//   stamps its checker window with the right windowKey so a task starting
//   later finds it via windowRegistry.get() instead of cascading a new one.
const PLATFORM_TO_MAIN_SUBPLATFORM: Record<LoginPlatform, string> = {
  xhs:     'xhs_main',
  douyin:  'douyin_main',
  tiktok:  'tiktok_main',
  x:       'x_main',
  binance: 'binance_square',
  youtube: 'youtube_main',
};

const PLATFORM_TO_CREATOR_SUBPLATFORM: Partial<Record<LoginPlatform, string>> = {
  xhs:    'xhs_creator',
  douyin: 'douyin_creator',
};

// v6.x pre-run-check window bounds (PR13). Deterministic per-sub_platform
// slot so:
//   - Two clicks on the same checker open the same windowKey (idempotent),
//     no extra positioning churn.
//   - Different sub_platforms cascade across the screen in a predictable
//     order: creator first, main next, etc. Same slot ordering as
//     SUB_PLATFORM_REGISTRY entries.
//   - Width/height fixed at 1100×750 — comfortable login + creator-center
//     navigation, fits 1366 laptop with a small right-edge clip user can
//     drag away if it matters.
//   - account_id offset reserved for multi-account future (PR-far) so
//     two accounts on the same sub_platform don't stack exactly on top.
//
// Lives in this file (rather than subPlatformRegistry) because only the
// pre-run-check flow uses it today; task openTab keeps relying on ext-
// side cascadeBounds via the no-bounds-passed fallback so existing
// scenarios don't bind to a positioning policy they didn't sign up for.
const SUB_PLATFORM_SLOT: Record<string, number> = {
  xhs_creator: 0,
  xhs_main: 1,
  douyin_creator: 2,
  douyin_main: 3,
  tiktok_main: 4,
  x_main: 5,
  binance_square: 6,
  youtube_main: 7,
};

function preRunBoundsFor(sub_platform: string, account_id = 'default') {
  const slot = SUB_PLATFORM_SLOT[sub_platform] ?? 0;
  const accountOffset = account_id === 'default' ? 0 : 30;
  return {
    left:   20 + slot * 60 + accountOffset,
    top:    20 + slot * 50 + accountOffset,
    width:  1100,
    height: 750,
  };
}

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
  // (?<!creator\.) 排除 creator.xiaohongshu.com 子域 —— 用户只打开
  // 创作者中心(未登录会落到 /login)时,主站 check 必须报 fail,而不是
  // 误以为"主站已登录"。creator 子域走独立的 checkCreatorCenter 检查,
  // 那里有真正的登录重定向 URL 判断。lookbehind 在 Node 20+ / Chrome 62+
  // 支持,sidecar / 扩展 / browserBridge 三端都能跑。
  xhs: /(?<!creator\.)xiaohongshu\.com/i,
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
  // 抖音 web — jingxuan / 推荐 / 视频详情 等主站路径。
  // (?<!creator\.) 排除 creator.douyin.com 子域 —— 用户只打开创作者中心
  // (未登录会 302 到 /passport/login)时,主站 check 必须报 fail,不能
  // 因为 URL 串里有 "douyin.com" 就当成"主站已登录"。creator 子域走独立
  // 的 checkCreatorCenter 检查(那里有 /passport/login 重定向判断)。
  // 任务执行时 ctx.navigate(creator.* URL) 走 manifest 的 tab_url_pattern,
  // 跟这个 client 端 TAB_PATTERNS 是分开的,不受这条改动影响。
  douyin: /(?<!creator\.)douyin\.com/i,
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

  // v1.6.2+ (PR11 / Phase 2-D follow-up): route the pre-run-check window
  // through the v6 windowRegistry so a task starting later can reuse it.
  //   - windowKey: ${PLATFORM_TO_MAIN_SUBPLATFORM[platform]}::default
  //   - groupTitle: idle form (no taskId — no task is running yet)
  //   - taskId: empty (windowRegistry stamps currentTaskId null; ext does
  //     NOT also write to legacy taskTabRegistry, so this window stays
  //     unowned by any task until ctx.openTab adopts it)
  // When the user later runs xhs_reply_fans_comment, phaseRunner's
  // ctx.openTab({ sub_platform: 'xhs_creator', ... }) sees the existing
  // entry, focuses + reuses + restamps title with task short-id. Two
  // sub_platforms (creator + main) → two windowKeys → two physical
  // windows, exactly satisfying "如果检查框要检查两个,那要求是两个窗口
  // 而不是一个窗口两个 tab".
  const subPlatform = PLATFORM_TO_MAIN_SUBPLATFORM[platform];
  if (subPlatform && connectionHasCapability(undefined, 'window_registry_v6')) {
    const windowKey = `${subPlatform}::default`;
    const idleTitle = buildGroupTitle(subPlatform, 'default', null);
    // v1.6.5+ (PR13): client owns positioning. Ext accepts bounds param;
    // pre-v1.6.5 ext silently ignores extra fields and falls back to its
    // cascadeBounds default — same visual result, just no client control.
    const bounds = preRunBoundsFor(subPlatform, 'default');
    try {
      await sendBrowserCommand(
        'task_open_tab',
        {
          windowKey,
          groupTitle: idleTitle,
          role: 'main',
          url,
          bounds,
          // taskId omitted — pre-run check is not a task.
        },
        3000,
      );
      return { ok: true };
    } catch (err) {
      coworkLog('WARN', 'platformLoginDriver',
        `v6 task_open_tab failed for ${platform}, falling back to legacy tab_create`, { err: String(err) });
      // fall through to legacy path
    }
  }

  // Legacy (pre-PR7 ext): platform-level NoobClaw group via tab_create envelope.
  // v2.8+: 极简 — 只发 tab_create 带路由 envelope,extension 1.4.22+ 自治
  // (mutex 内 enforce + reuse-or-open),不需要 client 主动 tab_list 兜底。
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
    await sendBrowserCommand('tab_create', { url }, 3000, routeOpts);
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

  // v1.6.2+ (PR11): route through v6 windowRegistry so the creator window
  // ends up in its own windowKey-keyed slot, distinct from main domain's
  // slot. Tasks running later (e.g. xhs_reply_fans_comment) call
  // ctx.openTab({ sub_platform: 'xhs_creator' }) which finds + reuses
  // THIS exact window — same machinery as openPlatformLogin above.
  //
  // The earlier renderer workaround (LoginRequiredModal.handleOpenCreator
  // calling window.open directly to dodge the legacy "ext scoops user's
  // creator tab into MCP group" problem) is no longer necessary on v6:
  // task_open_tab v6 path only touches the windowRegistry entry for
  // exactly this windowKey, never adopts pre-existing user tabs into a
  // platform-level group. handleOpenCreator can switch back to calling
  // this function.
  const subPlatform = PLATFORM_TO_CREATOR_SUBPLATFORM[platform];
  if (subPlatform && connectionHasCapability(undefined, 'window_registry_v6')) {
    const windowKey = `${subPlatform}::default`;
    const idleTitle = buildGroupTitle(subPlatform, 'default', null);
    const bounds = preRunBoundsFor(subPlatform, 'default');
    try {
      await sendBrowserCommand(
        'task_open_tab',
        {
          windowKey,
          groupTitle: idleTitle,
          role: 'creator',
          url,
          bounds,
        },
        3000,
      );
      return { ok: true };
    } catch (err) {
      coworkLog('WARN', 'platformLoginDriver',
        `v6 creator task_open_tab failed for ${platform}, falling back to legacy tab_create`, { err: String(err) });
      // fall through to legacy
    }
  }

  // Legacy fallback (pre-PR7 ext)
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
    await sendBrowserCommand('tab_create', { url }, 3000, routeOpts);
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
