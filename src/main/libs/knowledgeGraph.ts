/**
 * Knowledge Graph — Extracts entities and relationships from conversations,
 * stores them in SQLite, and provides contextual retrieval for prompt injection.
 *
 * Architecture:
 *   User message + AI response
 *     → Async LLM extraction (cheap model, ~400 tokens)
 *     → Store entities, relations, memories in SQLite
 *     → Next conversation: query graph → inject relevant context (~100-300 tokens)
 *
 * Memory types (inspired by human cognition):
 *   - Semantic: Facts about the user (name, job, tech stack)
 *   - Episodic: Time-bound events (deployed v2 on March 20)
 *   - Procedural: Preferences and habits (likes concise replies)
 */

import path from 'path';
import { getUserDataPath } from './platformAdapter';

// Conditionally load better-sqlite3 — unavailable in sidecar/pkg mode
let Database: any = null;
try { Database = require('better-sqlite3'); } catch {}

const DB_NAME = 'knowledge-graph.db';
const MAX_CONTEXT_TOKENS = 800;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * APPROX_CHARS_PER_TOKEN;

let db: any = null;

// --- Database Setup ---

export function initKnowledgeGraph(): void {
  if (!Database) { console.warn('[KnowledgeGraph] better-sqlite3 not available, skipping'); return; }
  try {
    const dbPath = path.join(getUserDataPath(), DB_NAME);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createTables();
    console.log('[KnowledgeGraph] Initialized:', dbPath);
  } catch (err) {
    console.error('[KnowledgeGraph] Failed to initialize:', err);
    db = null;
  }
}

function createTables(): void {
  if (!db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      attributes TEXT DEFAULT '{}',
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      mention_count INTEGER DEFAULT 1,
      UNIQUE(name, type)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity_id INTEGER NOT NULL,
      to_entity_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      context TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      UNIQUE(from_entity_id, to_entity_id, type)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic', 'procedural')),
      content TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      source_turn INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  `);
}

// --- Entity Operations ---

function upsertEntity(name: string, type: string, attributes?: Record<string, any>): number {
  if (!db) return -1;
  const existing = db.prepare('SELECT id, attributes, mention_count FROM entities WHERE name = ? AND type = ?').get(name, type) as any;

  if (existing) {
    const mergedAttrs = { ...JSON.parse(existing.attributes || '{}'), ...(attributes || {}) };
    db.prepare('UPDATE entities SET attributes = ?, last_seen = CURRENT_TIMESTAMP, mention_count = mention_count + 1 WHERE id = ?')
      .run(JSON.stringify(mergedAttrs), existing.id);
    return existing.id;
  }

  const result = db.prepare('INSERT INTO entities (name, type, attributes) VALUES (?, ?, ?)')
    .run(name, type, JSON.stringify(attributes || {}));
  return Number(result.lastInsertRowid);
}

function upsertRelation(fromId: number, toId: number, type: string, context: string = '', confidence: number = 0.8): void {
  if (!db || fromId < 0 || toId < 0) return;
  db.prepare(`
    INSERT INTO relations (from_entity_id, to_entity_id, type, context, confidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(from_entity_id, to_entity_id, type) DO UPDATE SET
      context = excluded.context,
      confidence = MAX(confidence, excluded.confidence)
  `).run(fromId, toId, type, context, confidence);
}

// --- Memory Operations ---

function addMemory(type: 'semantic' | 'episodic' | 'procedural', content: string, importance: number = 0.5): void {
  if (!db) return;

  // Deduplicate: check if similar memory exists
  const existing = db.prepare('SELECT id, content FROM memories WHERE type = ? AND content = ?').get(type, content) as any;
  if (existing) {
    db.prepare('UPDATE memories SET importance = MAX(importance, ?), last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?')
      .run(importance, existing.id);
    return;
  }

  db.prepare('INSERT INTO memories (type, content, importance) VALUES (?, ?, ?)')
    .run(type, content, importance);

  // Keep memory count manageable (max 200 per type)
  db.prepare(`
    DELETE FROM memories WHERE type = ? AND id NOT IN (
      SELECT id FROM memories WHERE type = ? ORDER BY importance DESC, last_accessed DESC LIMIT 200
    )
  `).run(type, type);
}

// --- Extraction (called async after each conversation turn) ---

export interface ExtractionResult {
  entities: Array<{ name: string; type: string; attributes?: Record<string, any> }>;
  relations: Array<{ from: string; to: string; type: string }>;
  memories: Array<{ type: 'semantic' | 'episodic' | 'procedural'; content: string; importance: number }>;
}

export function getExtractionPrompt(userMessage: string, assistantMessage: string): string {
  return `Extract structured knowledge from this conversation turn. Return valid JSON only.

USER: ${userMessage.slice(0, 1000)}
ASSISTANT: ${assistantMessage.slice(0, 500)}

Extract:
1. entities: people, companies, projects, technologies, places mentioned
2. relations: how entities relate to each other
3. memories: facts(semantic), events(episodic), preferences(procedural)

JSON format:
{
  "entities": [{"name": "...", "type": "person|company|project|technology|place"}],
  "relations": [{"from": "entity_name", "to": "entity_name", "type": "works_at|uses|built|knows|part_of|located_in|prefers"}],
  "memories": [{"type": "semantic|episodic|procedural", "content": "...", "importance": 0.0-1.0}]
}

Rules:
- Only extract information explicitly stated, never infer
- "importance" ranges: 0.9+ personal identity, 0.7-0.9 work/project facts, 0.5-0.7 preferences, <0.5 trivial
- Skip greetings, questions, and transient information
- If nothing worth extracting, return {"entities":[],"relations":[],"memories":[]}`;
}

export function storeExtractionResult(result: ExtractionResult): void {
  if (!db) return;

  try {
    const entityIdMap = new Map<string, number>();

    // Store entities
    for (const entity of result.entities) {
      if (!entity.name || !entity.type) continue;
      const id = upsertEntity(entity.name, entity.type, entity.attributes);
      entityIdMap.set(entity.name, id);
    }

    // Store relations
    for (const rel of result.relations) {
      const fromId = entityIdMap.get(rel.from) ?? getEntityIdByName(rel.from);
      const toId = entityIdMap.get(rel.to) ?? getEntityIdByName(rel.to);
      if (fromId >= 0 && toId >= 0) {
        upsertRelation(fromId, toId, rel.type);
      }
    }

    // Store memories
    for (const mem of result.memories) {
      if (!mem.content || !mem.type) continue;
      addMemory(mem.type, mem.content, mem.importance ?? 0.5);
    }
  } catch (err) {
    console.error('[KnowledgeGraph] Failed to store extraction:', err);
  }
}

function getEntityIdByName(name: string): number {
  if (!db) return -1;
  const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as any;
  return row ? row.id : -1;
}

// --- Query (called before each conversation turn) ---

export function queryRelevantContext(userMessage: string): string {
  if (!db) return '';

  try {
    const parts: string[] = [];

    // 1. Get top memories by importance
    const memories = db.prepare(`
      SELECT type, content, importance FROM memories
      ORDER BY importance DESC, last_accessed DESC
      LIMIT 15
    `).all() as Array<{ type: string; content: string; importance: number }>;

    if (memories.length > 0) {
      const semanticMems = memories.filter(m => m.type === 'semantic').map(m => m.content);
      const episodicMems = memories.filter(m => m.type === 'episodic').map(m => m.content);
      const proceduralMems = memories.filter(m => m.type === 'procedural').map(m => m.content);

      if (semanticMems.length > 0) {
        parts.push(`[User Facts] ${semanticMems.join('; ')}`);
      }
      if (episodicMems.length > 0) {
        parts.push(`[Recent Events] ${episodicMems.join('; ')}`);
      }
      if (proceduralMems.length > 0) {
        parts.push(`[User Preferences] ${proceduralMems.join('; ')}`);
      }

      // Update access timestamps
      for (const mem of memories) {
        db.prepare('UPDATE memories SET last_accessed = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE content = ?')
          .run(mem.content);
      }
    }

    // 2. Get keyword-matched entities and their relations
    const keywords = extractKeywords(userMessage);
    if (keywords.length > 0) {
      const placeholders = keywords.map(() => 'name LIKE ?').join(' OR ');
      const params = keywords.map(k => `%${k}%`);

      const matchedEntities = db.prepare(`
        SELECT id, name, type, attributes FROM entities
        WHERE ${placeholders}
        ORDER BY mention_count DESC
        LIMIT 10
      `).all(...params) as Array<{ id: number; name: string; type: string; attributes: string }>;

      if (matchedEntities.length > 0) {
        const entityParts: string[] = [];
        for (const entity of matchedEntities) {
          const rels = db.prepare(`
            SELECT e2.name, r.type FROM relations r
            JOIN entities e2 ON (r.to_entity_id = e2.id AND r.from_entity_id = ?)
              OR (r.from_entity_id = e2.id AND r.to_entity_id = ?)
            LIMIT 5
          `).all(entity.id, entity.id) as Array<{ name: string; type: string }>;

          const relStr = rels.map(r => `${r.type} ${r.name}`).join(', ');
          entityParts.push(`${entity.name}(${entity.type}${relStr ? ': ' + relStr : ''})`);
        }
        parts.push(`[Related] ${entityParts.join('; ')}`);
      }
    }

    // 3. Truncate to budget
    let context = parts.join('\n');
    if (context.length > MAX_CONTEXT_CHARS) {
      context = context.slice(0, MAX_CONTEXT_CHARS) + '...';
    }

    return context;
  } catch (err) {
    console.error('[KnowledgeGraph] Failed to query context:', err);
    return '';
  }
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: split by spaces/punctuation, filter short/common words
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'like',
    'through', 'after', 'over', 'between', 'out', 'up', 'down', 'and',
    'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very',
    'just', 'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your',
    'his', 'her', 'our', 'their', 'what', 'which', 'who', 'whom', 'how',
    'when', 'where', 'why', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'other', 'some', 'such', 'me', 'him', 'them', 'us', 'i', 'you',
    'he', 'she', 'we', 'they', 'help', 'please', 'thanks', 'thank',
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
    '个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '吗', '啊', '吧',
    '呢', '把', '被', '给', '让', '用', '从', '对', '能', '可以', '什么',
    '怎么', '帮', '帮我', '请', '谢谢', '打开', '关闭',
  ]);

  return text
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()))
    .slice(0, 5);
}

// --- Stats ---

export function getGraphStats(): { entities: number; relations: number; memories: number } {
  if (!db) return { entities: 0, relations: 0, memories: 0 };
  try {
    const entities = (db.prepare('SELECT COUNT(*) as count FROM entities').get() as any).count;
    const relations = (db.prepare('SELECT COUNT(*) as count FROM relations').get() as any).count;
    const memories = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as any).count;
    return { entities, relations, memories };
  } catch {
    return { entities: 0, relations: 0, memories: 0 };
  }
}

export function closeKnowledgeGraph(): void {
  if (db) {
    db.close();
    db = null;
  }
}
