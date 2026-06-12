import React, { useState, useEffect, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import WindowTitleBar from '../window/WindowTitleBar';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';

interface GlobalHotSearchPageProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

interface HotItem {
  id: string;
  title: string;
  summary?: string;
  url: string;
  rank?: number;
  source: string;
}
interface HotSource { source: string; items: HotItem[]; }

// 每个榜单的视觉标识(emoji + 主题渐变色)。没列到的源走默认。
const SOURCE_STYLE: Record<string, { emoji: string; from: string; to: string; ring: string }> = {
  '微博热搜':   { emoji: '🔥', from: 'from-red-500/20',    to: 'to-orange-500/5',  ring: 'group-hover:border-red-500/50' },
  '知乎热榜':   { emoji: '💭', from: 'from-blue-500/20',   to: 'to-sky-500/5',     ring: 'group-hover:border-blue-500/50' },
  '百度热搜':   { emoji: '🔍', from: 'from-blue-600/20',   to: 'to-indigo-500/5',  ring: 'group-hover:border-indigo-500/50' },
  '抖音热搜':   { emoji: '🎵', from: 'from-fuchsia-500/20', to: 'to-pink-500/5',   ring: 'group-hover:border-fuchsia-500/50' },
  'B站热搜':    { emoji: '📺', from: 'from-pink-400/20',   to: 'to-cyan-400/5',    ring: 'group-hover:border-pink-400/50' },
  '雪球热门股': { emoji: '📈', from: 'from-emerald-500/20', to: 'to-teal-500/5',   ring: 'group-hover:border-emerald-500/50' },
};
const styleOf = (s: string) => SOURCE_STYLE[s] || { emoji: '🌐', from: 'from-gray-500/20', to: 'to-gray-500/5', ring: 'group-hover:border-claude-accent/50' };

// 前三名奖牌色,其余暗灰。
const rankBadge = (rank: number): string => {
  if (rank === 1) return 'bg-gradient-to-br from-yellow-400 to-amber-600 text-white shadow-lg shadow-amber-500/30';
  if (rank === 2) return 'bg-gradient-to-br from-gray-300 to-gray-500 text-white shadow';
  if (rank === 3) return 'bg-gradient-to-br from-amber-600 to-orange-800 text-white shadow';
  return 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary';
};

const GlobalHotSearchPage: React.FC<GlobalHotSearchPageProps> = ({
  isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [sources, setSources] = useState<HotSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const resp = await fetch(`${getBackendApiUrl()}/api/web3/hot-search`);
      if (!resp.ok) throw new Error('http ' + resp.status);
      const json = await resp.json();
      setSources(Array.isArray(json.sources) ? json.sources.filter((s: HotSource) => s.items?.length) : []);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openLink = (url: string) => { if (url) window.electron?.shell?.openExternal?.(url); };
  const title = i18nService.t('globalHotSearch');

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 dark:bg-claude-darkSurface/50 bg-claude-surface/50 draggable" style={{ paddingLeft: isMac ? 80 : undefined }}>
        <div className="non-draggable flex items-center gap-2">
          {isSidebarCollapsed && (
            <>
              <button type="button" onClick={onToggleSidebar} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button type="button" onClick={onNewChat} className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </>
          )}
          <h1 className="text-sm font-semibold dark:text-claude-darkText text-claude-text flex items-center gap-2">
            <span className="text-base">🔥</span> {title}
          </h1>
          <button type="button" onClick={load} disabled={loading}
            className="ml-1 text-[11px] px-2 py-0.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50">
            {loading ? '⟳' : '↻'} {i18nService.t('globalHotSearchRefresh')}
          </button>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto dark:bg-claude-darkBg bg-claude-bg">
        {loading && sources.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="animate-pulse">🔥 {i18nService.t('globalHotSearchLoading')}</span>
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span>😶‍🌫️ {i18nService.t('globalHotSearchError')}</span>
            <button onClick={load} className="px-3 py-1.5 rounded-lg bg-claude-accent text-white text-xs hover:opacity-90">{i18nService.t('globalHotSearchRetry')}</button>
          </div>
        ) : (
          <div className="p-3 sm:p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 auto-rows-min">
            {sources.map((src) => {
              const st = styleOf(src.source);
              return (
                <div key={src.source}
                  className={`group rounded-2xl border dark:border-claude-darkBorder/60 border-claude-border/60 ${st.ring} bg-gradient-to-br ${st.from} ${st.to} dark:bg-claude-darkSurface/40 bg-white/60 backdrop-blur-sm overflow-hidden transition-all hover:shadow-lg`}>
                  {/* 卡片头 */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b dark:border-claude-darkBorder/40 border-claude-border/40">
                    <span className="text-xl">{st.emoji}</span>
                    <span className="text-sm font-bold dark:text-claude-darkText text-claude-text">{src.source}</span>
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full dark:bg-claude-darkBg/60 bg-white/70 dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium">
                      {src.items.length} {i18nService.t('globalHotSearchCount')}
                    </span>
                  </div>
                  {/* 榜单 */}
                  <ol className="px-2 py-2">
                    {src.items.map((it, i) => {
                      const rank = it.rank || (i + 1);
                      return (
                        <li key={it.id}>
                          <button type="button" onClick={() => openLink(it.url)}
                            className="w-full flex items-start gap-2.5 px-2 py-1.5 rounded-lg text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                            <span className={`shrink-0 w-5 h-5 mt-0.5 rounded-md text-[11px] font-bold flex items-center justify-center ${rankBadge(rank)}`}>
                              {rank}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13px] leading-snug dark:text-claude-darkText text-claude-text line-clamp-2 group-hover:text-claude-text dark:group-hover:text-claude-darkText">
                                {it.title}
                              </span>
                              {it.summary && (
                                <span className="block text-[11px] mt-0.5 dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 truncate">
                                  {it.summary}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default GlobalHotSearchPage;
