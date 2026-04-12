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
import { WorkflowDetailPage } from './WorkflowDetailPage';
import { TaskDetailPage } from './TaskDetailPage';
import { PlatformPlaceholder } from './PlatformPlaceholder';
import { ConfigWizard } from './ConfigWizard';

type PlatformId = 'xhs' | 'x' | 'douyin' | 'tiktok' | 'youtube';

type ViewState =
  | { kind: 'workflows'; platform: PlatformId }
  | { kind: 'workflow_detail'; platform: PlatformId; workflow_type: string }
  | { kind: 'task_detail'; task_id: string };

interface ScenarioViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const PLATFORM_TABS: Array<{ id: PlatformId; labelKey: string; icon: string; enabled: boolean }> = [
  { id: 'xhs', labelKey: 'scenarioPlatformXhs', icon: '📕', enabled: true },
  { id: 'x', labelKey: 'scenarioPlatformX', icon: '🐦', enabled: false },
  { id: 'douyin', labelKey: 'scenarioPlatformDouyin', icon: '🎵', enabled: false },
  { id: 'tiktok', labelKey: 'scenarioPlatformTiktok', icon: '📱', enabled: false },
  { id: 'youtube', labelKey: 'scenarioPlatformYoutube', icon: '📺', enabled: false },
];

export const ScenarioView: React.FC<ScenarioViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [view, setView] = useState<ViewState>({ kind: 'workflows', platform: 'xhs' });

  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

  // Wizard state
  const [wizardScenario, setWizardScenario] = useState<Scenario | null>(null);
  const [wizardEditingTask, setWizardEditingTask] = useState<Task | null>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t, d] = await Promise.all([
        scenarioService.listScenarios().catch(() => []),
        scenarioService.listTasks().catch(() => []),
        scenarioService.listDrafts().catch(() => []),
      ]);
      setScenarios(s);
      setTasks(t);
      setDrafts(d);
    } catch (err) {
      console.error('[ScenarioView] refreshAll failed:', err);
      setFatalError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const currentPlatform: PlatformId =
    view.kind === 'workflows' || view.kind === 'workflow_detail' ? view.platform : 'xhs';

  const setPlatform = (platform: PlatformId) => {
    setView({ kind: 'workflows', platform });
  };

  const openWorkflow = (platform: PlatformId, workflow_type: string) => {
    setView({ kind: 'workflow_detail', platform, workflow_type });
  };

  const openTask = (task_id: string) => {
    setView({ kind: 'task_detail', task_id });
  };

  const goBack = () => {
    if (view.kind === 'task_detail') {
      const task = tasks.find(t => t.id === view.task_id);
      const scenario = task ? scenarios.find(s => s.id === task.scenario_id) : null;
      if (scenario) {
        setView({ kind: 'workflow_detail', platform: scenario.platform, workflow_type: scenario.workflow_type });
      } else {
        setView({ kind: 'workflows', platform: 'xhs' });
      }
      return;
    }
    if (view.kind === 'workflow_detail') {
      setView({ kind: 'workflows', platform: view.platform });
      return;
    }
  };

  const openWizardFor = (scenario: Scenario) => {
    setWizardScenario(scenario);
    setWizardEditingTask(null);
  };

  const openWizardEdit = (task: Task, scenario: Scenario) => {
    setWizardScenario(scenario);
    setWizardEditingTask(task);
  };

  const closeWizard = () => {
    setWizardScenario(null);
    setWizardEditingTask(null);
  };

  const handleWizardSave = async (input: {
    scenario_id: string;
    track: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    daily_time: string;
  }) => {
    if (wizardEditingTask) {
      await scenarioService.updateTask(wizardEditingTask.id, input);
    } else {
      await scenarioService.createTask({ ...input, enabled: true, active: true });
    }
    closeWizard();
    await refreshAll();
  };

  const tasksForPlatform = useMemo(() => {
    const byId = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => byId.get(t.scenario_id)?.platform === currentPlatform);
  }, [tasks, scenarios, currentPlatform]);

  const draftsByTask = useMemo(() => {
    const map = new Map<string, Draft[]>();
    for (const d of drafts) {
      const arr = map.get(d.task_id) || [];
      arr.push(d);
      map.set(d.task_id, arr);
    }
    return map;
  }, [drafts]);

  // ── Render ──

  const platformTabContent = (() => {
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
        />
      );
    }

    if (view.kind === 'workflow_detail' && view.platform === 'xhs') {
      const platformScenarios = scenarios.filter(
        s => s.platform === view.platform && s.workflow_type === view.workflow_type
      );
      return (
        <WorkflowDetailPage
          workflow_type={view.workflow_type}
          scenarios={platformScenarios}
          tasks={tasksForPlatform.filter(
            t => scenarios.find(s => s.id === t.scenario_id)?.workflow_type === view.workflow_type
          )}
          draftsByTask={draftsByTask}
          onBack={goBack}
          onConfigure={openWizardFor}
          onOpenTask={openTask}
        />
      );
    }

    if (currentPlatform === 'xhs') {
      return (
        <XhsWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'xhs')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenWorkflow={wt => openWorkflow('xhs', wt)}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
        />
      );
    }

    // Other platforms — placeholder only
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

      {/* Platform tabs */}
      <div className="flex items-center gap-1 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 overflow-x-auto">
        {PLATFORM_TABS.map(tab => {
          const active = currentPlatform === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setPlatform(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? 'bg-green-500/10 text-green-500 border border-green-500/30'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent'
              }`}
            >
              <span>{tab.icon}</span>
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
    </div>
  );
};

export default ScenarioView;
