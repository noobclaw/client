/**
 * DouyinConfigWizard — 独立 3-step wizard 模仿 ConfigWizard 的形态:
 *
 *   Step 1 — 任务基础: 人设 + 每天处理几个视频
 *   Step 2 — 互动配置: 三个 toggle (点赞 / 关注 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 + 确认: 运行间隔 pills + 任务摘要 + 创建按钮
 *
 * 字段保持 v1: enable_like / enable_follow / enable_comment / comment_prompt /
 * persona / daily_count / daily_time / run_interval。**没有** min-max sliders
 * (抖音互动逻辑就是精选页随机挑视频按 toggle 做动作,跟 youtube/tiktok 同款)。
 *
 * 跟其他平台 wizard 的字段隔离 — 不读 X 的 KOL pool / Binance 的 track,
 * 也不写这些字段到 task,完全独立避免 UI 串台。在 ConfigWizard.tsx 顶部
 * 通过 `if (scenario.id === 'douyin_auto_engage') return <DouyinConfigWizard/>`
 * 短路路由到这里。
 *
 * 跟 YoutubeConfigWizard 的差异:
 *   - "subscribe" → "follow"(关注)
 *   - emoji 📺 → 🎶
 *   - 评论描述提到"中文为主"(抖音受众主要中文,默认中文回复)
 *   - 主色保持 red 跟 DouyinWorkflowsPage 的 brand color 一致
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

export const DouyinConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const defaults: any = scenario.default_config || {};
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── State ──
  const [persona, setPersona] = useState<string>(
    (initialTask?.persona as string) || defaults.persona || ''
  );
  const [dailyCount, setDailyCount] = useState<number>(
    (initialTask?.daily_count as number) || defaults.daily_count || 5
  );
  // daily_time not user-editable in new wizard — pills replace the picker.
  // Kept as memo for back-compat with scheduler / task store. No setter.
  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  const [enableLike, setEnableLike] = useState<boolean>(
    typeof (initialTask as any)?.enable_like === 'boolean'
      ? (initialTask as any).enable_like
      : (typeof defaults.enable_like === 'boolean' ? defaults.enable_like : true)
  );
  const [enableFollow, setEnableFollow] = useState<boolean>(
    typeof (initialTask as any)?.enable_follow === 'boolean'
      ? (initialTask as any).enable_follow
      : (typeof defaults.enable_follow === 'boolean' ? defaults.enable_follow : false)
  );
  const [enableComment, setEnableComment] = useState<boolean>(
    typeof (initialTask as any)?.enable_comment === 'boolean'
      ? (initialTask as any).enable_comment
      : (typeof defaults.enable_comment === 'boolean' ? defaults.enable_comment : true)
  );
  const [commentPrompt, setCommentPrompt] = useState<string>(
    ((initialTask as any)?.comment_prompt as string) || defaults.comment_prompt || ''
  );

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const noActionEnabled = !enableLike && !enableFollow && !enableComment;

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, dailyCount, runInterval, enableLike, enableFollow, enableComment, commentPrompt]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: persona.trim().length > 0 && dailyCount >= 1 && dailyCount <= 30, reason: isZh ? '请先填写人设 + 每天视频数 (1-30)' : 'Fill in persona + 1-30 videos/day' },
    2: noActionEnabled
        ? { ok: false, reason: isZh ? '至少开启一项互动 (点赞 / 关注 / 评论)' : 'Enable at least one action' }
        : (enableComment && !commentPrompt.trim())
          ? { ok: false, reason: isZh ? '开了评论但没填评论提示词' : 'Comment is on but the prompt is empty' }
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
        track: 'douyin_default',
        keywords: [],
        persona: persona.trim(),
        daily_count: Math.max(1, Math.min(30, dailyCount)),
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        enable_like: enableLike,
        enable_follow: enableFollow,
        enable_comment: enableComment,
        comment_prompt: commentPrompt.trim(),
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

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            🎶 {editing
              ? (isZh ? '编辑抖音互动任务' : 'Edit Douyin Engagement Task')
              : (isZh ? '配置抖音互动涨粉' : 'Configure Douyin Engage & Grow')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-red-500/40 text-red-500 bg-red-500/5">
              {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
            </span>
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
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* ── Step 1: persona + daily_count ── */}
          {step === 1 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {isZh ? '人设 (用于 AI 生成评论的语气底色)' : 'Persona (sets the voice for AI-generated comments)'}
                </label>
                <textarea
                  value={persona}
                  onChange={e => setPersona(e.target.value)}
                  rows={4}
                  maxLength={500}
                  placeholder={defaults.persona || (isZh ? '例: 对短视频 / 生活方式 / 美食 感兴趣的普通观众,评论自然口语,不爹味、不拍马屁' : 'e.g. casual viewer interested in short-form / lifestyle / food; natural comments, no flattery')}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1 text-right">{persona.length}/500</div>
              </div>

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
                  className="w-32 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40"
                  disabled={saving}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                  {isZh
                    ? '建议 3-8 个 / 天。抖音对自动化检测严,过多易触发风控。每个视频会模拟观看停留再操作。'
                    : 'Recommended 3-8/day. Douyin anti-automation is strict; the bot will simulate dwell time per video before acting.'}
                </p>
              </div>
            </>
          )}

          {/* ── Step 2: action toggles + comment prompt + safety note ── */}
          {step === 2 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '互动动作 (可多选)' : 'Engagement actions (multi-select)'}
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  <ToggleCard checked={enableLike} onChange={setEnableLike} disabled={saving}
                    emoji="👍" title={isZh ? '点赞' : 'Like'}
                    desc={isZh ? '为视频点赞' : 'Like the video'} />
                  <ToggleCard checked={enableFollow} onChange={setEnableFollow} disabled={saving}
                    emoji="➕" title={isZh ? '关注' : 'Follow'}
                    desc={isZh ? '关注作者 (谨慎)' : 'Follow author (careful)'} />
                  <ToggleCard checked={enableComment} onChange={setEnableComment} disabled={saving}
                    emoji="💬" title={isZh ? '评论' : 'Comment'}
                    desc={isZh ? 'AI 生成中文短评' : 'AI generates short Chinese comment'} />
                </div>
                {noActionEnabled && (
                  <div className="text-xs text-amber-500 mt-2">
                    ⚠️ {isZh ? '至少要开启一项,否则任务跑了什么都不做' : 'Enable at least one — otherwise the task has nothing to do'}
                  </div>
                )}
              </div>

              {enableComment && (
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    💬 {isZh ? '评论提示词 (引导 AI 怎么写评论)' : 'Comment prompt (guides AI how to write)'}
                  </label>
                  <textarea
                    value={commentPrompt}
                    onChange={e => setCommentPrompt(e.target.value)}
                    rows={4}
                    maxLength={400}
                    placeholder={defaults.comment_prompt || (isZh ? '例: 用一句自然口语的中文短评,不超过 30 字,不要拍马屁' : 'e.g. one casual short comment in Chinese, under 30 chars, no flattery')}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y"
                    disabled={saving}
                  />
                  <div className="text-[11px] text-gray-400 mt-1 text-right">{commentPrompt.length}/400</div>
                </div>
              )}

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{isZh ? '关注默认关闭 — 抖音对自动关注的检测最严,只在确实想关注作者时再开' : 'Follow is off by default — Douyin flags auto-follows most aggressively'}</li>
                  <li>{isZh ? '评论提示词写得越自然越好,避免空泛"学到了""棒"等典型水军词' : 'Keep comment prompts natural; avoid stock filler like "great" or "learned a lot"'}</li>
                  <li>{isZh ? '动作之间会随机停 30 秒-3 分钟模拟真人节奏' : 'Random 30s-3min jitter between actions to mimic human cadence'}</li>
                </ul>
              </div>
            </>
          )}

          {/* ── Step 3: schedule + summary + confirm ── */}
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
                      key={opt.value}
                      type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-red-500 bg-red-500/10 text-red-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-red-500/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {runInterval === 'daily_random' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {isZh
                      ? '⚠️ 互动类任务为避免被风控判定为机器人,禁止固定每日时间,每天会在随机时间点触发一次（每次距离上次至少 24 小时）。'
                      : '⚠️ Engagement tasks must not run at the same hour daily — that pattern flags as bot. Triggers once per day at a randomized time, with at least 24h between runs.'}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">
                  📋 {isZh ? '任务摘要' : 'Task summary'}
                </div>
                <SummaryRow label={isZh ? '人设' : 'Persona'} value={persona.split('\n')[0].slice(0, 50) + (persona.length > 50 ? '...' : '')} />
                <SummaryRow label={isZh ? '每天处理' : 'Per day'} value={`${dailyCount} ${isZh ? '个视频' : 'videos'}`} />
                <SummaryRow label={isZh ? '互动动作' : 'Actions'} value={[
                  enableLike && (isZh ? '👍 点赞' : '👍 like'),
                  enableFollow && (isZh ? '➕ 关注' : '➕ follow'),
                  enableComment && (isZh ? '💬 评论' : '💬 comment'),
                ].filter(Boolean).join(' / ') || (isZh ? '(无)' : '(none)')} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
                {enableComment && commentPrompt.trim() && (
                  <SummaryRow label={isZh ? '评论提示' : 'Prompt'} value={commentPrompt.trim().slice(0, 60) + (commentPrompt.length > 60 ? '...' : '')} />
                )}
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={e => setAgreed(e.target.checked)}
                  disabled={saving}
                  className="mt-0.5 h-4 w-4 accent-red-500 cursor-pointer shrink-0"
                />
                <span className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                  {isZh
                    ? '我了解抖音自动化有账号风险,会按上面配置的频率 + 间隔模拟真人节奏。任务可随时停止,运行记录可在「运行记录」查看。'
                    : 'I understand Douyin automation carries account risk. The bot will follow the configured cadence with humanized timing. I can stop the task anytime; runs are visible in Run History.'}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
          <div className="flex-1" />
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((step - 1) as WizardStep)}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              ← {isZh ? '上一步' : 'Prev'}
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                if (!canAdvance[step].ok) {
                  setSaveError(canAdvance[step].reason || (isZh ? '当前步骤未填完' : 'Current step incomplete'));
                  return;
                }
                setSaveError(null);
                setStep((step + 1) as WizardStep);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >
              {isZh ? '下一步' : 'Next'} →
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !agreed}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving
                ? (isZh ? '保存中...' : 'Saving...')
                : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '🎶 ' + (isZh ? '创建任务' : 'Create Task'))}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Sub-components ──

type ToggleCardProps = {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  emoji: string;
  title: string;
  desc: string;
};

const ToggleCard: React.FC<ToggleCardProps> = ({ checked, onChange, disabled, emoji, title, desc }) => {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`text-left px-3 py-3 rounded-xl border transition-all cursor-pointer ${
        checked
          ? 'border-red-500/50 bg-red-500/10'
          : 'border-gray-300 dark:border-gray-700 bg-white/30 dark:bg-gray-800/30 hover:border-gray-400 dark:hover:border-gray-600'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{emoji}</span>
        <span className="text-sm font-medium dark:text-white">{title}</span>
        <span className="ml-auto">
          <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded border text-[10px] leading-none ${
            checked
              ? 'bg-red-500 border-red-500 text-white'
              : 'border-gray-400 dark:border-gray-600 text-transparent'
          }`}>
            ✓
          </span>
        </span>
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">{desc}</div>
    </button>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs">
    <span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 break-all">{value}</span>
  </div>
);
