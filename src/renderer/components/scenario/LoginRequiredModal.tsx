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
  onCancel: () => void;
  onConfirmed: () => void;
}

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

export const LoginRequiredModal: React.FC<Props> = ({ mode, onCancel, onConfirmed }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [xhsTabStatus, setXhsTabStatus] = useState<StepStatus>('checking');
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  // Secondary modal: step-by-step guide for loading the unpacked extension
  const [localInstallOpen, setLocalInstallOpen] = useState(false);
  const [localInstallMsg, setLocalInstallMsg] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await scenarioService.checkXhsLogin();
      if (status.reason === 'browser_not_connected') {
        setExtensionStatus('fail');
        setXhsTabStatus('waiting');
      } else if (status.reason === 'xhs_tab_not_reachable') {
        setExtensionStatus('pass');
        setXhsTabStatus('fail');
      } else {
        setExtensionStatus('pass');
        setXhsTabStatus('pass');
      }
    } catch {
      setExtensionStatus('fail');
      setXhsTabStatus('waiting');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void runCheck(); }, []); // eslint-disable-line

  const handleOpenXhs = async () => {
    setOpening(true);
    try {
      const res = await scenarioService.openXhsLogin();
      if (!res.ok) { try { window.open('https://www.xiaohongshu.com', '_blank'); } catch {} }
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(false);
    }
  };

  const allReady = extensionStatus === 'pass' && xhsTabStatus === 'pass';
  const ICON: Record<StepStatus, string> = { pass: '✅', fail: '❌', checking: '⏳', waiting: '⏳' };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-3 text-center">
          <div className="text-4xl mb-2">🔐</div>
          <h3 className="text-lg font-bold dark:text-white">{isZh ? '运行前检查' : 'Pre-run Check'}</h3>
        </div>

        <div className="px-6 py-3 space-y-3">
          {/* Step 1: XHS tab — 先检查小红书是否打开 */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            xhsTabStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : xhsTabStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[xhsTabStatus]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">{isZh ? '① 在浏览器中打开小红书并登录' : '① Open Xiaohongshu in browser & login'}</div>
              {extensionStatus === 'fail' && (
                <div className="text-xs text-gray-400 mt-1">{isZh ? '请先安装浏览器插件（步骤②）' : 'Install browser extension first (step ②)'}</div>
              )}
              {extensionStatus === 'pass' && xhsTabStatus === 'fail' && (
                <div className="mt-1">
                  <div className="text-xs text-red-500">{isZh ? '未检测到小红书页面' : 'Xiaohongshu page not detected'}</div>
                  <button type="button" onClick={handleOpenXhs} disabled={opening}
                    className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50">
                    {opening ? '...' : (isZh ? '🌐 打开小红书' : '🌐 Open Xiaohongshu')}
                  </button>
                </div>
              )}
              {xhsTabStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">{isZh ? '已打开' : 'Connected'}</div>
              )}
            </div>
          </div>

          {/* Step 2: Extension — 再检查插件 */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
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
                  <div className="flex flex-col gap-1.5">
                    <button type="button" onClick={() => window.open('https://microsoftedge.microsoft.com/addons/search/noobclaw', '_blank')}
                      className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-500 hover:bg-blue-500/10 transition-colors text-left">
                      {isZh ? '🔷 安装 Edge 浏览器插件' : '🔷 Install Edge Extension'}
                    </button>
                    <button type="button" onClick={() => window.open('https://chromewebstore.google.com/detail/noobclaw-browser-assistan/abchfdkiphahgkoalhnmlfpfmgkedigf', '_blank')}
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-500/30 text-green-500 hover:bg-green-500/10 transition-colors text-left">
                      {isZh ? '🌐 安装 Chrome 浏览器插件' : '🌐 Install Chrome Extension'}
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
                </div>
              )}
              {extensionStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">{isZh ? '已连接' : 'Connected'}</div>
              )}
            </div>
          </div>

          {/* Step 3: Usage notes */}
          <div className={`rounded-xl p-3 border ${
            allReady ? 'border-amber-500/30 bg-amber-500/5' : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-sm font-medium dark:text-white mb-2">{isZh ? '③ 使用须知' : '③ Usage Notes'}</div>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1.5 leading-relaxed">
              <li>🤖 {isZh ? '所有操作模拟你本人在小红书上的行为' : 'All actions simulate your own behavior on Xiaohongshu'}</li>
              <li>🌐 {isZh ? <>运行期间请<strong>不要切换浏览器标签页</strong></> : <><strong>Do not switch browser tabs</strong> during a run</>}</li>
              <li>🔐 {isZh ? <>请<strong>不要退出小红书登录</strong></> : <><strong>Do not log out</strong> of Xiaohongshu</>}</li>
              <li>⏰ {isZh ? '可以正常使用电脑，保持浏览器打开即可' : 'You can use your computer normally, just keep the browser open'}</li>
            </ul>
          </div>
        </div>

        {/* Bottom button */}
        <div className="px-6 pb-6 pt-3 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onConfirmed}
            disabled={!allReady}
            className={`w-full max-w-[280px] text-sm font-semibold px-6 py-3 rounded-xl transition-colors ${
              allReady
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {mode === 'create' ? (isZh ? '✅ 我已登录，下一步' : '✅ Logged in, Next') : (isZh ? '✅ 我已登录小红书，开始' : '✅ Logged in, Start')}
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
              <li>{isZh ? '点下方 📂 按钮，会自动打开 chrome://extensions/ 并把插件目录复制到剪贴板' : 'Click 📂 below — opens chrome://extensions/ and copies the extension folder path to clipboard'}</li>
              <li>{isZh ? '在扩展页右上角打开「开发者模式」' : 'Enable "Developer mode" in the top-right'}</li>
              <li>{isZh ? '点「加载已解压的扩展程序」，地址栏粘贴刚才复制的路径回车' : 'Click "Load unpacked" and paste the copied path'}</li>
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
                        ? '✅ 已打开浏览器扩展页，插件目录已复制到剪贴板。按步骤 2-4 操作。'
                        : '✅ Opened extensions page, path copied. Follow steps 2-4.');
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
