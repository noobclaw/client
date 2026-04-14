/**
 * Artifact writer — saves scenario outputs to ~/Documents/NoobClaw/xhs/
 *
 * Layout:
 *   <Documents>/NoobClaw/xhs/<YYYY-MM-DD>/<track>/
 *     <run_number>/                    ← 同一天多次运行: 1, 2, 3...
 *       <post_id>/                     ← 每篇文章一个文件夹
 *         original.md                  ← 原文
 *         1-改写-新标题.md             ← 改写版本
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { isElectronMode } from '../platformAdapter';
import type { ScenarioTask, Draft, DiscoveredNote, ComposedVariant } from './types';

let appRef: any = null;
try {
  if (isElectronMode()) {
    appRef = require('electron').app;
  }
} catch {}

function getArtifactsRoot(): string {
  let base = appRef?.getPath?.('documents');
  if (!base) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    base = path.join(home, 'Documents');
  }
  return path.join(base, 'NoobClaw', 'xhs');
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitize(name: string): string {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim() || 'unnamed';
}

/** Find next run number for today (1, 2, 3...) */
function getNextRunNumber(dayDir: string): number {
  try {
    if (!fs.existsSync(dayDir)) return 1;
    const entries = fs.readdirSync(dayDir);
    let max = 0;
    for (const e of entries) {
      const n = parseInt(e, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

// ── Markdown renderers ──

function renderOriginalMd(post: DiscoveredNote): string {
  const lines: string[] = [];
  lines.push(`# ${post.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **平台**: 小红书`);
  lines.push(`- **链接**: ${post.external_url}`);
  lines.push(`- **作者**: ${post.author_name || '未知'}`);
  lines.push(`- **点赞**: ${post.metrics?.likes ?? 0}`);
  lines.push(`- **采集时间**: ${new Date(post.metrics?.collected_at || Date.now()).toLocaleString()}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push((post.body || '').replace(/\r\n/g, '\n'));
  lines.push('');
  if (post.hashtags && post.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(post.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  if (post.images && post.images.length > 0) {
    lines.push('## 图片');
    lines.push('');
    for (const src of post.images) lines.push(`- ${src}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderRewriteMd(variant: ComposedVariant, sourceTitle: string): string {
  const lines: string[] = [];
  lines.push(`# ${variant.title || '(untitled)'}`);
  lines.push('');
  lines.push(`> 原文标题: ${sourceTitle}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push((variant.body || '').replace(/\r\n/g, '\n'));
  lines.push('');
  if (variant.hashtags && variant.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(variant.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  return lines.join('\n');
}

// ── Public API ──

export interface ArtifactWriteResult {
  dir: string;
  files: string[];
}

// Cache run number per day+track to keep consistent within one task run
const runNumberCache = new Map<string, number>();

export async function writeTaskArtifacts(
  task: ScenarioTask,
  drafts: Draft[]
): Promise<ArtifactWriteResult> {
  const track = sanitize(task.track || task.scenario_id || 'unknown');
  const dayDir = path.join(getArtifactsRoot(), todayStr(), track);
  const files: string[] = [];

  // Get or create run number for this day+track
  const cacheKey = todayStr() + '/' + track;
  let runNum = runNumberCache.get(cacheKey);
  if (!runNum) {
    runNum = getNextRunNumber(dayDir);
    runNumberCache.set(cacheKey, runNum);
  }
  const runDir = path.join(dayDir, String(runNum));

  // Group drafts by source post
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
    const postDir = path.join(runDir, cleanId);

    try {
      fs.mkdirSync(postDir, { recursive: true });
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'mkdir failed', { postDir, err: String(err) });
      continue;
    }

    // Write original.md
    try {
      const origPath = path.join(postDir, 'original.md');
      fs.writeFileSync(origPath, renderOriginalMd(post), 'utf8');
      files.push(origPath);
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'write original failed', { postId, err: String(err) });
    }

    // Write analysis.json (if extraction exists)
    if (first.extraction) {
      try {
        const analysisPath = path.join(postDir, 'analysis.json');
        fs.writeFileSync(analysisPath, JSON.stringify(first.extraction, null, 2), 'utf8');
        files.push(analysisPath);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'write analysis failed', { postId, err: String(err) });
      }
    }

    // Write rewrite variants: "1-改写-新标题.md"
    let variantIdx = 0;
    for (const d of postDrafts) {
      if (!d.variant) continue;
      variantIdx++;
      const rewriteTitle = sanitize(d.variant.title || 'untitled');
      const filename = `${variantIdx}-改写-${rewriteTitle}.md`;
      try {
        const vPath = path.join(postDir, filename);
        fs.writeFileSync(vPath, renderRewriteMd(d.variant, post.title || ''), 'utf8');
        files.push(vPath);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'write variant failed', { postId, idx: variantIdx, err: String(err) });
      }
    }
  }

  coworkLog('INFO', 'artifactWriter', `wrote ${files.length} files`, { dir: runDir });
  return { dir: runDir, files };
}

export function getArtifactsRootPath(): string {
  return getArtifactsRoot();
}
