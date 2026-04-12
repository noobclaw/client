/**
 * LoginRequiredModal — shown whenever the user tries to run a scenario,
 * save a task, or push a draft but isn't currently logged in to Xiaohongshu.
 *
 * Offers two paths:
 *   1. "在浏览器打开小红书" — asks the main process to open xiaohongshu.com
 *      in a new tab so the user can log in.
 *   2. "我已登录" — re-runs the login probe; if it now succeeds, the modal
 *      closes and invokes the original pending action.
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';
import type { XhsLoginStatus } from '../../types/scenario';

interface Props {
  /** Machine reason from the last failed check (used to pick the hint text). */
  reason?: string;
  /** Cancel closes the modal without doing anything else. */
  onCancel: () => void;
  /** Called with a fresh status when the user clicks "我已登录". If the new
   *  status is loggedIn, the caller should re-run the pending action and
   *  close the modal. */
  onRetry: (status: XhsLoginStatus) => void;
}

function reasonToHint(reason?: string): string {
  switch (reason) {
    case 'browser_not_connected':
      return i18nService.t('scenarioLoginBrowserNotConnected');
    case 'xhs_tab_not_reachable':
      return i18nService.t('scenarioLoginNoXhsTab');
    case 'login_page':
    case 'login_modal':
    case 'sign_in_button':
      return i18nService.t('scenarioLoginNotLoggedIn');
    default:
      return i18nService.t('scenarioLoginRequiredDesc');
  }
}

export const LoginRequiredModal: React.FC<Props> = ({ reason, onCancel, onRetry }) => {
  const [opening, setOpening] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string>(reasonToHint(reason));

  const handleOpenBrowser = async () => {
    setOpening(true);
    try {
      const res = await scenarioService.openXhsLogin();
      if (!res.ok) {
        setMessage(i18nService.t('scenarioLoginBrowserNotConnected'));
      } else {
        setMessage(i18nService.t('scenarioLoginAfterOpenHint'));
      }
    } finally {
      setOpening(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const status = await scenarioService.checkXhsLogin();
      if (!status.loggedIn) {
        setMessage(reasonToHint(status.reason));
      }
      onRetry(status);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-2 text-center">
          <div className="text-5xl mb-3">🔐</div>
          <h3 className="text-xl font-bold dark:text-white mb-2">
            {i18nService.t('scenarioLoginRequiredTitle')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">{message}</p>
        </div>

        <div className="px-6 py-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={handleOpenBrowser}
            disabled={opening}
            className="w-full px-4 py-3 text-sm font-semibold rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
          >
            {opening ? '...' : '🌐 ' + i18nService.t('scenarioLoginOpenBrowser')}
          </button>
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full px-4 py-3 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            {retrying ? i18nService.t('scenarioLoginChecking') : '✅ ' + i18nService.t('scenarioLoginRetryCheck')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={opening || retrying}
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
