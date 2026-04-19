/**
 * ScenarioView — top-level replacement for QuickUseView.
 *
 * Owns the internal navigation state for the "一键使用" area:
 *   - Platform tab (xhs / x / douyin / tiktok / youtube)
 *   - Page within that platform (workflows list / workflow detail / task detail)
 *   - Modals (config wizard)
 *
 * Only xhs is functional in Phase 1. Everything else renders a placeholder.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { i18nService } from '../../services/i18n';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { XhsWorkflowsPage } from './XhsWorkflowsPage';
import { XWorkflowsPage } from './XWorkflowsPage';
import { TaskDetailPage } from './TaskDetailPage';
import { PlatformPlaceholder } from './PlatformPlaceholder';
import { ConfigWizard } from './ConfigWizard';
import { SensitiveCheckPage } from './SensitiveCheckPage';
import { MyTasksPage } from './MyTasksPage';
import { RunHistoryPage } from './RunHistoryPage';
import { RunRecordDetailPage } from './RunRecordDetailPage';

type PlatformId = 'xhs' | 'x' | 'douyin' | 'tiktok' | 'youtube';

// Top-level navigation:
//   create  — scenario cards (current XhsWorkflowsPage / XWorkflowsPage,
//             but with the bottom task list stripped out — those are now
//             over in `tasks`).
//   tasks   — unified "我的自动化运营任务" page across all platforms,
//             filtered by the active platform sub-tab.
//   history — unified "运行记录" page across all platforms, filtered by
//             the active platform sub-tab.
type SectionId = 'create' | 'tasks' | 'history';

type ViewState =
  | { kind: 'main'; section: SectionId; platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'task_detail'; task_id: string; from?: SectionId }
  | { kind: 'record_detail'; record_id: string; from_platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'sensitive_check' };

interface ScenarioViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const PLATFORM_TABS: Array<{ id: PlatformId; labelKey: string; icon: string; enabled: boolean }> = [
  { id: 'xhs', labelKey: 'scenarioPlatformXhs', icon: '📕', enabled: true },
  { id: 'x', labelKey: 'scenarioPlatformX', icon: '🐦', enabled: true },
];

const SECTION_TABS: Array<{ id: SectionId; zh: string; en: string; icon: string }> = [
  { id: 'create',  zh: '创建自动化运营任务', en: 'Create Task',     icon: '✨' },
  { id: 'tasks',   zh: '我的自动化运营任务', en: 'My Tasks',        icon: '📋' },
  { id: 'history', zh: '运行记录',          en: 'Run History',     icon: '📊' },
];

export const ScenarioView: React.FC<ScenarioViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [view, setView] = useState<ViewState>({ kind: 'main', section: 'create', platform: 'xhs' });

  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);

  // Wizard state (keyword/track tasks)
  const [wizardScenario, setWizardScenario] = useState<Scenario | null>(null);
  const [wizardEditingTask, setWizardEditingTask] = useState<Task | null>(null);
  // Link-mode edit modal (separate from the keyword wizard — they capture
  // completely different inputs and users were confusing them)
  const [linkEditTask, setLinkEditTask] = useState<Task | null>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      // Load tasks and drafts first (local, fast)
      const [t, d] = await Promise.all([
        scenarioService.listTasks().catch(() => []),
        scenarioService.listDrafts().catch(() => []),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setDrafts(Array.isArray(d) ? d : []);
      setLoading(false);

      // Load scenarios in background (network, slow) — don't block UI
      scenarioService.listScenarios().then(s => {
        setScenarios(Array.isArray(s) ? s : []);
      }).catch(() => {});
    } catch (err) {
      console.error('[ScenarioView] refreshAll failed:', err);
      setFatalError(String(err instanceof Error ? err.message : err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    // Sidecar might not be ready on first mount — retry once after 2s
    const t1 = setTimeout(() => void refreshAll(), 2000);
    return () => { clearTimeout(t1); };
  }, [refreshAll]);

  // Live window title showing running tasks. Polls running task ids + each
  // task's current step every 3s. Shows e.g.:
  //   "推特任务-步骤2 · 小红书任务-步骤1 — NoobClaw"
  // when 2 tasks are running, or just "NoobClaw" when idle. The user can
  // glance at the OS window list / dock and see status without bringing
  // the app to foreground.
  useEffect(() => {
    let cancelled = false;
    const baseTitle = 'NoobClaw';
    const tick = async () => {
      try {
        const ids = await scenarioService.getRunningTaskIds();
        if (cancelled) return;
        if (ids.length === 0) {
          document.title = baseTitle;
          return;
        }
        const scenarioById = new Map(scenarios.map(s => [s.id, s]));
        const parts: string[] = [];
        for (const id of ids) {
          const t = tasks.find(t => t.id === id);
          if (!t) continue;
          const s = scenarioById.get(t.scenario_id);
          const platform = s?.platform === 'x' ? '推特' : s?.platform === 'xhs' ? '小红书' : (s?.platform || '');
          // Get this task's progress to know which step it's in
          const prog = await scenarioService.getRunProgress(id).catch(() => null);
          if (prog && prog.status === 'running' && prog.currentStep > 0) {
            parts.push(`${platform}任务-步骤${prog.currentStep}`);
          } else if (prog && prog.status === 'done') {
            parts.push(`${platform}任务-已结束`);
          } else if (prog && prog.status === 'error') {
            parts.push(`${platform}任务-异常`);
          } else {
            parts.push(`${platform}任务-启动中`);
          }
        }
        document.title = parts.length > 0 ? `${parts.join(' · ')} — ${baseTitle}` : baseTitle;
      } catch {
        if (!cancelled) document.title = baseTitle;
      }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); document.title = baseTitle; };
  }, [tasks, scenarios]);

  // Derive the platform tab to highlight + return to:
  //   - workflows view  → use view.platform directly
  //   - task_detail     → look up task → its scenario → scenario.platform
  //                       (so Twitter tasks keep the 🐦 tab active)
  //   - sensitive_check → XHS-only feature, fall back to 'xhs'
  const currentPlatform: PlatformId = (() => {
    if (view.kind === 'main') return view.platform;
    if (view.kind === 'task_detail') {
      const t = tasks.find(t => t.id === view.task_id);
      const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
      const p = s?.platform;
      if (p === 'xhs' || p === 'x' || p === 'douyin' || p === 'tiktok' || p === 'youtube') return p;
      return 'xhs';
    }
    return 'xhs';
  })();

  // The currently-active top-level section (create / tasks / history). Used
  // to highlight the right L1 tab AND to remember which section to go back
  // to after viewing a task detail.
  const currentSection: SectionId = (() => {
    if (view.kind === 'main') return view.section;
    if (view.kind === 'task_detail') return view.from || 'tasks';
    return 'create';
  })();

  const setSection = (section: SectionId) => {
    // Clear any task filter when manually switching sections via the L1 tabs.
    setView({ kind: 'main', section, platform: currentPlatform });
  };

  const setPlatform = (platform: PlatformId) => {
    setView({ kind: 'main', section: currentSection, platform });
  };

  const openTask = (task_id: string) => {
    setView({ kind: 'task_detail', task_id, from: currentSection });
  };

  /** Jump from a task's detail page to Run History filtered by that task. */
  const openHistoryForTask = (task_id: string) => {
    // Resolve platform from the task so the right L2 sub-tab is active.
    const t = tasks.find(t => t.id === task_id);
    const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
    const p = (s?.platform === 'x' || s?.platform === 'xhs') ? s.platform : currentPlatform;
    setView({ kind: 'main', section: 'history', platform: p, filterTaskId: task_id });
  };

  const openSensitiveCheck = () => {
    setView({ kind: 'sensitive_check' });
  };

  // Go back to the section the user was on before opening a detail page.
  // task_detail remembers via `view.from`; record_detail returns to the
  // history section it came from (optionally still filtered); sensitive_check
  // just goes home.
  const goBack = () => {
    if (view.kind === 'task_detail' && view.from) {
      setView({ kind: 'main', section: view.from, platform: currentPlatform });
    } else if (view.kind === 'record_detail') {
      setView({ kind: 'main', section: 'history', platform: view.from_platform, filterTaskId: view.filterTaskId });
    } else {
      setView({ kind: 'main', section: 'tasks', platform: currentPlatform });
    }
  };

  /** Open a run record's read-only detail page. Remembers where we came
   *  from so the back button takes the user back to the right filtered
   *  history view. */
  const openRecord = (record_id: string) => {
    const currentFilter = view.kind === 'main' ? view.filterTaskId || null : null;
    setView({ kind: 'record_detail', record_id, from_platform: currentPlatform, filterTaskId: currentFilter });
  };

  const openWizardFor = (scenario: Scenario) => {
    setWizardScenario(scenario);
    setWizardEditingTask(null);
  };

  const openWizardEdit = (task: Task, scenario: Scenario) => {
    // Link-mode tasks have a completely different input shape (URLs vs
    // keywords) — open the dedicated link editor instead of the keyword
    // wizard so users aren't asked to pick a track for links they already
    // supplied.
    const isLinkMode = task.track === 'link_mode'
      || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
    if (isLinkMode) {
      setLinkEditTask(task);
      return;
    }
    setWizardScenario(scenario);
    setWizardEditingTask(task);
  };

  const closeWizard = () => {
    setWizardScenario(null);
    setWizardEditingTask(null);
  };

  const closeLinkEdit = () => setLinkEditTask(null);

  const handleWizardSave = async (input: {
    scenario_id: string;
    track: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    daily_time: string;
    /** Twitter v1: extra optional fields. Spread through unchanged. */
    language?: 'zh' | 'en' | 'mixed';
    user_context?: string;
    urls?: string[];
  }) => {
    if (wizardEditingTask) {
      // Edit → always activate as scheduled task
      await scenarioService.updateTask(wizardEditingTask.id, { ...input, active: true, enabled: true });
    } else {
      await scenarioService.createTask({ ...input, enabled: true, active: true });
    }
    closeWizard();
    await refreshAll();
  };

  const tasksForPlatform = useMemo(() => {
    if (!Array.isArray(tasks) || !Array.isArray(scenarios)) return [];
    const byId = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => byId.get(t.scenario_id)?.platform === currentPlatform);
  }, [tasks, scenarios, currentPlatform]);

  const draftsByTask = useMemo(() => {
    const map = new Map<string, Draft[]>();
    if (!Array.isArray(drafts)) return map;
    for (const d of drafts) {
      const arr = map.get(d.task_id) || [];
      arr.push(d);
      map.set(d.task_id, arr);
    }
    return map;
  }, [drafts]);

  // ── Render ──

  const platformTabContent = (() => {
    if (view.kind === 'sensitive_check') {
      return <SensitiveCheckPage onBack={goBack} />;
    }
    if (view.kind === 'record_detail') {
      return (
        <RunRecordDetailPage
          recordId={view.record_id}
          onBack={goBack}
          onOpenTask={openTask}
        />
      );
    }
    if (view.kind === 'task_detail') {
      const task = tasks.find(t => t.id === view.task_id);
      if (!task) {
        return (
          <div className="p-6 text-center text-gray-500 dark:text-gray-400">
            {i18nService.t('scenarioSectionNoTasks')}
          </div>
        );
      }
      const scenario = scenarios.find(s => s.id === task.scenario_id);
      return (
        <TaskDetailPage
          task={task}
          scenario={scenario || null}
          onBack={goBack}
          onEdit={() => scenario && openWizardEdit(task, scenario)}
          onChanged={refreshAll}
          onOpenHistory={() => openHistoryForTask(task.id)}
        />
      );
    }

    // Section + platform branching. Each L1 section has a per-platform
    // view; the user picked the platform via the L2 sub-tabs above.
    // Platform display label — locale-aware so the My Tasks / History
    // page headers don't show Chinese names in EN mode.
    const isZh = i18nService.currentLanguage === 'zh';
    const platformLabel = currentPlatform === 'xhs' ? (isZh ? '小红书' : 'Xiaohongshu')
      : currentPlatform === 'x' ? (isZh ? '推特' : 'Twitter')
      : currentPlatform;

    if (currentSection === 'tasks') {
      return (
        <MyTasksPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          loading={loading}
          platformLabel={platformLabel}
          onOpenTask={openTask}
          onRefresh={refreshAll}
        />
      );
    }

    if (currentSection === 'history') {
      const filterTaskId = view.kind === 'main' ? view.filterTaskId || null : null;
      return (
        <RunHistoryPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          platformId={currentPlatform}
          platformLabel={platformLabel}
          onOpenRecord={openRecord}
          filterByTaskId={filterTaskId}
          onClearFilter={() => setView({ kind: 'main', section: 'history', platform: currentPlatform })}
        />
      );
    }

    // currentSection === 'create' — show the platform's scenario cards
    if (currentPlatform === 'xhs') {
      return (
        <XhsWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'xhs')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onOpenSensitiveCheck={openSensitiveCheck}
        />
      );
    }

    if (currentPlatform === 'x') {
      return (
        <XWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'x')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
        />
      );
    }

    // Other platforms (douyin / tiktok / youtube) — placeholder only
    return <PlatformPlaceholder platform={currentPlatform} />;
  })();

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
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
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('quickUse')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* L1 — section tabs (Create / My Tasks / History). Hidden when in
          a sub-page (task_detail / sensitive_check) so the user gets a
          full-bleed page without competing nav. */}
      {view.kind === 'main' && (
        <div className="flex items-center gap-1 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 overflow-x-auto">
          {SECTION_TABS.map(tab => {
            const active = currentSection === tab.id;
            const isZh = i18nService.currentLanguage === 'zh';
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSection(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-500/10 text-blue-500 border border-blue-500/30'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent'
                }`}
              >
                <span>{tab.icon}</span>
                <span>{isZh ? tab.zh : tab.en}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* L2 — platform sub-tabs (XHS / Twitter). Same hidden rule.
          Larger + bolder text + visible inactive border so users can find
          the toggles at a glance (previous version was too quiet). */}
      {view.kind === 'main' && (
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 overflow-x-auto">
          {PLATFORM_TABS.map(tab => {
            const active = currentPlatform === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPlatform(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-green-500/15 text-green-500 border border-green-500/50 shadow-sm shadow-green-500/20'
                    : 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600'
                }`}
              >
                <span className="text-base">{tab.icon}</span>
                <span>{i18nService.t(tab.labelKey)}</span>
                {!tab.enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">
                    {i18nService.t('scenarioPlatformSoon')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main content */}
      {/* Main content — guarded with a fallback so a render crash doesn't black-screen the app */}
      <div className="flex-1 overflow-y-auto">
        {fatalError ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <div className="text-sm text-red-500 mb-4">{fatalError}</div>
            <button
              type="button"
              onClick={() => { setFatalError(null); void refreshAll(); }}
              className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900"
            >
              重试
            </button>
          </div>
        ) : (
          platformTabContent
        )}
      </div>

      {/* Config wizard modal */}
      {wizardScenario && (
        <ConfigWizard
          scenario={wizardScenario}
          initialTask={wizardEditingTask}
          onCancel={closeWizard}
          onSave={handleWizardSave}
        />
      )}

      {/* Link-mode edit modal */}
      {linkEditTask && (
        <LinkModeEditModal
          task={linkEditTask}
          onCancel={closeLinkEdit}
          onSaved={async () => {
            closeLinkEdit();
            await refreshAll();
          }}
        />
      )}
    </div>
  );
};

// ─── Link-mode edit modal ────────────────────────────────────────────────
// Dedicated editor for tasks created via 🔗 指定链接 flow. Takes URL list
// + auto_upload toggle — deliberately does NOT ask for track / keywords /
// persona, which would be meaningless for link-mode tasks.

const LinkModeEditModal: React.FC<{
  task: Task;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}> = ({ task, onCancel, onSaved }) => {
  const isZh = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';
  const initialUrls: string[] = (task as any).urls || [];
  const [linksText, setLinksText] = useState(initialUrls.join('\n'));
  const [autoUpload, setAutoUpload] = useState<boolean>((task as any).auto_upload !== false);
  const [submitting, setSubmitting] = useState(false);

  const validate = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: isZh ? '至少粘贴 1 个链接' : 'Paste at least 1 URL' };
    if (lines.length > 3) return { ok: [], err: isZh ? '最多 3 个链接' : 'Max 3 URLs' };
    for (const l of lines) {
      if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
        return { ok: [], err: (isZh ? '不是小红书链接：' : 'Not an XHS link: ') + l.slice(0, 80) };
      }
    }
    return { ok: lines, err: null };
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const { ok, err } = validate(linksText);
    if (err) { alert(err); return; }
    setSubmitting(true);
    try {
      await scenarioService.updateTask(task.id, {
        urls: ok,
        daily_count: ok.length,
        auto_upload: autoUpload,
        active: true,
        enabled: true,
      } as any);
      await onSaved();
    } catch (e) {
      alert((isZh ? '保存失败：' : 'Save failed: ') + String(e).slice(0, 120));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
      >
        <h3 className="text-lg font-bold dark:text-white mb-2">
          🔗 {isZh ? '编辑指定链接任务' : 'Edit link-mode task'}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {isZh ? '粘贴 1~3 个小红书原文链接，每行一个。' : 'Paste 1-3 XHS note URLs, one per line.'}
        </p>
        <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
          {isZh ? '原文链接' : 'Source URLs'}
        </label>
        <textarea
          value={linksText}
          onChange={e => setLinksText(e.target.value)}
          rows={8}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y min-h-[200px] break-all"
          disabled={submitting}
        />

        <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
          {isZh ? '生成后的处理' : 'After generation'}
        </label>
        <div className="space-y-2">
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={autoUpload} onChange={() => setAutoUpload(true)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {isZh ? '📤 自动上传到小红书草稿箱' : '📤 Auto-upload to XHS drafts'}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {isZh ? '全流程无人值守。⚠️ 单日 >3 篇有封号风险。' : 'Unattended. ⚠️ >3/day risks ban.'}
              </div>
            </div>
          </label>
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={!autoUpload} onChange={() => setAutoUpload(false)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {isZh ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {isZh ? '存盘后手动审核上传，封号风险最低。' : 'Review and upload manually later.'}
              </div>
            </div>
          </label>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {submitting
              ? (isZh ? '保存中...' : 'Saving...')
              : (isZh ? '💾 保存' : '💾 Save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScenarioView;
