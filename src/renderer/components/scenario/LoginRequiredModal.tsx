/**
 * LoginRequiredModal — 3-step guided checker.
 *
 *   ① 浏览器插件是否连接 (auto-check)
 *   ② Chrome 是否打开了小红书 (auto-check)
 *   ③ 用户手动确认已登录 (button click, no auto-detection)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';

interface Props {
  onCancel: () => void;
  /** Called when user confirms all 3 steps are done. */
  onConfirmed: () => void;
}

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

interface CheckResult {
  extension: StepStatus;
  xhsTab: StepStatus;
  userConfirmed: StepStatus;
}

const BROWSER_STORE_KEY = 'noobclaw_preferred_browser';

function getStoredBrowser(): string | null {
  try { return localStorage.getItem(BROWSER_STORE_KEY); } catch { return null; }
}

function setStoredBrowser(b: string) {
  try { localStorage.setItem(BROWSER_STORE_KEY, b); } catch {}
}

export const LoginRequiredModal: React.FC<Props> = ({ onCancel, onConfirmed }) => {
  const [selectedBrowser, setSelectedBrowser] = useState<string | null>(getStoredBrowser());
  const [steps, setSteps] = useState<CheckResult>({
    extension: 'checking',
    xhsTab: 'checking',
    userConfirmed: 'waiting',
  });
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await scenarioService.checkXhsLogin();
      // We only care about extension + tab status, NOT login detection
      if (status.reason === 'browser_not_connected') {
        setSteps({ extension: 'fail', xhsTab: 'checking', userConfirmed: 'waiting' });
      } else if (status.reason === 'xhs_tab_not_reachable') {
        setSteps({ extension: 'pass', xhsTab: 'fail', userConfirmed: 'waiting' });
      } else {
        // Extension connected + XHS tab found (login status doesn't matter)
        setSteps(prev => ({ extension: 'pass', xhsTab: 'pass', userConfirmed: prev.userConfirmed }));
      }
    } catch {
      setSteps({ extension: 'fail', xhsTab: 'checking', userConfirmed: 'waiting' });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenXhs = async () => {
    setOpening(true);
    try {
      const res = await scenarioService.openXhsLogin();
      if (!res.ok) {
        try { window.open('https://www.xiaohongshu.com', '_blank'); } catch {}
      }
      // Re-check after opening
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(false);
    }
  };

  const handleUserConfirm = () => {
    setSteps(prev => ({ ...prev, userConfirmed: 'pass' }));
    // Brief green flash then proceed
    setTimeout(() => onConfirmed(), 300);
  };

  const extensionAndTabReady = steps.extension === 'pass' && steps.xhsTab === 'pass';

  const ICON: Record<StepStatus, string> = {
    pass: '✅',
    fail: '❌',
    checking: '⏳',
    waiting: '⏳',
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-3 text-center">
          <div className="text-4xl mb-2">🔐</div>
          <h3 className="text-lg font-bold dark:text-white">
            {i18nService.t('scenarioLoginRequiredTitle')}
          </h3>
        </div>

        <div className="px-6 py-3 space-y-3">
          {/* Step 0: Browser selection */}
          {!selectedBrowser && (
            <div className="rounded-xl p-4 border border-blue-500/30 bg-blue-500/5">
              <div className="text-sm font-medium dark:text-white mb-3">选择你使用的浏览器</div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => { setSelectedBrowser('chrome'); setStoredBrowser('chrome'); }}
                  className="flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-gray-300 dark:border-gray-700 hover:border-green-500 transition-colors"
                >
                  <span className="text-3xl">🌐</span>
                  <span className="text-sm font-medium dark:text-white">Chrome</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedBrowser('edge'); setStoredBrowser('edge'); }}
                  className="flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-gray-300 dark:border-gray-700 hover:border-blue-500 transition-colors"
                >
                  <span className="text-3xl">🔷</span>
                  <span className="text-sm font-medium dark:text-white">Edge</span>
                </button>
              </div>
            </div>
          )}

          {selectedBrowser && <>
          {/* Step 1: Extension */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.extension === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : steps.extension === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[steps.extension]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">① 安装并连接 {selectedBrowser === 'edge' ? 'Edge' : 'Chrome'} 插件</div>
              {steps.extension === 'fail' && (
                <div className="text-xs text-red-500 mt-1">
                  插件未连接。请在 {selectedBrowser === 'edge' ? 'Edge 外接程序商店' : 'Chrome 应用商店'} 安装 NoobClaw Browser Assistant 插件。
                  <button
                    type="button"
                    onClick={() => {
                      const url = selectedBrowser === 'edge'
                        ? 'https://microsoftedge.microsoft.com/addons/search/noobclaw'
                        : 'https://chromewebstore.google.com/search/noobclaw';
                      try { window.open(url, '_blank'); } catch {}
                    }}
                    className="ml-2 text-blue-500 hover:underline"
                  >
                    去安装 →
                  </button>
                </div>
              )}
              {steps.extension === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已连接</div>
              )}
            </div>
          </div>

          {/* Step 2: XHS tab */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.xhsTab === 'fail' ? 'border-red-500/30 bg-red-500/5'
              : steps.xhsTab === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[steps.xhsTab]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">② 在 {selectedBrowser === 'edge' ? 'Edge' : 'Chrome'} 中打开小红书</div>
              {steps.xhsTab === 'fail' && (
                <>
                  <div className="text-xs text-red-500 mt-1">
                    {i18nService.t('scenarioLoginNoXhsTab')}
                  </div>
                  <button type="button" onClick={handleOpenXhs} disabled={opening}
                    className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50">
                    {opening ? '...' : '🌐 ' + i18nService.t('scenarioLoginOpenBrowser')}
                  </button>
                </>
              )}
              {steps.xhsTab === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已打开</div>
              )}
            </div>
          </div>

          {/* Step 3: User manual confirm */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.userConfirmed === 'pass' ? 'border-green-500/30 bg-green-500/5'
              : extensionAndTabReady ? 'border-amber-500/30 bg-amber-500/5'
              : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{ICON[steps.userConfirmed]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">③ 确认已登录小红书</div>
              {steps.userConfirmed === 'pass' ? (
                <div className="text-xs text-green-500 mt-1">已确认</div>
              ) : extensionAndTabReady ? (
                <>
                  <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    请确保你已在 {selectedBrowser === 'edge' ? 'Edge' : 'Chrome'} 的小红书页面完成登录
                  </div>
                  <button type="button" onClick={handleUserConfirm}
                    className="mt-2 w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors">
                    ✅ 我已登录，开始
                  </button>
                </>
              ) : (
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  请先完成上面两步
                </div>
              )}
            </div>
          </div>
          </>}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex flex-col gap-2">
          {(steps.extension === 'fail' || steps.xhsTab === 'fail') && (
            <button type="button" onClick={runCheck} disabled={checking}
              className="w-full px-4 py-3 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50">
              {checking ? '⏳ 检查中...' : '🔄 重新检查'}
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={checking}
            className="w-full px-4 py-2 text-sm rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            取消
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginRequiredModal;
