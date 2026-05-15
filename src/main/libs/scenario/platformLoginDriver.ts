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
  const tabPattern = TAB_PATTERNS[platform]?.source;
  const tabGroup = PLATFORM_TAB_GROUPS[platform];
  const routeOpts: any = {};
  if (tabPattern) routeOpts.tabPattern = tabPattern;
  if (tabGroup) routeOpts.tabGroup = tabGroup;
  if (tabPattern && connectionHasCapability(tabPattern, 'isolated_windows')) {
    routeOpts.isolate = true;
  }
  if (url) routeOpts.anchor_url = url;
  // v2.7+: 主动去重 — 先全量 tab_list,自己用 platform regex 找现有 tab。
  // 找到就直接 navigate 它(reuse),不调 tab_create。
  // 之前的方案是把 routing info 传给 extension 让它自己 reuse,但那依赖
  // extension 的 priority 1/2/3 detection,而且老 extension 没有 isolated
  // path。client 主动 query 是 belt-and-suspenders — 不论 extension 啥
  // 行为,client 这边都不会让用户因为反复点按钮而累积 N 个同平台 tab。
  const platformRe = TAB_PATTERNS[platform];
  if (platformRe) {
    try {
      const listRes: any = await sendBrowserCommand('tab_list', {}, 3000);
      const allTabs: any[] = Array.isArray(listRes?.tabs) ? listRes.tabs
        : (Array.isArray(listRes?.data?.tabs) ? listRes.data.tabs : []);
      const existing = allTabs.find(t => typeof t?.url === 'string' && platformRe.test(t.url));
      if (existing) {
        // 已有就用 navigate 路径(extension 会在 routeOpts.tabPattern 引导下
        // resolve 到那个 tab,顺便给它打 NoobClaw 分组标签)。
        coworkLog('INFO', 'platformLoginDriver',
          `openPlatformLogin: reusing existing ${platform} tab`,
          { tabId: existing.id, url: existing.url });
        await sendBrowserCommand('navigate', { url }, 8000, routeOpts);
        return { ok: true };
      }
    } catch (qErr) {
      // tab_list 失败不是致命的 — 走下面 tab_create 兜底
      coworkLog('WARN', 'platformLoginDriver',
        'openPlatformLogin: tab_list probe failed, falling back to tab_create',
        { err: String(qErr) });
    }
  }
  try {
    await sendBrowserCommand('tab_create', { url }, 8000, routeOpts);
    return { ok: true };
  } catch {
    try {
      await sendBrowserCommand('navigate', { url }, 8000, routeOpts);
      return { ok: true };
    } catch (err2) {
      return { ok: false, reason: String(err2) };
    }
  }
}

/** v2.7+: 收敛同平台 NoobClaw managed tab 到 1 个 — 任务启动前调用,
 *  把累积的重复 X / binance / xhs ... NoobClaw managed tab 关到只剩一个。
 *  只关 NoobClaw 标签下的 tab(按 group title 筛),绝不动用户自己开的
 *  tab,所以可以安全在每次任务启动前无脑跑。
 *
 *  依赖 chrome-extension v1.4.11+(tab_list 必须返回 groupTitle)。老版本
 *  扩展 groupTitle 字段不存在,函数 silently no-op。 */
export async function closeDuplicatePlatformTabs(
  platforms: LoginPlatform[]
): Promise<{ closed: number }> {
  if (!platforms || platforms.length === 0) return { closed: 0 };
  let listRes: any;
  try {
    listRes = await sendBrowserCommand('tab_list', {}, 3000);
  } catch (e) {
    coworkLog('WARN', 'platformLoginDriver',
      'closeDuplicatePlatformTabs: tab_list failed', { err: String(e) });
    return { closed: 0 };
  }
  const allTabs: any[] = Array.isArray(listRes?.tabs) ? listRes.tabs
    : (Array.isArray(listRes?.data?.tabs) ? listRes.data.tabs : []);
  // groupTitle 是 v1.4.11+ 才有的字段。老 extension 会没这个字段 → 全 null
  // → 没法识别 managed → 函数 no-op,这是预期行为。
  let totalClosed = 0;
  for (const platform of platforms) {
    const expectedTitle = PLATFORM_TAB_GROUPS[platform]?.title;
    if (!expectedTitle) continue;
    const managed = allTabs.filter(t =>
      typeof t?.groupTitle === 'string' && t.groupTitle === expectedTitle
    );
    if (managed.length <= 1) continue;
    // 留第一个,关掉其他。第一个的选择标准:active 优先,其次最早 id(stable)。
    managed.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (a.id || 0) - (b.id || 0);
    });
    const toClose = managed.slice(1).map(t => t.id).filter(id => typeof id === 'number');
    if (toClose.length === 0) continue;
    coworkLog('INFO', 'platformLoginDriver',
      `closeDuplicatePlatformTabs: closing ${toClose.length} duplicate ${platform} tab(s)`,
      { keep: managed[0].id, close: toClose });
    try {
      // Extension 的 tab_close 接受 tabId 单个;循环关。
      for (const tabId of toClose) {
        try { await sendBrowserCommand('tab_close', { tabId }, 3000); }
        catch (cErr) {
          coworkLog('WARN', 'platformLoginDriver',
            `closeDuplicatePlatformTabs: failed to close tab ${tabId}`, { err: String(cErr) });
        }
      }
      totalClosed += toClose.length;
    } catch (e) {
      coworkLog('WARN', 'platformLoginDriver',
        `closeDuplicatePlatformTabs: ${platform} batch failed`, { err: String(e) });
    }
  }
  return { closed: totalClosed };
}

// ── Backward-compat aliases ─────────────────────────────────────────
// Old callers imported `checkXhsLogin` / `openXhsLogin` from `./xhsDriver`.
// They now route here; the misleading-named exports are kept so any caller
// we didn't migrate still works. Delete after a release where main +
// preload + sidecar + renderer all use the new names.
export const checkXhsLogin = checkPlatformLogin;
export const openXhsLogin = openPlatformLogin;
