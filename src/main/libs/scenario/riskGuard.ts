/**
 * Risk Guard — enforces per-task frequency caps and anomaly cooldowns
 * for scenario automation runs. All decisions are local; no backend calls.
 *
 * State is persisted via a simple JSON file (no dependency on electron-store
 * so this compiles under the same tsconfig as the rest of src/main/libs).
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import type { RiskCaps, TaskRun, ScenarioTask } from './types';

export type AnomalyKind =
  | 'captcha'
  | 'login_wall'
  | 'rate_limited'
  | 'account_flag'
  | 'dom_missing'
  | 'upload_flagged';

interface GuardState {
  runs: Record<string, TaskRun[]>;       // task_id → recent runs (trimmed to 50)
  cooldowns: Record<string, number>;     // task_id → epoch ms when cooldown ends
}

let stateFilePath: string | null = null;
let state: GuardState = { runs: {}, cooldowns: {} };
let loaded = false;

export function initRiskGuard(userDataPath: string): void {
  stateFilePath = path.join(userDataPath, 'scenario-risk-guard.json');
  try {
    if (fs.existsSync(stateFilePath)) {
      const raw = fs.readFileSync(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        runs: parsed.runs || {},
        cooldowns: parsed.cooldowns || {},
      };
    }
  } catch (err) {
    coworkLog('WARN', 'riskGuard', 'failed to load state, starting fresh', { err: String(err) });
    state = { runs: {}, cooldowns: {} };
  }
  loaded = true;
}

function persist(): void {
  if (!stateFilePath) return;
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
  } catch (err) {
    coworkLog('WARN', 'riskGuard', 'failed to persist state', { err: String(err) });
  }
}

function ensureLoaded(): void {
  if (!loaded) {
    throw new Error('riskGuard not initialized; call initRiskGuard() first');
  }
}

// ── Helpers ──

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function isSameWeek(a: number, b: number): boolean {
  // ISO week: Monday start
  const fromMonday = (d: Date) => {
    const day = d.getDay();
    const offset = day === 0 ? 6 : day - 1;
    const res = new Date(d);
    res.setDate(res.getDate() - offset);
    res.setHours(0, 0, 0, 0);
    return res.getTime();
  };
  return fromMonday(new Date(a)) === fromMonday(new Date(b));
}

// ── Public API ──

export interface GateDecision {
  allowed: boolean;
  reason?:
    | 'disabled'
    | 'daily_cap_reached'
    | 'cooldown_active'
    | 'interval_not_met'
    | 'weekly_rest_enforced'
    | 'out_of_window';
  cooldown_ends_at?: number;
}

/**
 * Decide whether a task is allowed to run right now.
 */
export function canRunNow(task: ScenarioTask, caps: RiskCaps): GateDecision {
  ensureLoaded();
  if (!task.enabled) return { allowed: false, reason: 'disabled' };

  const now = Date.now();
  const runs = state.runs[task.id] || [];

  // 1. Cooldown
  const cooldown = state.cooldowns[task.id] || 0;
  if (cooldown > now) {
    return { allowed: false, reason: 'cooldown_active', cooldown_ends_at: cooldown };
  }

  // 2. Daily cap
  const todayRuns = runs.filter(r => isSameDay(r.started_at, now));
  if (todayRuns.length >= caps.max_daily_runs) {
    return { allowed: false, reason: 'daily_cap_reached' };
  }

  // 3. Minimum interval
  if (runs.length > 0) {
    const latest = runs[runs.length - 1];
    const hoursSince = (now - latest.started_at) / 3_600_000;
    if (hoursSince < caps.min_interval_hours) {
      return { allowed: false, reason: 'interval_not_met' };
    }
  }

  // 4. Weekly rest
  const weekRuns = runs.filter(r => isSameWeek(r.started_at, now));
  const distinctDays = new Set(weekRuns.map(r => new Date(r.started_at).toDateString())).size;
  if (distinctDays >= 7 - caps.weekly_rest_days) {
    return { allowed: false, reason: 'weekly_rest_enforced' };
  }

  return { allowed: true };
}

export function markRunStart(task_id: string): TaskRun {
  ensureLoaded();
  const run: TaskRun = { task_id, started_at: Date.now(), status: 'running' };
  state.runs[task_id] = (state.runs[task_id] || []).concat(run).slice(-50);
  persist();
  return run;
}

export function markRunSuccess(task_id: string, collected_count: number, draft_count: number): void {
  ensureLoaded();
  const runs = state.runs[task_id] || [];
  const latest = runs[runs.length - 1];
  if (latest && latest.status === 'running') {
    latest.status = 'ok';
    latest.ended_at = Date.now();
    latest.collected_count = collected_count;
    latest.draft_count = draft_count;
    persist();
  }
}

export function markRunFailure(task_id: string, reason: string): void {
  ensureLoaded();
  const runs = state.runs[task_id] || [];
  const latest = runs[runs.length - 1];
  if (latest && latest.status === 'running') {
    latest.status = 'failed';
    latest.ended_at = Date.now();
    latest.reason = reason;
    persist();
  }
}

export function markRunSkipped(task_id: string, reason: string): void {
  ensureLoaded();
  const run: TaskRun = {
    task_id,
    started_at: Date.now(),
    ended_at: Date.now(),
    status: 'skipped',
    reason,
  };
  state.runs[task_id] = (state.runs[task_id] || []).concat(run).slice(-50);
  persist();
}

export function recordAnomaly(task_id: string, kind: AnomalyKind, caps: RiskCaps): void {
  ensureLoaded();
  const hours = (() => {
    switch (kind) {
      case 'captcha':
        return caps.cooldown_captcha_hours;
      case 'rate_limited':
        return caps.cooldown_rate_limit_hours;
      case 'account_flag':
        return caps.cooldown_account_flag_hours;
      case 'dom_missing':
        return 12;
      case 'login_wall':
      case 'upload_flagged':
        return 0; // user must intervene, no automatic cooldown
      default:
        return 24;
    }
  })();

  if (hours > 0) {
    state.cooldowns[task_id] = Date.now() + hours * 3_600_000;
    persist();
  }

  coworkLog('WARN', 'riskGuard', `anomaly recorded`, { task_id, kind, cooldown_hours: hours });
}

export function getRuns(task_id: string): TaskRun[] {
  ensureLoaded();
  return state.runs[task_id] || [];
}

export function getCooldown(task_id: string): number {
  ensureLoaded();
  return state.cooldowns[task_id] || 0;
}

export function clearCooldown(task_id: string): void {
  ensureLoaded();
  delete state.cooldowns[task_id];
  persist();
}
