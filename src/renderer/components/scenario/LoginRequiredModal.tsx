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

interface Props {
  mode: 'create' | 'run';
  onCancel: () => void;
  onConfirmed: () => void;
}

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

export const LoginRequiredModal: React.FC<Props> = ({ mode, onCancel, onConfirmed }) => {
  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [xhsTabStatus, setXhsTabStatus] = useState<StepStatus>('checking');
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);

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
          <h3 className="text-lg font-bold dark:text-white">运行前检查</h3>
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
              <div className="text-sm font-medium dark:text-white">① 在浏览器中打开小红书并登录</div>
              {xhsTabStatus === 'fail' && (
                <div className="mt-1">
                  <div className="text-xs text-red-500">未检测到小红书页面</div>
                  <button type="button" onClick={handleOpenXhs} disabled={opening}
                    className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50">
                    {opening ? '...' : '🌐 打开小红书'}
                  </button>
                </div>
              )}
              {xhsTabStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已打开</div>
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
              <div className="text-sm font-medium dark:text-white">② 安装并连接浏览器插件</div>
              {extensionStatus === 'fail' && (
                <div className="mt-2 space-y-2">
                  <div className="text-xs text-red-500">插件未连接，请选择安装方式：</div>
                  <div className="flex flex-col gap-1.5">
                    <button type="button" onClick={() => window.open('https://microsoftedge.microsoft.com/addons/search/noobclaw', '_blank')}
                      className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-500 hover:bg-blue-500/10 transition-colors text-left">
                      🔷 安装 Edge 浏览器插件
                    </button>
                    <button type="button" onClick={() => window.open('https://chromewebstore.google.com/search/noobclaw', '_blank')}
                      className="text-xs px-3 py-1.5 rounded-lg border border-green-500/30 text-green-500 hover:bg-green-500/10 transition-colors text-left">
                      🌐 安装 Chrome 浏览器插件
                    </button>
                    <button type="button" onClick={() => {}}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-500/10 transition-colors text-left">
                      📁 本地安装
                    </button>
                  </div>
                  <button type="button" onClick={runCheck} disabled={checking}
                    className="text-xs text-blue-500 hover:underline mt-1">
                    {checking ? '检测中...' : '🔄 重新检测'}
                  </button>
                </div>
              )}
              {extensionStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">已连接</div>
              )}
            </div>
          </div>

          {/* Step 3: Usage notes */}
          <div className={`rounded-xl p-3 border ${
            allReady ? 'border-amber-500/30 bg-amber-500/5' : 'border-gray-200 dark:border-gray-700'
          }`}>
            <div className="text-sm font-medium dark:text-white mb-2">③ 使用须知</div>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1.5 leading-relaxed">
              <li>🤖 所有操作模拟你本人在小红书上的行为</li>
              <li>🌐 运行期间请<strong>不要切换浏览器标签页</strong></li>
              <li>🔐 请<strong>不要退出小红书登录</strong></li>
              <li>⏰ 可以正常使用电脑，保持浏览器打开即可</li>
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
            {mode === 'create' ? '✅ 我已登录，下一步' : '✅ 我已登录小红书，开始'}
          </button>
          <button type="button" onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            取消
          </button>
        </div>
      </div>
    </div>
  );
};
