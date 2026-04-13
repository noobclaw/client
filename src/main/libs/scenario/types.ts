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
  skills: Record<string, any>;      // key → filename or nested object
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

/** Config for discovery behavior (from config.json on server) */
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
  behavior: {
    first_screen_pause: [number, number];
    scroll_pause: [number, number];
    detail_page_pause: [number, number];
    filter_click_pause: [number, number];
    max_scrolls_no_new: number;
  };
}

/**
 * ScenarioPack — downloaded from server on each run.
 * Contains everything needed to execute a scenario:
 *   - scripts: browser-injected JS code (hot-updatable)
 *   - prompts: AI system prompts (hot-updatable)
 *   - config: discovery strategy/thresholds (hot-updatable)
 *   - manifest: metadata + risk caps
 */
export interface ScenarioPack {
  manifest: ScenarioManifest;
  scripts: {
    click_by_text: string;
    read_feed_cards: string;
    read_detail_page: string;
    check_anomaly: string;
    apply_filters: string;
  };
  prompts: {
    extractor: string;
    composer: string;
  };
  config: DiscoveryConfig;
  draft_uploader?: any;
}

// ── Task (a user's configured instance of a scenario) ──

export interface ScenarioTask {
  id: string;                       // local uuid
  scenario_id: string;              // references a scenario manifest id
  /** Fine-grained niche id (e.g. "career_side_hustle") — used for
   *  on-disk artifact organization and default keywords. */
  track: string;
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  /** Preferred daily run time in HH:MM (24h local). Wizard sets this
   *  instead of the legacy schedule_window. */
  daily_time: string;
  /** Legacy field: original "HH:MM-HH:MM" window. Kept so older tasks
   *  still parse. */
  schedule_window?: string;
  enabled: boolean;
  /** Only the 'active' task is eligible for scheduled auto-runs.
   *  When multiple tasks exist, user must explicitly pick which one is active.
   *  If only one task exists, it's auto-marked active. */
  active: boolean;
  created_at: number;
  updated_at: number;
}

// ── Track preset catalogue ──
// Hard-coded list of fine-grained XHS tracks. Each preset seeds the
// wizard's default keywords and suggests a persona direction. The UI
// renders an icon grid of these; the user picks one and can still tweak
// keywords afterwards.

export interface TrackPreset {
  id: string;
  platform: Platform;
  icon: string;
  name_zh: string;
  name_en: string;
  keywords: string[];
  persona_hint: string;
}

export const XHS_TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'career_side_hustle', platform: 'xhs', icon: '💼',
    name_zh: '副业 · 打工人赚钱', name_en: 'Side Hustle',
    keywords: ['副业', '下班变现', '兼职', '月入'],
    persona_hint: '一个想在下班后搞点副业的普通打工人，真诚不装',
  },
  {
    id: 'indie_dev', platform: 'xhs', icon: '👩‍💻',
    name_zh: '独立开发 · 程序员记录', name_en: 'Indie Dev',
    keywords: ['独立开发', '程序员副业', 'indie hacker', '个人开发者'],
    persona_hint: '独立开发者，前后端都写，真诚记录产品和收入',
  },
  {
    id: 'personal_finance', platform: 'xhs', icon: '💰',
    name_zh: '理财 · 记账攻略', name_en: 'Personal Finance',
    keywords: ['理财', '攒钱', '记账', '定投', '资产配置'],
    persona_hint: '月薪 1 万的普通白领，认真记账、稳健理财',
  },
  {
    id: 'travel', platform: 'xhs', icon: '✈️',
    name_zh: '旅行 · 攻略分享', name_en: 'Travel',
    keywords: ['旅行攻略', '穷游', '周末游', '小众目的地'],
    persona_hint: '爱说走就走的旅行爱好者，分享性价比攻略',
  },
  {
    id: 'food', platform: 'xhs', icon: '🍲',
    name_zh: '美食 · 探店做饭', name_en: 'Food',
    keywords: ['探店', '做饭', '日常晚餐', '健康餐'],
    persona_hint: '喜欢折腾吃喝的上班族，每天做饭给自己',
  },
  {
    id: 'outfit', platform: 'xhs', icon: '👗',
    name_zh: '穿搭 · 风格分享', name_en: 'Outfit',
    keywords: ['穿搭', 'OOTD', '通勤穿搭', '小个子穿搭'],
    persona_hint: '小个子职场穿搭爱好者',
  },
  {
    id: 'beauty', platform: 'xhs', icon: '💄',
    name_zh: '美妆 · 产品测评', name_en: 'Beauty',
    keywords: ['美妆', '护肤', '平价彩妆', '粉底液测评'],
    persona_hint: '敏感肌护肤爱好者，只买成分党认证的',
  },
  {
    id: 'fitness', platform: 'xhs', icon: '💪',
    name_zh: '健身 · 减脂日记', name_en: 'Fitness',
    keywords: ['健身', '减脂', '塑形', '居家健身'],
    persona_hint: '上班族，边工作边坚持居家健身一年',
  },
  {
    id: 'reading', platform: 'xhs', icon: '📚',
    name_zh: '读书 · 书单笔记', name_en: 'Reading',
    keywords: ['读书', '书单', '读书笔记', '年度书单'],
    persona_hint: '一年读 50 本书的普通读者',
  },
  {
    id: 'parenting', platform: 'xhs', icon: '🧸',
    name_zh: '育儿 · 亲子日常', name_en: 'Parenting',
    keywords: ['育儿', '亲子', '早教', '母婴好物'],
    persona_hint: '3 岁娃妈妈，理性育儿不焦虑',
  },
  {
    id: 'exam_prep', platform: 'xhs', icon: '🎓',
    name_zh: '考研 · 备考党', name_en: 'Exam Prep',
    keywords: ['考研', '考研经验', '英语学习', '备考'],
    persona_hint: '二战考研人，记录每日学习节奏',
  },
  {
    id: 'pets', platform: 'xhs', icon: '🐱',
    name_zh: '宠物 · 猫狗日常', name_en: 'Pets',
    keywords: ['猫咪', '狗狗', '宠物日常', '宠物用品'],
    persona_hint: '一只中华田园猫的主人，真实养宠记录',
  },
  {
    id: 'home_decor', platform: 'xhs', icon: '🏠',
    name_zh: '家居 · 小屋布置', name_en: 'Home Decor',
    keywords: ['家居', '小户型', '租房改造', '收纳'],
    persona_hint: '租房党，用 2000 预算把小公寓改舒服',
  },
  {
    id: 'study_method', platform: 'xhs', icon: '🏆',
    name_zh: '学习 · 效率工具', name_en: 'Study Method',
    keywords: ['效率', '时间管理', '学习方法', 'Notion'],
    persona_hint: '热爱效率工具的产品经理',
  },
  {
    id: 'career_growth', platform: 'xhs', icon: '🎯',
    name_zh: '职场 · 升级打怪', name_en: 'Career Growth',
    keywords: ['职场', '升职', '面试', '跳槽'],
    persona_hint: '互联网行业工作 5 年的打工人',
  },
  {
    id: 'emotional_wellness', platform: 'xhs', icon: '🧘',
    name_zh: '情感 · 心理疗愈', name_en: 'Emotional Wellness',
    keywords: ['情感', '心理', 'MBTI', '自我成长'],
    persona_hint: '正在做自我探索的 30 岁女性',
  },
  {
    id: 'photography', platform: 'xhs', icon: '📷',
    name_zh: '摄影 · 日常记录', name_en: 'Photography',
    keywords: ['摄影', '手机摄影', '胶片', '构图'],
    persona_hint: '业余摄影爱好者，周末扫街',
  },
  {
    id: 'crafts', platform: 'xhs', icon: '🎨',
    name_zh: '手工 · DIY', name_en: 'Crafts',
    keywords: ['手工', 'DIY', '手账', '手工教程'],
    persona_hint: '热爱动手做点小东西的文艺青年',
  },
];

export function findTrackPreset(track_id: string): TrackPreset | null {
  return XHS_TRACK_PRESETS.find(t => t.id === track_id) || null;
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
