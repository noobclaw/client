/**
 * Xiaohongshu driver — pure orchestrator for scenario discovery and draft-upload.
 *
 * All browser-injected JS code lives on the server (scripts/*.js). This file
 * only handles the flow: navigate → wait → inject script → scroll → repeat.
 *
 * Hot-update: change scripts/*.js or config.json on the server, deploy backend.
 * No client rebuild needed.
 *
 * Chrome extension primitives used:
 *   navigate, javascript, scroll, click, fill, type, wait_for, keypress,
 *   upload_file, screenshot, get_value, scroll_to, go_back, tab_list, tab_create
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, getBrowserBridgeStatus } from '../browserBridge';
import * as riskGuard from './riskGuard';
import { isAbortRequested } from './scenarioManager';
import type {
  DiscoveredNote,
  DiscoveryConfig,
  ScenarioManifest,
  ScenarioPack,
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

// ── Login state check ──

export interface XhsLoginStatus {
  loggedIn: boolean;
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

export async function checkXhsLogin(): Promise<XhsLoginStatus> {
  try {
    const bridgeStatus = getBrowserBridgeStatus();
    if (!bridgeStatus.connected) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  } catch {
    return { loggedIn: false, reason: 'browser_not_connected' };
  }

  let tabs: any[] = [];
  try {
    const res = await sendBrowserCommand('tab_list', {}, 8000);
    tabs = Array.isArray(res?.tabs) ? res.tabs : [];
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'tab_list failed', { err: String(err) });
    return { loggedIn: false, reason: 'xhs_tab_not_reachable' };
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
  } catch (err1) {
    try {
      await sendBrowserCommand('navigate', { url }, 8000);
      return { ok: true };
    } catch (err2) {
      return { ok: false, reason: String(err2) };
    }
  }
}

// ── Script injection helpers ──

/** Inject a server-hosted script into the browser and return the result. */
async function runScript(script: string, timeout = 8000): Promise<any> {
  const res = await sendBrowserCommand('javascript', { code: script }, timeout);
  return res?.result;
}

/** Inject click_by_text.js with a specific text target. */
async function clickByText(script: string, text: string, pauseRange: [number, number]): Promise<string> {
  const code = script.replace(/__TARGET__/g, text.replace(/'/g, "\\'"));
  try {
    const result = await runScript(code, 5000) || 'not_found';
    coworkLog('DEBUG', 'xhsDriver', `clickByText("${text}") → ${result}`);
    if (!String(result).startsWith('not_found')) {
      await sleep(randInt(pauseRange[0], pauseRange[1]));
    }
    return String(result);
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', `clickByText("${text}") failed`, { err: String(err) });
    return 'error';
  }
}

// ── Feed card reader ──

interface FeedCard {
  post_id: string;
  url: string;
  title: string;
  likes_text: string;
  is_video: boolean;
}

async function readFeedCards(script: string): Promise<FeedCard[]> {
  try {
    const raw = await runScript(script, 8000);
    if (typeof raw !== 'string') return [];
    return JSON.parse(raw) as FeedCard[];
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'readFeedCards failed', { err: String(err) });
    return [];
  }
}

// ── Detail page reader ──

interface DetailPagePayload {
  title: string;
  body: string;
  images: string[];
  publish_time: string;
  hashtags: string[];
  author_name: string;
  author_followers_text: string;
}

async function readDetailPage(script: string): Promise<DetailPagePayload | null> {
  try {
    const raw = await runScript(script, 8000);
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw) as DetailPagePayload;
  } catch (err) {
    coworkLog('WARN', 'xhsDriver', 'readDetailPage failed', { err: String(err) });
    return null;
  }
}

// ── Anomaly detection ──

async function checkAnomaly(script: string): Promise<
  'ok' | 'captcha' | 'login_wall' | 'rate_limited' | 'account_flag'
> {
  try {
    const raw = await runScript(script, 5000) || 'ok';
    if (raw === 'captcha' || raw === 'login_wall' || raw === 'rate_limited' || raw === 'account_flag') {
      return raw;
    }
    return 'ok';
  } catch {
    return 'ok';
  }
}

// ── Discovery ──

/** Progress callback — xhsDriver calls this at every key moment. */
export type ProgressCallback = (message: string) => void;

export interface DiscoveryOptions {
  pack: ScenarioPack;
  task: ScenarioTask;
  seenPostIds: Set<string>;
  onProgress?: ProgressCallback;
}

export async function discoverXhsNotes(opts: DiscoveryOptions): Promise<DiscoveredNote[]> {
  const { pack, task, seenPostIds, onProgress } = opts;
  const { manifest, scripts, config } = pack;
  const caps = manifest.risk_caps;
  const beh = config.behavior;
  const MIN_LIKES = config.qualify.min_likes;
  const target = Math.max(1, Math.min(20, task.daily_count));
  const startedAt = Date.now();

  const report = (msg: string) => { if (onProgress) onProgress(msg); };

  const collected: DiscoveredNote[] = [];
  const candidates: FeedCard[] = [];

  // ── Apply search filters via server script ──
  async function applySearchFilters(): Promise<void> {
    const f = config.search_filters;
    const pause = beh.filter_click_pause;
    try {
      // 1. Click tab (e.g. "图文") — may reload page
      if (f.tab) {
        await clickByText(scripts.click_by_text, f.tab, pause);
        await sleep(randInt(2000, 3500));
      }
      // 2. Open filter panel
      if (f.open_filter_panel) {
        await clickByText(scripts.click_by_text, '筛选', pause);
        await sleep(randInt(800, 1500));
      }
      // 3. Sort option (e.g. "最多点赞")
      if (f.sort) {
        await clickByText(scripts.click_by_text, f.sort, pause);
      }
      // 4. Time filter (e.g. "一周内")
      if (f.time) {
        await clickByText(scripts.click_by_text, f.time, [2000, 4000]);
      }
      report(`已设置筛选: ${[f.tab, f.sort, f.time].filter(Boolean).join(' · ')}`);
      coworkLog('INFO', 'xhsDriver', 'applySearchFilters done', {
        tab: f.tab, sort: f.sort, time: f.time
      });
    } catch (err) {
      coworkLog('WARN', 'xhsDriver', 'applySearchFilters failed (non-fatal)', { err: String(err) });
    }
  }

  /**
   * Visit a feed/search page, scroll and collect qualifying cards.
   */
  async function visitFeedAndCollect(url: string, requireKeywordMatch: boolean, isSearchPage = false): Promise<void> {
    report(isSearchPage ? `打开搜索页 ......` : `浏览发现页 ......`);
    await sendBrowserCommand('navigate', { url }, 30000);
    await sleep(randInt(beh.first_screen_pause[0], beh.first_screen_pause[1]));

    if (isSearchPage) {
      report('设置筛选条件 ......');
      await applySearchFilters();
    }

    const anomaly = await checkAnomaly(scripts.check_anomaly);
    if (anomaly !== 'ok') {
      report(`检测到异常: ${anomaly}`);
      riskGuard.recordAnomaly(task.id, anomaly as any, caps);
      throw new Error(`anomaly:${anomaly}`);
    }

    for (let scroll = 0; scroll < caps.max_scroll_per_run; scroll++) {
      if (isAbortRequested()) throw new Error('user_stopped');
      if (Date.now() - startedAt > caps.max_run_duration_ms) throw new Error('run_duration_exceeded');

      report(`第 ${scroll + 1} 次滚动，已找到 ${candidates.length}/${target} 条`);

      const cards = await readFeedCards(scripts.read_feed_cards);
      let fresh = 0;
      for (const card of cards) {
        if (seenPostIds.has(card.post_id)) continue;
        if (candidates.some(c => c.post_id === card.post_id)) continue;
        if (card.is_video) continue;
        if (parseLikes(card.likes_text) < MIN_LIKES) continue;
        if (requireKeywordMatch && !keywordMatch(card.title, task.keywords)) continue;
        candidates.push(card);
        fresh++;
        report(`发现符合条件文章: "${card.title.slice(0, 20)}..." (${card.likes_text} 赞)`);
        if (candidates.length >= target) return;
      }

      if (fresh === 0 && scroll > beh.max_scrolls_no_new - 1) {
        report(`连续 ${beh.max_scrolls_no_new} 次滚动无新内容，换下一个关键词`);
        const recheck = await checkAnomaly(scripts.check_anomaly);
        if (recheck !== 'ok') {
          riskGuard.recordAnomaly(task.id, recheck as any, caps);
          throw new Error(`anomaly:${recheck}`);
        }
        break;
      }

      await sendBrowserCommand('scroll', { direction: 'down', amount: randInt(2, 4) }, 3000);
      if (isAbortRequested()) throw new Error('user_stopped');
      await sleep(randInt(beh.scroll_pause[0], beh.scroll_pause[1]));
    }
  }

  try {
    const doSearch = async () => {
      for (let ki = 0; ki < task.keywords.length; ki++) {
        const kw = task.keywords[ki];
        if (candidates.length >= target) break;
        if (isAbortRequested()) throw new Error('user_stopped');
        report(`关键词 ${ki + 1}/${task.keywords.length}: "${kw}"`);
        const searchUrl = manifest.entry_urls.search.replace('{keyword}', encodeURIComponent(kw));
        await visitFeedAndCollect(searchUrl, config.qualify.require_keyword_on_search, true);
      }
    };
    const doExplore = async () => {
      if (candidates.length < target) {
        report('搜索结果不足，浏览发现页补充');
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
    if (msg.startsWith('anomaly:') || msg === 'run_duration_exceeded') throw err;
    coworkLog('WARN', 'xhsDriver', 'feed visit threw', { err: msg });
  }

  // For each candidate, open detail page, read body + images
  report(`共找到 ${candidates.length} 条候选，开始逐条读取详情`);
  const detailSlice = candidates.slice(0, target);
  for (let di = 0; di < detailSlice.length; di++) {
    const card = detailSlice[di];
    if (isAbortRequested()) throw new Error('user_stopped');
    if (Date.now() - startedAt > caps.max_run_duration_ms) break;

    try {
      report(`读取详情 ${di + 1}/${detailSlice.length}: "${card.title.slice(0, 20)}..."`);
      await sendBrowserCommand('navigate', { url: card.url }, 30000);
      await sleep(randInt(beh.detail_page_pause[0], beh.detail_page_pause[1]));

      const anomaly = await checkAnomaly(scripts.check_anomaly);
      if (anomaly !== 'ok') {
        report(`检测到异常: ${anomaly}`);
        riskGuard.recordAnomaly(task.id, anomaly as any, caps);
        throw new Error(`anomaly:${anomaly}`);
      }

      const detail = await readDetailPage(scripts.read_detail_page);
      if (!detail || !detail.body) {
        report(`详情为空，跳过`);
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
      await sleep(randInt(caps.read_dwell_min_ms, caps.read_dwell_max_ms));
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
