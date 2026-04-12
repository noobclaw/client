/**
 * Scenario automation — renderer-side TS types.
 *
 * Mirrors the IPC surface exposed by the Electron main process's
 * src/main/libs/scenario/*.ts modules. Imported by both the scenario
 * service (services/scenario.ts) and all React components under
 * components/scenario/.
 */

export type ScenarioPlatform = 'xhs' | 'x' | 'douyin' | 'tiktok' | 'youtube';

export type ScenarioWorkflowType =
  | 'viral_production'
  | 'auto_reply'
  | 'mass_comment'
  | 'dm_reply'
  | 'data_monitor';

export interface ScenarioRiskCapsIPC {
  max_daily_runs: number;
  max_scroll_per_run: number;
  min_scroll_delay_ms: number;
  max_scroll_delay_ms: number;
  read_dwell_min_ms: number;
  read_dwell_max_ms: number;
  max_run_duration_ms: number;
  min_interval_hours: number;
  weekly_rest_days: number;
  cooldown_captcha_hours: number;
  cooldown_rate_limit_hours: number;
  cooldown_account_flag_hours: number;
}

export interface ScenarioManifestIPC {
  id: string;
  version: string;
  platform: ScenarioPlatform;
  workflow_type: ScenarioWorkflowType;
  category: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  icon: string;
  default_config: {
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    schedule_window: string;
  };
  risk_caps: ScenarioRiskCapsIPC;
  required_login_url: string;
  entry_urls: Record<string, string>;
  creator_urls?: Record<string, string>;
  skills: Record<string, string>;
}

export interface ScenarioTaskIPC {
  id: string;
  scenario_id: string;
  /** Fine-grained niche id (e.g. "career_side_hustle"). Used to organize
   *  saved artifacts on disk by date/track and to seed default keywords. */
  track: string;
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  /** Preferred daily run time in HH:MM (24h local). The run loop adds a
   *  small random jitter (± ~15 min) around this value to look human. */
  daily_time: string;
  /** Legacy: original "HH:MM-HH:MM" window string. Kept for backward
   *  compatibility with tasks created before the v2 wizard. */
  schedule_window?: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface ScenarioDiscoveredNoteIPC {
  external_post_id: string;
  external_url: string;
  title: string;
  body: string;
  images: string[];
  hashtags: string[];
  publish_time?: string;
  author_name?: string;
  author_followers?: number;
  metrics: {
    likes: number;
    comments: number;
    collects?: number;
    collected_at: number;
  };
}

export interface ScenarioExtractionIPC {
  hook_type: string;
  hook_first_sentence: string;
  body_structure: string[];
  emotion_arc: string;
  core_value_prop: string;
  cta_type: string;
  cta_sentence: string;
  hashtag_strategy: {
    big_traffic: string[];
    niche: string[];
    count_total: number;
  };
  visual_pattern: string;
  length_char_count: number;
  paragraph_count: number;
  emoji_density: string;
  signature_phrases: string[];
}

export interface ScenarioVariantIPC {
  title: string;
  body: string;
  hashtags: string[];
  suggested_cover_text: string;
  route: string;
  notes_for_user: string;
}

export interface ScenarioDraftIPC {
  id: string;
  task_id: string;
  source_post: ScenarioDiscoveredNoteIPC;
  extraction: ScenarioExtractionIPC;
  variant: ScenarioVariantIPC;
  status: 'pending' | 'pushed' | 'ignored';
  created_at: number;
  pushed_at?: number;
}

export interface ScenarioTaskRun {
  task_id: string;
  started_at: number;
  ended_at?: number;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
}

export interface ScenarioRunOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  drafts?: ScenarioDraftIPC[];
}

export interface XhsLoginStatus {
  loggedIn: boolean;
  /**
   * Machine-readable code explaining why. Stable values:
   *   login_page | login_modal | sign_in_button
   *   no_response | browser_not_connected | xhs_tab_not_reachable
   *   probe_error
   */
  reason?: string;
}
