/**
 * LoginRequiredModal — checklist before running XHS task.
 *
 *   ① 在浏览器中打开小红书并登录
 *   ② 安装并连接浏览器插件
 *   ③ 使用须知
 *   → 底部居中按钮
 */

import React, { useCallback, useEffect, useState } from 'react';
import { scenarioService } from '../../services/scenario';
import { i18nService } from '../../services/i18n';

interface Props {
  mode: 'create' | 'run';
  /** Which platform's login state we're checking. Default 'xhs' for
   *  back-compat. 'x' (Twitter) opens x.com + surfaces a VPN reminder for
   *  mainland China users. 'binance' opens binance.com/square. */
  platform?: 'xhs' | 'x' | 'binance';
  /** v4.25.4 Cross-tab scenarios (binance_from_x_repost) need both platforms
   *  open + logged in. Pass the secondary platform here — modal will render
   *  an extra row and gate the "下一步" button until BOTH check pass. */
  secondaryPlatform?: 'xhs' | 'x' | 'binance';
  onCancel: () => void;
  onConfirmed: () => void;
}

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

export const LoginRequiredModal: React.FC<Props> = ({ mode, platform = 'xhs', secondaryPlatform, onCancel, onConfirmed }) => {
  const isZh = i18nService.currentLanguage === 'zh';

  // Per-platform label/url helpers (primary AND secondary use these).
  // VPN reminders below check both primary and secondary so cross-tab
  // scenarios surface the warning if either platform needs a proxy.
  function platformLabelOf(p: 'xhs' | 'x' | 'binance'): string {
    if (p === 'x') return 'Twitter (x.com)';
    if (p === 'binance') return isZh ? '币安广场 (binance.com/square)' : 'Binance Square (binance.com/.../square)';
    return isZh ? '小红书' : 'Xiaohongshu';
  }
  function platformShortOf(p: 'xhs' | 'x' | 'binance'): string {
    if (p === 'x') return 'Twitter';
    if (p === 'binance') return isZh ? '币安广场' : 'Binance Square';
    return isZh ? '小红书' : 'Xiaohongshu';
  }
  function platformUrlOf(p: 'xhs' | 'x' | 'binance'): string {
    if (p === 'x') return 'https://x.com/home';
    if (p === 'binance') return 'https://www.binance.com/square';
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
  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [xhsTabStatus, setXhsTabStatus] = useState<StepStatus>('checking');
  const [secondaryTabStatus, setSecondaryTabStatus] = useState<StepStatus>(secondaryPlatform ? 'checking' : 'pass');
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  // Outdated extension warning — shown inline in step ② when an extension
  // is connected but reports a version below MIN_EXTENSION_VERSION. The
  // floor is bumped each release that ships a behavior-affecting
  // extension change (see chrome-extension/manifest.json version).
  // Both XHS and Twitter pre-run modals run this check.
  // v2.4.63+ bumped to 1.2.9 因为 binance auto_engage / post_creator 必须用
  // chrome-extension 1.2.9 新加的 binance_dom_action 命令(CSP-safe DOM 操作),
  // 老版本会在 binance.com 撞 CSP 报错。XHS / Twitter 不依赖这个,但下限统一
  // 拉到 1.2.9 让用户看到提醒尽快升,避免遇到币安场景才发现要更新。
  const MIN_EXTENSION_VERSION = '1.2.9';
  const [outdatedExts, setOutdatedExts] = useState<Array<{ version: string }>>([]);
  // True when an extension is connected but hasn't reported its version yet
  // AND we're still inside the handshake grace window. The UI shows a
  // yellow "正在握手" label instead of green "已连接" so the user knows the
  // version check hasn't completed yet — and we auto-recheck after the
  // grace expires so the outdated warning surfaces without a manual click.
  const [handshakePending, setHandshakePending] = useState(false);
  // Secondary modal: step-by-step guide for loading the unpacked extension
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [localInstallMsg, setLocalInstallMsg] = useState<string | null>(null);

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
        status.reason === 'tab_not_reachable'
      ) {
        setExtensionStatus('pass');
        setXhsTabStatus('fail');
      } else {
        setExtensionStatus('pass');
        setXhsTabStatus('pass');
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
    } finally {
      setChecking(false);
    }
  }, [platform, secondaryPlatform]);

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
    && (!secondaryPlatform || secondaryTabStatus === 'pass');

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
  const ICON: Record<StepStatus, string> = { pass: '✅', fail: '❌', checking: '⏳', waiting: '⏳' };

  // Shared install/update action block — used by BOTH "extension not
  // connected" (red) and "extension outdated" (yellow) states. Logically
  // they're the same problem (need to install a new build), so the
  // buttons should be identical; only the surrounding header copy differs.
  // Pre-2.4.29 the outdated branch had only Chrome + Edge store links and
  // was missing the "📁 本地安装" path that the not-connected branch had,
  // which left users with locally-developed installs no way to update
  // without knowing chrome://extensions by heart.
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
        <button type="button" onClick={() => {
          setLocalInstallOpen(true);
          setLocalInstallMsg(null);
        }}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-500/10 transition-colors text-left">
          {isZh ? '📁 本地安装' : '📁 Local Install'}
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
          {/* Step 1: 平台 tab —— 不依赖插件,先让用户打开页面。
              v4.25.4: 之前 step ① 的真实状态要等 step ② 装好插件才能查,
              UI 显示"请先安装浏览器插件(步骤②)" — 用户被两步互锁绕晕。
              改成:不论插件状态,这一步都允许用户立刻点 "打开" 按钮 → 浏览器
              开页;插件已连接时再用真检测 (✓/✗);未连接时显示"待插件检测",
              但按钮仍可用,用户可以在装插件之前先把页面打开。 */}
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
                    {isZh ? `① 在浏览器中打开 ${platformLabel} 并登录` : `① Open ${platformLabel} in browser & login`}
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

          {/* Step 1b: 副 tab —— 仅跨 tab scenario(binance_from_x_repost)展示。
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
                    {isZh ? `① 同时打开 ${sLabel} 并登录(跨 tab 任务必需)` : `① Also open ${sLabel} & login (required for cross-tab task)`}
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

          {/* Step 2: Extension — 再检查插件 */}
          <div className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
            extensionStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : extensionStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[extensionStatus]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">{isZh ? '② 安装并连接浏览器插件' : '② Install & connect browser extension'}</div>
              {extensionStatus === 'fail' && (
                <div className="mt-2 space-y-2">
                  <div className="text-xs text-red-500">{isZh ? '插件未连接，请选择安装方式：' : 'Extension not connected. Choose install method:'}</div>
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
              {(isX || isBinance) && (() => {
                // 跨 tab 任务时两个站点合并成一句,免得连出两条 ⚠️ 警告占屏。
                const sites = [
                  isX ? 'x.com' : null,
                  isBinance ? (isZh ? '币安广场 (binance.com/square)' : 'Binance Square (binance.com/.../square)') : null,
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

      {/* Secondary modal: local install step-by-step guide. Clicking
          "📂 打开扩展目录 & chrome://extensions/" runs the main-process
          helper which copies the bundled chrome-extension path to the
          clipboard and opens chrome://extensions in the default browser. */}
      {localInstallOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
            <h3 className="text-lg font-bold dark:text-white mb-4">
              📁 {isZh ? '本地安装浏览器插件' : 'Install Local Extension'}
            </h3>
            <ol className="text-xs text-gray-700 dark:text-gray-300 space-y-2 mb-4 list-decimal list-inside leading-relaxed">
              <li>{isZh ? '点下方 📂 按钮，会自动打开 chrome://extensions/ 并把 NoobClaw 的插件目录复制到剪贴板' : 'Click 📂 below — opens chrome://extensions/ and copies the NoobClaw extension folder path to clipboard'}</li>
              <li>{isZh ? '在浏览器的插件页右上角打开「开发者模式」' : 'Enable "Developer mode" in the top-right of the browser extensions page'}</li>
              <li>{isZh ? '点「加载已解压的扩展程序」，在弹出的文件选择框地址栏粘贴刚才复制的路径回车，然后选中里面的 chrome-extension 文件夹进行加载' : 'Click "Load unpacked", paste the copied path into the file dialog\'s address bar, then select the chrome-extension folder to load it'}</li>
              <li>{isZh ? '回到本页面点「重新检测」，检测到绿色 ✓ 即安装成功' : 'Return here and click "Re-check" — ✓ means success'}</li>
            </ol>
            {localInstallMsg && (
              <div className="text-xs text-green-500 mb-3 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg whitespace-pre-line break-all">
                {localInstallMsg}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const r = await window.electron?.browserBridge?.installLocal?.();
                    if (!r?.success) {
                      setLocalInstallMsg((isZh ? '❌ 操作失败：' : '❌ Failed: ')
                        + (r?.error || (isZh ? '未知错误' : 'unknown error')));
                      return;
                    }
                    // Main/sidecar has already opened chrome://extensions
                    // in the default browser. Renderer must do the actual
                    // clipboard write — electron.clipboard doesn't exist
                    // inside Tauri's sidecar process, so the returned path
                    // is the single source of truth.
                    let copied = false;
                    if (r.extensionPath) {
                      try {
                        await navigator.clipboard.writeText(r.extensionPath);
                        copied = true;
                      } catch {
                        copied = false;
                      }
                    }
                    if (!r.browserFound) {
                      setLocalInstallMsg(isZh
                        ? '⚠️ 未检测到 Chrome/Edge 浏览器，请先安装浏览器。路径：' + (r.extensionPath || '')
                        : '⚠️ No Chrome/Edge detected. Install a browser first. Path: ' + (r.extensionPath || ''));
                      return;
                    }
                    if (copied) {
                      setLocalInstallMsg(isZh
                        ? '✅ 已打开浏览器扩展页，插件目录已复制到剪贴板。粘贴后选中里面的 chrome-extension 文件夹即可。'
                        : '✅ Opened extensions page, extension folder path copied. After pasting, click into the chrome-extension folder and select it.');
                    } else {
                      // Clipboard write failed — give user the path to copy manually
                      setLocalInstallMsg((isZh
                        ? '✅ 已打开扩展页，但剪贴板复制失败。请手动复制下方路径：'
                        : '✅ Opened extensions page, but clipboard write failed. Copy this path manually:')
                        + '\n' + (r.extensionPath || ''));
                    }
                  } catch (e) {
                    setLocalInstallMsg((isZh ? '❌ 调用失败：' : '❌ Call failed: ')
                      + String(e).slice(0, 100));
                  }
                }}
                className="w-full py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 transition-colors"
              >
                📂 {isZh ? '打开扩展目录 & chrome://extensions/' : 'Open extension folder & chrome://extensions/'}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLocalInstallOpen(false)}
                  className="flex-1 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  {isZh ? '关闭' : 'Close'}
                </button>
                <button
                  type="button"
                  onClick={() => { setLocalInstallOpen(false); void runCheck(); }}
                  className="flex-1 py-2 rounded-lg text-sm bg-green-500 text-white hover:bg-green-600"
                >
                  🔄 {isZh ? '我已安装，重新检测' : 'I installed, re-check'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
