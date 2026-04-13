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
import { isAbortRequested } from './scenarioManager';
import type {
  DiscoveredNote,
  ScenarioManifest,
  ScenarioTask,
  RiskCaps,
  ComposedVariant,
} from './types';

// ── Discovery config (parsed from discovery.md YAML block) ──

export interface DiscoveryConfig {
  strategy: 'search_first' | 'explore_first';
  search_filters: {
    tab: string;
    sort: string;
    time: string;
    open_filter_panel: boolean;
  };
  qualify: {
    min_likes: number;
    exclude_types: string[];
    require_keyword_on_search: boolean;
    require_keyword_on_explore: boolean;
  };
  card_selectors: {
    note_id_pattern: string;
    min_card_width: number;
    min_card_height: number;
    video_indicator: string;
    title_selectors: string[];
    likes_selectors: string[];
  };
  detail_selectors: {
    title: string[];
    body: string[];
    images: { selector: string; attr: string };
    publish_time: string[];
    hashtags: string[];
    author_name: string[];
    author_followers: string[];
  };
  anomaly_selectors: {
    captcha: string[];
    login_wall: { url_pattern: string; selectors: string[] };
    rate_limit: { text_match: string[] };
    account_flag: { text_match: string[] };
  };
  behavior: {
    first_screen_pause: [number, number];
    scroll_pause: [number, number];
    detail_page_pause: [number, number];
    filter_click_pause: [number, number];
    max_scrolls_no_new: number;
  };
}

// Default config — used if discovery.md can't be parsed
const DEFAULT_CONFIG: DiscoveryConfig = {
  strategy: 'search_first',
  search_filters: { tab: '图文', sort: '最多点赞', time: '一周内', open_filter_panel: true },
  qualify: { min_likes: 100, exclude_types: ['video'], require_keyword_on_search: false, require_keyword_on_explore: true },
  card_selectors: {
    note_id_pattern: '/([a-f0-9]{24})(?:\\\\?|$)',
    min_card_width: 100, min_card_height: 80,
    video_indicator: '.play-icon, [class*="video-icon"], [class*="play"]',
    title_selectors: ['.title', '[class*="title"]', '.note-text', 'a span'],
    likes_selectors: ['.like-wrapper .count', '.count', '[class*="like"] span', '[class*="like-count"]'],
  },
  detail_selectors: {
    title: ['#detail-title', 'h1.title', '[class*="title"]'],
    body: ['#detail-desc', '.content', '[class*="desc"]'],
    images: { selector: '.carousel .slide img, [class*="swiper-slide"] img', attr: 'src' },
    publish_time: ['.publish-date', '.date', 'time'],
    hashtags: ['.hash-tag', 'a[href*="page/topics/"]'],
    author_name: ['.author .name', '.user .name'],
    author_followers: ['.follower-count'],
  },
  anomaly_selectors: {
    captcha: ['.captcha-slider', '.nc_iconfont', 'iframe[src*="captcha"]'],
    login_wall: { url_pattern: '/login|/signin', selectors: ['.login-container', '[class*="login-panel"]'] },
    rate_limit: { text_match: ['操作过于频繁', '访问频率'] },
    account_flag: { text_match: ['账号异常', '暂时限流'] },
  },
  behavior: {
    first_screen_pause: [4000, 8000],
    scroll_pause: [3000, 7000],
    detail_page_pause: [3500, 7000],
    filter_click_pause: [1500, 3000],
    max_scrolls_no_new: 3,
  },
};

/**
 * Parse discovery.md YAML config. The file has a ```yaml code block
 * containing the structured config. We extract and parse it.
 */
export function parseDiscoveryConfig(rawMd: string | undefined): DiscoveryConfig {
  if (!rawMd) return DEFAULT_CONFIG;
  try {
    // Extract YAML from ```yaml ... ``` code fence
    const yamlMatch = rawMd.match(/```yaml\s*\n([\s\S]*?)\n```/);
    if (!yamlMatch) return DEFAULT_CONFIG;
    const yamlText = yamlMatch[1];
    // Simple YAML parser — handles our flat/nested structure
    // For production we'd use js-yaml, but keeping deps minimal.
    // Strategy: parse key-value pairs with indentation awareness.
    const result = simpleYamlParse(yamlText);
    return deepMerge(DEFAULT_CONFIG, result) as DiscoveryConfig;
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'Failed to parse discovery.md config, using defaults', { err: String(err) });
    return DEFAULT_CONFIG;
  }
}

function simpleYamlParse(text: string): any {
  // Simple recursive YAML-like parser (handles our specific format)
  const result: any = {};
  const lines = text.split('\n');
  let i = 0;

  function parseLevel(indent: number): any {
    const obj: any = {};
    while (i < lines.length) {
      const line = lines[i];
      const stripped = line.replace(/#.*$/, ''); // remove comments
      if (stripped.trim() === '') { i++; continue; }
      const lineIndent = line.search(/\S/);
      if (lineIndent < indent) break; // back to parent
      if (lineIndent > indent) { i++; continue; } // skip over-indented

      const kvMatch = stripped.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)/);
      if (!kvMatch) { i++; continue; }
      const key = kvMatch[2];
      let value = kvMatch[3].trim();
      i++;

      if (value === '' || value === '|') {
        // Nested object or block
        obj[key] = parseLevel(indent + 2);
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Inline array: [a, b, c]
        obj[key] = value.slice(1, -1).split(',').map((s: string) => {
          const t = s.trim().replace(/^['"]|['"]$/g, '');
          const n = Number(t);
          return isNaN(n) ? t : n;
        });
      } else if (value.startsWith('- ')) {
        // YAML list starting on same line — shouldn't happen in our format
        obj[key] = [value.slice(2).trim()];
      } else if (value === 'true') {
        obj[key] = true;
      } else if (value === 'false') {
        obj[key] = false;
      } else {
        const num = Number(value);
        obj[key] = isNaN(num) ? value.replace(/^['"]|['"]$/g, '') : num;
      }
    }
    // Check if next lines are list items (- value)
    while (i < lines.length) {
      const line = lines[i];
      const stripped = line.replace(/#.*$/, '').trim();
      if (stripped === '') { i++; continue; }
      if (!stripped.startsWith('- ')) break;
      // This is a list continuation — but we need to know which key it belongs to
      break;
    }
    return obj;
  }

  i = 0;
  // Top-level parse
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, '');
    if (stripped.trim() === '') { i++; continue; }

    const kvMatch = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)/);
    if (!kvMatch) {
      // Could be a list item under previous key
      if (stripped.trim().startsWith('- ')) {
        i++;
        continue;
      }
      i++;
      continue;
    }
    const key = kvMatch[1];
    let value = kvMatch[2].trim();
    i++;

    if (value === '' || value === '|') {
      result[key] = parseLevel(2);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map((s: string) => {
        const t = s.trim().replace(/^['"]|['"]$/g, '');
        const n = Number(t);
        return isNaN(n) ? t : n;
      });
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else {
      const num = Number(value);
      result[key] = isNaN(num) ? value.replace(/^['"]|['"]$/g, '') : num;
    }
  }
  return result;
}

function deepMerge(defaults: any, overrides: any): any {
  if (!overrides || typeof overrides !== 'object') return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined && overrides[key] !== null) {
      if (typeof defaults[key] === 'object' && !Array.isArray(defaults[key]) && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
        result[key] = deepMerge(defaults[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
  }
  return result;
}

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
// Login check is now handled by background.js's 'check_xhs_login' command
// which calls the XHS API directly (cookies auto-attached, including HttpOnly).
// No DOM probe needed.

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

  // Step 2 passed — XHS tab exists. We no longer auto-detect login;
  // the user confirms manually via the modal's "我已登录" button.
  return { loggedIn: true };
}

/**
 * Open Xiaohongshu in a new browser tab so the user can log in. Called from
 * the LoginRequiredModal when the user clicks "open login page".
 */
export async function openXhsLogin(): Promise<{ ok: boolean; reason?: string }> {
  const url = 'https://www.xiaohongshu.com';
  // Try tab_create first, fall back to navigate (opens in active tab)
  try {
    await sendBrowserCommand('tab_create', { url }, 8000);
    return { ok: true };
  } catch (err1) {
    coworkLog('WARN', 'xhsDriver', 'tab_create failed, trying navigate', { err: String(err1) });
    try {
      await sendBrowserCommand('navigate', { url }, 8000);
      return { ok: true };
    } catch (err2) {
      coworkLog('WARN', 'xhsDriver', 'navigate also failed', { err: String(err2) });
      return { ok: false, reason: String(err2) };
    }
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
return (function() {
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

// Generic card reader — works on BOTH explore page AND search results page.
// Finds all links containing a 24-char hex note ID (the universal XHS note ID format).
const FEED_CARDS_CODE = `
return (function() {
  var out = [];
  var seen = {};
  // Find ALL anchor tags that link to a note (explore, search, discovery — any page)
  var allLinks = document.querySelectorAll('a[href]');
  for (var i = 0; i < allLinks.length; i++) {
    var a = allLinks[i];
    var href = a.getAttribute('href') || '';
    // XHS note IDs are 24-char hex strings in the URL path
    var idMatch = href.match(/\\/([a-f0-9]{24})(?:\\?|$)/i);
    if (!idMatch) continue;
    var noteId = idMatch[1];
    if (seen[noteId]) continue;
    // Must be a visible card-like element (not a tiny link in the footer)
    var card = a.closest('section, [class*="note"], [class*="card"], [class*="feed"]') || a;
    var rect = card.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 80) continue;
    seen[noteId] = true;
    // Extract info from the card
    var isVideo = !!card.querySelector('.play-icon, [class*="video-icon"], [class*="play"]');
    var titleEl = card.querySelector('.title, [class*="title"], .note-text, a span');
    var likesEl = card.querySelector('.like-wrapper .count, .count, [class*="like"] span, [class*="like-count"]');
    var title = '';
    if (titleEl) {
      title = (titleEl.textContent || '').trim().slice(0, 200);
    } else {
      // Fallback: use the link text itself
      title = (a.textContent || '').trim().slice(0, 200);
    }
    out.push({
      post_id: noteId,
      url: href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href,
      title: title,
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
return (function() {
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
  config: DiscoveryConfig;
  task: ScenarioTask;
  manifest: ScenarioManifest;
  seenPostIds: Set<string>;
}

export async function discoverXhsNotes(opts: DiscoveryOptions): Promise<DiscoveredNote[]> {
  const { task, manifest, seenPostIds, config } = opts;
  const caps = manifest.risk_caps;
  const beh = config.behavior;
  const MIN_LIKES = config.qualify.min_likes;
  const target = Math.max(1, Math.min(5, task.daily_count));
  const startedAt = Date.now();

  const collected: DiscoveredNote[] = [];
  const candidates: FeedCard[] = [];

  /**
   * On search pages, click the filter buttons to get: 图文 + 最多点赞 + 一周内.
   * These are DOM clicks, not URL params (more reliable across XHS versions).
   */
  async function applySearchFilters(): Promise<void> {
    const f = config.search_filters;
    const pause = beh.filter_click_pause;
    try {
      // Click tab (e.g. "图文")
      if (f.tab) {
        await clickByText(f.tab, pause);
      }
      // Open filter panel
      if (f.open_filter_panel) {
        await clickByText('筛选', pause);
      }
      // Sort (e.g. "最多点赞")
      if (f.sort) {
        await clickByText(f.sort, pause);
      }
      // Time filter (e.g. "一周内")
      if (f.time) {
        await clickByText(f.time, [2000, 4000]);
      }
    } catch (err) {
      coworkLog('WARN', 'xhsDriver', 'applySearchFilters failed (non-fatal)', { err: String(err) });
    }
  }

  async function clickByText(text: string, pauseRange: [number, number]): Promise<void> {
    try {
      const res: any = await sendBrowserCommand('find', { query: text }, 5000);
      const els = res?.elements || [];
      if (els.length > 0) {
        await sendBrowserCommand('click', { selector: els[0].selector }, 3000);
        await sleep(randInt(pauseRange[0], pauseRange[1]));
      }
    } catch {}
  }

  /**
   * @param requireKeywordMatch — false for search pages (results are
   *   already keyword-relevant), true for explore/discover pages.
   * @param isSearchPage — if true, apply filters after page load.
   */
  async function visitFeedAndCollect(url: string, requireKeywordMatch: boolean, isSearchPage = false): Promise<void> {
    await sendBrowserCommand('navigate', { url }, 30000);
    await sleep(randInt(beh.first_screen_pause[0], beh.first_screen_pause[1]));

    // Apply search filters on first visit to a search page
    if (isSearchPage) {
      await applySearchFilters();
    }

    const anomaly = await checkAnomaly();
    if (anomaly !== 'ok') {
      riskGuard.recordAnomaly(task.id, anomaly as any, caps);
      throw new Error(`anomaly:${anomaly}`);
    }

    for (let scroll = 0; scroll < caps.max_scroll_per_run; scroll++) {
      if (isAbortRequested()) throw new Error('user_stopped');
      if (Date.now() - startedAt > caps.max_run_duration_ms) throw new Error('run_duration_exceeded');

      const cards = await readFeedCards();
      let fresh = 0;
      for (const card of cards) {
        if (seenPostIds.has(card.post_id)) continue;
        if (candidates.some(c => c.post_id === card.post_id)) continue;
        if (card.is_video) continue;
        if (parseLikes(card.likes_text) < MIN_LIKES) continue;
        // Search results don't need keyword match (they're already relevant)
        if (requireKeywordMatch && !keywordMatch(card.title, task.keywords)) continue;
        candidates.push(card);
        fresh++;
        if (candidates.length >= target) return;
      }
      // If no new cards found for 3+ scrolls, stop scrolling this page
      if (fresh === 0 && scroll > 2) {
        const recheck = await checkAnomaly();
        if (recheck !== 'ok') {
          riskGuard.recordAnomaly(task.id, recheck as any, caps);
          throw new Error(`anomaly:${recheck}`);
        }
        break; // Move on to next keyword / explore page
      }
      await sendBrowserCommand('scroll', { direction: 'down', amount: randInt(2, 4) }, 3000);
      if (isAbortRequested()) throw new Error('user_stopped');
      await humanPause(caps);
    }
  }

  try {
    // ── STRATEGY: driven by config.strategy ──
    const doSearch = async () => {
      for (const kw of task.keywords) {
        if (candidates.length >= target) break;
        if (isAbortRequested()) throw new Error('user_stopped');
        const searchUrl = manifest.entry_urls.search.replace('{keyword}', encodeURIComponent(kw));
        await visitFeedAndCollect(searchUrl, config.qualify.require_keyword_on_search, true);
      }
    };
    const doExplore = async () => {
      if (candidates.length < target) {
        await visitFeedAndCollect(manifest.entry_urls.explore, config.qualify.require_keyword_on_explore);
      }
    };

    if (config.strategy === 'search_first') {
      await doSearch();
      await doExplore();
    } else {
      await doExplore();
      await doSearch();
    }
  } catch (err) {
    const msg = String(err);
    if (msg === 'user_stopped') throw err;
    if (!msg.startsWith('anomaly:') && msg !== 'run_duration_exceeded') {
      coworkLog('WARN', 'xhsDriver', 'feed visit threw', { err: msg });
    } else {
      throw err;
    }
  }

  // 3. For each candidate, open detail, read body + images, then go_back
  for (const card of candidates.slice(0, target)) {
    if (isAbortRequested()) throw new Error('user_stopped');
    if (Date.now() - startedAt > caps.max_run_duration_ms) break;

    try {
      await sendBrowserCommand('navigate', { url: card.url }, 30000);
      await sleep(randInt(3500, 7000));

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
