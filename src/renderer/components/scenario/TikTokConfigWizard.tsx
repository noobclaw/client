/**
 * TikTokConfigWizard — 独立 3-step wizard,镜像 YoutubeConfigWizard:
 *
 *   Step 1 — 人设
 *   Step 2 — 互动数量 (3 个 min/max 滑条: 点赞 / 关注 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 pills + 摘要 + 创建
 *
 * 跟 YoutubeConfigWizard 的差异:
 *   - 关注 (follow) 而不是订阅 (subscribe)
 *   - 主色 cyan (避开 TikTok brand pink + 跟其它平台色区分)
 *   - 字段 enable_follow / daily_follow_min / daily_follow_max
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

export const TikTokConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const defaults: any = scenario.default_config || {};
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  const [persona, setPersona] = useState<string>(
    (initialTask?.persona as string) || defaults.persona || ''
  );

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

  const [commentPrompt, setCommentPrompt] = useState<string>(
    ((initialTask as any)?.comment_prompt as string) || defaults.comment_prompt || ''
  );

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
  }, [persona, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, commentPrompt, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: persona.trim().length > 0, reason: isZh ? '请填写人设' : 'Persona is required' },
    2: totalMaxActions === 0
        ? { ok: false, reason: isZh ? '至少配置一项动作 (max > 0)' : 'Configure at least one action (max > 0)' }
        : (cmtMax > 0 && !commentPrompt.trim())
          ? { ok: false, reason: isZh ? '评论数 > 0 时必须填写评论提示词' : 'Comment prompt required when comments > 0' }
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
        track: 'tiktok_default',
        keywords: [],
        persona: persona.trim(),
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
        comment_prompt: commentPrompt.trim(),
      });
    } catch (err) {
      console.error('[TikTokConfigWizard] save failed:', err);
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
            🎵 {editing
              ? (isZh ? '编辑 TikTok 互动任务' : 'Edit TikTok Engagement Task')
              : (isZh ? '配置 TikTok 互动涨粉' : 'Configure TikTok Engage & Grow')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-cyan-500/40 text-cyan-500 bg-cyan-500/5">
              {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
            </span>
            <button type="button" onClick={onCancel} disabled={saving}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="close">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {step === 1 && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '人设 (用于 AI 生成评论的语气底色)' : 'Persona (sets the voice for AI-generated comments)'}
              </label>
              <textarea
                value={persona}
                onChange={e => setPersona(e.target.value)}
                rows={8} maxLength={800}
                placeholder={defaults.persona || (isZh ? '例: 对短视频 / 流行文化 / 旅行 感兴趣的普通观众,评论自然口语,不爹味、不拍马屁' : 'e.g. casual viewer interested in short-form / pop culture / travel; natural comments, no flattery')}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 resize-y"
                disabled={saving}
              />
              <div className="text-[11px] text-gray-400 mt-1 text-right">{persona.length}/800</div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">
                {isZh
                  ? '人设决定 AI 评论的语气。下一步设置每次运行点赞 / 关注 / 评论的随机区间。'
                  : 'Persona shapes the voice of AI-generated comments. Next step picks the per-run quotas for like / follow / comment.'}
              </p>
            </div>
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
                hardCap={FOLLOW_HARDCAP} hint={isZh ? `每次随机关注 ${folMin}-${folMax} 个作者 (0-${FOLLOW_HARDCAP},关注是 TikTok 风控最严的动作,建议保守)` : `Random ${folMin}-${folMax} follows (0-${FOLLOW_HARDCAP}, this is TikTok's most-flagged action — keep low)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行评论数量' : 'Comments per run'}
                min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax}
                hardCap={COMMENT_HARDCAP} hint={isZh ? `每次随机发 ${cmtMin}-${cmtMax} 条评论 (0-${COMMENT_HARDCAP},内容由 AI 按下方提示词生成,语言会自动匹配视频与评论区)` : `Random ${cmtMin}-${cmtMax} comments (0-${COMMENT_HARDCAP}, AI writes from prompt below; language auto-matches video & comments)`}
                disabled={saving}
              />

              {cmtMax > 0 && (
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    💬 {isZh ? '评论提示词 (引导 AI 怎么写评论)' : 'Comment prompt (guides AI how to write)'}
                  </label>
                  <textarea
                    value={commentPrompt}
                    onChange={e => setCommentPrompt(e.target.value)}
                    rows={3} maxLength={400}
                    placeholder={defaults.comment_prompt || (isZh ? '例: 用一句自然口语短评,语言匹配视频与评论区,不超过 30 字 / 20 词' : 'e.g. one casual short reaction; match video & comments language; under 30 chars / 20 words')}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 resize-y"
                    disabled={saving}
                  />
                  <div className="text-[11px] text-gray-400 mt-1 text-right">{commentPrompt.length}/400</div>
                </div>
              )}

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{isZh ? '关注默认上限 1 — TikTok 对自动关注检测最严,长期跑建议 0-2' : 'Follow is capped low — TikTok flags auto-follow most aggressively'}</li>
                  <li>{isZh ? '动作之间随机停 30 秒-3 分钟,模拟真人节奏' : 'Random 30s-3min between actions to mimic human cadence'}</li>
                  <li>{isZh ? '所有动作都基于真实 click(不发合成事件),TikTok 看到的是合法 user gesture' : 'All actions use native click — TikTok sees legitimate user gestures'}</li>
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
                          ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-cyan-500/50'
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
                <SummaryRow label={isZh ? '人设' : 'Persona'} value={persona.split('\n')[0].slice(0, 60) + (persona.length > 60 ? '...' : '')} />
                <SummaryRow label={isZh ? '点赞数' : 'Likes'} value={`${likeMin}-${likeMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '关注数' : 'Follows'} value={`${folMin}-${folMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '评论数' : 'Comments'} value={`${cmtMin}-${cmtMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
                {cmtMax > 0 && commentPrompt.trim() && (
                  <SummaryRow label={isZh ? '评论提示' : 'Prompt'} value={commentPrompt.trim().slice(0, 60) + (commentPrompt.length > 60 ? '...' : '')} />
                )}
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} disabled={saving}
                  className="mt-0.5 h-4 w-4 accent-cyan-500 cursor-pointer shrink-0" />
                <span className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                  {isZh
                    ? '我了解 TikTok 自动化有账号风险,会按上面配置的频率 + 间隔模拟真人节奏。任务可随时停止,运行记录可在「运行记录」查看。'
                    : 'I understand TikTok automation carries account risk. The bot will follow the configured cadence with humanized timing. I can stop anytime; runs visible in Run History.'}
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-cyan-500 text-white hover:bg-cyan-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !agreed}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-cyan-500 text-white hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '🎵 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
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
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{isZh ? '最少' : 'min'}: <span className="font-bold text-cyan-500">{min}</span></div>
          <input type="range" min={0} max={hardCap} value={min}
            onChange={e => setMin(parseInt(e.target.value, 10))}
            disabled={disabled}
            className="w-full accent-cyan-500" />
        </div>
        <div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{isZh ? '最多' : 'max'}: <span className="font-bold text-cyan-500">{max}</span></div>
          <input type="range" min={0} max={hardCap} value={max}
            onChange={e => setMax(parseInt(e.target.value, 10))}
            disabled={disabled}
            className="w-full accent-cyan-500" />
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
