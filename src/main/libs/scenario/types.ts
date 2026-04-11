/**
 * Scenario automation — shared types between Electron main process libs.
 *
 * Keep this file dependency-free (no runtime imports) so both renderer
 * (via a type-only import) and main can use it.
 */

export type Platform = 'xhs' | 'x' | 'douyin' | 'tiktok' | 'youtube';

export type WorkflowType =
  | 'viral_production'
  | 'auto_reply'
  | 'mass_comment'
  | 'dm_reply'
  | 'data_monitor';

export interface ScenarioManifest {
  id: string;                // e.g. "xhs_viral_production_career"
  version: string;           // "1.0.0"
  platform: Platform;
  workflow_type: WorkflowType;
  category: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  icon: string;
  default_config: ScenarioDefaultConfig;
  qualify?: {
    min_likes?: number;
    max_age_hours?: number;
    exclude_types?: string[];
  };
  risk_caps: RiskCaps;
  required_login_url: string;
  entry_urls: Record<string, string>;
  creator_urls?: Record<string, string>;
  skills: Record<string, string>;   // key → filename
}

export interface ScenarioDefaultConfig {
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  schedule_window: string;          // 'HH:MM-HH:MM'
}

export interface RiskCaps {
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

export interface ScenarioPack {
  manifest: ScenarioManifest;
  skills: {
    discovery?: string;
    extractor?: string;
    composer?: string;
    draft_uploader?: string;
    [k: string]: string | undefined;
  };
}

// ── Task (a user's configured instance of a scenario) ──

export interface ScenarioTask {
  id: string;                       // local uuid
  scenario_id: string;              // references a scenario manifest id
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  schedule_window: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

// ── Discovery output ──

export interface DiscoveredNote {
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

// ── Extraction / composition output ──

export interface ExtractionResult {
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

export interface ComposedVariant {
  title: string;
  body: string;
  hashtags: string[];
  suggested_cover_text: string;
  route: string;
  notes_for_user: string;
}

export interface Draft {
  id: string;
  task_id: string;
  source_post: DiscoveredNote;
  extraction: ExtractionResult;
  variant: ComposedVariant;
  status: 'pending' | 'pushed' | 'ignored';
  created_at: number;
  pushed_at?: number;
}

// ── Run record (for riskGuard + UI status) ──

export interface TaskRun {
  task_id: string;
  started_at: number;
  ended_at?: number;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
}
