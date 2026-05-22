/**
 * LoginRequiredModal — checklist before running XHS task.
 *
 *   ① 安装并连接浏览器插件
 *   ② 在浏览器中打开小红书并登录
 *   ③ 使用须知
 *   → 底部居中按钮
 *
 * 顺序说明:插件是其他所有检测的依赖根节点 — 没插件就探测不到
 * 任何 tab 状态。早期版本把"打开平台 tab"放第一,首次用户进
 * 来看到 step ① 一堆 ⏳ + 提示"装好插件后自动确认",得反向
 * 往下扫到 step ② 才知道要先装插件,直觉错位。改成依赖优先
 * 的顺序后,首次用户从上往下读一遍就能 onboard。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { scenarioService } from '../../services/scenario';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import { noobClawAuth } from '../../services/noobclawAuth';

interface Props {
  mode: 'create' | 'run';
  /** Which platform's login state we're checking. Default 'xhs' for
   *  back-compat. 'x' (Twitter) opens x.com + surfaces a VPN reminder for
   *  mainland China users. 'binance' opens binance.com/square. 'tiktok'
   *  opens tiktok.com/explore (also needs proxy in mainland China). */
  platform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin';
  /** v4.25.4 Cross-tab scenarios (binance_from_x_repost) need both platforms
   *  open + logged in. Pass the secondary platform here — modal will render
   *  an extra row and gate the "下一步" button until BOTH check pass. */
  secondaryPlatform?: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin';
  onCancel: () => void;
  onConfirmed: () => void;
}

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

export const LoginRequiredModal: React.FC<Props> = ({ mode, platform = 'xhs', secondaryPlatform, onCancel, onConfirmed }) => {
  const isZh = i18nService.currentLanguage === 'zh';

  type LoginPlatform = 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin';

  // Per-platform label/url helpers (primary AND secondary use these).
  // VPN reminders below check both primary and secondary so cross-tab
  // scenarios surface the warning if either platform needs a proxy.
  function platformLabelOf(p: LoginPlatform): string {
    if (p === 'x') return 'Twitter (x.com)';
    if (p === 'binance') return isZh ? '币安广场 (binance.com/square)' : 'Binance Square (binance.com/.../square)';
    if (p === 'tiktok') return 'TikTok (tiktok.com)';
    if (p === 'youtube') return 'YouTube (youtube.com)';
    if (p === 'douyin') return isZh ? '抖音 (douyin.com)' : 'Douyin (douyin.com)';
    return isZh ? '小红书' : 'Xiaohongshu';
  }
  function platformShortOf(p: LoginPlatform): string {
    if (p === 'x') return 'Twitter';
    if (p === 'binance') return isZh ? '币安广场' : 'Binance Square';
    if (p === 'tiktok') return 'TikTok';
    if (p === 'youtube') return 'YouTube';
    if (p === 'douyin') return isZh ? '抖音' : 'Douyin';
    return isZh ? '小红书' : 'Xiaohongshu';
  }
  function platformUrlOf(p: LoginPlatform): string {
    if (p === 'x') return 'https://x.com/home';
    if (p === 'binance') return 'https://www.binance.com/square';
    if (p === 'tiktok') return 'https://www.tiktok.com/explore';
    if (p === 'youtube') return 'https://www.youtube.com';
    if (p === 'douyin') return 'https://www.douyin.com/jingxuan';
    return 'https://www.xiaohongshu.com';
  }
  // Back-compat aliases — primary platform's label/url, used by step ① UI
  // text and the "Open" button. Secondary platform gets its own row using
  // platformLabelOf/Url in render.
  const platformLabel = platformLabelOf(platform);
  const platformShort = platformShortOf(platform);
  const platformUrl = platformUrlOf(platform);
  // Primary tab is "isX/isBinance" for downstream conditionals like VPN warning,
  // but VPN reminder must trigger when EITHER platform needs a proxy. So track
  // both flags separately.
  const isX = platform === 'x' || secondaryPlatform === 'x';
  const isBinance = platform === 'binance' || secondaryPlatform === 'binance';
  const isTiktok = platform === 'tiktok' || secondaryPlatform === 'tiktok';
  const isYoutube = platform === 'youtube' || secondaryPlatform === 'youtube';
  // 抖音 (douyin) 是大陆站点,不参与 VPN 提示。
  // 抖音 / 小红书的图文创作 / 爆款仿写都要发到 creator.*.com 子域,主站
  // tab 在不等于 creator tab 在 — 用户得真打开过 creator 才会渲染那个
  // origin 的页面、跑发布脚本。这里额外加一行 creator center 检查,只对
  // 这两个平台启用。其他平台没有独立 creator 子域,沿用单行检查。
  const requireCreatorCenter = platform === 'xhs' || platform === 'douyin';
  function creatorLabelOf(p: LoginPlatform): string {
    if (p === 'douyin') return isZh ? '抖音创作者中心 (creator.douyin.com)' : 'Douyin Creator Center (creator.douyin.com)';
    if (p === 'xhs') return isZh ? '小红书创作者中心 (creator.xiaohongshu.com)' : 'Xiaohongshu Creator Center (creator.xiaohongshu.com)';
    return platformLabelOf(p);
  }
  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [xhsTabStatus, setXhsTabStatus] = useState<StepStatus>('checking');
  const [secondaryTabStatus, setSecondaryTabStatus] = useState<StepStatus>(secondaryPlatform ? 'checking' : 'pass');
  // creator center 默认 pass — 只有 xhs/douyin 会真正动它,其他平台保持 pass
  // 不参与 allReady 判断。
  const [creatorTabStatus, setCreatorTabStatus] = useState<StepStatus>(requireCreatorCenter ? 'checking' : 'pass');
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  // Outdated extension warning — shown inline in step ② when an extension
  // is connected but reports a version below MIN_EXTENSION_VERSION. The
  // floor is bumped each release that ships a behavior-affecting
  // extension change (see chrome-extension/manifest.json version).
  //
  // v1.x: 从硬编码改成 server 下发 — 运营调 system_config['min_extension_version']
  // 即可让所有 client 重新弹"更新插件"提示,不用发 desktop-app release。
  // 启动时 fetch /api/user/runtime-config,失败 fallback '1.2.9' (旧默认)。
  const [MIN_EXTENSION_VERSION, setMinExtVersion] = useState<string>('1.2.9');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getBackendApiUrl()}/api/user/runtime-config`, {
          headers: noobClawAuth.getAuthHeaders(),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (alive && typeof j?.min_extension_version === 'string') {
          setMinExtVersion(j.min_extension_version);
        }
      } catch { /* keep fallback */ }
    })();
    return () => { alive = false; };
  }, []);
  const [outdatedExts, setOutdatedExts] = useState<Array<{ version: string }>>([]);
  // True when an extension is connected but hasn't reported its version yet
  // AND we're still inside the handshake grace window. The UI shows a
  // yellow "正在握手" label instead of green "已连接" so the user knows the
  // version check hasn't completed yet — and we auto-recheck after the
  // grace expires so the outdated warning surfaces without a manual click.
  const [handshakePending, setHandshakePending] = useState(false);
  // Secondary modal: step-by-step guide for loading the unpacked extension

  const compareVersion = (a: string, b: string): number => {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] || 0; const db = pb[i] || 0;
      if (da !== db) return da - db;
    }
    return 0;
  };

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await scenarioService.checkXhsLogin(platform);
      if (status.reason === 'browser_not_connected') {
        setExtensionStatus('fail');
        setXhsTabStatus('waiting');
        if (secondaryPlatform) setSecondaryTabStatus('waiting');
      } else if (
        status.reason === 'xhs_tab_not_reachable' ||
        status.reason === 'x_tab_not_reachable' ||
        status.reason === 'binance_tab_not_reachable' ||
        status.reason === 'tiktok_tab_not_reachable' ||
        status.reason === 'youtube_tab_not_reachable' ||
        status.reason === 'douyin_tab_not_reachable' ||
        status.reason === 'tab_not_reachable'
      ) {
        setExtensionStatus('pass');
        setXhsTabStatus('fail');
      } else {
        setExtensionStatus('pass');
        setXhsTabStatus('pass');
      }
      // 抖音 / 小红书 创作者中心 secondary check — 只在插件已连接后跑。
      // 跟主 tab 检查同一个 tab_list 来源,但用 creator.* 子域更严的正则
      // 匹配,并把命中页面是登录重定向(/passport/login / #/login)的情况
      // 显式判为未登录,而不是当成"已打开"。
      if (requireCreatorCenter && status.reason !== 'browser_not_connected') {
        try {
          const cStatus = await scenarioService.checkCreatorCenter(platform as 'xhs' | 'douyin');
          if (cStatus.reason === 'browser_not_connected') {
            setCreatorTabStatus('waiting');
          } else if (cStatus.loggedIn) {
            setCreatorTabStatus('pass');
          } else {
            setCreatorTabStatus('fail');
          }
        } catch {
          setCreatorTabStatus('fail');
        }
      } else if (requireCreatorCenter) {
        // 主检查报 browser_not_connected,creator 检查没法独立判断,统一 waiting。
        setCreatorTabStatus('waiting');
      }

      // v4.25.4: cross-tab scenario — also probe the secondary platform tab.
      // Only runs once extension is confirmed connected (else status would
      // also report browser_not_connected and we already set 'waiting' above).
      if (secondaryPlatform && status.reason !== 'browser_not_connected') {
        try {
          const sStatus = await scenarioService.checkXhsLogin(secondaryPlatform);
          if (
            sStatus.reason === 'xhs_tab_not_reachable' ||
            sStatus.reason === 'x_tab_not_reachable' ||
            sStatus.reason === 'binance_tab_not_reachable' ||
            sStatus.reason === 'tiktok_tab_not_reachable' ||
            sStatus.reason === 'youtube_tab_not_reachable' ||
            sStatus.reason === 'douyin_tab_not_reachable' ||
            sStatus.reason === 'tab_not_reachable'
          ) {
            setSecondaryTabStatus('fail');
          } else if (sStatus.reason === 'browser_not_connected') {
            setSecondaryTabStatus('waiting');
          } else {
            setSecondaryTabStatus('pass');
          }
        } catch {
          setSecondaryTabStatus('fail');
        }
      }
      // Version check piggy-backs on the same poll. If any connected
      // extension is below the floor, surface it inline. The "empty
      // version" case is tricky:
      //   - 1.2.0+ extensions send hello with version within ~1s of
      //     connecting → if version is still empty after 5s, the
      //     extension is OLDER than 1.2.0 (1.1.0 etc., which never
      //     sends hello at all) → flag as outdated.
      //   - During the first 5s of a fresh connection, version may
      //     still be legitimately empty (handshake in flight) → don't
      //     flag yet to avoid false positives.
      try {
        const exts = await scenarioService.getConnectedExtensions();
        const HANDSHAKE_GRACE_MS = 5000;
        const now = Date.now();
        let stillHandshaking = false;
        let earliestGraceExpiresAt = Infinity;
        const old = exts.filter(e => {
          if (!e.version) {
            // Old extensions that don't send version at all — flag
            // after grace period. Without this, 1.1.0 stays "connected"
            // but never reports anything and we never warn.
            const elapsed = now - (e.connectedAt || 0);
            if (elapsed <= HANDSHAKE_GRACE_MS) {
              // Still inside grace — defer judgment, but remember to
              // re-check the moment grace expires so a real old extension
              // surfaces its warning even if the user never clicks
              // "重新检测" again. Without this, scenario "client-first
              // then browser → user clicks recheck within 2s" leaves the
              // version check stuck in a permanent "in grace, looks fine"
              // state with no warning ever shown.
              stillHandshaking = true;
              const expiresAt = (e.connectedAt || 0) + HANDSHAKE_GRACE_MS + 200;
              if (expiresAt < earliestGraceExpiresAt) earliestGraceExpiresAt = expiresAt;
              return false;
            }
            return true;
          }
          return compareVersion(e.version, MIN_EXTENSION_VERSION) < 0;
        });
        setHandshakePending(stillHandshaking && old.length === 0);
        setOutdatedExts(old.map(o => ({ version: o.version || '< 1.2.0 (no version reported)' })));
        // Auto-recheck after the earliest grace window expires so the
        // outdated warning shows up without requiring a manual re-click.
        if (stillHandshaking && earliestGraceExpiresAt !== Infinity) {
          const wait = Math.max(500, earliestGraceExpiresAt - now);
          setTimeout(() => { void runCheck(); }, wait);
        }
      } catch {
        setOutdatedExts([]);
        setHandshakePending(false);
      }
    } catch {
      setExtensionStatus('fail');
      setXhsTabStatus('waiting');
      if (secondaryPlatform) setSecondaryTabStatus('waiting');
      if (requireCreatorCenter) setCreatorTabStatus('waiting');
    } finally {
      setChecking(false);
    }
  }, [platform, secondaryPlatform, requireCreatorCenter]);

  useEffect(() => { void runCheck(); }, []); // eslint-disable-line

  // Periodic auto-poll while the modal is open. Catches:
  //   - User opens modal first, then opens browser → extension connects
  //   - User updates extension from store → old conn disconnects, new
  //     conn connects with the higher version → outdated warning clears
  //   - User logs in to XHS / Twitter mid-check → tab now reachable
  // 3s strikes a balance between responsiveness and cost (the check
  // round-trips to sidecar; doing it every 1s would feel snappy but
  // hammer the bridge unnecessarily).
  useEffect(() => {
    const h = setInterval(() => { void runCheck(); }, 3000);
    return () => clearInterval(h);
  }, [runCheck]);

  const handleOpenXhs = async () => {
    setOpening(true);
    try {
      // platform-aware: opens xiaohongshu.com or x.com based on prop. The
      // sidecar's xhsDriver now respects the platform arg and tells the
      // extension to open the right URL.
      const res = await scenarioService.openXhsLogin(platform);
      if (!res.ok) { try { window.open(platformUrl, '_blank'); } catch {} }
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(false);
    }
  };

  const allReady = extensionStatus === 'pass' && xhsTabStatus === 'pass'
    && (!secondaryPlatform || secondaryTabStatus === 'pass')
    && (!requireCreatorCenter || creatorTabStatus === 'pass');
  // v2.8+: 不再 client 主动 prepareTabsForRun(dedup + split)。chrome-extension
  // 1.4.22+ 在 _windowMutex 内自治,任何会动 chrome.windows / tabGroups 的
  // 路径都串行 enforce,不需要 client 提前 nudge。

  // 一键打开 secondary 平台 tab(跨 tab scenario 用)
  const handleOpenSecondary = async () => {
    if (!secondaryPlatform) return;
    setOpening(true);
    try {
      const res = await scenarioService.openXhsLogin(secondaryPlatform);
      if (!res.ok) { try { window.open(platformUrlOf(secondaryPlatform), '_blank'); } catch {} }
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(false);
    }
  };

  // 一键打开 creator center tab(xhs / douyin 图文创作必需)
  const handleOpenCreator = async () => {
    if (!requireCreatorCenter) return;
    const p = platform as 'xhs' | 'douyin';
    const creatorUrl = p === 'douyin' ? 'https://creator.douyin.com/' : 'https://creator.xiaohongshu.com/';
    setOpening(true);
    try {
      const res = await scenarioService.openCreatorCenter(p);
      if (!res.ok) { try { window.open(creatorUrl, '_blank'); } catch {} }
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(false);
    }
  };
  const ICON: Record<StepStatus, string> = { pass: '✅', fail: '❌', checking: '⏳', waiting: '⏳' };

  // Shared install/update action block — used by BOTH "extension not
  // connected" (red) and "extension outdated" (yellow) states. Logically
  // they're the same problem (need to install a new build), so the
  // buttons should be identical; only the surrounding header copy differs.
  // The extension is published in all three stores (Chrome / Firefox / Edge),
  // so users always install from a store — no local-install path.
  const installActionButtons = (
    <>
      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={() => window.open('https://chromewebstore.google.com/detail/noobclaw-browser-assistan/abchfdkiphahgkoalhnmlfpfmgkedigf', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-green-500/30 text-green-500 hover:bg-green-500/10 transition-colors text-left">
          {isZh ? '🌐 安装 Chrome 浏览器插件' : '🌐 Install Chrome Extension'}
        </button>
        <button type="button" onClick={() => window.open('https://addons.mozilla.org/firefox/addon/noobclaw-browser-assistant/', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-orange-500/30 text-orange-500 hover:bg-orange-500/10 transition-colors text-left">
          {isZh ? '🦊 安装 Firefox 浏览器插件' : '🦊 Install Firefox Extension'}
        </button>
        <button type="button" onClick={() => window.open('https://microsoftedge.microsoft.com/addons/detail/laphnggbfbalnemcgjcgmdjaaehldkbd', '_blank')}
          className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-500 hover:bg-blue-500/10 transition-colors text-left">
          {isZh ? '🔷 安装 Edge 浏览器插件' : '🔷 Install Edge Extension'}
        </button>
      </div>
      <button type="button" onClick={runCheck} disabled={checking}
        className="text-xs text-blue-500 hover:underline mt-1">
        {checking ? (isZh ? '检测中...' : 'Checking...') : (isZh ? '🔄 重新检测' : '🔄 Re-check')}
      </button>
    </>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      {/* v4.25.4: 跨 tab 任务多了一行检查,modal 高度容易超屏导致取消按钮被切。
          宽度从 max-w-md (~448px) 拉到 max-w-2xl (~672px),整体 max-h 限到
          90vh,中间内容区 overflow-y-auto,头/底永远可见。 */}
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-5 pb-2 text-center shrink-0">
          <div className="text-3xl mb-1">🔐</div>
          <h3 className="text-lg font-bold dark:text-white">{isZh ? '运行前检查' : 'Pre-run Check'}</h3>
        </div>

        <div className="px-6 py-2 space-y-2.5 overflow-y-auto flex-1">
          {/* Step 1: Extension — 依赖根节点,所有 tab 检测都靠它,放最前 */}
          <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
            extensionStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : extensionStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[extensionStatus]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">{isZh ? '① 安装并连接浏览器插件' : '① Install & connect browser extension'}</div>
              {extensionStatus === 'fail' && (
                <div className="mt-2 space-y-2">
                  <div className="text-xs text-red-500">{isZh ? '插件未连接，请打开浏览器，如尚未安装，点击下方选项进行安装：' : 'Extension not connected. Open your browser; if not yet installed, click an option below to install:'}</div>
                  {installActionButtons}
                </div>
              )}
              {extensionStatus === 'pass' && outdatedExts.length === 0 && !handshakePending && (
                <div className="text-xs text-green-500 mt-1">{isZh ? '已连接' : 'Connected'}</div>
              )}
              {/* Handshake-in-progress: extension just connected (TCP open)
                  but its version-bearing `hello` message hasn't arrived yet
                  AND we're still inside the 5s grace window. Show a yellow
                  intermediate state so the user doesn't see misleading
                  green "Connected" while we're actually still waiting to
                  judge whether it's an outdated build. The runCheck above
                  schedules an auto re-poll right after grace expires, so
                  this label will flip to either ✅ Connected or ⚠️ outdated
                  on its own — no user action needed. */}
              {extensionStatus === 'pass' && outdatedExts.length === 0 && handshakePending && (
                <div className="mt-1">
                  <div className="text-xs text-amber-500 flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
                    {isZh ? '正在握手，确认插件版本中...' : 'Handshaking, verifying extension version...'}
                  </div>
                  <button type="button" onClick={runCheck} disabled={checking}
                    className="text-xs text-blue-500 hover:underline mt-1.5">
                    {checking ? (isZh ? '检测中...' : 'Checking...') : (isZh ? '🔄 重新检测' : '🔄 Re-check')}
                  </button>
                </div>
              )}
              {/* Outdated-version warning, inline. Shown ONLY when at least
                  one connected extension is below the required floor. The
                  pre-run check is the right place for this — it's the
                  natural gate before a run, and the user can click straight
                  through to the right store to update. */}
              {extensionStatus === 'pass' && outdatedExts.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                  <div className="font-semibold mb-1">
                    ⚠️ {isZh
                      ? `检测到旧版插件（${outdatedExts.map(o => o.version).join(', ')}）— 多浏览器并行任务可能不工作，建议立即更新到 v${MIN_EXTENSION_VERSION}+`
                      : `Outdated extension detected (${outdatedExts.map(o => o.version).join(', ')}). Multi-browser tasks may not work — update to v${MIN_EXTENSION_VERSION}+`}
                  </div>
                  <div className="mt-2 space-y-2">
                    {installActionButtons}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Step 2: 平台 tab —— 不依赖插件即可点"打开"按钮,但真实
              的 ✓/✗ 检测要等 step ① 插件连接后才能跑。未连接时显示
              "装好插件后这里会自动确认",按钮仍可用,用户可以在装插
              件之前先把页面开起来。
              历史:v4.25.4 解锁这一步的按钮(之前两步互锁、用户被
              绕晕);后续把插件移到 step ①,这一步顺位变 ② —
              依赖根节点排前面,首次用户从上往下读更顺。 */}
          {(() => {
            // 只有在插件已连接 + tab 检测真过了的时候才算 pass。其他都让用户能动作。
            const realPass = extensionStatus === 'pass' && xhsTabStatus === 'pass';
            const realFail = extensionStatus === 'pass' && xhsTabStatus === 'fail';
            const visualStatus: StepStatus = realPass ? 'pass' : (realFail ? 'fail' : 'checking');
            return (
              <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
                visualStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
                  : visualStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                <div className="text-xl shrink-0 mt-0.5">{ICON[visualStatus]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium dark:text-white">
                    {isZh ? `② 在浏览器中打开 ${platformLabel} 并登录` : `② Open ${platformLabel} in browser & login`}
                  </div>
                  {realPass && (
                    <div className="text-xs text-green-500 mt-1">{isZh ? '已打开' : 'Connected'}</div>
                  )}
                  {realFail && (
                    <div className="text-xs text-red-500 mt-1">
                      {isZh ? `未检测到 ${platformLabel} 页面` : `${platformLabel} page not detected`}
                    </div>
                  )}
                  {!realPass && extensionStatus !== 'pass' && (
                    <div className="text-xs text-gray-400 mt-1">
                      {isZh ? '装好插件后这里会自动确认' : 'Auto-verifies once extension is installed'}
                    </div>
                  )}
                  {!realPass && (
                    <button type="button" onClick={handleOpenXhs} disabled={opening}
                      className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50">
                      {opening ? '...' : (isZh ? `🌐 打开 ${platformLabel}` : `🌐 Open ${platformLabel}`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Step 2a: 创作者中心 —— 仅 xhs / douyin 图文/爆款仿写 scenario 需要。
              主站登录态 SSO 共享到 creator 子域,但用户得真打开过 creator tab
              那个 origin 的脚本才能跑起来。命中 /passport/login 之类的重定向
              URL 会显式判 fail(creator_not_logged_in),让用户知道要去补登录,
              而不是误以为"已打开 = OK"。 */}
          {requireCreatorCenter && (() => {
            const cLabel = creatorLabelOf(platform);
            const realPass = extensionStatus === 'pass' && creatorTabStatus === 'pass';
            const realFail = extensionStatus === 'pass' && creatorTabStatus === 'fail';
            const visualStatus: StepStatus = realPass ? 'pass' : (realFail ? 'fail' : 'checking');
            return (
              <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
                visualStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
                  : visualStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                <div className="text-xl shrink-0 mt-0.5">{ICON[visualStatus]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium dark:text-white">
                    {isZh ? `② 打开 ${cLabel} 并登录` : `② Open ${cLabel} & login`}
                  </div>
                  {realPass && (
                    <div className="text-xs text-green-500 mt-1">{isZh ? '已打开并已登录' : 'Open & logged in'}</div>
                  )}
                  {realFail && (
                    <div className="text-xs text-red-500 mt-1">
                      {isZh ? `未检测到 ${cLabel} 登录态(可能未打开,或停在登录页)` : `${cLabel} not logged in (tab missing or on login page)`}
                    </div>
                  )}
                  {!realPass && extensionStatus !== 'pass' && (
                    <div className="text-xs text-gray-400 mt-1">
                      {isZh ? '装好插件后这里会自动确认' : 'Auto-verifies once extension is installed'}
                    </div>
                  )}
                  {!realPass && (
                    <button type="button" onClick={handleOpenCreator} disabled={opening}
                      className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50">
                      {opening ? '...' : (isZh ? `🌐 打开 ${cLabel}` : `🌐 Open ${cLabel}`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Step 2b: 副 tab —— 仅跨 tab scenario(binance_from_x_repost)展示。
              v4.25.4: 推特搬运任务两个 tab 都得登录,只检查 binance 不够。
              用同一套 真检测 + 按钮兜底 模式渲染。 */}
          {secondaryPlatform && (() => {
            const sLabel = platformLabelOf(secondaryPlatform);
            const realPass = extensionStatus === 'pass' && secondaryTabStatus === 'pass';
            const realFail = extensionStatus === 'pass' && secondaryTabStatus === 'fail';
            const visualStatus: StepStatus = realPass ? 'pass' : (realFail ? 'fail' : 'checking');
            return (
              <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
                visualStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
                  : visualStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                <div className="text-xl shrink-0 mt-0.5">{ICON[visualStatus]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium dark:text-white">
                    {isZh ? `② 同时打开 ${sLabel} 并登录(跨 tab 任务必需)` : `② Also open ${sLabel} & login (required for cross-tab task)`}
                  </div>
                  {realPass && (
                    <div className="text-xs text-green-500 mt-1">{isZh ? '已打开' : 'Connected'}</div>
                  )}
                  {realFail && (
                    <div className="text-xs text-red-500 mt-1">
                      {isZh ? `未检测到 ${sLabel} 页面` : `${sLabel} page not detected`}
                    </div>
                  )}
                  {!realPass && extensionStatus !== 'pass' && (
                    <div className="text-xs text-gray-400 mt-1">
                      {isZh ? '装好插件后这里会自动确认' : 'Auto-verifies once extension is installed'}
                    </div>
                  )}
                  {!realPass && (
                    <button type="button" onClick={handleOpenSecondary} disabled={opening}
                      className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50">
                      {opening ? '...' : (isZh ? `🌐 打开 ${sLabel}` : `🌐 Open ${sLabel}`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Step 3: Usage notes */}
          <div className={`rounded-xl p-3 border ${
            allReady ? 'border-amber-500/30 bg-amber-500/5' : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-sm font-medium dark:text-white mb-2">{isZh ? '③ 使用须知' : '③ Usage Notes'}</div>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1.5 leading-relaxed">
              <li>🤖 {isZh ? `所有操作模拟你本人在 ${platformLabel} 上的行为` : `All actions simulate your own behavior on ${platformLabel}`}</li>
              <li>🌐 {isZh ? <>运行期间请<strong>不要切换浏览器标签页</strong></> : <><strong>Do not switch browser tabs</strong> during a run</>}</li>
              <li>🔐 {isZh ? <>请<strong>不要退出 {platformLabel} 登录</strong></> : <><strong>Do not log out</strong> of {platformLabel}</>}</li>
              <li>⏰ {isZh ? '可以正常使用电脑，保持浏览器打开即可' : 'You can use your computer normally, just keep the browser open'}</li>
              {(isX || isBinance || isTiktok || isYoutube) && (() => {
                // 跨 tab 任务时两个站点合并成一句,免得连出两条 ⚠️ 警告占屏。
                const sites = [
                  isX ? 'x.com' : null,
                  isBinance ? (isZh ? '币安广场 (binance.com/square)' : 'Binance Square (binance.com/.../square)') : null,
                  isTiktok ? 'tiktok.com' : null,
                  isYoutube ? 'youtube.com' : null,
                ].filter(Boolean).join(' + ');
                return (
                  <li className="text-amber-600 dark:text-amber-400">
                    ⚠️ {isZh
                      ? <><strong>大陆用户</strong>请确保 VPN / 代理已开启,且 {sites} 都能正常访问</>
                      : <><strong>Mainland China users</strong> must enable a VPN / proxy and verify {sites} is reachable</>}
                  </li>
                );
              })()}
            </ul>
          </div>
        </div>

        {/* Bottom button — shrink-0 + 边框分隔,永远 stick 在 modal 底部不会被滚走 */}
        <div className="px-6 py-3 flex flex-col items-center gap-1.5 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            type="button"
            onClick={onConfirmed}
            disabled={!allReady}
            className={`w-full max-w-[280px] text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors ${
              allReady
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {mode === 'create'
              ? (isZh ? '✅ 我已登录，下一步' : '✅ Logged in, Next')
              : (isZh ? `✅ 我已登录 ${platformShort}，开始` : `✅ Logged in to ${platformShort}, Start`)}
          </button>
          <button type="button" onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            {isZh ? '取消' : 'Cancel'}
          </button>
        </div>
      </div>

    </div>
  );
};
