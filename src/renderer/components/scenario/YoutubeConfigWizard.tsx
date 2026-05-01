/**
 * YoutubeConfigWizard — 独立 wizard,不复用 ConfigWizard 的 X/XHS/Binance
 * 字段。专门为 youtube_auto_engage 场景设计:
 *
 *   - persona (人设)
 *   - daily_count (每天处理几个视频, 1-30)
 *   - daily_time (HH:MM)
 *   - run_interval (daily / weekdays_only)
 *   - 三个 toggle: enable_like / enable_subscribe / enable_comment
 *   - comment_prompt (评论提示词 textarea)
 *
 * Props 接口与 ConfigWizard 一致,保证调用方(ScenarioView)不需要按平台
 * 分发。在 ConfigWizard.tsx 顶部做 if-return 路由到这里。
 *
 * 跟其他平台 wizard 的字段隔离 — 不读 X 的 KOL pool / Binance 的 track,
 * 也不写这些字段到 task,完全独立避免 UI 串台。
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

export const YoutubeConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const defaults: any = scenario.default_config || {};
  const editing = !!initialTask;

  // ── State (initialized from initialTask if editing, otherwise from defaults) ──
  const [persona, setPersona] = useState<string>(
    (initialTask?.persona as string) || defaults.persona || ''
  );
  const [dailyCount, setDailyCount] = useState<number>(
    (initialTask?.daily_count as number) || defaults.daily_count || 5
  );
  // Default time = (now + 1h), HH:MM. Editing — use existing task's time.
  const defaultTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [dailyTime, setDailyTime] = useState<string>(defaultTime);
  const [runInterval, setRunInterval] = useState<string>(
    (initialTask?.run_interval as string) || 'daily'
  );

  const [enableLike, setEnableLike] = useState<boolean>(
    typeof initialTask?.enable_like === 'boolean'
      ? initialTask.enable_like
      : (typeof defaults.enable_like === 'boolean' ? defaults.enable_like : true)
  );
  const [enableSubscribe, setEnableSubscribe] = useState<boolean>(
    typeof initialTask?.enable_subscribe === 'boolean'
      ? initialTask.enable_subscribe
      : (typeof defaults.enable_subscribe === 'boolean' ? defaults.enable_subscribe : false)
  );
  const [enableComment, setEnableComment] = useState<boolean>(
    typeof initialTask?.enable_comment === 'boolean'
      ? initialTask.enable_comment
      : (typeof defaults.enable_comment === 'boolean' ? defaults.enable_comment : true)
  );
  const [commentPrompt, setCommentPrompt] = useState<string>(
    (initialTask?.comment_prompt as string) || defaults.comment_prompt || ''
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 至少要开一个动作,否则 task 跑了什么都不做。disable 保存按钮提示用户。
  const noActionEnabled = !enableLike && !enableSubscribe && !enableComment;

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, dailyCount, dailyTime, runInterval, enableLike, enableSubscribe, enableComment, commentPrompt]);

  const handleSave = async () => {
    if (saving) return;
    if (noActionEnabled) {
      setSaveError(isZh ? '请至少开启一项互动 (点赞 / 订阅 / 评论)' : 'Please enable at least one action (like / subscribe / comment)');
      return;
    }
    if (enableComment && !commentPrompt.trim()) {
      setSaveError(isZh ? '开了评论但没填评论提示词' : 'Comment is enabled but the prompt is empty');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        // YouTube 没有 track / 关键词概念 — 传空但保留字段(后端 task store
        // 类型签名要求)。orchestrator 不读这两个字段。
        track: 'youtube_default',
        keywords: [],
        persona: persona.trim(),
        daily_count: Math.max(1, Math.min(30, dailyCount)),
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        // YouTube-specific fields — orchestrator.js reads these.
        enable_like: enableLike,
        enable_subscribe: enableSubscribe,
        enable_comment: enableComment,
        comment_prompt: commentPrompt.trim(),
      });
    } catch (err) {
      console.error('[YoutubeConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            📺 {editing
              ? (isZh ? '编辑 YouTube 互动任务' : 'Edit YouTube Engagement Task')
              : (isZh ? '配置 YouTube 智能互动' : 'Configure YouTube Auto Engagement')}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            disabled={saving}
            aria-label="close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* persona */}
          <div>
            <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
              {isZh ? '人设 (用于 AI 生成评论的语气底色)' : 'Persona (sets the voice for AI-generated comments)'}
            </label>
            <textarea
              value={persona}
              onChange={e => setPersona(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={defaults.persona || (isZh ? '例: 对科技 / Web3 / AI 内容感兴趣的普通观众' : 'e.g. casual viewer interested in tech / Web3 / AI content')}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y"
              disabled={saving}
            />
            <div className="text-[11px] text-gray-400 mt-1 text-right">{persona.length}/500</div>
          </div>

          {/* daily_count + daily_time + run_interval */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '每天处理几个视频' : 'Videos per day'}
              </label>
              <input
                type="number"
                min={1}
                max={30}
                value={dailyCount}
                onChange={e => setDailyCount(parseInt(e.target.value || '1', 10))}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40"
                disabled={saving}
              />
              <div className="text-[11px] text-gray-400 mt-1">{isZh ? '1-30' : '1-30'}</div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '执行时间' : 'Run at'}
              </label>
              <input
                type="time"
                value={dailyTime}
                onChange={e => setDailyTime(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40"
                disabled={saving}
              />
              <div className="text-[11px] text-gray-400 mt-1">{isZh ? '本机时间' : 'Local time'}</div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '运行频率' : 'Frequency'}
              </label>
              <select
                value={runInterval}
                onChange={e => setRunInterval(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40"
                disabled={saving}
              >
                <option value="daily">{isZh ? '每天' : 'Daily'}</option>
                <option value="weekdays_only">{isZh ? '仅工作日' : 'Weekdays only'}</option>
                <option value="manual">{isZh ? '仅手动触发' : 'Manual only'}</option>
              </select>
            </div>
          </div>

          {/* Action toggles */}
          <div>
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {isZh ? '互动动作 (可多选)' : 'Engagement actions (multi-select)'}
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              <ToggleCard
                checked={enableLike}
                onChange={setEnableLike}
                disabled={saving}
                emoji="👍"
                title={isZh ? '点赞' : 'Like'}
                desc={isZh ? '为视频点赞' : 'Like the video'}
                color="red"
              />
              <ToggleCard
                checked={enableSubscribe}
                onChange={setEnableSubscribe}
                disabled={saving}
                emoji="📌"
                title={isZh ? '订阅' : 'Subscribe'}
                desc={isZh ? '订阅频道 (谨慎)' : 'Subscribe (careful)'}
                color="amber"
              />
              <ToggleCard
                checked={enableComment}
                onChange={setEnableComment}
                disabled={saving}
                emoji="💬"
                title={isZh ? '评论' : 'Comment'}
                desc={isZh ? 'AI 生成一句评论' : 'AI-generated comment'}
                color="sky"
              />
            </div>
            {noActionEnabled && (
              <div className="text-[11px] text-amber-500 mt-2">
                ⚠️ {isZh ? '至少要开启一项' : 'Enable at least one'}
              </div>
            )}
          </div>

          {/* comment prompt — show only when comment is enabled */}
          {enableComment && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                💬 {isZh ? '评论提示词 (引导 AI 怎么写评论)' : 'Comment prompt (guides AI how to write)'}
              </label>
              <textarea
                value={commentPrompt}
                onChange={e => setCommentPrompt(e.target.value)}
                rows={3}
                maxLength={400}
                placeholder={defaults.comment_prompt || (isZh ? '例: 用一句自然口语化的中文写一句评论,不超过 30 字' : 'e.g. Write one casual short comment, under 30 chars')}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y"
                disabled={saving}
              />
              <div className="text-[11px] text-gray-400 mt-1 text-right">{commentPrompt.length}/400</div>
            </div>
          )}

          {/* Safety note */}
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
            ⚠️ {isZh
              ? 'YouTube 对自动化行为审查严,建议: ① 评论一定开,但提示词要写得自然;② 订阅默认关,需要时再开;③ 每天处理 5-10 个视频比较稳妥,过多易触发风控。'
              : 'YouTube enforces strict anti-automation rules. Tips: keep comments natural; leave subscribe off by default; 5-10 videos per day is the safe range.'}
          </div>

          {saveError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs text-red-600 dark:text-red-400">
              ❌ {saveError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || noActionEnabled}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '📺 ' + (isZh ? '创建任务' : 'Create Task'))}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Toggle card sub-component ──

type ToggleCardProps = {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  emoji: string;
  title: string;
  desc: string;
  color: 'red' | 'amber' | 'sky';
};

const ToggleCard: React.FC<ToggleCardProps> = ({ checked, onChange, disabled, emoji, title, desc, color }) => {
  const palette: Record<typeof color, { border: string; bg: string }> = {
    red: { border: 'border-red-500/50', bg: 'bg-red-500/10' },
    amber: { border: 'border-amber-500/50', bg: 'bg-amber-500/10' },
    sky: { border: 'border-sky-500/50', bg: 'bg-sky-500/10' },
  };
  const c = palette[color];
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`text-left px-3 py-3 rounded-xl border transition-all cursor-pointer ${
        checked
          ? `${c.border} ${c.bg}`
          : 'border-gray-300 dark:border-gray-700 bg-white/30 dark:bg-gray-800/30 hover:border-gray-400 dark:hover:border-gray-600'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{emoji}</span>
        <span className="text-sm font-medium dark:text-white">{title}</span>
        <span className="ml-auto">
          <span className={`inline-block w-3.5 h-3.5 rounded border ${
            checked
              ? 'bg-red-500 border-red-500 text-white text-[10px] flex items-center justify-center leading-none'
              : 'border-gray-400 dark:border-gray-600'
          }`}>
            {checked ? '✓' : ''}
          </span>
        </span>
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{desc}</div>
    </button>
  );
};
