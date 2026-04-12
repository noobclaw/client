/**
 * Scenario Manager — top-level orchestrator for a scenario task run.
 *
 * Pipeline:
 *   1. riskGuard.canRunNow()
 *   2. loadPack()              — cached per version
 *   3. driver.discoverXhsNotes() via browserBridge primitives
 *   4. for each note:
 *        a. viralPoolClient.lookup() — skip local AI if cached
 *        b. localExtractor.extract() — one Haiku call per new note
 *        c. viralPoolClient.submit() — fire-and-forget upload
 *        d. localExtractor.compose() — one Haiku call per note for N variants
 *        e. taskStore.addDrafts()
 *   5. riskGuard.markRunSuccess()
 */

import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as viralPoolClient from './viralPoolClient';
import * as localExtractor from './localExtractor';
import { discoverXhsNotes } from './xhsDriver';
import { writeTaskArtifacts } from './artifactWriter';
import type {
  DiscoveredNote,
  Draft,
  ExtractionResult,
  ScenarioManifest,
  ScenarioPack,
  ScenarioTask,
} from './types';

const packCache = new Map<string, ScenarioPack>();

async function loadPack(scenario_id: string): Promise<ScenarioPack | null> {
  if (packCache.has(scenario_id)) return packCache.get(scenario_id)!;
  const raw = await viralPoolClient.fetchScenarioPack(scenario_id);
  if (!raw || !raw.manifest) return null;
  const pack: ScenarioPack = {
    manifest: raw.manifest as ScenarioManifest,
    skills: raw.skills || {},
  };
  packCache.set(scenario_id, pack);
  return pack;
}

export function clearPackCache(): void {
  packCache.clear();
  viralPoolClient.clearScenarioPackCache();
}

export interface RunOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  drafts?: Draft[];
}

export async function runTask(task: ScenarioTask): Promise<RunOutcome> {
  // 1. Load pack
  const pack = await loadPack(task.scenario_id);
  if (!pack) return { status: 'failed', reason: 'scenario_pack_not_found' };

  // 2. Gate
  const gate = riskGuard.canRunNow(task, pack.manifest.risk_caps);
  if (!gate.allowed) {
    riskGuard.markRunSkipped(task.id, gate.reason || 'gate');
    return { status: 'skipped', reason: gate.reason };
  }

  riskGuard.markRunStart(task.id);

  try {
    // 3. Discover
    const seen = taskStore.getSeenPostIds(task.id);
    let notes: DiscoveredNote[] = [];

    if (pack.manifest.platform === 'xhs') {
      notes = await discoverXhsNotes({ task, manifest: pack.manifest, seenPostIds: seen });
    } else {
      // Other platforms are placeholders in Phase 1
      riskGuard.markRunFailure(task.id, 'platform_not_implemented');
      return { status: 'failed', reason: 'platform_not_implemented' };
    }

    taskStore.recordSeen(task.id, notes.map(n => n.external_post_id));

    // 4. Extract + compose + save drafts
    const drafts: Draft[] = [];
    for (const note of notes) {
      try {
        const extraction = await extractWithCache(pack, note);
        if (!extraction) continue;

        const variants = await localExtractor.compose(pack, task, extraction, note.body);
        if (variants.length === 0) continue;

        for (const variant of variants) {
          drafts.push({
            id: crypto.randomUUID(),
            task_id: task.id,
            source_post: note,
            extraction,
            variant,
            status: 'pending',
            created_at: Date.now(),
          });
        }
      } catch (err) {
        coworkLog('WARN', 'scenarioManager', 'note processing failed', {
          post_id: note.external_post_id,
          err: String(err),
        });
      }
    }

    if (drafts.length > 0) {
      taskStore.addDrafts(drafts);
      // Persist originals + rewrites to disk organized by date/track.
      // Non-fatal on failure — we still consider the run successful if
      // the drafts got stored in the local task store.
      try {
        await writeTaskArtifacts(task, drafts);
      } catch (err) {
        coworkLog('WARN', 'scenarioManager', 'artifact save failed', { err: String(err) });
      }
    }

    riskGuard.markRunSuccess(task.id, notes.length, drafts.length);

    return {
      status: 'ok',
      collected_count: notes.length,
      draft_count: drafts.length,
      drafts,
    };
  } catch (err) {
    const msg = String(err);
    riskGuard.markRunFailure(task.id, msg);
    // Anomaly errors ("anomaly:captcha" etc.) are already recorded by driver
    return { status: 'failed', reason: msg };
  }
}

// ── Helpers ──

async function extractWithCache(pack: ScenarioPack, note: DiscoveredNote): Promise<ExtractionResult | null> {
  // Try backend pool first
  const cached = await viralPoolClient.lookup(
    pack.manifest.platform,
    note.external_post_id,
    pack.manifest.version
  );
  if (cached?.extraction?.result) {
    return cached.extraction.result;
  }

  // Local extraction
  const extraction = await localExtractor.extract(pack, note);
  if (!extraction) return null;

  // Fire-and-forget submit to pool
  viralPoolClient
    .submit({
      manifest: pack.manifest,
      note,
      extraction,
      ai_model: localExtractor.getCurrentModelName(),
    })
    .catch(err =>
      coworkLog('WARN', 'scenarioManager', 'pool submit failed (non-fatal)', { err: String(err) })
    );

  return extraction;
}
