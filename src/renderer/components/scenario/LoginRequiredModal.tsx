/**
 * LoginRequiredModal — 3-step guided checker shown before any scenario action.
 *
 * Steps:
 *   ① 浏览器插件是否连接
 *   ② Chrome 是否打开了小红书
 *   ③ 小红书是否已登录
 *
 * Each step shows a ✅ or ❌ with a specific action button for the first
 * failing step. The user can click "重新检查" at any time to re-run all
 * three checks. When all three pass, the modal auto-closes and triggers
 * the pending action.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';
import type { XhsLoginStatus } from '../../types/scenario';

interface Props {
  reason?: string;
  onCancel: () => void;
  onRetry: (status: XhsLoginStatus) => void;
}

type StepStatus = 'pass' | 'fail' | 'checking';

interface CheckResult {
  extension: StepStatus;
  xhsTab: StepStatus;
  loggedIn: StepStatus;
  raw?: XhsLoginStatus;
}

function deriveSteps(reason?: string): CheckResult {
  if (!reason) return { extension: 'checking', xhsTab: 'checking', loggedIn: 'checking' };

  switch (reason) {
    case 'browser_not_connected':
      return { extension: 'fail', xhsTab: 'checking', loggedIn: 'checking' };
    case 'xhs_tab_not_reachable':
      return { extension: 'pass', xhsTab: 'fail', loggedIn: 'checking' };
    case 'login_page':
    case 'login_modal':
    case 'sign_in_button':
    case 'no_response':
    case 'probe_error':
      return { extension: 'pass', xhsTab: 'pass', loggedIn: 'fail' };
    default:
      return { extension: 'fail', xhsTab: 'checking', loggedIn: 'checking' };
  }
}

const STEP_ICON: Record<StepStatus, string> = {
  pass: '✅',
  fail: '❌',
  checking: '⏳',
};

export const LoginRequiredModal: React.FC<Props> = ({ reason, onCancel, onRetry }) => {
  const [steps, setSteps] = useState<CheckResult>(() => deriveSteps(reason));
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);

  // Determine which step is the first failure
  const firstFail: 'extension' | 'xhsTab' | 'loggedIn' | null =
    steps.extension === 'fail' ? 'extension' :
    steps.xhsTab === 'fail' ? 'xhsTab' :
    steps.loggedIn === 'fail' ? 'loggedIn' :
    null;

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await scenarioService.checkXhsLogin();
      const derived = deriveSteps(status.loggedIn ? undefined : status.reason);
      if (status.loggedIn) {
        derived.extension = 'pass';
        derived.xhsTab = 'pass';
        derived.loggedIn = 'pass';
      }
      setSteps({ ...derived, raw: status });

      if (status.loggedIn) {
        // All good — auto-close after a brief green flash
        setTimeout(() => onRetry(status), 400);
      }
    } finally {
      setChecking(false);
    }
  }, [onRetry]);

  // Auto-check on mount
  useEffect(() => {
    void runCheck();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenXhs = async () => {
    setOpening(true);
    try {
      const res = await scenarioService.openXhsLogin();
      if (!res.ok) {
        // Extension tab_create failed — fall back to opening in system browser
        try {
          window.open('https://www.xiaohongshu.com', '_blank');
        } catch {
          // Last resort: copy URL
          try { navigator.clipboard.writeText('https://www.xiaohongshu.com'); } catch {}
        }
      }
    } finally {
      setOpening(false);
    }
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

        {/* 3-step checklist */}
        <div className="px-6 py-3 space-y-3">
          {/* Step 1: Extension */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.extension === 'fail'
              ? 'border-red-500/30 bg-red-500/5'
              : steps.extension === 'pass'
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{STEP_ICON[steps.extension]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">① 安装并连接浏览器插件</div>
              {steps.extension === 'fail' && (
                <div className="text-xs text-red-500 mt-1">
                  {i18nService.t('scenarioLoginBrowserNotConnected')}
                </div>
              )}
              {steps.extension === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已连接</div>
              )}
            </div>
          </div>

          {/* Step 2: XHS tab */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.xhsTab === 'fail'
              ? 'border-red-500/30 bg-red-500/5'
              : steps.xhsTab === 'pass'
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{STEP_ICON[steps.xhsTab]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">② 在 Chrome 中打开小红书</div>
              {steps.xhsTab === 'fail' && (
                <>
                  <div className="text-xs text-red-500 mt-1">
                    {i18nService.t('scenarioLoginNoXhsTab')}
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenXhs}
                    disabled={opening}
                    className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                  >
                    {opening ? '...' : '🌐 ' + i18nService.t('scenarioLoginOpenBrowser')}
                  </button>
                </>
              )}
              {steps.xhsTab === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已打开</div>
              )}
            </div>
          </div>

          {/* Step 3: Logged in */}
          <div className={`flex items-start gap-3 rounded-xl p-3 border ${
            steps.loggedIn === 'fail'
              ? 'border-red-500/30 bg-red-500/5'
              : steps.loggedIn === 'pass'
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-xl shrink-0 mt-0.5">{STEP_ICON[steps.loggedIn]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white">③ 登录小红书账号</div>
              {steps.loggedIn === 'fail' && (
                <div className="text-xs text-red-500 mt-1">
                  {i18nService.t('scenarioLoginNotLoggedIn')}
                </div>
              )}
              {steps.loggedIn === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已登录</div>
              )}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="px-6 py-4 flex flex-col gap-2">
          {firstFail && (
            <button
              type="button"
              onClick={runCheck}
              disabled={checking}
              className="w-full px-4 py-3 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
            >
              {checking ? '⏳ 检查中...' : '🔄 重新检查'}
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={checking}
            className="w-full px-4 py-2 text-sm rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {i18nService.t('scenarioWizardCancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginRequiredModal;
