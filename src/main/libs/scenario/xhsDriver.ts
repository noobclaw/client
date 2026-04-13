/**
 * Xiaohongshu driver — executes scenario discovery and draft-upload flows
 * by issuing commands to the existing Chrome extension via browserBridge.
 *
 * No Playwright. No new extension code. We only use primitives that are
 * already implemented in chrome-extension/content.js:
 *   navigate, javascript, scroll, click, fill, type, wait_for, keypress,
 *   upload_file, screenshot, get_value, scroll_to, go_back
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, getBrowserBridgeStatus } from '../browserBridge';
import * as riskGuard from './riskGuard';
import type {
  DiscoveredNote,
  ScenarioManifest,
  ScenarioTask,
  RiskCaps,
  ComposedVariant,
} from './types';

// ── Utilities ──

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Login state check (used before runs, before draft pushes, and from UI) ──

// Login probe: fetch XHS user API (same-origin, cookies auto-attached).
// This works regardless of DOM structure or HttpOnly cookie flags.
// If logged in, the API returns user data (200). If not, it 401s or
// returns an error code in the JSON body.
const LOGIN_PROBE_CODE = `
(async function() {
  try {
    // Quick check: are we even on xiaohongshu.com?
    if (!/xiaohongshu\\.com/i.test(location.hostname)) {
      return JSON.stringify({ loggedIn: false, reason: 'not_xhs_page' });
    }

    // Call a lightweight XHS API that requires login.
    // /api/sns/web/v1/user/selfinfo returns user profile when logged in.
    var resp = await fetch('/api/sns/web/v1/user/selfinfo', {
      method: 'GET',
      credentials: 'include',
      headers: { 'accept': 'application/json' }
    });

    if (!resp.ok) {
      // 401/403 = not logged in
      return JSON.stringify({ loggedIn: false, reason: 'api_unauthorized' });
    }

    var data = await resp.json();
    // XHS API returns { success: true, data: { ... } } when logged in,
    // or { success: false, code: -100 } when session expired.
    if (data && data.success === true) {
      return JSON.stringify({ loggedIn: true });
    }
    if (data && (data.code === -100 || data.code === -101 || data.success === false)) {
      return JSON.stringify({ loggedIn: false, reason: 'session_expired' });
    }

    // Got a response but can't parse — assume logged in
    return JSON.stringify({ loggedIn: true });
  } catch (err) {
    // Network error or CORS — fall back to DOM check
    try {
      // Sidebar "我" link = logged in
      var meLink = document.querySelector('a[href*="/user/profile"], a[href*="/user/self"]');
      if (meLink) return JSON.stringify({ loggedIn: true });

      // Visible "登录" button = not logged in
      var btns = document.querySelectorAll('button, a');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').trim() === '登录') {
          var r = btns[i].getBoundingClientRect();
          if (r.width > 30 && r.height > 20) {
            return JSON.stringify({ loggedIn: false, reason: 'sign_in_button' });
          }
        }
      }
      return JSON.stringify({ loggedIn: true });
    } catch (e2) {
      return JSON.stringify({ loggedIn: false, reason: 'probe_error' });
    }
  }
})()
`;

export interface XhsLoginStatus {
  loggedIn: boolean;
  /** Machine-readable code explaining why */
  reason?:
    | 'login_page'
    | 'login_modal'
    | 'sign_in_button'
    | 'no_response'
    | 'browser_not_connected'
    | 'xhs_tab_not_reachable'
    | 'probe_error'
    | string;
}

/**
 * Check whether the user is currently logged into Xiaohongshu in their real
 * browser. Never opens a new tab on failure — if there is no XHS tab, it
 * reports "no tab" back to the caller so the UI can decide whether to open
 * one (via `openXhsLogin`). This keeps the check cheap and non-intrusive.
 *
 * Contract:
 *   - If browser extension is not connected → { loggedIn: false, reason: 'browser_not_connected' }
 *   - If no tab on *.xiaohongshu.com exists → { loggedIn: false, reason: 'xhs_tab_not_reachable' }
 *   - Otherwise runs a DOM probe on that tab and returns its verdict
 */
export async function checkXhsLogin(): Promise<XhsLoginStatus> {
  // 0. Check whether the browser extension bridge is actually connected.
  //    This distinguishes "extension not installed" from "tab_list timed out".
  try {
    const bridgeStatus = getBrowserBridgeStatus();
    if (!bridgeStatus.connected) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch {
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  // 1. Find an existing xhs tab
  let tabs: any[] = [];
  try {
    const res = await sendBrowserCommand('tab_list', {}, 8000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'tab_list failed (bridge connected but command threw)', { err: String(err) });
    // Bridge is connected but command failed — still report as connected,
    // just say "can't reach xhs tab" so the modal shows step 2 not step 1.
    return { loggedIn: false, reason: 'xhs_tab_not_reachable' };
  }

  const xhsTab = tabs.find(
    (t: any) => typeof t.url === 'string' && /xiaohongshu\.com/i.test(t.url)
  );
  if (!xhsTab || typeof xhsTab.id !== 'number') {
    return { loggedIn: false, reason: 'xhs_tab_not_reachable' };
  }

  // 2. Make it the active tab so content-script primitives target it
  try {
    await sendBrowserCommand('tab_switch', { tabId: xhsTab.id }, 5000);
    await sleep(randInt(300, 800));
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'tab_switch failed', { err: String(err) });
    return { loggedIn: false, reason: 'xhs_tab_not_reachable' };
  }

  // 3. Run the DOM probe
  try {
    const result = await sendBrowserCommand('javascript', { code: LOGIN_PROBE_CODE }, 10000);
    const raw = result?.result;
    if (typeof raw !== 'string') return { loggedIn: false, reason: 'no_response' };
    const parsed = JSON.parse(raw);
    return { loggedIn: Boolean(parsed?.loggedIn), reason: parsed?.reason };
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'login probe failed', { err: String(err) });
    return { loggedIn: false, reason: 'probe_error' };
  }
}

/**
 * Open Xiaohongshu in a new browser tab so the user can log in. Called from
 * the LoginRequiredModal when the user clicks "open login page".
 */
export async function openXhsLogin(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await sendBrowserCommand(
      'tab_create',
      { url: 'https://www.xiaohongshu.com' },
      10000
    );
    return { ok: true };
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'openXhsLogin failed', { err: String(err) });
    return { ok: false, reason: String(err) };
  }
}

async function humanPause(caps: RiskCaps): Promise<void> {
  await sleep(randInt(caps.min_scroll_delay_ms, caps.max_scroll_delay_ms));
}

async function readingPause(caps: RiskCaps): Promise<void> {
  await sleep(randInt(caps.read_dwell_min_ms, caps.read_dwell_max_ms));
}

function parseLikes(text: string): number {
  if (!text) return 0;
  const s = String(text).trim();
  const match = s.match(/([\d.]+)\s*([万wW千kK]*)/);
  if (!match) return parseInt(s, 10) || 0;
  const n = parseFloat(match[1]);
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(n * 1000);
  return Math.round(n);
}

function keywordMatch(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return keywords.some(k => lowered.includes(k.toLowerCase()));
}

// ── Anomaly detection via page eval ──

const ANOMALY_DETECTOR_CODE = `
(function() {
  var body = document.body ? (document.body.innerText || '') : '';
  var url = location.href || '';
  if (document.querySelector('.captcha-slider, .nc_iconfont, iframe[src*="captcha"]')) return 'captcha';
  if (/\\/login|\\bsignin\\b/i.test(url) || document.querySelector('.login-container')) return 'login_wall';
  if (body.indexOf('操作过于频繁') >= 0 || body.indexOf('访问频率') >= 0) return 'rate_limited';
  if (body.indexOf('账号异常') >= 0 || body.indexOf('暂时限流') >= 0) return 'account_flag';
  return 'ok';
})()
`;

async function checkAnomaly(): Promise<
  'ok' | 'captcha' | 'login_wall' | 'rate_limited' | 'account_flag'
> {
  try {
    const res = await sendBrowserCommand('javascript', { code: ANOMALY_DETECTOR_CODE }, 5000);
    const raw = res?.result || 'ok';
    if (raw === 'captcha' || raw === 'login_wall' || raw === 'rate_limited' || raw === 'account_flag') {
      return raw;
    }
    return 'ok';
  } catch {
    return 'ok';
  }
}

// ── Feed card reader (single round-trip DOM eval) ──

const FEED_CARDS_CODE = `
(function() {
  function q(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }
  var cards = document.querySelectorAll('section.note-item, a[href^="/explore/"], div[data-v-noteitem]');
  var out = [];
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    if (!c || !c.getBoundingClientRect) continue;
    var rect = c.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    var isVideo = !!c.querySelector('.play-icon, [class*="video-icon"]');
    var titleEl = c.querySelector('a.title span, .title, [class*="title"]');
    var likesEl = c.querySelector('.like-wrapper .count, .count, [class*="like"]');
    var linkEl = c.matches('a[href^="/explore/"]') ? c : c.querySelector('a[href^="/explore/"]');
    if (!linkEl) continue;
    var href = linkEl.getAttribute('href');
    if (!href) continue;
    var idMatch = href.match(/\\/explore\\/([a-f0-9]+)/i);
    if (!idMatch) continue;
    out.push({
      post_id: idMatch[1],
      url: href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href,
      title: titleEl ? (titleEl.textContent || '').trim().slice(0, 200) : '',
      likes_text: likesEl ? (likesEl.textContent || '').trim() : '0',
      is_video: isVideo,
    });
  }
  return JSON.stringify(out);
})()
`;

interface FeedCard {
  post_id: string;
  url: string;
  title: string;
  likes_text: string;
  is_video: boolean;
}

async function readFeedCards(): Promise<FeedCard[]> {
  try {
    const res = await sendBrowserCommand('javascript', { code: FEED_CARDS_CODE }, 8000);
    const raw = res?.result;
    if (typeof raw !== 'string') return [];
    return JSON.parse(raw) as FeedCard[];
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'readFeedCards failed', { err: String(err) });
    return [];
  }
}

// ── Detail page reader ──

const DETAIL_PAGE_CODE = `
(function() {
  function text(sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) return (el.textContent || '').trim();
    }
    return '';
  }
  function many(sel, attr) {
    var arr = [];
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var v = attr ? els[i].getAttribute(attr) : (els[i].textContent || '').trim();
      if (v) arr.push(v);
    }
    return arr;
  }
  var out = {
    title: text(['#detail-title', 'h1.title', '[class*="title"]']),
    body: text(['#detail-desc', '.content', '[class*="desc"]']),
    images: many('.carousel .slide img, [class*="swiper-slide"] img', 'src'),
    publish_time: text(['.publish-date', '.date', 'time']),
    hashtags: many('.hash-tag, a[href*="page/topics/"]', null),
    author_name: text(['.author .name', '.user .name']),
    author_followers_text: text(['.follower-count']),
  };
  return JSON.stringify(out);
})()
`;

interface DetailPagePayload {
  title: string;
  body: string;
  images: string[];
  publish_time: string;
  hashtags: string[];
  author_name: string;
  author_followers_text: string;
}

async function readDetailPage(): Promise<DetailPagePayload | null> {
  try {
    const res = await sendBrowserCommand('javascript', { code: DETAIL_PAGE_CODE }, 8000);
    const raw = res?.result;
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw) as DetailPagePayload;
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'readDetailPage failed', { err: String(err) });
    return null;
  }
}

// ── Discovery ──

export interface DiscoveryOptions {
  task: ScenarioTask;
  manifest: ScenarioManifest;
  seenPostIds: Set<string>;
}

export async function discoverXhsNotes(opts: DiscoveryOptions): Promise<DiscoveredNote[]> {
  const { task, manifest, seenPostIds } = opts;
  const caps = manifest.risk_caps;
  const qualify = manifest.qualify || { min_likes: 500, max_age_hours: 48, exclude_types: ['video'] };
  const target = Math.max(1, Math.min(5, task.daily_count));
  const startedAt = Date.now();

  const collected: DiscoveredNote[] = [];
  const candidates: FeedCard[] = [];

  async function visitFeedAndCollect(url: string): Promise<void> {
    await sendBrowserCommand('navigate', { url }, 30000);
    await sleep(randInt(2500, 5500));

    const anomaly = await checkAnomaly();
    if (anomaly !== 'ok') {
      riskGuard.recordAnomaly(task.id, anomaly as any, caps);
      throw new Error(`anomaly:${anomaly}`);
    }

    for (let scroll = 0; scroll < caps.max_scroll_per_run; scroll++) {
      if (Date.now() - startedAt > caps.max_run_duration_ms) {
        throw new Error('run_duration_exceeded');
      }
      const cards = await readFeedCards();
      let fresh = 0;
      for (const card of cards) {
        if (seenPostIds.has(card.post_id)) continue;
        if (candidates.some(c => c.post_id === card.post_id)) continue;
        if (card.is_video && qualify.exclude_types?.includes('video')) continue;
        if (parseLikes(card.likes_text) < (qualify.min_likes || 0)) continue;
        if (!keywordMatch(card.title, task.keywords)) continue;
        candidates.push(card);
        fresh++;
        if (candidates.length >= target) return;
      }
      if (fresh === 0 && scroll > 2) {
        // DOM unchanged after consecutive scrolls — maybe reached end or
        // XHS re-shipped. Check anomaly once more then break out.
        const recheck = await checkAnomaly();
        if (recheck !== 'ok') {
          riskGuard.recordAnomaly(task.id, recheck as any, caps);
          throw new Error(`anomaly:${recheck}`);
        }
      }
      await sendBrowserCommand('scroll', { direction: 'down', amount: randInt(2, 4) }, 3000);
      await humanPause(caps);
    }
  }

  try {
    // 1. Try the explore page first
    await visitFeedAndCollect(manifest.entry_urls.explore);

    // 2. Fall through to search pages per keyword until target met
    for (const kw of task.keywords) {
      if (candidates.length >= target) break;
      const searchUrl = manifest.entry_urls.search.replace('{keyword}', encodeURIComponent(kw));
      await visitFeedAndCollect(searchUrl);
    }
  } catch (err) {
    // Visit loop threw — propagate but keep whatever we already have
    const msg = String(err);
    if (!msg.startsWith('anomaly:') && msg !== 'run_duration_exceeded') {
      coworkLog('WARN', 'xhsDriver', 'feed visit threw', { err: msg });
    } else {
      throw err;
    }
  }

  // 3. For each candidate, open detail, read body + images, then go_back
  for (const card of candidates.slice(0, target)) {
    if (Date.now() - startedAt > caps.max_run_duration_ms) break;

    try {
      await sendBrowserCommand('navigate', { url: card.url }, 30000);
      await sleep(randInt(2000, 4000));

      const anomaly = await checkAnomaly();
      if (anomaly !== 'ok') {
        riskGuard.recordAnomaly(task.id, anomaly as any, caps);
        throw new Error(`anomaly:${anomaly}`);
      }

      const detail = await readDetailPage();
      if (!detail || !detail.body) {
        coworkLog('WARN', 'xhsDriver', 'detail empty, skipping', { post_id: card.post_id });
        continue;
      }

      const likes = parseLikes(card.likes_text);
      collected.push({
        external_post_id: card.post_id,
        external_url: card.url,
        title: detail.title || card.title,
        body: detail.body,
        images: detail.images || [],
        hashtags: detail.hashtags || [],
        publish_time: detail.publish_time || undefined,
        author_name: detail.author_name || undefined,
        author_followers: parseLikes(detail.author_followers_text || '0') || undefined,
        metrics: {
          likes,
          comments: 0,
          collected_at: Date.now(),
        },
      });
      await readingPause(caps);
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith('anomaly:')) throw err;
      coworkLog('WARN', 'xhsDriver', 'detail fetch failed', { post_id: card.post_id, err: msg });
    }
  }

  return collected;
}

// ── Draft upload ──

export interface DraftUploadInput {
  manifest: ScenarioManifest;
  variant: ComposedVariant;
  images: string[]; // absolute local file paths
}

/**
 * Navigate to the XHS creator and populate an image-note draft. Stops at
 * the "存草稿" button without clicking it. User must confirm in the browser.
 */
export async function uploadXhsDraft(input: DraftUploadInput): Promise<
  { status: 'ready_for_user' } | { status: 'failed'; error: string }
> {
  const { manifest, variant, images } = input;
  const publishUrl = manifest.creator_urls?.publish;
  if (!publishUrl) return { status: 'failed', error: 'no_creator_url' };

  try {
    await sendBrowserCommand('navigate', { url: publishUrl }, 30000);
    await sleep(randInt(2000, 4000));

    // Login check
    const pageUrl = await sendBrowserCommand('get_url', {}, 5000);
    if (typeof pageUrl?.url === 'string' && pageUrl.url.includes('login')) {
      return { status: 'failed', error: 'not_logged_in' };
    }

    // Switch to image tab
    await sendBrowserCommand(
      'click',
      { selector: '.publish-tab-item:nth-of-type(2), [class*="tab"]:has-text("图文")' },
      5000
    ).catch(() => {});
    await sleep(randInt(1000, 2000));

    // Upload images (extension's upload_file primitive handles DataTransfer)
    for (const imagePath of images) {
      try {
        const fs = await import('fs');
        const buf = fs.readFileSync(imagePath);
        const base64 = buf.toString('base64');
        const fileName = imagePath.split(/[\\/]/).pop() || 'image.jpg';
        const mimeType = fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        await sendBrowserCommand(
          'upload_file',
          {
            selector: 'input[type="file"][accept*="image"], input[type="file"]',
            fileData: base64,
            fileName,
            mimeType,
          },
          30000
        );
        await sleep(randInt(1500, 3000));
      } catch (err) {
        coworkLog('WARN', 'xhsDriver', 'image upload failed', { imagePath, err: String(err) });
      }
    }

    await sleep(randInt(2000, 3500));

    // Title
    await sendBrowserCommand(
      'fill',
      { selector: '.title-input input, input[placeholder*="标题"]', value: variant.title },
      5000
    );
    await sleep(randInt(500, 1500));

    // Body — split by newline, type + Enter
    const paragraphs = (variant.body || '').split('\n');
    // Click on the content editor first
    await sendBrowserCommand(
      'click',
      { selector: '.content-input [contenteditable="true"], [contenteditable="true"]' },
      5000
    ).catch(() => {});
    await sleep(randInt(300, 700));

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (p) {
        await sendBrowserCommand('type', { text: p }, 10000);
      }
      if (i < paragraphs.length - 1) {
        await sendBrowserCommand('keypress', { key: 'Enter' }, 3000);
      }
      await sleep(randInt(200, 600));
    }

    // Hashtags
    for (const raw of variant.hashtags) {
      const tag = raw.replace(/^#/, '');
      if (!tag) continue;
      await sendBrowserCommand('type', { text: '#' + tag }, 5000);
      // Wait briefly for the suggestion, then try to click
      await sendBrowserCommand(
        'wait_for',
        { selector: '.topic-suggest-item, .hashtag-suggestion', timeout: 3000 },
        5000
      ).catch(() => {});
      await sendBrowserCommand(
        'click',
        { selector: '.topic-suggest-item, .hashtag-suggestion' },
        3000
      ).catch(() => {});
      await sleep(randInt(600, 1200));
    }

    // Scroll to save-draft button (do NOT click)
    await sendBrowserCommand(
      'scroll_to',
      { selector: 'button.ant-btn-default, button:has-text("草稿"), .save-draft-btn' },
      5000
    ).catch(() => {});

    await sendBrowserCommand('screenshot', {}, 5000).catch(() => {});

    return { status: 'ready_for_user' };
  } catch (err) {
    return { status: 'failed', error: String(err) };
  }
}
