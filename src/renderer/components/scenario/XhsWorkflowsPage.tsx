/**
 * XhsWorkflowsPage — layer 1 inside 小红书 tab.
 *
 * Shows:
 *   - "My tasks" list (collapsed card per task)
 *   - Workflow type grid (爆款仿写 active, 4 others coming soon)
 */

import React from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task, Draft } from '../../services/scenario';

type WorkflowDef = {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
  available: boolean;
};

const WORKFLOWS: WorkflowDef[] = [
  { id: 'viral_production', icon: '🔥', titleKey: 'scenarioWorkflowViral', descKey: 'scenarioWorkflowViralDesc', available: true },
  { id: 'auto_reply', icon: '💬', titleKey: 'scenarioWorkflowAutoReply', descKey: 'scenarioWorkflowAutoReplyDesc', available: false },
  { id: 'mass_comment', icon: '🎯', titleKey: 'scenarioWorkflowMassComment', descKey: 'scenarioWorkflowMassCommentDesc', available: false },
  { id: 'dm_reply', icon: '📬', titleKey: 'scenarioWorkflowDmReply', descKey: 'scenarioWorkflowDmRelyDesc', available: false },
  { id: 'data_monitor', icon: '📈', titleKey: 'scenarioWorkflowDataMonitor', descKey: 'scenarioWorkflowDataMonitorDesc', available: false },
];

interface Props {
  scenarios: Scenario[];
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenWorkflow: (workflow_type: string) => void;
  onOpenTask: (task_id: string) => void;
  onConfigure: (scenario: Scenario) => void;
}

export const XhsWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask,
  loading,
  onOpenWorkflow,
  onOpenTask,
}) => {
  const scenarioById = new Map(scenarios.map(s => [s.id, s]));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* My tasks */}
      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
          📌 {i18nService.t('scenarioSectionMyTasks')}
        </h2>
        {loading && tasks.length === 0 ? (
          <div className="text-sm text-gray-400 py-6">{i18nService.t('common.loading') || '加载中...'}</div>
        ) : tasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {i18nService.t('scenarioSectionNoTasks')}
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map(task => {
              const scenario = scenarioById.get(task.scenario_id);
              const taskDrafts = draftsByTask.get(task.id) || [];
              const pendingCount = taskDrafts.filter(d => d.status === 'pending').length;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  className="w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 hover:border-green-500/50 dark:hover:border-green-500/50 bg-white dark:bg-gray-900 px-4 py-3 flex items-center gap-3 transition-colors"
                >
                  <div className="text-2xl">{scenario?.icon || '🔥'}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium dark:text-white truncate">
                      {scenario?.name_zh || task.scenario_id}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {task.keywords.join(' · ')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {task.enabled ? (
                      <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30">
                        {i18nService.t('scenarioCardTaskRunning')}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-800 text-gray-500">
                        {i18nService.t('scenarioCardTaskPaused')}
                      </span>
                    )}
                    {pendingCount > 0 && (
                      <span className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-500 border border-amber-500/30">
                        {i18nService.t('scenarioCardTaskDraftCount').replace('{n}', String(pendingCount))}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Workflow grid */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
          🛠  {i18nService.t('scenarioPlatformXhs')} · {i18nService.t('scenarioSectionRun')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {WORKFLOWS.map(wf => (
            <button
              key={wf.id}
              type="button"
              onClick={() => (wf.available ? onOpenWorkflow(wf.id) : undefined)}
              disabled={!wf.available}
              className={`text-left rounded-2xl border p-5 transition-colors ${
                wf.available
                  ? 'border-gray-200 dark:border-gray-700 hover:border-green-500/50 hover:shadow-lg dark:hover:border-green-500/50 bg-white dark:bg-gray-900 cursor-pointer'
                  : 'border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 opacity-60 cursor-not-allowed'
              }`}
            >
              <div className="text-4xl mb-3">{wf.icon}</div>
              <div className="font-semibold text-base dark:text-white mb-1.5">
                {i18nService.t(wf.titleKey)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-4 min-h-[2.5rem]">
                {i18nService.t(wf.descKey)}
              </div>
              <div>
                {wf.available ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    {i18nService.t('scenarioWorkflowAvailable')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                    {i18nService.t('scenarioWorkflowComingSoon')}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
};

export default XhsWorkflowsPage;
