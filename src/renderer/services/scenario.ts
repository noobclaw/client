/**
 * Scenario service — thin renderer-side wrapper around window.electron.scenario.
 *
 * All scenario logic (discovery, extraction, composition, risk guard, draft
 * upload) lives in the main process. This file only exposes convenient
 * async methods so React components don't have to reach into window.electron
 * directly.
 */

import type {
  ScenarioManifestIPC,
  ScenarioTaskIPC,
  ScenarioDraftIPC,
  ScenarioRunOutcome,
  ScenarioPlatform,
  ScenarioWorkflowType,
  ScenarioTaskRun,
  XhsLoginStatus,
} from '../types/scenario';

export type Scenario = ScenarioManifestIPC;
export type Task = ScenarioTaskIPC;
export type Draft = ScenarioDraftIPC;
export type RunOutcome = ScenarioRunOutcome;

class ScenarioService {
  // ── Catalogue ──

  async listScenarios(): Promise<Scenario[]> {
    try {
      const res = await window.electron.scenario.listScenarios();
      return res?.scenarios || [];
    } catch {
      return [];
    }
  }

  /** Filter scenarios by platform and workflow type. */
  async listScenariosFor(platform: ScenarioPlatform, workflow?: ScenarioWorkflowType): Promise<Scenario[]> {
    const all = await this.listScenarios();
    return all.filter(
      s => s.platform === platform && (!workflow || s.workflow_type === workflow)
    );
  }

  // ── Tasks ──

  async listTasks(): Promise<Task[]> {
    try {
      return (await window.electron.scenario.listTasks()) || [];
    } catch {
      return [];
    }
  }

  async listTasksFor(platform: ScenarioPlatform): Promise<Task[]> {
    const [tasks, scenarios] = await Promise.all([this.listTasks(), this.listScenarios()]);
    const scenarioById = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => scenarioById.get(t.scenario_id)?.platform === platform);
  }

  getTask(id: string): Promise<Task | null> {
    return window.electron.scenario.getTask(id);
  }

  createTask(input: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task> {
    return window.electron.scenario.createTask(input);
  }

  updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    return window.electron.scenario.updateTask(id, patch);
  }

  deleteTask(id: string): Promise<boolean> {
    return window.electron.scenario.deleteTask(id);
  }

  runTaskNow(id: string): Promise<RunOutcome> {
    return window.electron.scenario.runTaskNow(id);
  }

  runStatus(id: string): Promise<{ runs: ScenarioTaskRun[]; cooldown_ends_at: number }> {
    return window.electron.scenario.runStatus(id);
  }

  // ── Drafts ──

  async listDrafts(taskId?: string): Promise<Draft[]> {
    try {
      return (await window.electron.scenario.listDrafts(taskId)) || [];
    } catch {
      return [];
    }
  }

  pushDraft(draftId: string): Promise<{ status: 'ready_for_user' | 'failed'; error?: string }> {
    return window.electron.scenario.pushDraft(draftId);
  }

  deleteDraft(draftId: string): Promise<boolean> {
    return window.electron.scenario.deleteDraft(draftId);
  }

  markDraftIgnored(draftId: string): Promise<Draft | null> {
    return window.electron.scenario.markDraftIgnored(draftId);
  }

  // ── Active task management ──

  setActiveTask(id: string): Promise<Task | null> {
    return window.electron.scenario.setActiveTask(id);
  }

  getActiveTask(): Promise<Task | null> {
    return window.electron.scenario.getActiveTask();
  }

  // ── XHS login gate ──

  async checkXhsLogin(): Promise<XhsLoginStatus> {
    try {
      return await window.electron.scenario.checkXhsLogin();
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openXhsLogin(): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await window.electron.scenario.openXhsLogin();
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  // ── Derived helpers ──

  /** Aggregate per-task stats the task dashboard likes to show. */
  async getTaskStats(taskId: string): Promise<{
    runs: ScenarioTaskRun[];
    draft_count: number;
    pending_draft_count: number;
    pushed_draft_count: number;
    last_run_at: number | null;
    last_run_status: ScenarioTaskRun['status'] | null;
    cooldown_ends_at: number;
  }> {
    const [{ runs, cooldown_ends_at }, drafts] = await Promise.all([
      this.runStatus(taskId),
      this.listDrafts(taskId),
    ]);
    const last = runs[runs.length - 1];
    return {
      runs,
      draft_count: drafts.length,
      pending_draft_count: drafts.filter(d => d.status === 'pending').length,
      pushed_draft_count: drafts.filter(d => d.status === 'pushed').length,
      last_run_at: last?.started_at || null,
      last_run_status: last?.status || null,
      cooldown_ends_at,
    };
  }
}

export const scenarioService = new ScenarioService();
