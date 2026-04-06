/**
 * Memory Store — SQLite-backed persistent memory with decay model.
 * Replaces knowledgeGraph.ts with OpenClaw's Dreaming-compatible schema.
 *
 * Features:
 * - 4 memory types: semantic, episodic, procedural, behavioral
 * - 14-day half-life decay for recency weighting
 * - Recall tracking (count + unique queries)
 * - Deduplication support (similarity scoring)
 * - Storage modes: inline, separate, both
 *
 * Ported from OpenClaw src/memory-host-sdk/
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'behavioral';
export type StorageMode = 'inline' | 'separate' | 'both';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  score: number;              // 0-1, importance
  recallCount: number;
  uniqueQueries: number;
  storageMode: StorageMode;
  sourceSessionIds: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  mergedFromIds: string[];    // IDs this memory was merged from (dedup)
}

export interface BehavioralPattern {
  id: string;
  description: string;
  strength: number;           // 0-1
  supportingMemoryIds: string[];
  detectedAt: number;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  averageScore: number;
  averageRecalls: number;
  oldestMemory: number | null;
  newestMemory: number | null;
}

// ── Constants ──

const HALF_LIFE_DAYS = 14;
const MAX_MEMORIES_PER_TYPE = 200;
const RECALL_BUDGET_TOKENS = 800;
const CHARS_PER_TOKEN = 4;
const MAX_RECALL_CHARS = RECALL_BUDGET_TOKENS * CHARS_PER_TOKEN;

// ── Database handle (set by init) ──

let db: any = null;

// ── Initialize ──

export function initMemoryStore(database: any): void {
  db = database;

  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.5,
    recall_count INTEGER NOT NULL DEFAULT 0,
    unique_queries INTEGER NOT NULL DEFAULT 0,
    storage_mode TEXT NOT NULL DEFAULT 'inline',
    source_session_ids TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    merged_from_ids TEXT DEFAULT '[]'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS behavioral_patterns (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    strength REAL NOT NULL,
    supporting_memory_ids TEXT DEFAULT '[]',
    detected_at INTEGER NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at DESC)`);

  coworkLog('INFO', 'memoryStore', 'Memory store initialized');
}

// ── Decay model ──

/**
 * Calculate decayed score based on 14-day half-life.
 * Reference: OpenClaw dreaming.ts — recency weighting
 */
export function decayedScore(record: MemoryRecord): number {
  const daysSinceAccess = (Date.now() - record.lastAccessedAt) / (1000 * 60 * 60 * 24);
  return record.score * Math.pow(0.5, daysSinceAccess / HALF_LIFE_DAYS);
}

// ── CRUD ──

export function storeMemory(params: {
  type: MemoryType;
  content: string;
  score?: number;
  sourceSessionId?: string;
  tags?: string[];
  storageMode?: StorageMode;
}): MemoryRecord {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  const record: MemoryRecord = {
    id,
    type: params.type,
    content: params.content,
    score: params.score ?? 0.5,
    recallCount: 0,
    uniqueQueries: 0,
    storageMode: params.storageMode ?? 'inline',
    sourceSessionIds: params.sourceSessionId ? [params.sourceSessionId] : [],
    tags: params.tags ?? [],
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    mergedFromIds: [],
  };

  if (db) {
    db.run(
      `INSERT INTO memories (id, type, content, score, recall_count, unique_queries, storage_mode, source_session_ids, tags, created_at, updated_at, last_accessed_at, merged_from_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.type, record.content, record.score, record.recallCount, record.uniqueQueries,
       record.storageMode, JSON.stringify(record.sourceSessionIds), JSON.stringify(record.tags),
       record.createdAt, record.updatedAt, record.lastAccessedAt, JSON.stringify(record.mergedFromIds)]
    );
  }

  // Enforce per-type limit
  enforceTypeLimit(params.type);

  return record;
}

export function recallMemories(query: string, limit: number = 15): MemoryRecord[] {
  if (!db) return [];

  // Keyword-based search with score + recency ranking
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
  const rows = db.exec(
    `SELECT * FROM memories ORDER BY score DESC, last_accessed_at DESC LIMIT 200`
  );

  if (!rows || rows.length === 0 || !rows[0].values) return [];

  const columns = rows[0].columns as string[];
  const allRecords = rows[0].values.map((row: any[]) => rowToRecord(columns, row));

  // Score by keyword matches + decay
  const scored = allRecords.map((rec: MemoryRecord) => {
    const contentLower = rec.content.toLowerCase();
    const tagStr = rec.tags.join(' ').toLowerCase();
    let matchScore = 0;
    for (const kw of keywords) {
      if (contentLower.includes(kw)) matchScore += 1;
      if (tagStr.includes(kw)) matchScore += 0.5;
    }
    const effective = matchScore > 0 ? decayedScore(rec) + matchScore * 0.1 : decayedScore(rec) * 0.1;
    return { record: rec, effective };
  }).filter((s: any) => s.effective > 0.01);

  scored.sort((a: any, b: any) => b.effective - a.effective);
  const results = scored.slice(0, limit).map((s: any) => s.record);

  // Update recall counts
  const queryHash = simpleHash(query);
  for (const rec of results) {
    db.run(
      `UPDATE memories SET recall_count = recall_count + 1, unique_queries = unique_queries + 1, last_accessed_at = ? WHERE id = ?`,
      [Date.now(), rec.id]
    );
  }

  return results;
}

export function getMemoriesByType(type: MemoryType, limit: number = 50): MemoryRecord[] {
  if (!db) return [];
  const rows = db.exec(
    `SELECT * FROM memories WHERE type = ? ORDER BY score DESC, last_accessed_at DESC LIMIT ?`,
    [type, limit]
  );
  if (!rows || rows.length === 0) return [];
  const columns = rows[0].columns as string[];
  return rows[0].values.map((row: any[]) => rowToRecord(columns, row));
}

export function getRecentMemories(lookbackMs: number, limit: number = 100): MemoryRecord[] {
  if (!db) return [];
  const cutoff = Date.now() - lookbackMs;
  const rows = db.exec(
    `SELECT * FROM memories WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
    [cutoff, limit]
  );
  if (!rows || rows.length === 0) return [];
  const columns = rows[0].columns as string[];
  return rows[0].values.map((row: any[]) => rowToRecord(columns, row));
}

export function getHighFrequencyMemories(minRecalls: number = 3, minUniqueQueries: number = 3, limit: number = 10): MemoryRecord[] {
  if (!db) return [];
  const rows = db.exec(
    `SELECT * FROM memories WHERE recall_count >= ? AND unique_queries >= ? AND score >= 0.8 ORDER BY recall_count DESC LIMIT ?`,
    [minRecalls, minUniqueQueries, limit]
  );
  if (!rows || rows.length === 0) return [];
  const columns = rows[0].columns as string[];
  return rows[0].values.map((row: any[]) => rowToRecord(columns, row));
}

export function updateMemory(id: string, updates: Partial<Pick<MemoryRecord, 'content' | 'score' | 'tags' | 'type'>>): boolean {
  if (!db) return false;
  const sets: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
  if (updates.score !== undefined) { sets.push('score = ?'); values.push(updates.score); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }

  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, values);
  return true;
}

export function deleteMemory(id: string): boolean {
  if (!db) return false;
  db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  return true;
}

export function mergeMemories(keepId: string, mergeIds: string[], mergedContent: string): boolean {
  if (!db) return false;
  const now = Date.now();

  // Update the kept memory
  db.run(
    `UPDATE memories SET content = ?, merged_from_ids = ?, updated_at = ? WHERE id = ?`,
    [mergedContent, JSON.stringify(mergeIds), now, keepId]
  );

  // Delete merged memories
  for (const id of mergeIds) {
    if (id !== keepId) db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  }

  return true;
}

// ── Behavioral patterns ──

export function storeBehavioralPattern(pattern: Omit<BehavioralPattern, 'id'>): BehavioralPattern {
  const id = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: BehavioralPattern = { id, ...pattern };

  if (db) {
    db.run(
      `INSERT INTO behavioral_patterns (id, description, strength, supporting_memory_ids, detected_at) VALUES (?, ?, ?, ?, ?)`,
      [full.id, full.description, full.strength, JSON.stringify(full.supportingMemoryIds), full.detectedAt]
    );
  }

  return full;
}

export function getBehavioralPatterns(minStrength: number = 0.5): BehavioralPattern[] {
  if (!db) return [];
  const rows = db.exec(
    `SELECT * FROM behavioral_patterns WHERE strength >= ? ORDER BY strength DESC`,
    [minStrength]
  );
  if (!rows || rows.length === 0) return [];
  return rows[0].values.map((row: any[]) => ({
    id: row[0] as string,
    description: row[1] as string,
    strength: row[2] as number,
    supportingMemoryIds: JSON.parse(row[3] as string || '[]'),
    detectedAt: row[4] as number,
  }));
}

// ── Stats ──

export function getMemoryStats(): MemoryStats {
  if (!db) return { total: 0, byType: { semantic: 0, episodic: 0, procedural: 0, behavioral: 0 }, averageScore: 0, averageRecalls: 0, oldestMemory: null, newestMemory: null };

  const countRows = db.exec(`SELECT type, COUNT(*) as cnt FROM memories GROUP BY type`);
  const byType: Record<MemoryType, number> = { semantic: 0, episodic: 0, procedural: 0, behavioral: 0 };
  let total = 0;
  if (countRows && countRows[0]) {
    for (const row of countRows[0].values) {
      byType[row[0] as MemoryType] = row[1] as number;
      total += row[1] as number;
    }
  }

  const avgRows = db.exec(`SELECT AVG(score), AVG(recall_count), MIN(created_at), MAX(created_at) FROM memories`);
  const avg = avgRows?.[0]?.values?.[0] || [0, 0, null, null];

  return {
    total,
    byType,
    averageScore: (avg[0] as number) || 0,
    averageRecalls: (avg[1] as number) || 0,
    oldestMemory: avg[2] as number | null,
    newestMemory: avg[3] as number | null,
  };
}

// ── Format for prompt injection ──

export function formatMemoriesForPrompt(memories: MemoryRecord[]): string {
  if (memories.length === 0) return '';

  let totalChars = 0;
  const lines: string[] = ['<memories>'];

  for (const mem of memories) {
    const line = `- [${mem.type}] ${mem.content}`;
    if (totalChars + line.length > MAX_RECALL_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  lines.push('</memories>');
  return lines.join('\n');
}

// ── Helpers ──

function rowToRecord(columns: string[], row: any[]): MemoryRecord {
  const obj: any = {};
  columns.forEach((col, i) => obj[col] = row[i]);
  return {
    id: obj.id,
    type: obj.type,
    content: obj.content,
    score: obj.score,
    recallCount: obj.recall_count,
    uniqueQueries: obj.unique_queries,
    storageMode: obj.storage_mode,
    sourceSessionIds: JSON.parse(obj.source_session_ids || '[]'),
    tags: JSON.parse(obj.tags || '[]'),
    createdAt: obj.created_at,
    updatedAt: obj.updated_at,
    lastAccessedAt: obj.last_accessed_at,
    mergedFromIds: JSON.parse(obj.merged_from_ids || '[]'),
  };
}

function enforceTypeLimit(type: MemoryType): void {
  if (!db) return;
  const countRow = db.exec(`SELECT COUNT(*) FROM memories WHERE type = ?`, [type]);
  const count = countRow?.[0]?.values?.[0]?.[0] as number || 0;

  if (count > MAX_MEMORIES_PER_TYPE) {
    const excess = count - MAX_MEMORIES_PER_TYPE;
    db.run(
      `DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE type = ? ORDER BY score ASC, last_accessed_at ASC LIMIT ?)`,
      [type, excess]
    );
    coworkLog('INFO', 'memoryStore', `Evicted ${excess} low-score ${type} memories (LRU)`);
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
