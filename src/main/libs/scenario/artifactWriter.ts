/**
 * Artifact writer — persists scenario outputs to the user's Documents folder.
 *
 * Layout (one folder per article):
 *   <Documents>/NoobClaw/xhs/<YYYY-MM-DD>/<track>/
 *     <post_id>/
 *       original.md           — scraped post (title, body, metrics, hashtags)
 *       images/
 *         1.jpg, 2.jpg ...    — downloaded images
 *       analysis.json         — AI extraction/analysis report
 *       rewrite-1.md          — AI rewrite variant 1
 *       rewrite-2.md          — AI rewrite variant 2
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
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
  let base = appRef?.getPath?.('documents');
  if (!base) {
    // Tauri / sidecar mode — construct Documents path manually
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

function mdEscape(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/\r\n/g, '\n');
}

// ── Image downloader ──

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return reject(new Error('invalid url'));
    }
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const loc = res.headers.location;
        if (loc) {
          file.close();
          fs.unlinkSync(dest);
          downloadFile(loc, dest).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function getImageExt(url: string): string {
  const m = url.match(/\.(jpg|jpeg|png|gif|webp|avif)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

async function downloadImages(urls: string[], dir: string): Promise<string[]> {
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const saved: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const ext = getImageExt(urls[i]);
    const filename = `${i + 1}.${ext}`;
    const dest = path.join(imgDir, filename);
    try {
      await downloadFile(urls[i], dest);
      saved.push(dest);
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'image download failed', { url: urls[i].slice(0, 80), err: String(err) });
    }
  }
  return saved;
}

// ── Markdown renderers ──

function renderOriginalMd(post: DiscoveredNote, imageFiles: string[]): string {
  const collected = new Date(post.metrics?.collected_at || Date.now()).toISOString();
  const lines: string[] = [];
  lines.push(`# ${post.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **平台**: 小红书`);
  lines.push(`- **文章ID**: ${post.external_post_id}`);
  lines.push(`- **链接**: ${post.external_url}`);
  lines.push(`- **作者**: ${post.author_name || '未知'}${post.author_followers ? ` (${post.author_followers} 粉丝)` : ''}`);
  lines.push(`- **发布时间**: ${post.publish_time || '未知'}`);
  lines.push(`- **采集时间**: ${collected}`);
  lines.push(`- **点赞**: ${post.metrics?.likes ?? 0}`);
  lines.push(`- **评论**: ${post.metrics?.comments ?? 0}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push(mdEscape(post.body));
  lines.push('');
  if (post.hashtags && post.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(post.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  if (imageFiles.length > 0) {
    lines.push('## 图片');
    lines.push('');
    for (const f of imageFiles) {
      lines.push(`![](images/${path.basename(f)})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderVariantMd(variant: ComposedVariant, sourcePostId: string): string {
  const lines: string[] = [];
  lines.push(`# ${variant.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **路线**: ${variant.route || ''}`);
  lines.push(`- **角度说明**: ${variant.notes_for_user || ''}`);
  lines.push(`- **原文ID**: ${sourcePostId}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push(mdEscape(variant.body));
  lines.push('');
  if (variant.hashtags && variant.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(variant.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  if (variant.suggested_cover_text) {
    lines.push('## 建议封面文字');
    lines.push('');
    lines.push(variant.suggested_cover_text);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Public API ──

export interface ArtifactWriteResult {
  dir: string;
  files: string[];
}

/**
 * Write original + rewrite markdown files for a task run.
 * Each post gets its own folder with images downloaded.
 */
export async function writeTaskArtifacts(
  task: ScenarioTask,
  drafts: Draft[]
): Promise<ArtifactWriteResult> {
  const track = sanitize(task.track || task.scenario_id || 'unknown');
  const rootDir = path.join(getArtifactsRoot(), todayStr(), track);
  const files: string[] = [];

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
    const postDir = path.join(rootDir, cleanId);

    try {
      fs.mkdirSync(postDir, { recursive: true });
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'mkdir failed', { postDir, err: String(err) });
      continue;
    }

    // Download images
    let imageFiles: string[] = [];
    if (post.images && post.images.length > 0) {
      try {
        imageFiles = await downloadImages(post.images, postDir);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'downloadImages failed', { postId, err: String(err) });
      }
    }

    // Write original.md
    try {
      const origPath = path.join(postDir, 'original.md');
      fs.writeFileSync(origPath, renderOriginalMd(post, imageFiles), 'utf8');
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

    // Write rewrite variants
    let variantIdx = 0;
    for (const d of postDrafts) {
      if (!d.variant) continue;
      variantIdx++;
      try {
        const vPath = path.join(postDir, `rewrite-${variantIdx}.md`);
        fs.writeFileSync(vPath, renderVariantMd(d.variant, post.external_post_id), 'utf8');
        files.push(vPath);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'write variant failed', { postId, idx: variantIdx, err: String(err) });
      }
    }
  }

  coworkLog('INFO', 'artifactWriter', `wrote ${files.length} files`, { dir: rootDir });
  return { dir: rootDir, files };
}

export function getArtifactsRootPath(): string {
  return getArtifactsRoot();
}
