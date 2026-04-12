/**
 * Artifact writer — persists each scenario run's scraped originals and
 * AI-generated rewrites as markdown files under the user's Documents folder.
 *
 * Layout:
 *   <Documents>/NoobClaw/xhs/<YYYY-MM-DD>/<track>/
 *     <post_id>-original.md     — scraped post (title, body, url, metrics, extraction JSON)
 *     <post_id>-rewrite-1.md
 *     <post_id>-rewrite-2.md
 *     ...
 *
 * The user can find the daily output in a stable place without having to
 * dig into the client's userData directory. Everything is plain markdown,
 * so it's readable by Obsidian / VS Code / any editor.
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { isElectronMode } from '../platformAdapter';
import type { ScenarioTask, Draft, DiscoveredNote, ExtractionResult, ComposedVariant } from './types';

let appRef: any = null;
try {
  if (isElectronMode()) {
    appRef = require('electron').app;
  }
} catch {
  /* non-electron */
}

function getArtifactsRoot(): string {
  const base = appRef?.getPath?.('documents') || process.env.HOME || process.cwd();
  return path.join(base, 'NoobClaw', 'xhs');
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sanitize(name: string): string {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || 'unnamed';
}

function mdEscape(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/\r\n/g, '\n');
}

function renderOriginalMd(post: DiscoveredNote, extraction: ExtractionResult | null): string {
  const collected = new Date(post.metrics?.collected_at || Date.now()).toISOString();
  const lines: string[] = [];
  lines.push(`# ${post.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **Platform**: xiaohongshu`);
  lines.push(`- **Post ID**: ${post.external_post_id}`);
  lines.push(`- **URL**: ${post.external_url}`);
  lines.push(`- **Author**: ${post.author_name || 'unknown'}${post.author_followers ? ` (${post.author_followers} followers)` : ''}`);
  lines.push(`- **Published**: ${post.publish_time || 'unknown'}`);
  lines.push(`- **Collected**: ${collected}`);
  lines.push(`- **Likes**: ${post.metrics?.likes ?? 0}`);
  lines.push(`- **Comments**: ${post.metrics?.comments ?? 0}`);
  lines.push('');
  lines.push('## Body');
  lines.push('');
  lines.push(mdEscape(post.body));
  lines.push('');
  if (post.hashtags && post.hashtags.length > 0) {
    lines.push('## Hashtags');
    lines.push('');
    for (const h of post.hashtags) lines.push(`- ${h}`);
    lines.push('');
  }
  if (post.images && post.images.length > 0) {
    lines.push('## Images');
    lines.push('');
    for (const src of post.images) lines.push(`- ${src}`);
    lines.push('');
  }
  if (extraction) {
    lines.push('## AI Extraction');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(extraction, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function renderVariantMd(variant: ComposedVariant, sourceUrl: string, postId: string): string {
  const lines: string[] = [];
  lines.push(`# ${variant.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **Route**: ${variant.route || ''}`);
  lines.push(`- **Angle note**: ${variant.notes_for_user || ''}`);
  lines.push(`- **Source post**: ${postId}`);
  lines.push(`- **Source URL**: ${sourceUrl}`);
  lines.push('');
  lines.push('## Body');
  lines.push('');
  lines.push(mdEscape(variant.body));
  lines.push('');
  if (variant.hashtags && variant.hashtags.length > 0) {
    lines.push('## Hashtags');
    lines.push('');
    for (const h of variant.hashtags) lines.push(`- ${h}`);
    lines.push('');
  }
  if (variant.suggested_cover_text) {
    lines.push('## Suggested cover text');
    lines.push('');
    lines.push(variant.suggested_cover_text);
    lines.push('');
  }
  return lines.join('\n');
}

export interface ArtifactWriteResult {
  dir: string;
  files: string[];
}

/**
 * Write original + rewrite markdown files for a task run.
 * Returns the root directory and the list of written file paths.
 * Fails gracefully: logs a warning on any filesystem error and returns
 * whatever it managed to write.
 */
export async function writeTaskArtifacts(
  task: ScenarioTask,
  drafts: Draft[]
): Promise<ArtifactWriteResult> {
  const track = sanitize(task.track || task.scenario_id || 'unknown');
  const dir = path.join(getArtifactsRoot(), todayStr(), track);
  const files: string[] = [];

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    coworkLog('WARN', 'artifactWriter', 'mkdir failed', { dir, err: String(err) });
    return { dir, files };
  }

  // Group drafts by source post so we write one original + N variants per post
  const byPost = new Map<string, Draft[]>();
  for (const d of drafts) {
    const key = d.source_post.external_post_id;
    const arr = byPost.get(key) || [];
    arr.push(d);
    byPost.set(key, arr);
  }

  for (const [postId, postDrafts] of byPost) {
    const first = postDrafts[0];
    if (!first) continue;
    const post = first.source_post;
    const cleanId = sanitize(postId);

    // Original
    try {
      const origPath = path.join(dir, `${cleanId}-original.md`);
      fs.writeFileSync(origPath, renderOriginalMd(post, first.extraction), 'utf8');
      files.push(origPath);
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'write original failed', { postId, err: String(err) });
    }

    // Variants
    postDrafts.forEach((d, idx) => {
      try {
        const vPath = path.join(dir, `${cleanId}-rewrite-${idx + 1}.md`);
        fs.writeFileSync(vPath, renderVariantMd(d.variant, post.external_url, post.external_post_id), 'utf8');
        files.push(vPath);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'write variant failed', {
          postId,
          idx,
          err: String(err),
        });
      }
    });
  }

  coworkLog('INFO', 'artifactWriter', `wrote ${files.length} files`, { dir });
  return { dir, files };
}

export function getArtifactsRootPath(): string {
  return getArtifactsRoot();
}
