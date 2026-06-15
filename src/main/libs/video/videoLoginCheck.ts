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

/** 探哪个子域(主站 vs 创作者中心)。⚠️ 创作中心 cookie 可能跟主站不同名 —— 取材走 main,发布多走 creator。 */
export type LoginWhich = 'main' | 'creator';

/**
 * 各「平台:子域」的登录态 cookie:命中任一个（存在、值非空、未过期）即视为已登录。【需真机确认名字】
 *
 * 用 cdp_cookies_get 探【对应子域的 url】:Network.getCookies 会返回「能发给该 url」的全部 cookie,
 * 即父域(.douyin.com)共享的 + 该子域专属的都在里头。所以校验创作中心登录就探 creator.* 的 url,
 * 别拿主站 url 顶替(创作中心可能另发独立登录 cookie —— 用户明确提示)。
 *
 * 没列 creator 行的平台(tiktok/youtube/binance/x)= 主站发布、无独立创作中心,只用 main。
 */
// domain:cookie 必须落在这个域(去前导点后 includes 匹配)。⚠️多平台同名 cookie 必须靠它区分 ——
//   如抖音和 TikTok 的登录 cookie 都叫 sessionid,只按名匹配会串台误判;按 domain 区分(.douyin.com
//   vs .tiktok.com)才对。主站/创作中心共用一个 base 域(creator.* 的 cookie 多挂在 base 域上)。
const VIDEO_LOGIN_COOKIES: Record<string, { url: string; domain: string; names: string[] }> = {
  'douyin:main':      { url: 'https://www.douyin.com/',          domain: 'douyin.com',       names: ['sessionid_ss', 'sessionid', 'sid_guard'] },
  // 抖音创作中心:多数 cookie 跟主站 SSO 共享(.douyin.com),若创作中心另发登录 cookie 需真机补名。
  'douyin:creator':   { url: 'https://creator.douyin.com/',      domain: 'douyin.com',       names: ['sessionid_ss', 'sessionid', 'sid_guard'] },
  'xhs:main':         { url: 'https://www.xiaohongshu.com/',     domain: 'xiaohongshu.com',  names: ['web_session'] },
  // 小红书创作中心:cookie 跟主站不一样(galaxy_creator_*),主站的 web_session 也带上兜底 —— 真机确认。
  // 小红书创作中心:实测(2026-06-15)登录态 session 是 HttpOnly,名字按通用知识多填几个候选 —— 真实名以
  //   诊断日志(见 checkVideoLoginByCookieBatch 的 console.log)为准,确认后收敛。这些都是登录后才有的会话项。
  'xhs:creator':      { url: 'https://creator.xiaohongshu.com/', domain: 'xiaohongshu.com',  names: ['access-token-creator.xiaohongshu.com', 'galaxy_creator_session_id', 'galaxy.creator.beaker.session.id', 'customer-sso-sid', 'web_session'] },
  'bilibili:main':    { url: 'https://www.bilibili.com/',        domain: 'bilibili.com',     names: ['SESSDATA', 'DedeUserID'] },
  'bilibili:creator': { url: 'https://member.bilibili.com/',     domain: 'bilibili.com',     names: ['SESSDATA', 'DedeUserID'] },
  'kuaishou:main':    { url: 'https://www.kuaishou.com/',        domain: 'kuaishou.com',     names: ['passToken', 'userId'] },
  'kuaishou:creator': { url: 'https://cp.kuaishou.com/',         domain: 'kuaishou.com',     names: ['passToken', 'userId', 'kuaishou.web.cp.api_st'] },
  'tiktok:main':      { url: 'https://www.tiktok.com/',          domain: 'tiktok.com',       names: ['sessionid', 'sid_tt'] },
  'youtube:main':     { url: 'https://www.youtube.com/',         domain: 'youtube.com',      names: ['LOGIN_INFO'] },
  'binance:main':     { url: 'https://www.binance.com/',         domain: 'binance.com',      names: ['p20t'] },
  'x:main':           { url: 'https://x.com/',                   domain: 'x.com',            names: ['auth_token'] },
};

/** 一组 cookie 里是否命中某「平台:子域」的登录态:域名匹配 + 名匹配 + 值非空 + 未过期。 */
function cookieHit(cookies: any[], cfg: { domain: string; names: string[] }): boolean {
  const nowSec = Date.now() / 1000;
  const dom = cfg.domain.replace(/^\./, '');
  const domOk = (cd: unknown): boolean => {
    if (typeof cd !== 'string') return false;
    const d = cd.replace(/^\./, '');
    return d === dom || d.endsWith('.' + dom); // 严格:本域或其子域;不让 evildouyin.com 蒙混(includes 会)
  };
  return cfg.names.some((name) =>
    cookies.some((c) =>
      c && c.name === name
      && typeof c.value === 'string' && c.value.length > 0
      && domOk(c.domain)                                                            // 按域名区分同名 cookie(抖音/TikTok 都叫 sessionid)
      && !(typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec),    // 持久 cookie 判过期;会话 cookie 不判
    ),
  );
}

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

/** 读指定 URL(单个或多个)可用的全部 cookie(含 HttpOnly,走扩展 cdp_cookies_get)。失败返回 null。 */
async function cdpGetCookies(urls: string | string[], tabId: number): Promise<any[] | null> {
  try {
    const urlArr = Array.isArray(urls) ? urls : [urls];
    const res: any = await sendBrowserCommand('cdp_cookies_get', { urls: urlArr, tabId }, 10000);
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
  which: LoginWhich = 'main',
  /** 复用现成 tab 读 cookie(如发布时已导航到平台的发布 tab)→ 不再开 video_check 空白窗。
   *  Network.getCookies 按 url 取,不管该 tab 当前停在哪页,所以任意 tab 都能读。 */
  reuseTabId?: number,
): Promise<{ loggedIn: boolean } | null> {
  // 创作中心校验 → 探 creator 子域;没登记 creator 行的平台退回 main(主站发布、无独立创作中心)。
  const cfg = VIDEO_LOGIN_COOKIES[`${platform}:${which}`] || VIDEO_LOGIN_COOKIES[`${platform}:main`];
  if (!cfg) return null;
  const tabId = typeof reuseTabId === 'number' ? reuseTabId : await ensureVideoCheckWindow();
  if (typeof tabId !== 'number') return null;
  const cookies = await cdpGetCookies(cfg.url, tabId);
  if (!cookies) {
    if (typeof reuseTabId !== 'number') _checkTabId = undefined; // 自家检查窗可能已关 → 下次重开;复用的 tab 不动
    return null;
  }
  return { loggedIn: cookieHit(cookies, cfg) };
}

/**
 * 【批量】多平台一次性 cookie 校验 —— 用户勾选多个上传平台时用:
 *   ① 在【一个】视频检查窗的 tab 上【一次】cdp_cookies_get 把所有平台 url 的 cookie 全读出来
 *      —— 避免并发各开一次 CDP attach(同 tab 只能 attach 一个 → 互相抢占失败)+ 只闪一次横幅;
 *   ② 按【域名 + cookie 名】逐平台判(域名区分抖音/TikTok 的同名 sessionid,防串台误判)。
 * 返回 { [platform]: true|false|null }(null = 该平台没配 / 无法判定 → 调用方对该平台回退老校验)。
 */
export async function checkVideoLoginByCookieBatch(
  items: { platform: LoginPlatform; which?: LoginWhich }[],
): Promise<Record<string, boolean | null>> {
  const out: Record<string, boolean | null> = {};
  for (const it of items) out[it.platform] = null;
  const resolved = items
    .map((it) => ({ platform: it.platform, cfg: VIDEO_LOGIN_COOKIES[`${it.platform}:${it.which || 'main'}`] || VIDEO_LOGIN_COOKIES[`${it.platform}:main`] }))
    .filter((x): x is { platform: LoginPlatform; cfg: { url: string; domain: string; names: string[] } } => !!x.cfg);
  if (resolved.length === 0) return out;
  const tabId = await ensureVideoCheckWindow();
  if (typeof tabId !== 'number') return out;
  // 【不关窗】窗口留着:它既是 cookie 读取窗,又是「打开 X 登录」复用的那一个登录窗(见
  //   openLoginInCheckWindow),轮询也复用它。模态关闭时由 closeVideoCheckWindow 统一收掉。
  const urls = Array.from(new Set(resolved.map((x) => x.cfg.url)));
  const cookies = await cdpGetCookies(urls, tabId); // 一次读全部 url 的 cookie(任意页都能读)
  if (!cookies) { _checkTabId = undefined; return out; }
  for (const { platform, cfg } of resolved) {
    out[platform] = cookieHit(cookies, cfg);
    // 诊断:打印该平台域名下实际读到的 cookie 名(只名字、无值,无隐私)。用来核对真实 session 名 ——
    //   若某平台明明登录了却 hit=false,看这行就知道真实 cookie 叫啥,据此改 VIDEO_LOGIN_COOKIES。
    try {
      const dom = cfg.domain.replace(/^\./, '');
      const found = cookies
        .filter((c: any) => typeof c?.domain === 'string' && c.domain.replace(/^\./, '').includes(dom) && c.value)
        .map((c: any) => c.name);
      // eslint-disable-next-line no-console
      console.log(`[videoLoginCheck] ${platform}(${cfg.domain}) hit=${out[platform]} cookieNames=[${found.join(', ')}]`);
    } catch { /* 诊断失败不影响 */ }
  }
  return out;
}

/** 把【唯一的检查/登录窗】导航到某平台登录页 —— 多平台登录【复用这一个窗口】,不再每点一个开新窗。
 *  用户在这个窗里挨个登录,cookie 批量读从同一个窗取 → 开一个窗就能知道所有平台登录态。 */
export async function openLoginInCheckWindow(url: string): Promise<{ ok: boolean }> {
  const tabId = await ensureVideoCheckWindow();
  if (typeof tabId !== 'number') return { ok: false };
  try {
    await sendBrowserCommand('navigate', { url, tabId }, 15000);
    return { ok: true };
  } catch { return { ok: false }; }
}

/** 关掉「运行检查/登录」窗(模态关闭时调,避免空白窗常驻)。 */
export async function closeVideoCheckWindow(): Promise<void> {
  const id = _checkTabId;
  if (typeof id !== 'number') return;
  _checkTabId = undefined;
  try { await sendBrowserCommand('tab_close', { tabId: id }, 5000); } catch { /* 关不掉就算了 */ }
}
