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
  ScenarioRunProgress,
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
      const r = await window.electron.scenario.listTasks();
      return Array.isArray(r) ? r : [];
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

  /** Upload a single already-generated draft. Used by TaskDetailPage
   *  per-draft 📤 button when auto_upload was false. */
  uploadDraft(taskId: string, draftId: string): Promise<{ status: string; reason?: string }> {
    return (window.electron.scenario as any).uploadDraft(taskId, draftId);
  }

  runStatus(id: string): Promise<{ runs: ScenarioTaskRun[]; cooldown_ends_at: number }> {
    return window.electron.scenario.runStatus(id);
  }

  // ── Drafts ──

  async listDrafts(taskId?: string): Promise<Draft[]> {
    try {
      const r = await window.electron.scenario.listDrafts(taskId);
      return Array.isArray(r) ? r : [];
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

  // ── Running state ──

  async getRunningTaskId(): Promise<string | null> {
    try {
      const r = await window.electron.scenario.getRunningTaskId();
      return r?.runningTaskId || null;
    } catch {
      return null;
    }
  }

  /** Multi-tab concurrency (Twitter v1): returns ALL running task ids —
   *  can be > 1 when XHS task + Twitter task are both in flight. */
  async getRunningTaskIds(): Promise<string[]> {
    try {
      const r = await window.electron.scenario.getRunningTaskIds();
      return Array.isArray(r?.runningTaskIds) ? r.runningTaskIds : [];
    } catch {
      return [];
    }
  }

  /** Connected browser extensions, with their reported versions + when
   *  the bridge accepted the connection. Used to detect outdated
   *  extensions: an extension that pre-dates the version-reporting
   *  protocol (< 1.2.0) shows up with version === '' AND has been
   *  connected for > 5s without sending hello (older versions don't
   *  send it at all). */
  async getConnectedExtensions(): Promise<Array<{ id: string; version: string; tabCount: number; connectedAt: number }>> {
    try {
      const r = await window.electron.scenario.getConnectedExtensions();
      return Array.isArray(r?.extensions) ? r.extensions : [];
    } catch {
      return [];
    }
  }

  /** All recorded runs across every task, newest-first. Used by the
   *  Run History page. */
  async getAllRuns(): Promise<Array<{
    task_id: string;
    started_at: number;
    finished_at?: number;
    status: 'success' | 'failure' | 'skipped' | 'running';
    reason?: string;
    collected_count?: number;
    draft_count?: number;
  }>> {
    try {
      const r = await window.electron.scenario.getAllRuns();
      return Array.isArray(r?.runs) ? r.runs : [];
    } catch {
      return [];
    }
  }

  /** Rich run records (v2.4.22+) — full task snapshot + step logs +
   *  output dir. Replaces getAllRuns for the Run History UI. */
  async listRunRecords(filter?: { task_id?: string; platform?: string; light?: boolean }): Promise<Array<any>> {
    try {
      const r = await window.electron.scenario.listRunRecords(filter);
      return Array.isArray(r?.records) ? r.records : [];
    } catch {
      return [];
    }
  }

  /** Single record lookup, for the read-only detail page. */
  async getRunRecord(id: string): Promise<any | null> {
    try {
      const r = await window.electron.scenario.getRunRecord(id);
      return r?.record || null;
    } catch {
      return null;
    }
  }

  async getRunProgress(taskId?: string): Promise<ScenarioRunProgress | null> {
    try {
      return await window.electron.scenario.getRunProgress(taskId) || null;
    } catch {
      return null;
    }
  }

  /** v4.31.41: Persistent fallback for the detail page —— in-memory progress
   *  gets cleared 30s after task end, but runRecords keeps step_logs forever.
   *  UI mounts: read latest record, show its step_logs as a baseline; live
   *  polling overlays in-memory progress when task is actively running. */
  async getLatestRunRecord(taskId: string): Promise<any | null> {
    try {
      return await (window.electron.scenario as any).getLatestRunRecord(taskId) || null;
    } catch {
      return null;
    }
  }

  async requestAbort(taskId?: string): Promise<void> {
    try {
      await window.electron.scenario.requestAbort(taskId);
    } catch {}
  }

  // ── XHS login gate ──

  async checkXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' = 'xhs'): Promise<XhsLoginStatus> {
    try {
      return await window.electron.scenario.checkXhsLogin(platform as any);
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' = 'xhs'): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await window.electron.scenario.openXhsLogin(platform as any);
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
    const [runStatusResult, drafts] = await Promise.all([
      this.runStatus(taskId).catch(() => ({ runs: [], cooldown_ends_at: 0 })),
      this.listDrafts(taskId),
    ]);
    const runs = Array.isArray(runStatusResult?.runs) ? runStatusResult.runs : [];
    const cooldown_ends_at = runStatusResult?.cooldown_ends_at || 0;
    const last = runs.length > 0 ? runs[runs.length - 1] : null;
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
