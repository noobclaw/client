/**
 * BinanceSourceViralWizard — 新增的 binance_from_{xhs,douyin,tiktok}_viral 三个
 * 场景共用的 wizard。
 *
 * Source 由 scenario.id 推导:
 *   binance_from_xhs_viral    → xhs    (图文 + 视频)
 *   binance_from_douyin_viral → douyin (图文 + 视频)
 *   binance_from_tiktok_viral → tiktok (仅视频,UI 隐藏图文选项)
 *
 * 3 步 wizard(刻意简化,跟 ConfigWizard 18 个 track preset 那一套不同):
 *   Step 1 — 关键词输入(空白 textarea,用户自由填,带 placeholder 示例)
 *   Step 2 — 媒体类型(xhs/douyin:图文/视频/不限;tiktok:仅视频锁死)
 *   Step 3 — 定时(daily_count 1~5 + schedule_window 起止时间) + 摘要 + 创建
 *
 * onSave 传出来的字段跟 ConfigWizard 一致(track / keywords / persona /
 * daily_count / variants_per_post / daily_time / media_filter),所以
 * scenarioService.createTask 可以无缝接收。
 *
 * 推特(X)源**不走本 wizard** — 推特沿用现有 ConfigWizard 的 binance_from_x_repost
 * 流程(BinanceWorkflowsPage 已有的逻辑)。
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: any) => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;
type MediaFilter = 'all' | 'image_only' | 'video_only';

function sourceFromScenarioId(id: string): 'xhs' | 'douyin' | 'tiktok' {
  if (id.includes('_douyin_')) return 'douyin';
  if (id.includes('_tiktok_')) return 'tiktok';
  return 'xhs';
}

function sourceLabel(source: 'xhs' | 'douyin' | 'tiktok', zh: boolean): string {
  if (source === 'xhs')    return zh ? '小红书' : 'Xiaohongshu';
  if (source === 'douyin') return zh ? '抖音'   : 'Douyin';
  return 'TikTok';
}

function sourceEmoji(source: 'xhs' | 'douyin' | 'tiktok'): string {
  if (source === 'xhs')    return '📕';
  if (source === 'douyin') return '🎵';
  return '🎬';
}

function parseKeywords(raw: string): string[] {
  return raw.split(/[,，\s\n]+/).map(s => s.trim()).filter(Boolean);
}

const KEYWORD_PLACEHOLDER: Record<'xhs' | 'douyin' | 'tiktok', { zh: string; en: string }> = {
  xhs:    { zh: '副业\n下班赚钱\n兼职\n月入',  en: 'side hustle\npart-time\nincome\nfreelance' },
  douyin: { zh: '副业\n创业\n赚钱\n打工人', en: 'side hustle\nbusiness\nincome\nworkplace' },
  tiktok: { zh: 'crypto trading\nbitcoin tips\nweb3\nbinance', en: 'crypto trading\nbitcoin tips\nweb3\nbinance' },
};

const DEFAULT_PERSONA = '中文 web3 KOL,搬运海外/国内 alpha 并加上自己的锐评';

export const BinanceSourceViralWizard: React.FC<Props> = ({ scenario, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const source = sourceFromScenarioId(scenario.id);
  const isTiktok = source === 'tiktok';
  const srcLabel = sourceLabel(source, isZh);
  const srcEmoji = sourceEmoji(source);

  const [step, setStep] = useState<WizardStep>(1);
  const [keywordsText, setKeywordsText] = useState<string>(
    Array.isArray(initialTask?.keywords) ? (initialTask!.keywords as string[]).join('\n') : ''
  );
  // TikTok 只能视频,锁死;其它默认 'all'。Initial task 优先
  const initialMedia: MediaFilter = isTiktok ? 'video_only'
    : ((initialTask as any)?.media_filter || 'all');
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>(initialMedia);
  const [dailyCount, setDailyCount] = useState<number>(
    typeof initialTask?.daily_count === 'number' ? initialTask.daily_count : 1
  );
  const [scheduleStart, setScheduleStart] = useState<string>('09');
  const [scheduleEnd, setScheduleEnd] = useState<string>('23');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const keywords = useMemo(() => parseKeywords(keywordsText), [keywordsText]);
  const canFinish = keywords.length >= 1 && dailyCount >= 1 && dailyCount <= 5
    && Number(scheduleStart) < Number(scheduleEnd);

  // schedule_window 是 "HH:00-HH:00" 字符串。orchestrator 在窗内随机一个时间点跑。
  const scheduleWindow = `${scheduleStart.padStart(2, '0')}:00-${scheduleEnd.padStart(2, '0')}:00`;

  const handleSave = async () => {
    if (saving || !canFinish) return;
    setSaving(true);
    setSaveError(null);
    try {
      // daily_time = schedule_window 的起点(legacy field,实际触发由 scheduler
      // 在 schedule_window 内随机)
      const dailyTime = `${scheduleStart.padStart(2, '0')}:00`;
      await onSave({
        scenario_id: scenario.id,
        // 不走 preset,后端不需要 track 语义。传 'general' 占位让 schema 通过。
        track: 'general',
        keywords,
        persona: DEFAULT_PERSONA,
        daily_count: dailyCount,
        variants_per_post: 1,
        daily_time: dailyTime,
        schedule_window: scheduleWindow,
        media_filter: mediaFilter,
        enabled: true,
        active: true,
      } as any);
    } catch (e) {
      setSaveError(String(e).slice(0, 200));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl">
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-lg font-bold dark:text-white">
            {srcEmoji} {isZh ? `币安搬运 · 从${srcLabel}` : `Binance Repost · From ${srcLabel}`}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {isZh
              ? `按关键词搜${srcLabel}爆款,AI 改写后搬到币安广场。`
              : `Search ${srcLabel} by keywords, AI rewrite, repost to Binance Square.`}
          </p>
          {/* Step indicator */}
          <div className="mt-3 flex items-center gap-1.5">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`h-1.5 flex-1 rounded-full ${step >= n ? 'bg-yellow-500' : 'bg-gray-200 dark:bg-gray-700'}`}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
          {/* Step 1: keywords */}
          {step === 1 && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                {isZh ? `🔍 关键词(每行 1 个,至少 1 个)` : `🔍 Keywords (one per line, ≥ 1)`}
              </label>
              <div className="mb-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] text-yellow-700 dark:text-yellow-400 leading-relaxed">
                {isZh
                  ? `📌 关键词用于在${srcLabel}搜索爆文,AI 会按"一周内点赞最多"挑;数据不够时延伸到最近半年。建议 3-8 个紧扣赛道的词。`
                  : `📌 Keywords drive ${srcLabel} search; we pick top-liked from the last week (fallback last 6 months). 3-8 niche keywords recommended.`}
              </div>
              <textarea
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                placeholder={isZh ? KEYWORD_PLACEHOLDER[source].zh : KEYWORD_PLACEHOLDER[source].en}
                rows={6}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/50 font-mono leading-relaxed"
              />
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                {isZh ? '识别到' : 'Parsed'}: {keywords.length}
              </div>
            </div>
          )}

          {/* Step 2: media type */}
          {step === 2 && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                {isZh ? '🎨 搬运内容类型' : '🎨 Media Type'}
              </label>
              {isTiktok ? (
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-3 text-xs text-cyan-700 dark:text-cyan-300">
                  {isZh
                    ? 'TikTok 是短视频平台,只支持搬运视频(自动去水印)。'
                    : 'TikTok is short-video only — videos only (auto-watermark-removed).'}
                </div>
              ) : (
                <div className="space-y-2">
                  {(['all', 'image_only', 'video_only'] as MediaFilter[]).map((m) => (
                    <label
                      key={m}
                      className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                        mediaFilter === m
                          ? 'border-yellow-500 bg-yellow-500/5'
                          : 'border-gray-300 dark:border-gray-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="media_filter"
                        checked={mediaFilter === m}
                        onChange={() => setMediaFilter(m)}
                        className="mt-0.5"
                      />
                      <div className="text-xs">
                        <div className="font-semibold dark:text-white">
                          {m === 'all'        ? (isZh ? '📦 不限(图文 + 视频都搬)' : '📦 Any (image + video)')
                            : m === 'image_only' ? (isZh ? '🖼 仅图文'              : '🖼 Image-text only')
                            :                     (isZh ? '🎬 仅视频(去水印)'      : '🎬 Video only (watermark-removed)')}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 3: schedule + summary */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 每日搬运次数' : '⏰ Daily Run Count'}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={dailyCount}
                    onChange={(e) => setDailyCount(parseInt(e.target.value, 10))}
                    className="flex-1"
                  />
                  <span className="text-lg font-bold text-yellow-600 dark:text-yellow-400 w-8 text-center">
                    {dailyCount}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                  {isZh ? '每日最多搬运 N 条到币安广场(1~5)' : 'Up to N posts/day to Binance Square (1~5)'}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '🕒 时间窗(在此区间内随机时间点触发)' : '🕒 Schedule Window (random trigger inside this range)'}
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={scheduleStart}
                    onChange={(e) => setScheduleStart(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm dark:text-white"
                  >
                    {Array.from({ length: 24 }).map((_, h) => (
                      <option key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                  <span className="text-gray-500">→</span>
                  <select
                    value={scheduleEnd}
                    onChange={(e) => setScheduleEnd(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm dark:text-white"
                  >
                    {Array.from({ length: 24 }).map((_, h) => (
                      <option key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Summary */}
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-3 text-xs space-y-1">
                <div className="font-semibold dark:text-white mb-1">
                  {isZh ? '📋 配置摘要' : '📋 Summary'}
                </div>
                <div>{isZh ? '来源' : 'Source'}: {srcEmoji} {srcLabel}</div>
                <div>{isZh ? '关键词' : 'Keywords'}: {keywords.length > 0 ? keywords.join(', ') : (isZh ? '(空)' : '(empty)')}</div>
                <div>{isZh ? '内容类型' : 'Media'}: {
                  mediaFilter === 'all'        ? (isZh ? '图文 + 视频' : 'Image + video')
                    : mediaFilter === 'image_only' ? (isZh ? '仅图文'     : 'Image only')
                    :                                (isZh ? '仅视频(去水印)' : 'Video only (watermark-removed)')
                }</div>
                <div>{isZh ? '每日次数' : 'Daily count'}: {dailyCount}</div>
                <div>{isZh ? '时间窗' : 'Window'}: {scheduleWindow}</div>
              </div>

              {saveError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  {isZh ? '保存失败:' : 'Save failed: '}{saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex justify-between items-center bg-gray-50 dark:bg-gray-900/40">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <div className="flex gap-2">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as WizardStep)}
                className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 dark:text-gray-200"
              >
                ← {isZh ? '上一步' : 'Back'}
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s + 1) as WizardStep)}
                disabled={step === 1 && keywords.length < 1}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${
                  step === 1 && keywords.length < 1
                    ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                    : 'bg-yellow-500 text-black hover:bg-yellow-600'
                }`}
              >
                {isZh ? '下一步' : 'Next'} →
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={!canFinish || saving}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${
                  !canFinish || saving
                    ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed'
                    : 'bg-green-500 text-white hover:bg-green-600'
                }`}
              >
                {saving ? '...' : (isZh ? '✅ 创建任务' : '✅ Create Task')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BinanceSourceViralWizard;
