import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import { SkillsView } from './components/skills';
import { ScheduledTasksView } from './components/scheduledTasks';
import { Web3View } from './components/web3/Web3View';
import Web3NewsPage from './components/web3/Web3NewsPage';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import { configService } from './services/config';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { scheduledTaskService } from './services/scheduledTask';
import { checkForAppUpdate, type AppUpdateInfo, type AppUpdateDownloadProgress, UPDATE_POLL_INTERVAL_MS, UPDATE_HEARTBEAT_INTERVAL_MS } from './services/appUpdate';
import { defaultConfig } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import type { ApiConfig } from './services/api';
import type { CoworkPermissionResult } from './types/cowork';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateModal from './components/update/AppUpdateModal';
import { WalletView } from './components/wallet/WalletView';
import { InviteView } from './components/invite/InviteView';
import { ScenarioView } from './components/scenario/ScenarioView';
import PartnersView from './components/partners/PartnersView';
import PersonalityView from './components/personality/PersonalityView';
import LoginWall from './components/LoginWall';
import TokenInsufficientDialog from './components/TokenInsufficientDialog';
import { noobClawAuth } from './services/noobclawAuth';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'skills' | 'scheduledTasks' | 'mcp' | 'wallet' | 'invite' | 'quickuse' | 'web3news' | 'partners' | 'personality'>('cowork');
  // v4.31.44: 主页 3 个涨粉标签可以指定打开"一键使用"时初选哪个平台
  const [quickUseInitialPlatform, setQuickUseInitialPlatform] = useState<'xhs' | 'x' | 'binance' | undefined>(undefined);
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateModalState, setUpdateModalState] = useState<'info' | 'downloading' | 'installing' | 'error'>('info');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [authState, setAuthState] = useState(noobClawAuth.getState());
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [showLoginWall, setShowLoginWall] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const pendingPermission = pendingPermissions[0] ?? null;
  const isWindows = window.electron.platform === 'win32';

  // Initialize application
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        // Mark platform for CSS conditional styles (e.g. Windows title bar button area padding)
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // Initialize configuration
        await configService.init();
        
        // Initialize theme
        themeService.initialize();

        // Initialize language
        await i18nService.initialize();
        
        const config = await configService.getConfig();
        
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // Load available models from providers config into Redux
        const useNoobClawServer = config.app?.useNoobClawServer !== false;
        let resolvedModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[];

        if (useNoobClawServer) {
          // v4.31.28: 砍掉 reasoner 选项,后端两路都走 v4-flash,UI 只暴露一个 chat。
          resolvedModels = [
            { id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' },
          ];
        } else {
          // Custom API Key mode: load models from enabled third-party providers (skip NoobClaw own services)
          const providerModels: typeof resolvedModels = [];
          if (config.providers) {
            Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
              if (providerName === 'noobclawAI' || providerName === 'noobclawzhiyun') return;
              if (providerConfig.enabled && providerConfig.models) {
                providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
                  providerModels.push({
                    id: model.id,
                    name: model.name,
                    provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
                    providerKey: providerName,
                    supportsImage: model.supportsImage ?? false,
                  });
                });
              }
            });
          }
          const fallbackModels = config.model.availableModels.map(model => ({
            id: model.id,
            name: model.name,
            providerKey: undefined,
            supportsImage: model.supportsImage ?? false,
          }));
          resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        }

        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          // v4.31.28: reasoner 砍掉了,老用户存的 noobclawai-reasoner / deepseek-reasoner
          // 也要回落到 chat。
          let defaultModelId = config.model.defaultModel;
          if (
            defaultModelId === 'deepseek-chat'
            || defaultModelId === 'deepseek-reasoner'
            || defaultModelId === 'noobclawai-reasoner'
          ) {
            defaultModelId = 'noobclawai-chat';
          }
          const preferredModel = resolvedModels.find(
            model => model.id === defaultModelId
              && (!config.model.defaultModelProvider || model.providerKey === config.model.defaultModelProvider)
          ) ?? resolvedModels.find(m => m.id === 'noobclawai-chat') ?? resolvedModels[0];
          dispatch(setSelectedModel(preferredModel));
        }
        
        // Initialize scheduled task service
        await scheduledTaskService.init();

        // Initialize cowork service early so SSE listeners (including
        // noobclaw:sse-payload for lucky bag / balance update) are registered
        // as soon as possible, not only when the user first opens CoworkView.
        // Without this, lucky bag events broadcast before the user navigates
        // to cowork would be silently dropped.
        void coworkService.init().catch((err) => {
          console.error('[App] coworkService.init failed:', err);
        });

        setIsInitialized(true);

        // No longer automatically showing LoginWall at startup; users can browse freely
        // LoginWall only appears when the user tries to send a message
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Renderer] Network online');
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      console.log('[Renderer] Network offline');
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    if (
      config.model.defaultModel === selectedModel.id
      && (config.model.defaultModelProvider ?? '') === (selectedModel.providerKey ?? '')
    ) {
      return;
    }
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
        defaultModelProvider: selectedModel.providerKey,
      },
    });
  }, [isInitialized, selectedModel?.id, selectedModel?.providerKey]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowSkills = useCallback(() => {
    setMainView('skills');
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowMcp = useCallback(() => {
    setMainView('mcp');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    // New chat no longer shows LoginWall; login check happens when user sends a message
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    coworkService.clearSession();
    dispatch(clearSelection());
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: shouldClearInput },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const handleShowLogin = useCallback(() => {
    noobClawAuth.openWebsiteLogin();
  }, []);

  const runUpdateCheck = useCallback(async () => {
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      const nextUpdate = await checkForAppUpdate(currentVersion);
      setUpdateInfo(nextUpdate);
      if (!nextUpdate) {
        setShowUpdateModal(false);
      }
    } catch (error) {
      console.error('Failed to check app update:', error);
      setUpdateInfo(null);
      setShowUpdateModal(false);
    }
  }, []);

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, [updateInfo]);

  const handleUpdateFound = useCallback((info: AppUpdateInfo) => {
    setUpdateInfo(info);
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, []);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    // Tauri always delegates updates to the OS browser — the user
    // downloads the new installer and runs it manually, exactly like the
    // first install. No in-app downloader, no binary replacement, no
    // updater plugin. Fall into the same code path as the Electron
    // fallback page branch below.
    const isTauri = !!(window as any).__TAURI__;

    // If the URL is a fallback page (not a direct file download), open in browser
    if (isTauri || updateInfo.url.includes('#') || updateInfo.url.endsWith('/download-list')) {
      setShowUpdateModal(false);
      try {
        const result = await window.electron.shell.openExternal(updateInfo.url);
        if (!result.success) {
          showToast(i18nService.t('updateOpenFailed'));
        }
      } catch (error) {
        console.error('Failed to open update url:', error);
        showToast(i18nService.t('updateOpenFailed'));
      }
      return;
    }

    setUpdateModalState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const downloadResult = await window.electron.appUpdate.download(updateInfo.url);
      unsubscribe();

      if (!downloadResult.success) {
        // If user cancelled, handleCancelDownload already set the state — don't overwrite
        if (downloadResult.error === 'Download cancelled') {
          return;
        }
        setUpdateModalState('error');
        setUpdateError(downloadResult.error || i18nService.t('updateDownloadFailed'));
        return;
      }

      setUpdateModalState('installing');
      const installResult = await window.electron.appUpdate.install(downloadResult.filePath!);

      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
      // If successful, app will quit and relaunch
    } catch (error) {
      unsubscribe();
      const msg = error instanceof Error ? error.message : '';
      // If user cancelled, handleCancelDownload already set the state — don't overwrite
      if (msg === 'Download cancelled') {
        return;
      }
      setUpdateModalState('error');
      setUpdateError(msg || i18nService.t('updateDownloadFailed'));
    }
  }, [updateInfo, showToast]);

  const handleCancelDownload = useCallback(async () => {
    await window.electron.appUpdate.cancelDownload();
    setUpdateModalState('info');
    setDownloadProgress(null);
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
  }, []);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    const useServer = config.app?.useNoobClawServer !== false;
    if (useServer) {
      // v4.31.28: 单 chat 项,reasoner 已砍。
      dispatch(setAvailableModels([
        { id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' },
      ]));
      dispatch(setSelectedModel({ id: 'noobclawai-chat', name: 'NoobClawAI-Chat', provider: 'NoobClaw', providerKey: 'noobclawAI' }));
    } else if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerName === 'noobclawAI' || providerName === 'noobclawzhiyun') return;
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleNewChat]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // v4.31.45: 全局监听定时任务被 SKIPPED 事件,toast 提示用户。手动触发已有
  //   类似提示(在 TaskDetailPage),定时跑跟它对齐 — 用户能看到"X 任务到点
  //   没启动:被 XXX 占用",不再 silently 错过。
  useEffect(() => {
    const off = (window.electron as any)?.ipcRenderer?.on?.('scenario:scheduledSkipped', (info: any) => {
      const taskShort = info?.taskId ? `#${String(info.taskId).slice(0, 8)}` : '任务';
      const reason = String(info?.reason || '');
      let msg: string;
      if (reason.startsWith('resource_busy:') && Array.isArray(info?.busyPlatforms) && info.busyPlatforms.length) {
        const plats = info.busyPlatforms.join(' + ');
        const holder = info?.busyTaskName || '其他任务';
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:${plats} 被 ${holder} 占用,下个 tick 重试`;
      } else if (reason === 'concurrency_limit_reached') {
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:同时运行任务已达上限,下个 tick 重试`;
      } else {
        msg = `⏰ 定时任务 ${taskShort} 到点未启动:${reason || '未知'}`;
      }
      showToast(msg);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [showToast]);

  // Subscribe to auth state changes
  useEffect(() => {
    const unsub = noobClawAuth.subscribe(setAuthState);
    return unsub;
  }, []);

  // Listen for token-insufficient event from api.ts
  useEffect(() => {
    const handler = () => setShowTokenDialog(true);
    window.addEventListener('noobclaw:token-insufficient', handler);
    return () => window.removeEventListener('noobclaw:token-insufficient', handler);
  }, []);

  // Listen for show-wallet event (e.g. from low-balance button)
  useEffect(() => {
    const handler = () => setMainView('wallet');
    window.addEventListener('noobclaw:show-wallet', handler);
    return () => window.removeEventListener('noobclaw:show-wallet', handler);
  }, []);

  // Listen for command-bar submissions from the floating NSPanel window
  // (src/renderer/components/commandBar/CommandBarView.tsx). When the
  // user hits ⌘K / Ctrl+K and enters a prompt, the command bar uses a
  // BroadcastChannel to push the text here; we switch to the cowork
  // view and dispatch a custom `noobclaw:prefill-prompt` event which
  // the composer picks up. Also checked on mount against localStorage
  // as a fallback for webviews without BroadcastChannel.
  useEffect(() => {
    const forward = (payload: { prompt?: string; source?: string }) => {
      if (!payload?.prompt) return;
      setMainView('cowork');
      // Give React a tick to mount the cowork view before dispatching.
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('noobclaw:prefill-prompt', {
            detail: { prompt: payload.prompt, source: payload.source || 'command-bar' },
          })
        );
      }, 50);
    };

    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('noobclaw-command-bar');
      bc.onmessage = (ev) => {
        if (ev?.data?.type === 'submit') forward(ev.data.payload);
      };
    } catch { /* older webviews */ }

    // Fallback: consume pending prompt persisted by the command bar.
    try {
      const pending = localStorage.getItem('noobclaw:command-bar:pending');
      if (pending) {
        localStorage.removeItem('noobclaw:command-bar:pending');
        forward(JSON.parse(pending));
      }
    } catch { /* ignore */ }

    return () => {
      if (bc) {
        try { bc.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  // Listen for need-login event from api.ts
  useEffect(() => {
    const handler = () => setShowLoginWall(true);
    window.addEventListener('noobclaw:need-login', handler);
    return () => window.removeEventListener('noobclaw:need-login', handler);
  }, []);

  // Sidecar crash events — the crash reporter (main/libs/crashReporter.ts)
  // broadcasts a system:crash SSE whenever it catches an uncaught
  // exception or unhandled rejection in the sidecar. Surface it as a
  // one-line toast so the user knows to restart or file a bug. The
  // full record lives on disk and is retrievable via electron.crashes.list.
  useEffect(() => {
    const api = (window as any).electron?.crashes;
    if (!api?.onCrash) return;
    const off = api.onCrash((detail: { kind: string; message: string }) => {
      setToastMessage(`Sidecar ${detail.kind}: ${detail.message.slice(0, 80)}`);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  // Renderer ErrorBoundary-adjacent global handlers: unhandled promise
  // rejections and thrown errors in React callbacks land here. We
  // emit them as manual crash reports via the sidecar IPC (if wired)
  // and show a toast — this covers the renderer side of the crash
  // pipeline without pulling in Sentry.
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error('[window.error]', event.error || event.message);
      setToastMessage(`Error: ${(event.message || 'unknown').slice(0, 80)}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      // eslint-disable-next-line no-console
      console.error('[unhandledrejection]', event.reason);
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      setToastMessage(`Unhandled: ${msg.slice(0, 80)}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Listen for auth token from website (via electron IPC or deep link)
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).electron) {
      (window as any).electron.onAuthCallback?.((token: string, wallet: string) => {
        noobClawAuth.setAuthFromWebsite(token, wallet);
      });
    }
  }, []);

  // Listen for tray menu open-settings IPC event
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:openSettings', () => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // Listen for tray menu new-task IPC event
  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('app:newTask', () => {
      handleNewChat();
    });
    return unsubscribe;
  }, [handleNewChat]);

  // Listen for scheduled task view-session event
  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const { sessionId } = (event as CustomEvent).detail;
      if (sessionId) {
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('scheduledTask:viewSession', handleViewSession);
    return () => window.removeEventListener('scheduledTask:viewSession', handleViewSession);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async () => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      await runUpdateCheck();
    };

    // Check immediately on startup
    void maybeCheck();

    // Heartbeat: every 30 minutes, check if more than 12 hours since last check
    const timer = window.setInterval(() => {
      void maybeCheck();
    }, UPDATE_HEARTBEAT_INTERVAL_MS);

    // Check when window becomes visible again (covers sleep/wake scenarios)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck]);

  // Choose which permission component to use based on the scenario
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // Check if it's AskUserQuestion with multiple questions -> use wizard component
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        );
      }
    }

    // For other cases, use the original permission modal
    return (
      <CoworkPermissionModal
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
      />
    );
  }, [pendingPermission, handlePermissionResponse]);

  const isOverlayActive = showSettings || showUpdateModal || pendingPermissions.length > 0;
  const updateBadge = updateInfo ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-claude-accent to-claude-accentHover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-claude-accent/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-claude-accent animate-shimmer" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="px-6 py-2.5 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
              onUpdateFound={handleUpdateFound}
            />
          )}
        </div>
      </div>
    );
  }

  const handleShowWallet = () => setMainView('wallet');
  const handleShowInvite = () => setMainView('invite');
  const handleShowQuickUse = (platform?: 'xhs' | 'x' | 'binance') => {
    setQuickUseInitialPlatform(platform);
    setMainView('quickuse');
  };
  const handleShowWeb3News = () => setMainView('web3news');
  const handleShowPartners = () => setMainView('partners');
  const handleShowPersonality = () => setMainView('personality');

  return (
    <div className="relative h-screen overflow-hidden flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {showLoginWall && !authState.isAuthenticated && (
        <LoginWall
          onDismiss={() => setShowLoginWall(false)}
          onSwitchToCustomApi={() => {
            setShowLoginWall(false);
            handleShowSettings({ initialTab: 'model' as any, forceCustomApi: true });
          }}
        />
      )}
      {showTokenDialog && (
        <TokenInsufficientDialog
          onConfirm={() => { setShowTokenDialog(false); setMainView('wallet'); }}
          onCancel={() => setShowTokenDialog(false)}
        />
      )}
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          onShowLogin={handleShowLogin}
          onShowSettings={handleShowSettings}
          activeView={mainView}
          onShowSkills={handleShowSkills}
          onShowCowork={handleShowCowork}
          onShowScheduledTasks={handleShowScheduledTasks}
          onShowMcp={handleShowMcp}
          onShowWallet={handleShowWallet}
          onShowInvite={handleShowInvite}
          onShowQuickUse={handleShowQuickUse}
          onShowWeb3News={handleShowWeb3News}
          onShowPersonality={handleShowPersonality}
          onShowPartners={handleShowPartners}
          onNewChat={handleNewChat}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
          updateBadge={!isSidebarCollapsed ? updateBadge : null}
        />
        <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
          <div className="h-full min-h-0 rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
            {mainView === 'skills' ? (
              <SkillsView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'scheduledTasks' ? (
              <ScheduledTasksView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'mcp' ? (
              <Web3View
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'wallet' ? (
              <WalletView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'invite' ? (
              <InviteView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'quickuse' ? (
              <ScenarioView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                initialPlatform={quickUseInitialPlatform}
              />
            ) : mainView === 'partners' ? (
              <PartnersView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
                onShowInvite={handleShowInvite}
                onShowXhs={handleShowQuickUse}
                onShowPersonality={handleShowPersonality}
              />
            ) : mainView === 'personality' ? (
              <PersonalityView
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : mainView === 'web3news' ? (
              <Web3NewsPage
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            ) : (
              <CoworkView
                onRequestAppSettings={handleShowSettings}
                onShowSkills={handleShowSkills}
                onShowWallet={handleShowWallet}
                onShowQuickUse={handleShowQuickUse}
                isSidebarCollapsed={isSidebarCollapsed}
                onToggleSidebar={handleToggleSidebar}
                onNewChat={handleNewChat}
                updateBadge={isSidebarCollapsed ? updateBadge : null}
              />
            )}
          </div>
        </div>
      </div>

      {/* Settings window displays above all main content without affecting main UI interaction */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          initialTab={settingsOptions.initialTab}
          notice={settingsOptions.notice}
          onUpdateFound={handleUpdateFound}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateInfo={updateInfo}
          onCancel={() => {
            if (updateModalState === 'info' || updateModalState === 'error') {
              setShowUpdateModal(false);
              setUpdateModalState('info');
              setUpdateError(null);
              setDownloadProgress(null);
            }
          }}
          onConfirm={handleConfirmUpdate}
          modalState={updateModalState}
          downloadProgress={downloadProgress}
          errorMessage={updateError}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
    </div>
  );
};

export default App; 
