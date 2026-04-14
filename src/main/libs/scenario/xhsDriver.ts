/**
 * xhsDriver.ts — XHS-specific utilities (login check, draft upload).
 *
 * The main orchestration logic has been moved to the server's orchestrator.js
 * and is executed by phaseRunner.ts. This file only contains standalone
 * operations called directly from the UI (not from the orchestrator).
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, getBrowserBridgeStatus } from '../browserBridge';
import type { ScenarioManifest, ComposedVariant } from './types';

// ── Utilities ──

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Login state check ──

export interface XhsLoginStatus {
  loggedIn: boolean;
  reason?: string;
}

export async function checkXhsLogin(): Promise<XhsLoginStatus> {
  // Always do a live check — don't trust cached connection status
  let tabs: any[] = [];
  try {
    // Short timeout: if browser is closed, this will fail fast
    const res = await sendBrowserCommand('tab_list', {}, 3000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
    if (!res || (!res.tabs && !Array.isArray(res))) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'tab_list failed — browser likely closed', { err: String(err) });
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  const xhsTab = tabs.find(
    (t: any) => typeof t.url === 'string' && /xiaohongshu\.com/i.test(t.url)
  );
  if (!xhsTab || typeof xhsTab.id !== 'number') {
    return { loggedIn: false, reason: 'xhs_tab_not_reachable' };
  }

  return { loggedIn: true };
}

export async function openXhsLogin(): Promise<{ ok: boolean; reason?: string }> {
  const url = 'https://www.xiaohongshu.com';
  try {
    await sendBrowserCommand('tab_create', { url }, 8000);
    return { ok: true };
  } catch {
    try {
      await sendBrowserCommand('navigate', { url }, 8000);
      return { ok: true };
    } catch (err2) {
      return { ok: false, reason: String(err2) };
    }
  }
}

// ── Draft upload ──

export interface DraftUploadInput {
  manifest: ScenarioManifest;
  variant: ComposedVariant;
  images: string[];
}

export async function uploadXhsDraft(input: DraftUploadInput): Promise<
  { status: 'ready_for_user' } | { status: 'failed'; error: string }
> {
  const { manifest, variant, images } = input;
  const publishUrl = manifest.creator_urls?.publish;
  if (!publishUrl) return { status: 'failed', error: 'no_creator_url' };

  try {
    await sendBrowserCommand('navigate', { url: publishUrl }, 30000);
    await sleep(randInt(2000, 4000));

    const pageUrl = await sendBrowserCommand('get_url', {}, 5000);
    if (typeof pageUrl?.url === 'string' && pageUrl.url.includes('login')) {
      return { status: 'failed', error: 'not_logged_in' };
    }

    await sendBrowserCommand(
      'click',
      { selector: '.publish-tab-item:nth-of-type(2), [class*="tab"]:has-text("图文")' },
      5000
    ).catch(() => {});
    await sleep(randInt(1000, 2000));

    for (const imagePath of images) {
      try {
        const fs = await import('fs');
        const buf = fs.readFileSync(imagePath);
        const base64 = buf.toString('base64');
        const fileName = imagePath.split(/[\\/]/).pop() || 'image.jpg';
        const mimeType = fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        await sendBrowserCommand(
          'upload_file',
          { selector: 'input[type="file"][accept*="image"], input[type="file"]', fileData: base64, fileName, mimeType },
          30000
        );
        await sleep(randInt(1500, 3000));
      } catch (err) {
        coworkLog('WARN', 'xhsDriver', 'image upload failed', { imagePath, err: String(err) });
      }
    }

    await sleep(randInt(2000, 3500));

    await sendBrowserCommand(
      'fill',
      { selector: '.title-input input, input[placeholder*="标题"]', value: variant.title },
      5000
    );
    await sleep(randInt(500, 1500));

    const paragraphs = (variant.body || '').split('\n');
    await sendBrowserCommand(
      'click',
      { selector: '.content-input [contenteditable="true"], [contenteditable="true"]' },
      5000
    ).catch(() => {});
    await sleep(randInt(300, 700));

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (p) await sendBrowserCommand('type', { text: p }, 10000);
      if (i < paragraphs.length - 1) await sendBrowserCommand('keypress', { key: 'Enter' }, 3000);
      await sleep(randInt(200, 600));
    }

    for (const raw of variant.hashtags) {
      const tag = raw.replace(/^#/, '');
      if (!tag) continue;
      await sendBrowserCommand('type', { text: '#' + tag }, 5000);
      await sendBrowserCommand('wait_for', { selector: '.topic-suggest-item, .hashtag-suggestion', timeout: 3000 }, 5000).catch(() => {});
      await sendBrowserCommand('click', { selector: '.topic-suggest-item, .hashtag-suggestion' }, 3000).catch(() => {});
      await sleep(randInt(600, 1200));
    }

    await sendBrowserCommand('scroll_to', { selector: 'button.ant-btn-default, button:has-text("草稿"), .save-draft-btn' }, 5000).catch(() => {});
    await sendBrowserCommand('screenshot', {}, 5000).catch(() => {});

    return { status: 'ready_for_user' };
  } catch (err) {
    return { status: 'failed', error: String(err) };
  }
}
