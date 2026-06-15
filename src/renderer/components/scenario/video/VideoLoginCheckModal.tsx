/**
 * VideoLoginCheckModal — 视频任务【创建/保存前】的多平台登录校验。
 *
 * 跟 LoginRequiredModal 的区别:那个是单主平台(+可选 1 副平台)的「运行前检查」;
 * 视频发布是【N 选平台】(9 选若干),所以这里对【用户勾选的每个平台】各渲染一行,
 * 逐个显示登录态 + 各自「打开登录」按钮。
 *
 * 决策①(用户要求):必须【所有勾选平台都登录】才能保存 —— allReady 没全绿,底部
 * 「保存任务」按钮一直置灰(对齐币安任务 allReady gate 的严格度)。
 *
 * 检测复用现成 IPC(scenarioService):
 *   · 有创作者中心的(抖音/小红书/快手/B站)→ checkCreatorCenter(更准,能判断停在登录页)
 *   · 其余(TikTok/币安/推特/视频号/头条号)→ checkXhsLogin(主站/后台 tab 存在即视为登录)
 * 打开登录同理:有 creator 的 openCreatorCenter,其余 openXhsLogin。
 *
 * 3s 自动轮询,用户在打开的窗口里扫码 / 登录后无需手点「重新检测」就会自动转绿。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { scenarioService } from '../../../services/scenario';
import { i18nService } from '../../../services/i18n';

type StepStatus = 'pass' | 'fail' | 'checking' | 'waiting';

/** 视频可发布平台的展示元信息 + 登录入口。renderer 本地一份(不跨进程 import main)。 */
const PLATFORM_META: Record<string, { zh: string; en: string; emoji: string; url: string; creator: boolean }> = {
  douyin:    { zh: '抖音',     en: 'Douyin',    emoji: '🎵', url: 'https://creator.douyin.com/',                                    creator: true  },
  xhs:       { zh: '小红书',   en: 'Xiaohongshu', emoji: '📕', url: 'https://creator.xiaohongshu.com/',                            creator: true  },
  kuaishou:  { zh: '快手',     en: 'Kuaishou',  emoji: '⚡', url: 'https://cp.kuaishou.com/article/publish/video',                 creator: true  },
  bilibili:  { zh: 'B 站',     en: 'Bilibili',  emoji: '📺', url: 'https://member.bilibili.com/platform/upload/video/frame',      creator: true  },
  tiktok:    { zh: 'TikTok',   en: 'TikTok',    emoji: '🎬', url: 'https://www.tiktok.com/tiktokstudio/upload',                    creator: false },
  binance:   { zh: '币安广场', en: 'Binance',   emoji: '🟡', url: 'https://www.binance.com/square',                                creator: false },
  x:         { zh: '推特',     en: 'X',         emoji: '🐦', url: 'https://x.com/home',                                            creator: false },
  shipinhao: { zh: '视频号',   en: 'Channels',  emoji: '🟢', url: 'https://channels.weixin.qq.com/platform/post/create',          creator: false },
  toutiao:   { zh: '头条号',   en: 'Toutiao',   emoji: '🟠', url: 'https://mp.toutiao.com/',                                       creator: false },
};

function metaOf(id: string) {
  return PLATFORM_META[id] || { zh: id, en: id, emoji: '🌐', url: '', creator: false };
}

/** 「主站模式」(取素材)用的主站 URL —— 抖音/TikTok 取材只需主站登录,不进创作者中心。 */
const MAIN_SITE_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/',
};

interface Props {
  /** 用户在向导里勾选的发布平台 id 列表。 */
  platforms: string[];
  onCancel: () => void;
  /** 全部平台登录通过、用户点「保存任务」时回调(向导据此真正提交保存)。 */
  onConfirmed: () => void;
  /**
   * 这些 id 用【主站登录】校验(checkXhsLogin/主站 URL),即使它在 PLATFORM_META 里是
   * 创作者中心平台(如抖音)。用于「取素材」场景:抖音混剪/图文只需主站登录,不需创作者中心。
   * 默认空 = 全按 PLATFORM_META.creator 走(发布场景不变)。
   */
  mainSiteOverride?: string[];
  /** 自定义标题/副标题(默认是「发布平台登录校验」;取素材场景可传更贴切的文案)。 */
  title?: string;
  subtitle?: string;
}

export const VideoLoginCheckModal: React.FC<Props> = ({ platforms, onCancel, onConfirmed, mainSiteOverride, title, subtitle }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const list = (platforms || []).filter((p) => !!PLATFORM_META[p]);
  const override = mainSiteOverride || [];
  /** 这个 id 这次是否按创作者中心校验(主站 override 命中则否)。 */
  const useCreatorFor = (id: string) => metaOf(id).creator && !override.includes(id);

  const [extensionStatus, setExtensionStatus] = useState<StepStatus>('checking');
  const [platformStatus, setPlatformStatus] = useState<Record<string, StepStatus>>(
    () => Object.fromEntries(list.map((p) => [p, 'checking' as StepStatus])),
  );
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const checkOne = useCallback(async (id: string) => {
    const useCreator = metaOf(id).creator && !override.includes(id);
    try {
      const st = useCreator
        ? await scenarioService.checkCreatorCenter(id as any)
        : await scenarioService.checkXhsLogin(id as any);
      return { id, st };
    } catch {
      return { id, st: { loggedIn: false, reason: 'check_threw' } as { loggedIn: boolean; reason?: string } };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override.join(',')]);

  const runCheck = useCallback(async (useCookie = false) => {
    if (list.length === 0) { setExtensionStatus('pass'); return; }
    setChecking(true);
    try {
      // 多平台 cookie 批量快路径(仅首次/手动 useCookie=true):一次 CDP attach 把所有勾选平台的
      //   cookie 全读出来、按【域名+名】逐平台判(抖音/TikTok 同名 sessionid 靠域名区分,不串台)。
      //   命中的平台直接判已登录;没命中/没配的再走老 tab 校验。不放进 3s 轮询(避免反复闪 CDP 横幅)。
      let cookiePass: Record<string, boolean | null> = {};
      if (useCookie) {
        const items = list.map((id) => ({
          platform: id,
          which: (metaOf(id).creator && !override.includes(id)) ? ('creator' as const) : ('main' as const),
        }));
        cookiePass = await scenarioService.checkVideoLoginByCookieBatch(items);
      }
      // 并行探所有平台(每个走 tab_list,串行会很慢)。cookie 已判已登录的跳过 tab 校验。
      // 任一返回 browser_not_connected → 扩展没连上,统一把那些平台标 waiting。
      const results = await Promise.all(list.map((p) =>
        cookiePass[p] === true
          ? Promise.resolve({ id: p, st: { loggedIn: true } as { loggedIn: boolean; reason?: string } })
          : checkOne(p),
      ));
      let extConnected = true;
      const next: Record<string, StepStatus> = {};
      for (const { id, st } of results) {
        if (st.reason === 'browser_not_connected') {
          extConnected = false;
          next[id] = 'waiting';
        } else if (st.loggedIn) {
          next[id] = 'pass';
        } else {
          next[id] = 'fail';
        }
      }
      setExtensionStatus(extConnected ? 'pass' : 'fail');
      setPlatformStatus(next);
    } finally {
      setChecking(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, checkOne, override.join(',')]);

  useEffect(() => { void runCheck(true); }, []); // eslint-disable-line  首次走 cookie 快路径(不依赖页面开着)

  // 3s 自动轮询:用户开浏览器 / 登录后自动转绿,无需手点重新检测。【不带 cookie】避免反复闪 CDP 横幅。
  useEffect(() => {
    const h = setInterval(() => { void runCheck(false); }, 3000);
    return () => clearInterval(h);
  }, [runCheck]);

  const handleOpen = async (id: string) => {
    const m = metaOf(id);
    const useCreator = useCreatorFor(id);
    setOpening(id);
    try {
      const res = useCreator
        ? await scenarioService.openCreatorCenter(id as any)
        : await scenarioService.openXhsLogin(id as any);
      if (!res.ok) {
        // race 修复(同 LoginRequiredModal):扩展开 tab 可能比 3s timeout 慢,先 probe
        // 一次,已经开了就别再 window.open 双开。
        await new Promise((r) => setTimeout(r, 1500));
        const probe = useCreator
          ? await scenarioService.checkCreatorCenter(id as any)
          : await scenarioService.checkXhsLogin(id as any);
        if (!probe.loggedIn) {
          const fallbackUrl = useCreator ? m.url : (MAIN_SITE_URL[id] || m.url);
          try { window.open(fallbackUrl, '_blank'); } catch { /* ignore */ }
        }
      }
      setTimeout(() => void runCheck(), 2000);
    } finally {
      setOpening(null);
    }
  };

  const allReady = extensionStatus === 'pass' && list.length > 0
    && list.every((p) => platformStatus[p] === 'pass');

  const ICON: Record<StepStatus, string> = { pass: '✅', fail: '❌', checking: '⏳', waiting: '⏳' };

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
      <button type="button" onClick={() => { void runCheck(true); }} disabled={checking}
        className="text-xs text-blue-500 hover:underline mt-1">
        {checking ? (isZh ? '检测中...' : 'Checking...') : (isZh ? '🔄 重新检测' : '🔄 Re-check')}
      </button>
    </>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
        <div className="px-6 pt-5 pb-2 text-center shrink-0">
          <div className="text-3xl mb-1">🔐</div>
          <h3 className="text-lg font-bold dark:text-white">{title || (isZh ? '发布平台登录校验' : 'Publish Platform Login Check')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {subtitle || (isZh ? '保存前需确认每个发布平台都已登录(全部登录才能保存)' : 'All selected platforms must be logged in before saving')}
          </p>
        </div>

        <div className="px-6 py-2 space-y-2.5 overflow-y-auto flex-1">
          {/* Step 1: 浏览器插件 —— 所有 tab 检测的依赖根节点 */}
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
                  <div className="text-xs text-red-500">{isZh ? '插件未连接，请打开浏览器，如尚未安装，点击下方选项进行安装：' : 'Extension not connected. Open your browser; if not installed, click below:'}</div>
                  {installActionButtons}
                </div>
              )}
              {extensionStatus === 'pass' && (
                <div className="text-xs text-green-500 mt-1">{isZh ? '已连接' : 'Connected'}</div>
              )}
            </div>
          </div>

          {/* Step 2: 逐个勾选平台 —— 一平台一行,各自登录态 + 打开登录按钮 */}
          <div className="text-sm font-medium dark:text-white px-1 pt-1">
            {isZh ? `② 登录所选 ${list.length} 个发布平台` : `② Log in to ${list.length} selected platform(s)`}
          </div>
          {/* 平台多(常 8 个)→ 两列排,省竖向空间 */}
          <div className="grid grid-cols-2 gap-2">
          {list.map((id) => {
            const m = metaOf(id);
            const raw = platformStatus[id] || 'checking';
            const realPass = extensionStatus === 'pass' && raw === 'pass';
            const realFail = extensionStatus === 'pass' && raw === 'fail';
            const visualStatus: StepStatus = realPass ? 'pass' : (realFail ? 'fail' : 'checking');
            const label = `${m.emoji} ${isZh ? m.zh : m.en}${useCreatorFor(id) ? (isZh ? '(创作中心)' : ' (Creator)') : ''}`;
            return (
              <div key={id} className={`flex items-start gap-3 rounded-xl px-3 py-2.5 border ${
                visualStatus === 'fail' ? 'border-red-500/30 bg-red-500/5'
                  : visualStatus === 'pass' ? 'border-green-500/30 bg-green-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                <div className="text-xl shrink-0 mt-0.5">{ICON[visualStatus]}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium dark:text-white">{label}</div>
                  {realPass && (
                    <div className="text-xs text-green-500 mt-1">{isZh ? '已登录' : 'Logged in'}</div>
                  )}
                  {realFail && (
                    <div className="text-xs text-red-500 mt-1">
                      {isZh ? '未登录(未打开,或停在登录页)' : 'Not logged in (tab missing or on login page)'}
                    </div>
                  )}
                  {!realPass && extensionStatus !== 'pass' && (
                    <div className="text-xs text-gray-400 mt-1">
                      {isZh ? '装好插件后这里会自动确认' : 'Auto-verifies once extension is connected'}
                    </div>
                  )}
                  {!realPass && (
                    <button type="button" onClick={() => handleOpen(id)} disabled={opening === id}
                      className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50">
                      {opening === id ? '...' : (isZh ? `🌐 打开 ${m.zh} 登录` : `🌐 Open ${m.en} login`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </div>

          {/* Step 3: 使用须知 */}
          <div className="rounded-xl p-3 border border-gray-200 dark:border-gray-700">
            <div className="text-sm font-medium dark:text-white mb-2">{isZh ? '③ 使用须知' : '③ Usage Notes'}</div>
            <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1.5 leading-relaxed">
              <li>🚀 {isZh ? '发布时所有平台会在【同一个窗口】依次上传(不会每平台开一个窗口)' : 'All platforms upload one-by-one in a single window'}</li>
              <li>🔐 {isZh ? <>运行期间请<strong>不要退出任一平台登录</strong></> : <><strong>Do not log out</strong> of any platform during a run</>}</li>
              <li>⏰ {isZh ? '某平台运行时未登录会等待 3 分钟,超时则跳过该平台(本条视频不再补传)' : 'A platform not logged in at run time waits 3 min, then is skipped for this video'}</li>
            </ul>
          </div>
        </div>

        {/* Bottom button — allReady 才能保存(决策①:必须全登录) */}
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
            {allReady
              ? (isZh ? '✅ 全部已登录，保存任务' : '✅ All logged in, Save')
              : (isZh ? '请先登录全部平台' : 'Log in to all platforms first')}
          </button>
          <button type="button" onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            {isZh ? '返回' : 'Back'}
          </button>
        </div>
      </div>
    </div>
  );
};
