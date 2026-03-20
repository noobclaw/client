import React from 'react';
import { noobClawAuth } from '../services/noobclawAuth';
import { i18nService } from '../services/i18n';

interface LoginWallProps {
  onDismiss?: () => void;
  onSwitchToCustomApi?: () => void;
}

export const LoginWall: React.FC<LoginWallProps> = ({ onDismiss, onSwitchToCustomApi }) => {
  const handleSkipLogin = () => {
    // Open third-party API key configuration — don't change useNoobClawServer yet,
    // it will be set to false when the user actually configures and enables a provider.
    onSwitchToCustomApi?.();
    onDismiss?.();
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 p-8 rounded-2xl border border-green-500/30 dark:bg-[#12121a] bg-white shadow-2xl text-center">
        {/* Logo */}
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl overflow-hidden">
          <img src="logo.png" alt="NoobClaw" className="w-full h-full object-cover" />
        </div>

        <h2 className="text-xl font-bold dark:text-white text-gray-900 mb-2">
          {i18nService.t('loginWallTitle')}
        </h2>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-1 leading-relaxed">
          {i18nService.t('loginWallDescOpenSource')}
          <span
            className="text-blue-400 hover:text-blue-300 cursor-pointer font-medium"
            onClick={() => window.electron?.shell?.openExternal?.('https://github.com/noobclaw')}
          >
            {i18nService.t('loginWallViewSource')}
          </span>
        </p>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-6 leading-relaxed">
          {i18nService.t('loginWallDescBefore')}<span className="text-green-400 font-medium">{i18nService.t('loginWallDescHighlight')}</span>{i18nService.t('loginWallDescAfter')}<span className="text-yellow-400 font-medium">{i18nService.t('loginWallDescHighlight2')}</span>
        </p>

        <button
          onClick={() => noobClawAuth.openWebsiteLogin()}
          className="w-full py-3 rounded-xl bg-green-500/20 border border-green-500/40 text-green-400 font-semibold hover:bg-green-500/30 transition-all mb-3"
        >
          {i18nService.t('loginWallConnectBtn')}
        </button>

        <p className="text-xs dark:text-gray-500 text-gray-400 leading-relaxed mb-4">
          {i18nService.t('loginWallSupports')}<br />
          {i18nService.t('loginWallNoGas')}
        </p>

        <div className="border-t dark:border-gray-700 border-gray-200 pt-4">
          <button
            onClick={handleSkipLogin}
            className="w-full py-2.5 rounded-xl dark:bg-gray-800 bg-gray-100 dark:text-gray-300 text-gray-600 text-sm font-medium dark:hover:bg-gray-700 hover:bg-gray-200 transition-all"
          >
            {i18nService.t('loginWallSkipBtn')}
          </button>
          <p className="text-[10px] dark:text-gray-600 text-gray-400 mt-2">
            {i18nService.t('loginWallSkipDesc')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginWall;
