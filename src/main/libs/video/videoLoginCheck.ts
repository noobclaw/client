/**
 * videoLoginCheck —— 视频类任务【cookie 式登录校验】(req 3)。
 *
 * 旧校验(scenario 的 checkPlatformLogin / checkCreatorCenter)是「扫 tab_list 看有没有开着
 * 该平台 URL 的 tab」—— 必须把对应页面一直开着才算登录。视频侧不想这样:
 *   · 开【一个固定唯一的"视频任务运行检查"窗口】(windowKey=video_check::default),
 *   · 在它的 tab 上 attach CDP,用 cdp_cookies_get（Network.getCookies，能读 HttpOnly）
 *     读各平台域名的 cookie，
 *   · 看登录态 cookie 在不在 / 没过期 → 判已登录。cookie 在浏览器 profile 里全局可读，
 *     不依赖"对应页面开着"，也不用导航过去。
 *
 * 设计成【乐观快路径】：只有「cookie 探测成功且命中登录 cookie」才返回 loggedIn=true；
 * 任何不确定（没配该平台 / 开不出检查窗 / 扩展无 cdp_cookies_get / 探测异常）都返回 null，
 * 让调用方回退到老的 checkPlatformLogin —— 所以 cookie 名即使填错，最坏只是没有快路径，
 * 绝不会误判成已登录、也绝不回退现有能力。
 *
 * ⚠️ 各平台登录 cookie 名是按通用知识填的【需真机确认】（见 VIDEO_LOGIN_COOKIES 注释）。
 * 只选「登录后才有、登出即失效」的会话 cookie，避开设备级常驻 cookie（如小红书 a1）防误判。
 */

import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';
import { groupTitle as buildGroupTitle, getStandardBounds } from '../scenario/subPlatformRegistry';
import type { LoginPlatform } from '../scenario/platformLoginDriver';

const CHECK_SUB_PLATFORM = 'video_check';
const CHECK_WINDOW_KEY = `${CHECK_SUB_PLATFORM}::default`;

/** 各平台「登录态」cookie:命中任一个（存在、值非空、未过期）即视为已登录。【需真机确认名字】 */
const VIDEO_LOGIN_COOKIES: Partial<Record<LoginPlatform, { url: string; names: string[] }>> = {
  douyin:   { url: 'https://www.douyin.com/',        names: ['sessionid_ss', 'sessionid', 'sid_guard'] },
  xhs:      { url: 'https://www.xiaohongshu.com/',   names: ['web_session'] },
  bilibili: { url: 'https://www.bilibili.com/',      names: ['SESSDATA', 'DedeUserID'] },
  kuaishou: { url: 'https://www.kuaishou.com/',      names: ['passToken', 'kuaishou.web.cp.api_st'] },
  tiktok:   { url: 'https://www.tiktok.com/',        names: ['sessionid', 'sid_tt'] },
  youtube:  { url: 'https://www.youtube.com/',       names: ['LOGIN_INFO', 'SAPISID'] },
  binance:  { url: 'https://www.binance.com/',       names: ['p20t'] },
  x:        { url: 'https://x.com/',                 names: ['auth_token'] },
};

let _checkTabId: number | undefined;

/** 开/复用唯一的「视频任务运行检查」窗口的固定 tab,返回 tabId。拿不到返回 undefined(调用方回退老校验)。 */
async function ensureVideoCheckWindow(): Promise<number | undefined> {
  if (typeof _checkTabId === 'number') return _checkTabId;
  if (!connectionHasCapability(undefined, 'window_registry_v6')) return undefined;
  try {
    const idleTitle = buildGroupTitle(CHECK_SUB_PLATFORM, 'default', null);
    const bounds = getStandardBounds(CHECK_SUB_PLATFORM, 'default');
    const res: any = await sendBrowserCommand(
      'task_open_tab',
      {
        windowKey: CHECK_WINDOW_KEY,
        groupTitle: idleTitle,
        role: 'checker',
        url: 'about:blank', // 不导航到任何平台:只在这个 tab 上 attach CDP 读 cookie
        bounds,
      },
      12000,
    );
    const tabId = res?.tabId ?? res?.data?.tabId;
    if (typeof tabId === 'number') { _checkTabId = tabId; return tabId; }
  } catch { /* 开窗失败 → 回退 */ }
  return undefined;
}

/** 读指定 URL 可用的全部 cookie(含 HttpOnly,走扩展 cdp_cookies_get)。失败返回 null。 */
async function cdpGetCookies(url: string, tabId: number): Promise<any[] | null> {
  try {
    const res: any = await sendBrowserCommand('cdp_cookies_get', { urls: [url], tabId }, 10000);
    const cookies = res?.cookies ?? res?.data?.cookies;
    return Array.isArray(cookies) ? cookies : null;
  } catch {
    return null;
  }
}

/**
 * cookie 式登录校验。返回:
 *   { loggedIn: true }  —— 探测成功且命中登录 cookie(可信,调用方直接放行)
 *   { loggedIn: false } —— 探测成功但没有登录 cookie(可信,但调用方仍可保守回退老校验)
 *   null                —— 无法判定(没配 / 开不出检查窗 / 扩展不支持 / 异常),调用方回退老校验
 */
export async function checkVideoLoginByCookie(
  platform: LoginPlatform,
): Promise<{ loggedIn: boolean } | null> {
  const cfg = VIDEO_LOGIN_COOKIES[platform];
  if (!cfg) return null;
  const tabId = await ensureVideoCheckWindow();
  if (typeof tabId !== 'number') return null;
  const cookies = await cdpGetCookies(cfg.url, tabId);
  if (!cookies) {
    _checkTabId = undefined; // 可能 tab 已关:下次重开
    return null;
  }
  const nowSec = Date.now() / 1000;
  const ok = cfg.names.some((name) =>
    cookies.some((c) =>
      c && c.name === name
      && typeof c.value === 'string' && c.value.length > 0
      // 会话 cookie(expires<=0 / session)不判过期;持久 cookie 看是否过期
      && !(typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec),
    ),
  );
  return { loggedIn: ok };
}
