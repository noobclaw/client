/**
 * DouyinConfigWizard — 独立 3-step wizard,镜像 TikTokConfigWizard:
 *
 *   Step 1 — 人设
 *   Step 2 — 互动数量 (3 个 min/max 滑条: 点赞 / 关注 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 pills + 摘要 + 创建
 *
 * 跟 TikTokConfigWizard 的差异:
 *   - 主色 violet (避开 brand red)
 *   - 评论描述提到中文为主 (抖音受众主要中文,不强调跨语言匹配)
 *   - emoji 🎵 → 🎶
 *
 * 字段隔离 — 不读其它平台的 KOL pool / track,完全独立避免 UI 串台。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: any) => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;

const LIKE_HARDCAP = 30;
const FOLLOW_HARDCAP = 5;
const COMMENT_HARDCAP = 15;

// ── Douyin tracks ──
// v5.x+: 优先从 backend manifest.tracks 下发(可热更不需打新版)。下面的 fallback
// 在 scenario.tracks 缺失时使用,确保新 client 装到老 backend 也能工作。
// 海外直播必须放第一位 — 用户要求,抖音 2026 高流量新品类。
// 抖音几乎全中文素材,keywords_en 不必填(英文用户搜中文也能命中)。
type DouyinTrack = { id: string; icon: string; name_zh: string; name_en?: string; keywords_zh: string[]; keywords_en?: string[] };
const DOUYIN_TRACKS_FALLBACK: DouyinTrack[] = [
  { id: 'overseas_live', icon: '🌍', name_zh: '海外直播', name_en: 'Overseas Live',
    keywords_zh: ['海外直播', '海外华人', '海外生活', '海外探店', '海外街景', '海外吃播', '海外日常', 'TikTok直播', '海外购物', '海外旅游'] },
  { id: 'food', icon: '🍜', name_zh: '美食 · 探店', name_en: 'Food',
    keywords_zh: ['美食探店', '本地美食', '街边小吃', '网红餐厅', '探店打卡', '吃播', '夜市', '深夜食堂', '人均消费', '私房菜'] },
  { id: 'daily_vlog', icon: '📷', name_zh: '生活 · vlog', name_en: 'Daily Vlog',
    keywords_zh: ['vlog', '日常分享', '一人居', '工作日常', '生活记录', '周末vlog', '搬家', '装修日记', '城市vlog'] },
  { id: 'pet', icon: '🐶', name_zh: '萌宠日常', name_en: 'Pets',
    keywords_zh: ['宠物日常', '猫咪', '狗子', '田园猫', '柯基', '布偶', '橘猫', '萌宠', '养宠新手'] },
  { id: 'music_dance', icon: '🎵', name_zh: '音乐 · 舞蹈', name_en: 'Music & Dance',
    keywords_zh: ['翻唱', '抖音神曲', '舞蹈翻跳', 'kpop舞', '原创歌曲', '吉他弹唱', '钢琴', '电音', '街舞'] },
  { id: 'knowledge', icon: '🧠', name_zh: '知识 · 科普', name_en: 'Knowledge',
    keywords_zh: ['知识分享', '科普', '冷知识', '一分钟讲透', '历史', '心理学', '健康知识', '财经科普', '科技'] },
  { id: 'comedy', icon: '😂', name_zh: '搞笑 · 段子', name_en: 'Comedy',
    keywords_zh: ['搞笑', '段子', '反转', '沙雕日常', '抖音笑话', '剧情', '恶搞', '神回复', '配音'] },
  { id: 'parenting', icon: '👶', name_zh: '母婴 · 亲子', name_en: 'Parenting',
    keywords_zh: ['宝宝日常', '亲子', '辅食', '育儿', '早教', '幼儿园', '萌娃', '孕期', '产后'] },
  { id: 'games', icon: '🎮', name_zh: '游戏', name_en: 'Gaming',
    keywords_zh: ['游戏直播', '王者荣耀', '原神', '和平精英', '手游推荐', '游戏攻略', '主机游戏', '单机游戏', '游戏剪辑', 'lol'] },
  { id: 'anime', icon: '🍥', name_zh: '二次元', name_en: 'Anime',
    keywords_zh: ['二次元', '动漫推荐', 'cosplay', '国漫', '日漫', '番剧', '手办', '萌系', '动画剪辑'] },
  { id: 'movies_tv', icon: '🎬', name_zh: '影视 · 解说', name_en: 'Movie & TV',
    keywords_zh: ['电影解说', '电视剧推荐', '影评', '看片', '国产剧', '韩剧', '美剧', '影视剪辑', '高分电影', '热播剧'] },
  { id: 'short_drama', icon: '🎭', name_zh: '小剧场', name_en: 'Mini Drama',
    keywords_zh: ['短剧', '沙雕短剧', '反转剧情', '校园剧', '都市情感', '古装短剧', '搞笑短剧', '悬疑短剧'] },
  { id: 'sports', icon: '⚽', name_zh: '体育', name_en: 'Sports',
    keywords_zh: ['篮球', '足球', '健身', '跑步', '羽毛球', '乒乓球', '体育赛事', '运动技巧', 'NBA', '世界杯'] },
  { id: 'travel', icon: '✈️', name_zh: '旅行', name_en: 'Travel',
    keywords_zh: ['旅行vlog', '国内旅游', '自驾游', '周末游', '民宿推荐', '景点打卡', '小众目的地', '城市攻略', 'citywalk'] },
  { id: 'car', icon: '🚗', name_zh: '汽车', name_en: 'Cars',
    keywords_zh: ['汽车测评', '新车试驾', 'SUV', '新能源汽车', '改装车', '二手车', '汽车文化', '比亚迪', '特斯拉'] },
  { id: 'beauty_outfit', icon: '💄', name_zh: '美妆穿搭', name_en: 'Beauty & Outfit',
    keywords_zh: ['美妆教程', '穿搭', '护肤', '口红试色', '平价好物', '通勤穿搭', 'ootd', '气质穿搭', '彩妆'] },
];

export const DouyinConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── Track + keywords (replaces persona in v5.x) ──
  // tracks 优先取 backend 下发的 scenario.tracks,缺失时用本地 fallback。
  // i18n: zh/zh-TW 用 keywords_zh,其他语言用 keywords_en (抖音几乎全中文,
  // keywords_en 多半 fallback 到 keywords_zh)。
  const lang = i18nService.currentLanguage;
  const langKey: 'zh' | 'en' = (lang === 'zh' || lang === 'zh-TW') ? 'zh' : 'en';
  const TRACKS: DouyinTrack[] = (scenario as any).tracks && (scenario as any).tracks.length > 0
    ? (scenario as any).tracks as DouyinTrack[]
    : DOUYIN_TRACKS_FALLBACK;
  const trackName = (t: DouyinTrack): string => langKey === 'en' ? (t.name_en || t.name_zh) : t.name_zh;
  const trackKeywords = (t: DouyinTrack): string[] => langKey === 'en' ? (t.keywords_en || t.keywords_zh) : t.keywords_zh;
  const initialTrackId = ((initialTask as any)?.track as string)
    || (TRACKS.find(t => t.id === 'overseas_live')?.id || TRACKS[0].id);
  const [trackId, setTrackId] = useState<string>(
    TRACKS.find(t => t.id === initialTrackId) ? initialTrackId : TRACKS[0].id
  );
  const initialKeywords: string[] = Array.isArray((initialTask as any)?.keywords) && (initialTask as any).keywords.length > 0
    ? (initialTask as any).keywords
    : trackKeywords(TRACKS.find(t => t.id === initialTrackId) || TRACKS[0]);
  const [keywordsText, setKeywordsText] = useState<string>(initialKeywords.join(' '));
  const handleTrackChange = (newTrackId: string) => {
    setTrackId(newTrackId);
    const preset = TRACKS.find(t => t.id === newTrackId);
    if (preset) setKeywordsText(trackKeywords(preset).join(' '));
  };
  function parseKeywords(raw: string): string[] {
    return raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  }

  const [likeMin, setLikeMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_like_min === 'number' ? (initialTask as any).daily_like_min : 1
  );
  const [likeMax, setLikeMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_like_max === 'number' ? (initialTask as any).daily_like_max : 5
  );
  const setLikeMin = (v: number) => {
    const n = Math.max(0, Math.min(LIKE_HARDCAP, v));
    setLikeMinRaw(n);
    setLikeMaxRaw(prev => (prev < n ? n : prev));
  };
  const setLikeMax = (v: number) => {
    const n = Math.max(0, Math.min(LIKE_HARDCAP, v));
    setLikeMaxRaw(n);
    setLikeMinRaw(prev => (prev > n ? n : prev));
  };

  const [folMin, setFolMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_follow_min === 'number' ? (initialTask as any).daily_follow_min : 0
  );
  const [folMax, setFolMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_follow_max === 'number' ? (initialTask as any).daily_follow_max : 1
  );
  const setFolMin = (v: number) => {
    const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v));
    setFolMinRaw(n);
    setFolMaxRaw(prev => (prev < n ? n : prev));
  };
  const setFolMax = (v: number) => {
    const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v));
    setFolMaxRaw(n);
    setFolMinRaw(prev => (prev > n ? n : prev));
  };

  const [cmtMin, setCmtMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_comment_min === 'number' ? (initialTask as any).daily_comment_min : 1
  );
  const [cmtMax, setCmtMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_comment_max === 'number' ? (initialTask as any).daily_comment_max : 3
  );
  const setCmtMin = (v: number) => {
    const n = Math.max(0, Math.min(COMMENT_HARDCAP, v));
    setCmtMinRaw(n);
    setCmtMaxRaw(prev => (prev < n ? n : prev));
  };
  const setCmtMax = (v: number) => {
    const n = Math.max(0, Math.min(COMMENT_HARDCAP, v));
    setCmtMaxRaw(n);
    setCmtMinRaw(prev => (prev > n ? n : prev));
  };

  // commentPrompt 已从 wizard 移除 (v5.x): AI 按 video metadata + track + keyword 自动写。

  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const totalMaxActions = likeMax + folMax + cmtMax;

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, keywordsText, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, runInterval]);

  const parsedKeywords = parseKeywords(keywordsText);
  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: parsedKeywords.length >= 1, reason: isZh ? '请至少填一个关键词' : 'Add at least one keyword' },
    2: totalMaxActions === 0
        ? { ok: false, reason: isZh ? '至少配置一项动作 (max > 0)' : 'Configure at least one action (max > 0)' }
        : { ok: true },
    3: { ok: agreed, reason: isZh ? '请确认了解风险 + 同意条款' : 'Please confirm and agree' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) {
      setSaveError(canAdvance[3].reason || (isZh ? '请确认条款' : 'Please confirm'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: trackId,
        keywords: parsedKeywords,
        persona: '',
        daily_count: Math.max(1, totalMaxActions),
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        daily_like_min: likeMin,
        daily_like_max: likeMax,
        daily_follow_min: folMin,
        daily_follow_max: folMax,
        daily_comment_min: cmtMin,
        daily_comment_max: cmtMax,
        comment_prompt: '',
      });
    } catch (err) {
      console.error('[DouyinConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      'once': isZh ? '不重复（手动触发）' : 'Once (manual only)',
      '3h': isZh ? '每 3 小时' : 'Every 3h',
      '6h': isZh ? '每 6 小时' : 'Every 6h',
      'daily_random': isZh ? '每日随机时间一次' : 'Once daily (random time)',
    };
    return m[runInterval] || runInterval;
  }, [runInterval, isZh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            🎶 {editing
              ? (isZh ? '编辑抖音互动任务' : 'Edit Douyin Engagement Task')
              : (isZh ? '配置抖音互动涨粉' : 'Configure Douyin Engage & Grow')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-violet-500/40 text-violet-500 bg-violet-500/5">
              {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
            </span>
            <button type="button" onClick={onCancel} disabled={saving}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="close">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {step === 1 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '选择赛道' : 'Select Track'}
                </label>
                <div className="relative">
                  <select
                    value={trackId}
                    onChange={e => handleTrackChange(e.target.value)}
                    className="w-full appearance-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2.5 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 cursor-pointer"
                    disabled={saving}
                  >
                    {TRACKS.map(t => (
                      <option key={t.id} value={t.id}>{t.icon} {trackName(t)}</option>
                    ))}
                  </select>
                  <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {isZh ? '关键词' : 'Keywords'}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {isZh ? '· 每次运行随机选 1 个搜索匹配视频去互动' : '· Each run picks 1 random keyword to search'}
                  </span>
                </label>
                <div className="mb-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300">
                  ✨ {isZh
                    ? <>关键词决定<strong>会去搜哪些视频做互动</strong>。预填的是各赛道高流量词,可按你账号定位增删。</>
                    : <>Keywords decide <strong>which videos get engaged with</strong>. Pre-filled with each track's high-traffic terms.</>}
                </div>
                <textarea
                  value={keywordsText}
                  onChange={e => setKeywordsText(e.target.value)}
                  placeholder={isZh ? '用空格或逗号分隔,越多越好' : 'Space or comma separated'}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-y"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {isZh ? '当前 ' + parsedKeywords.length + ' 个关键词' : parsedKeywords.length + ' keywords'}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {isZh
                  ? '每次运行,下面三项动作分别按"随机区间 [min, max]"决定做几次。设为 0/0 则该动作不执行。'
                  : 'Each run rolls a random count for each action from its [min, max] range. Set both to 0 to disable that action.'}
              </div>

              <RangeSlider
                label={isZh ? '每次运行点赞数量' : 'Likes per run'}
                min={likeMin} max={likeMax} setMin={setLikeMin} setMax={setLikeMax}
                hardCap={LIKE_HARDCAP} hint={isZh ? `每次随机点赞 ${likeMin}-${likeMax} 个视频 (0-${LIKE_HARDCAP},越大风险越高)` : `Random ${likeMin}-${likeMax} likes (0-${LIKE_HARDCAP}, higher = riskier)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行关注数量' : 'Follows per run'}
                min={folMin} max={folMax} setMin={setFolMin} setMax={setFolMax}
                hardCap={FOLLOW_HARDCAP} hint={isZh ? `每次随机关注 ${folMin}-${folMax} 个作者 (0-${FOLLOW_HARDCAP},关注是抖音风控最严的动作,建议保守)` : `Random ${folMin}-${folMax} follows (0-${FOLLOW_HARDCAP}, this is Douyin's most-flagged action — keep low)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行评论数量' : 'Comments per run'}
                min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax}
                hardCap={COMMENT_HARDCAP} hint={isZh ? `每次随机发 ${cmtMin}-${cmtMax} 条评论 (0-${COMMENT_HARDCAP},内容由 AI 按视频上下文 + 关键词自动写)` : `Random ${cmtMin}-${cmtMax} comments (0-${COMMENT_HARDCAP}, AI auto-writes from video context + keyword)`}
                disabled={saving}
              />

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{isZh ? '关注默认上限 1 — 抖音对自动关注检测最严,长期跑建议 0-2' : 'Follow is capped low — Douyin flags auto-follow most aggressively'}</li>
                  <li>{isZh ? '动作之间随机停 30 秒-3 分钟,模拟真人节奏' : 'Random 30s-3min between actions to mimic human cadence'}</li>
                  <li>{isZh ? '所有动作都基于真实 click(不发合成事件),抖音看到的是合法 user gesture' : 'All actions use native click — Douyin sees legitimate user gestures'}</li>
                </ul>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 运行间隔' : '⏰ Run Interval'}
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once',         label: isZh ? '不重复（手动触发）' : 'Once (manual only)' },
                    { value: '3h',           label: isZh ? '每 3 小时' : 'Every 3h' },
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily_random', label: isZh ? '每日随机时间一次' : 'Once daily (random time)' },
                  ].map(opt => (
                    <button
                      key={opt.value} type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
                {runInterval === 'daily_random' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {isZh
                      ? '⚠️ 互动类任务为避免被风控判定为机器人,禁止固定每日时间,每天会在随机时间点触发一次（每次距离上次至少 24 小时）。'
                      : '⚠️ Engagement tasks must not run at the same hour daily — that pattern flags as bot. Triggers once per day at a randomized time.'}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">📋 {isZh ? '任务摘要' : 'Task summary'}</div>
                <SummaryRow label={isZh ? '赛道' : 'Track'} value={(TRACKS.find(t => t.id === trackId) ? trackName(TRACKS.find(t => t.id === trackId)!) : trackId) + (isZh ? ' · ' + parsedKeywords.length + ' 关键词' : ' · ' + parsedKeywords.length + ' kw')} />
                <SummaryRow label={isZh ? '点赞数' : 'Likes'} value={`${likeMin}-${likeMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '关注数' : 'Follows'} value={`${folMin}-${folMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '评论数' : 'Comments'} value={`${cmtMin}-${cmtMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} disabled={saving}
                  className="mt-0.5 h-4 w-4 accent-violet-500 cursor-pointer shrink-0" />
                <span className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                  {isZh
                    ? '我了解抖音自动化有账号风险,会按上面配置的频率 + 间隔模拟真人节奏。任务可随时停止,运行记录可在「运行记录」查看。'
                    : 'I understand Douyin automation carries account risk. The bot will follow the configured cadence with humanized timing. I can stop anytime; runs visible in Run History.'}
                </span>
              </label>

              {saveError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs text-red-600 dark:text-red-400">
                  ❌ {saveError}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
          <button type="button" onClick={onCancel} disabled={saving}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2"
          >{isZh ? '取消' : 'Cancel'}</button>
          <div className="flex-1" />
          {step > 1 && (
            <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >← {isZh ? '上一步' : 'Prev'}</button>
          )}
          {step < 3 ? (
            <button type="button"
              onClick={() => {
                if (!canAdvance[step].ok) {
                  setSaveError(canAdvance[step].reason || (isZh ? '当前步骤未填完' : 'Current step incomplete'));
                  return;
                }
                setSaveError(null);
                setStep((step + 1) as WizardStep);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !agreed}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '🎶 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
          )}
        </div>
      </div>
    </div>
  );
};

type RangeSliderProps = {
  label: string;
  min: number;
  max: number;
  setMin: (v: number) => void;
  setMax: (v: number) => void;
  hardCap: number;
  hint: string;
  disabled?: boolean;
};

const RangeSlider: React.FC<RangeSliderProps> = ({ label, min, max, setMin, setMax, hardCap, hint, disabled }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  return (
    <div>
      <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{label}（{isZh ? '随机区间' : 'random range'}）</label>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{isZh ? '最少' : 'min'}: <span className="font-bold text-violet-500">{min}</span></div>
          <input type="range" min={0} max={hardCap} value={min}
            onChange={e => setMin(parseInt(e.target.value, 10))}
            disabled={disabled}
            className="w-full accent-violet-500" />
        </div>
        <div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{isZh ? '最多' : 'max'}: <span className="font-bold text-violet-500">{max}</span></div>
          <input type="range" min={0} max={hardCap} value={max}
            onChange={e => setMax(parseInt(e.target.value, 10))}
            disabled={disabled}
            className="w-full accent-violet-500" />
        </div>
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs">
    <span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 break-all">{value}</span>
  </div>
);
