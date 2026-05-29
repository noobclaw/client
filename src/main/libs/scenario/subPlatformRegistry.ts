/**
 * subPlatformRegistry.ts — single source of truth for sub_platform metadata.
 *
 * A "sub_platform" is the (platform, domain_tier) granularity at which the
 * v6.x window-routing rework treats the world. Creator center vs main site
 * are separate sub_platforms because they have independent login flows
 * and concerns (e.g. XHS: `creator.xiaohongshu.com` vs `www.xiaohongshu.com`).
 *
 * This registry is consumed by:
 *   - scenarioManager.resourceKeysForPack (Phase 1, today)
 *   - scenarioManager.humanizePlatformFromKey (Phase 1, today)
 *   - future ScopedTab routing (PR9) — passes pre-computed windowKey +
 *     groupTitle into ext via task_open_tab so ext stays sub_platform-
 *     agnostic and never needs version bumps when new platforms ship
 *
 * **Ext stays decoupled**: chrome-extension/background.js intentionally
 * does NOT mirror this file. The ext receives `windowKey` and
 * `groupTitle` as opaque strings from the client and stores them in
 * Map<windowKey, ...> without ever needing to know the enum. Adding a
 * new sub_platform is therefore a client + scenario-manifest change
 * only — no extension release required.
 *
 * Adding a new sub_platform:
 *   1. Add the entry below (this file only — do NOT touch background.js)
 *   2. Make sure label + emoji + domain are accurate
 *   3. Update scenario manifests that touch this domain to declare it
 *      in their `platforms` array
 *   4. Ship client + backend (no ext release needed)
 */

export interface SubPlatformMeta {
  /** Chinese label used in user-facing toast text and Chrome tab group titles. */
  label: string;
  /** Single glyph hint shown in group title prefix; also used as Chrome group color cue. */
  emoji: string;
  /**
   * Canonical primary domain (informational only — NOT a strict URL match).
   * Useful for engineer debugging and as a hint for the (future) ext-side
   * URL → sub_platform classifier (PR8). Real URL pattern matching lives
   * in the scenario's manifest `tab_url_pattern` / `secondary_tab_url_pattern`.
   */
  domain: string;
}

/**
 * The 8 sub_platforms in active use as of 2026-05. Adding to this map
 * is the only sanctioned way to introduce a new sub_platform — scenarios
 * declaring an unknown id in `manifest.platforms` get a runtime warning
 * (see isKnownSubPlatform).
 */
// Labels are intentionally short (English abbreviation + optional CN
// domain-tier suffix). They land in Chrome tab group titles where space
// is at a premium and reading is glance-mode. Pattern:
//   {PLATFORM_ABBREV}            for single-domain platforms
//   {PLATFORM_ABBREV}·{TIER_CN}  for split creator/main platforms
export const SUB_PLATFORM_REGISTRY: Record<string, SubPlatformMeta> = {
  xhs_creator:    { label: 'XHS·创作', emoji: '📝', domain: 'creator.xiaohongshu.com' },
  xhs_main:       { label: 'XHS',      emoji: '📕', domain: 'www.xiaohongshu.com' },
  douyin_creator: { label: 'DY·创作',  emoji: '🎬', domain: 'creator.douyin.com' },
  douyin_main:    { label: 'DY',       emoji: '📹', domain: 'www.douyin.com' },
  tiktok_main:    { label: 'TK',       emoji: '🎵', domain: 'www.tiktok.com' },
  x_main:         { label: 'X',        emoji: '🐦', domain: 'x.com' },
  binance_square: { label: 'BN·广场',  emoji: '🟡', domain: 'www.binance.com/square' },
  youtube_main:   { label: 'YT',       emoji: '🔴', domain: 'www.youtube.com' },
};

/** Lookup set for fast enum validation. Derived from the registry. */
export const SUB_PLATFORM_IDS: ReadonlySet<string> = new Set(Object.keys(SUB_PLATFORM_REGISTRY));

/**
 * Returns true iff `id` is a known sub_platform. Use this to validate
 * manifest.platforms entries on pack load. Unknown ids are not fatal —
 * they still produce a unique mutex key, just with no human label and
 * no interlock with any other scenario.
 */
export function isKnownSubPlatform(id: string): boolean {
  return SUB_PLATFORM_IDS.has(id);
}

/**
 * Human label for a sub_platform id, used in:
 *   - toast strings ("正在运行: 小红书创作者中心")
 *   - tab group titles (via groupTitle below)
 *   - error messages ("资源被 占用: 抖音")
 *
 * Falls back to the raw id for forward-compat with scenarios on a newer
 * client that introduced an id we don't know about yet.
 */
export function subPlatformLabel(id: string): string {
  return SUB_PLATFORM_REGISTRY[id]?.label ?? id;
}

/**
 * Chrome tab-group title for an owned-window in v6.x+ routing.
 *
 * Format:
 *   single-account (account_id === 'default' or omitted):
 *     `🤖 {label}`         e.g. `🤖 小红书创作者中心`
 *   multi-account (future, account_id !== 'default'):
 *     `🤖 {label} · @{account_id}`  e.g. `🤖 小红书创作者中心 · @主号`
 *
 * The `🤖` prefix is the visual marker "this is a NoobClaw-managed window";
 * the ext only adopts / repurposes groups whose title starts with this glyph.
 */
export function groupTitle(sub_platform: string, account_id: string = 'default'): string {
  const base = `🤖 ${subPlatformLabel(sub_platform)}`;
  return account_id === 'default' ? base : `${base} · @${account_id}`;
}
