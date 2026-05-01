import React, { useEffect, useState, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { clearCurrentSession, setCurrentSession, setStreaming } from '../../store/slices/coworkSlice';
import { clearActiveSkills } from '../../store/slices/skillSlice';
import { setActions, clearSelection } from '../../store/slices/quickActionSlice';
import { coworkService } from '../../services/cowork';
import { skillService } from '../../services/skill';
import { quickActionService } from '../../services/quickAction';
import { i18nService } from '../../services/i18n';
import { noobClawAuth, type AuthState } from '../../services/noobclawAuth';
import { configService } from '../../services/config';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import CoworkSessionDetail from './CoworkSessionDetail';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import TickerMarquee from './TickerMarquee';
import WindowTitleBar from '../window/WindowTitleBar';
import type { SettingsOpenOptions } from '../Settings';
import type { CoworkSession, CoworkImageAttachment } from '../../types/cowork';

export interface CoworkViewProps {
  onRequestAppSettings?: (options?: SettingsOpenOptions) => void;
  onShowSkills?: () => void;
  onShowWallet?: () => void;
  /** v4.31.44: 主页 3 个涨粉标签调用,可选 platform 直跳到对应平台 tab */
  onShowQuickUse?: (platform?: 'xhs' | 'x' | 'binance') => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const CoworkView: React.FC<CoworkViewProps> = ({ onRequestAppSettings, onShowSkills, onShowWallet, onShowQuickUse, isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const [isInitialized, setIsInitialized] = useState(false);
  const [authState, setAuthState] = useState<AuthState>(noobClawAuth.getState());

  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    // Refresh balance on mount to ensure it's up-to-date
    noobClawAuth.refreshBalance().catch(() => {});
    return unsub;
  }, []);
  // Track if we're starting a session to prevent duplicate submissions
  const isStartingRef = useRef(false);
  // Track pending start request so stop can cancel delayed startup.
  const pendingStartRef = useRef<{ requestId: number; cancelled: boolean } | null>(null);
  const startRequestIdRef = useRef(0);
  // Ref for CoworkPromptInput
  const promptInputRef = useRef<CoworkPromptInputRef>(null);

  const {
    currentSession,
    isStreaming,
    config,
  } = useSelector((state: RootState) => state.cowork);

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);




  const buildApiConfigNotice = (error?: string) => {
    const baseNotice = i18nService.t('coworkModelSettingsRequired');
    if (!error) {
      return baseNotice;
    }
    const normalizedError = error.trim();
    if (
      normalizedError.startsWith('No enabled provider found for model:')
      || normalizedError === 'No available model configured in enabled providers.'
    ) {
      return baseNotice;
    }
    return `${baseNotice} (${error})`;
  };

  useEffect(() => {
    const init = async () => {
      await coworkService.init();
      // Load quick actions with localization
      try {
        quickActionService.initialize();
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to load quick actions:', error);
      }
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          const errMsg = apiConfig.error || '';
          // If the error is auth-related, show login wall instead of settings
          if (errMsg.includes('401') || errMsg.includes('Unauthorized') || errMsg.includes('Missing auth token')) {
            window.dispatchEvent(new CustomEvent('noobclaw:need-login'));
          } else {
            onRequestAppSettings?.({
              initialTab: 'model',
              notice: buildApiConfigNotice(apiConfig.error),
            });
          }
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }
      setIsInitialized(true);
    };
    init();

    // Subscribe to language changes to reload quick actions
    const unsubscribe = quickActionService.subscribe(async () => {
      try {
        const actions = await quickActionService.getLocalizedActions();
        dispatch(setActions(actions));
      } catch (error) {
        console.error('Failed to reload quick actions:', error);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [dispatch]);

  // Check if user needs to login (using noobclawAI service but not authenticated)
  const checkNeedLogin = (): boolean => {
    // Already authenticated with NoobClaw — allow
    if (noobClawAuth.getState().isAuthenticated) return false;

    // Check if user has configured and enabled any third-party provider with an API key
    const config = configService.getConfig();
    const providers = config.providers;
    if (providers) {
      const hasValidProvider = Object.entries(providers).some(
        ([key, p]) => key !== 'noobclawAI' && (p as any)?.enabled && (p as any)?.apiKey
      );
      if (hasValidProvider) return false;
    }

    // Neither logged in nor has third-party key — show LoginWall
    window.dispatchEvent(new CustomEvent('noobclaw:need-login'));
    return true;
  };

  const handleStartSession = async (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => {
    // Check login before starting session
    if (checkNeedLogin()) return;

    // Prevent duplicate submissions
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    const requestId = ++startRequestIdRef.current;
    pendingStartRef.current = { requestId, cancelled: false };
    const isPendingStartCancelled = () => {
      const pending = pendingStartRef.current;
      return !pending || pending.requestId !== requestId || pending.cancelled;
    };

    try {
      try {
        const apiConfig = await coworkService.checkApiConfig();
        if (apiConfig && !apiConfig.hasConfig) {
          const errMsg = apiConfig.error || '';
          if (errMsg.includes('401') || errMsg.includes('Unauthorized') || errMsg.includes('Missing auth token')) {
            window.dispatchEvent(new CustomEvent('noobclaw:need-login'));
          } else {
            onRequestAppSettings?.({
              initialTab: 'model',
              notice: buildApiConfigNotice(apiConfig.error),
            });
          }
          isStartingRef.current = false;
          return;
        }
      } catch (error) {
        console.error('Failed to check cowork API config:', error);
      }

      // Create a temporary session with user message to show immediately
      const tempSessionId = `temp-${Date.now()}`;
      const fallbackTitle = prompt.split('\n')[0].slice(0, 50) || i18nService.t('coworkNewSession');
      const now = Date.now();

      // Capture active skill IDs before clearing them
      const sessionSkillIds = [...activeSkillIds];

      const tempSession: CoworkSession = {
        id: tempSessionId,
        title: fallbackTitle,
        claudeSessionId: null,
        status: 'running',
        pinned: false,
        createdAt: now,
        updatedAt: now,
        cwd: config.workingDirectory || '',
        systemPrompt: '',
        executionMode: config.executionMode || 'local',
        activeSkillIds: sessionSkillIds,
        messages: [
          {
            id: `msg-${now}`,
            type: 'user',
            content: prompt,
            timestamp: now,
            metadata: (sessionSkillIds.length > 0 || (imageAttachments && imageAttachments.length > 0))
              ? {
                ...(sessionSkillIds.length > 0 ? { skillIds: sessionSkillIds } : {}),
                ...(imageAttachments && imageAttachments.length > 0 ? { imageAttachments } : {}),
              }
              : undefined,
          },
        ],
      };

      // Immediately show the session detail page with user message
      dispatch(setCurrentSession(tempSession));
      dispatch(setStreaming(true));

      // Clear active skills and quick action selection after starting session
      // so they don't persist to next session
      dispatch(clearActiveSkills());
      dispatch(clearSelection());

      // Combine skill prompt with system prompt
      // If no manual skill selected, use auto-routing prompt
      let effectiveSkillPrompt = skillPrompt;
      if (!skillPrompt) {
        effectiveSkillPrompt = await skillService.getAutoRoutingPrompt() || undefined;
      }
      const combinedSystemPrompt = [effectiveSkillPrompt, config.systemPrompt]
        .filter(p => p?.trim())
        .join('\n\n') || undefined;

      // Start the actual session immediately with fallback title
      const startedSession = await coworkService.startSession({
        prompt,
        title: fallbackTitle,
        cwd: config.workingDirectory || undefined,
        systemPrompt: combinedSystemPrompt,
        activeSkillIds: sessionSkillIds,
        imageAttachments,
      });

      // Generate title in the background and update when ready
      if (startedSession) {
        coworkService.generateSessionTitle(prompt).then(generatedTitle => {
          const betterTitle = generatedTitle?.trim();
          if (betterTitle && betterTitle !== fallbackTitle) {
            coworkService.renameSession(startedSession.id, betterTitle);
          }
        }).catch(error => {
          console.error('Failed to generate cowork session title:', error);
        });
      }

      // Stop immediately if user cancelled while startup request was in flight.
      if (isPendingStartCancelled() && startedSession) {
        await coworkService.stopSession(startedSession.id);
      }
    } finally {
      if (pendingStartRef.current?.requestId === requestId) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  };

  const handleContinueSession = async (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => {
    if (!currentSession) return;

    // Check login before continuing session
    if (checkNeedLogin()) return;

    console.log('[CoworkView] handleContinueSession called', {
      hasImageAttachments: !!imageAttachments,
      imageAttachmentsCount: imageAttachments?.length ?? 0,
      imageAttachmentsNames: imageAttachments?.map(a => a.name),
      imageAttachmentsBase64Lengths: imageAttachments?.map(a => a.base64Data.length),
    });

    // Capture active skill IDs before clearing
    const sessionSkillIds = [...activeSkillIds];

    // Clear active skills after capturing so they don't persist to next message
    if (sessionSkillIds.length > 0) {
      dispatch(clearActiveSkills());
    }

    // Combine skill prompt with system prompt for continuation
    // If no manual skill selected, use auto-routing prompt
    let effectiveSkillPrompt = skillPrompt;
    if (!skillPrompt) {
      effectiveSkillPrompt = await skillService.getAutoRoutingPrompt() || undefined;
    }
    const combinedSystemPrompt = [effectiveSkillPrompt, config.systemPrompt]
      .filter(p => p?.trim())
      .join('\n\n') || undefined;

    await coworkService.continueSession({
      sessionId: currentSession.id,
      prompt,
      systemPrompt: combinedSystemPrompt,
      activeSkillIds: sessionSkillIds.length > 0 ? sessionSkillIds : undefined,
      imageAttachments,
    });
  };

  const handleStopSession = async () => {
    if (!currentSession) return;
    if (currentSession.id.startsWith('temp-') && pendingStartRef.current) {
      pendingStartRef.current.cancelled = true;
    }
    await coworkService.stopSession(currentSession.id);
  };





  useEffect(() => {
    const handleNewSession = () => {
      dispatch(clearCurrentSession());
      dispatch(clearSelection());
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: true },
      }));
    };
    window.addEventListener('cowork:shortcut:new-session', handleNewSession);
    return () => {
      window.removeEventListener('cowork:shortcut:new-session', handleNewSession);
    };
  }, [dispatch]);

  if (!isInitialized) {
    return (
      <div className="flex-1 h-full flex flex-col dark:bg-claude-darkBg bg-claude-bg">
        <div className="draggable flex h-12 items-center justify-end px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <WindowTitleBar inline />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('loading')}
          </div>
        </div>
      </div>
    );
  }

  // When there's a current session, show the session detail view
  if (currentSession) {
    return (
      <>
        <CoworkSessionDetail
          onManageSkills={() => onShowSkills?.()}
          onContinue={handleContinueSession}
          onStop={handleStopSession}
          onNavigateHome={() => dispatch(clearCurrentSession())}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          onNewChat={onNewChat}
          updateBadge={updateBadge}
          onOpenSettings={onRequestAppSettings}
          onShowWallet={onShowWallet}
        />
      </>
    );
  }

  // Format wallet address for display: 0x1234...5678
  const formatWalletAddress = (addr: string) => {
    if (addr.length <= 10) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  // Home view - no current session
  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="non-draggable h-8 flex items-center gap-2">
          {isSidebarCollapsed && (
            <div className={`flex items-center gap-1 mr-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {/* BSC + wallet address + balance */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface">
            <img src="bsc.svg" alt="BSC" className="w-4 h-4" />
            <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">BSC</span>
            {authState.isAuthenticated && authState.walletAddress ? (
              <>
                <span className="text-xs font-mono dark:text-claude-darkText text-claude-text">
                  {formatWalletAddress(authState.walletAddress)}
                </span>
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">|</span>
                <span className={`text-xs font-semibold ${authState.tokenBalance < 1000 ? 'text-red-500' : 'dark:text-claude-darkText text-claude-text'}`}>
                  {i18nService.t('coworkTokenBalance', { n: authState.tokenBalance.toLocaleString() })}
                </span>
                {authState.tokenBalance < 1000 && (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent('noobclaw:show-wallet'))}
                    className="non-draggable px-2 py-0.5 rounded text-xs font-semibold bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 hover:bg-yellow-500/30 transition-colors"
                  >
                    {i18nService.t('coworkLowBalance')}
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => noobClawAuth.openWebsiteLogin()}
                className="px-2 py-0.5 rounded text-xs font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
              >
                {i18nService.t('coworkConnectWallet')}
              </button>
            )}
          </div>
        </div>
        <div className="non-draggable flex items-center gap-1 mr-1">
          <button
            type="button"
            onClick={() => window.electron?.shell?.openExternal('https://noobclaw.com')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Official Website"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9 9 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg>
            {i18nService.t('coworkWebsite')}
          </button>
          <button
            type="button"
            onClick={() => window.electron?.shell?.openExternal('https://x.com/noobclaw_com')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Twitter / X"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            Twitter
          </button>
          <button
            type="button"
            onClick={() => window.electron?.shell?.openExternal('https://t.me/noobclaw')}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            title="Telegram"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
            Telegram
          </button>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Ticker Marquee */}
      <TickerMarquee />
      {/* Main Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-4 py-16 space-y-12">
          {/* Welcome Section */}
          <div className="text-center space-y-5">
            <img src="logo.png" alt="logo" className="w-16 h-16 mx-auto rounded-2xl" />
            <h2 className="text-3xl font-bold tracking-tight dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkWelcome')}
            </h2>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-md mx-auto">
              {i18nService.t('coworkDescription')}
            </p>
          </div>

          {/* v4.31.44: 三个涨粉入口,点击后跳"一键使用"对应平台。
              横排紧凑款 — emoji 包在小色块里,主体是中性卡片,hover 时
              整卡淡染对应主题色 + 微微抬起,信息密度高、视觉重量轻,
              避免占满首屏触发滚动条。 */}
          {onShowQuickUse && (
            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => onShowQuickUse('binance')}
                className="group flex items-center gap-2.5 py-2.5 pl-2.5 pr-3 rounded-xl border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white hover:dark:bg-amber-500/10 hover:bg-amber-50 hover:dark:border-amber-500/40 hover:border-amber-300 hover:shadow-md hover:dark:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-150 cursor-pointer"
              >
                <span className="flex items-center justify-center w-8 h-8 rounded-lg dark:bg-amber-500/15 bg-amber-100 text-base shrink-0 group-hover:scale-105 transition-transform">🔶</span>
                <span className="text-sm font-medium dark:text-gray-100 text-gray-800 group-hover:dark:text-amber-200 group-hover:text-amber-700 transition-colors truncate">{i18nService.t('homeQuickEntryBinance')}</span>
              </button>
              <button
                type="button"
                onClick={() => onShowQuickUse('x')}
                className="group flex items-center gap-2.5 py-2.5 pl-2.5 pr-3 rounded-xl border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white hover:dark:bg-sky-500/10 hover:bg-sky-50 hover:dark:border-sky-500/40 hover:border-sky-300 hover:shadow-md hover:dark:shadow-sky-500/10 hover:-translate-y-0.5 transition-all duration-150 cursor-pointer"
              >
                <span className="flex items-center justify-center w-8 h-8 rounded-lg dark:bg-sky-500/15 bg-sky-100 text-base shrink-0 group-hover:scale-105 transition-transform">🐦</span>
                <span className="text-sm font-medium dark:text-gray-100 text-gray-800 group-hover:dark:text-sky-200 group-hover:text-sky-700 transition-colors truncate">{i18nService.t('homeQuickEntryX')}</span>
              </button>
              <button
                type="button"
                onClick={() => onShowQuickUse('xhs')}
                className="group flex items-center gap-2.5 py-2.5 pl-2.5 pr-3 rounded-xl border dark:border-white/10 border-gray-200/80 dark:bg-white/[0.03] bg-white hover:dark:bg-rose-500/10 hover:bg-rose-50 hover:dark:border-rose-500/40 hover:border-rose-300 hover:shadow-md hover:dark:shadow-rose-500/10 hover:-translate-y-0.5 transition-all duration-150 cursor-pointer"
              >
                <span className="flex items-center justify-center w-8 h-8 rounded-lg dark:bg-rose-500/15 bg-rose-100 text-base shrink-0 group-hover:scale-105 transition-transform">📕</span>
                <span className="text-sm font-medium dark:text-gray-100 text-gray-800 group-hover:dark:text-rose-200 group-hover:text-rose-700 transition-colors truncate">{i18nService.t('homeQuickEntryXhs')}</span>
              </button>
            </div>
          )}

          {/* Prompt Input Area - Large version with folder selector */}
          <div className="space-y-3">
            <div className="shadow-glow-accent rounded-2xl p-[2px]">
              <CoworkPromptInput
                ref={promptInputRef}
                onSubmit={handleStartSession}
                onStop={handleStopSession}
                isStreaming={isStreaming}
                placeholder={i18nService.t('coworkPlaceholder')}
                size="large"
                workingDirectory={config.workingDirectory}
                onWorkingDirectoryChange={async (dir: string) => {
                  await coworkService.updateConfig({ workingDirectory: dir });
                }}
                showFolderSelector={true}
                onManageSkills={() => onShowSkills?.()}
              />
            </div>
          </div>

          {/* Security Badge */}
          <div className="flex justify-center">
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.electron?.shell?.openExternal?.('https://github.com/noobclaw/client'); }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full dark:bg-emerald-500/10 bg-emerald-50 border dark:border-emerald-500/20 border-emerald-200 hover:opacity-80 transition-opacity cursor-pointer"
            >
              <span className="text-base">{'\uD83D\uDEE1\uFE0F'}</span>
              <span className="text-xs dark:text-emerald-400 text-emerald-600 font-medium">
                {i18nService.t('coworkOpenSource')}
              </span>
              <svg className="w-3 h-3 dark:text-emerald-400 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CoworkView;
