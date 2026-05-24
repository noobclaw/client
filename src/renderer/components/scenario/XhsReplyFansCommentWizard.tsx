/**
 * XhsReplyFansCommentWizard — 小红书自动回复粉丝评论 wizard
 *
 *   Step 1 — 核心引流语 + 概率 + 每次回复目标 + 单篇上限
 *   Step 2 — 运行间隔 + 摘要 + 条款
 *
 * 跟 XhsImageTextWizard 同款 modal 骨架。
 * 引流语为空时,probability slider 灰掉 + 显示"未填,不会带引流尾巴"。
 */

import React, { useMemo, useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: any) => Promise<void> | void;
}

type WizardStep = 1 | 2;

const FUNNEL_PHRASE_MAX = 200;
const FUNNEL_PROB_MIN = 1;
const FUNNEL_PROB_MAX = 100;
const FUNNEL_PROB_DEFAULT = 50;
const DAILY_MIN_FLOOR = 1;
const DAILY_MAX_CEIL = 80;
const PER_NOTE_MIN = 1;
const PER_NOTE_MAX = 10;

export const XhsReplyFansCommentWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── 引流语 ──
  const [funnelPhrase, setFunnelPhrase] = useState<string>(
    String((initialTask as any)?.funnel_phrase || '')
  );
  const hasFunnel = funnelPhrase.trim().length > 0;

  // ── 引流概率 ──
  const [funnelProb, setFunnelProb] = useState<number>(
    typeof (initialTask as any)?.funnel_probability === 'number'
      ? Math.max(FUNNEL_PROB_MIN, Math.min(FUNNEL_PROB_MAX, (initialTask as any).funnel_probability))
      : FUNNEL_PROB_DEFAULT
  );

  // ── 每次回复目标 (min/max) ──
  const [dailyMin, setDailyMin] = useState<number>(
    typeof (initialTask as any)?.daily_count_min === 'number'
      ? Math.max(DAILY_MIN_FLOOR, Math.min(DAILY_MAX_CEIL, (initialTask as any).daily_count_min))
      : 5
  );
  const [dailyMax, setDailyMax] = useState<number>(
    typeof (initialTask as any)?.daily_count_max === 'number'
      ? Math.max(DAILY_MIN_FLOOR, Math.min(DAILY_MAX_CEIL, (initialTask as any).daily_count_max))
      : 15
  );

  // ── 单篇笔记最多回复 ──
  const [perNoteCap, setPerNoteCap] = useState<number>(
    typeof (initialTask as any)?.max_replies_per_note === 'number'
      ? Math.max(PER_NOTE_MIN, Math.min(PER_NOTE_MAX, (initialTask as any).max_replies_per_note))
      : 5
  );

  // ── 调度 ──
  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  // ── 条款 ──
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnelPhrase, funnelProb, dailyMin, dailyMax, perNoteCap, runInterval]);

  // dailyMax 不能小于 dailyMin
  useEffect(() => {
    if (dailyMax < dailyMin) setDailyMax(dailyMin);
  }, [dailyMin, dailyMax]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: dailyMin >= 1 && dailyMax >= dailyMin
      ? { ok: true }
      : { ok: false, reason: isZh ? '每次回复目标至少 1，且上限 ≥ 下限' : 'Daily target ≥ 1 and max ≥ min' },
    2: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[2].ok) {
      setSaveError(canAdvance[2].reason || (isZh ? '请确认条款' : 'Please confirm'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: 'reply_fan_comment',
        keywords: [],
        persona: '',
        daily_count_min: dailyMin,
        daily_count_max: dailyMax,
        daily_count: dailyMax,  // back-compat field
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        funnel_phrase: funnelPhrase.trim(),
        funnel_probability: hasFunnel ? funnelProb : 0,
        max_replies_per_note: perNoteCap,
        auto_upload: false,
        auto_publish: false,
      });
    } catch (err) {
      console.error('[XhsReplyFansCommentWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      'once': isZh ? '不重复（手动触发）' : 'Once (manual only)',
      '6h': isZh ? '每 6 小时' : 'Every 6h',
      'daily': isZh ? '每日固定时间' : 'Daily (fixed time)',
      'daily_random': isZh ? '每日随机时间一次' : 'Once daily (random time)',
    };
    return m[runInterval] || runInterval;
  }, [runInterval, isZh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            💌 {editing
              ? (isZh ? '编辑回复粉丝评论任务' : 'Edit Fan-Comment Reply Task')
              : (isZh ? '配置回复粉丝评论' : 'Configure Fan-Comment Reply')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-fuchsia-500/40 text-fuchsia-500 bg-fuchsia-500/5">
              {isZh ? `第 ${step} / 2 步` : `Step ${step} / 2`}
            </span>
            <button type="button" onClick={onCancel} disabled={saving}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="close">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {step === 1 && (
            <>
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-700 dark:text-fuchsia-300">
                💌 {isZh
                  ? <>本任务会自动打开你的<strong>创作者中心</strong>,逐篇笔记进详情页,读粉丝评论 → AI 写回应 → 真人节奏发送。<strong>已回复过的、自己留的评论自动跳过</strong>,从不评论笔记本身。</>
                  : <>This task opens your <strong>Creator Center</strong>, walks each note's detail page, reads fan comments → AI writes replies → posts on human-paced jitter. <strong>Auto-skips comments you've already replied to or your own.</strong></>}
              </div>

              {/* 引流语 textarea */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {isZh ? '🎣 核心引流语（选填）' : '🎣 Funnel phrase (optional)'}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {isZh ? `· 留空则回复不带引流尾巴` : `· Empty = no funnel tail`}
                  </span>
                </label>
                <textarea
                  value={funnelPhrase}
                  onChange={e => setFunnelPhrase(e.target.value.slice(0, FUNNEL_PHRASE_MAX))}
                  placeholder={isZh
                    ? '比如：详细攻略发在我主页置顶笔记里，需要的可以去看一下\n或：私我领西湖路书pdf'
                    : 'e.g. Full guide in my pinned post — feel free to check.\nor: DM me for the West Lake route PDF.'}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[80px]"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {funnelPhrase.trim().length} / {FUNNEL_PHRASE_MAX} {isZh ? '字' : 'chars'}
                </div>
              </div>

              {/* 引流概率 slider */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh
                    ? `🎲 引流尾巴出现概率: ${hasFunnel ? funnelProb : 0}%`
                    : `🎲 Funnel tail probability: ${hasFunnel ? funnelProb : 0}%`}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {hasFunnel
                      ? (isZh ? '· AI 会按概率把引流语自然衔接到回复尾部' : '· AI weaves funnel into reply tail by probability')
                      : (isZh ? '· 引流语未填,概率失效' : '· Funnel empty, probability disabled')}
                  </span>
                </label>
                <input
                  type="range"
                  min={FUNNEL_PROB_MIN}
                  max={FUNNEL_PROB_MAX}
                  value={funnelProb}
                  onChange={e => setFunnelProb(parseInt(e.target.value, 10))}
                  disabled={saving || !hasFunnel}
                  className="w-full accent-fuchsia-500 disabled:opacity-40"
                />
                <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                  {isZh
                    ? '💡 推荐 30~60%。太高了所有回复带广告会被粉丝反感,太低看不出导流效果。每条回复独立抽签,统计上贴近你设的比例。'
                    : '💡 Recommended 30-60%. Too high reads as spammy; too low loses funnel effect. Each reply is an independent dice roll.'}
                </div>
              </div>

              {/* 每次回复目标 min/max + 单篇上限 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                    {isZh ? `每次最少回复 ${dailyMin} 条` : `Min per run: ${dailyMin}`}
                  </label>
                  <input
                    type="range"
                    min={DAILY_MIN_FLOOR}
                    max={DAILY_MAX_CEIL}
                    value={dailyMin}
                    onChange={e => setDailyMin(parseInt(e.target.value, 10))}
                    disabled={saving}
                    className="w-full accent-fuchsia-500"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                    {isZh ? `每次最多回复 ${dailyMax} 条` : `Max per run: ${dailyMax}`}
                  </label>
                  <input
                    type="range"
                    min={DAILY_MIN_FLOOR}
                    max={DAILY_MAX_CEIL}
                    value={dailyMax}
                    onChange={e => setDailyMax(parseInt(e.target.value, 10))}
                    disabled={saving}
                    className="w-full accent-fuchsia-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? `📌 单篇笔记最多回复 ${perNoteCap} 条` : `📌 Max replies per note: ${perNoteCap}`}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {isZh ? '· 一篇笔记下回得太多会被风控盯上' : '· Too many on one note triggers anti-spam'}
                  </span>
                </label>
                <input
                  type="range"
                  min={PER_NOTE_MIN}
                  max={PER_NOTE_MAX}
                  value={perNoteCap}
                  onChange={e => setPerNoteCap(parseInt(e.target.value, 10))}
                  disabled={saving}
                  className="w-full accent-fuchsia-500"
                />
              </div>

              <div className="rounded-md bg-amber-500/5 border border-amber-500/30 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                ⚠️ {isZh
                  ? <>每条回复有 <strong>30~90 秒</strong> 节奏抖动,每篇笔记间 <strong>45~150 秒</strong>。AI token 按 Anthropic 标价扣;<strong>每条成功回复额外扣平台 token (跟点赞类似)</strong>,失败/跳过不扣。</>
                  : <>Each reply: <strong>30-90s</strong> jitter; between notes: <strong>45-150s</strong>. AI tokens billed at provider rates; <strong>each successful reply also charges platform tokens (like the 点赞 model)</strong>; skipped/failed = no charge.</>}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 运行间隔' : '⏰ Run Interval'}
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once',         label: isZh ? '不重复（手动触发）' : 'Once (manual only)' },
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily',        label: isZh ? '每日固定时间' : 'Daily (fixed time)' },
                    { value: 'daily_random', label: isZh ? '每日随机时间一次' : 'Once daily (random time)' },
                  ].map(opt => (
                    <button
                      key={opt.value} type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-fuchsia-500/50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">📋 {isZh ? '任务摘要' : 'Task summary'}</div>
                <SummaryRow
                  label={isZh ? '引流语' : 'Funnel'}
                  value={hasFunnel
                    ? `"${funnelPhrase.trim().slice(0, 40)}${funnelPhrase.trim().length > 40 ? '...' : ''}" · ${funnelProb}%`
                    : (isZh ? '（未填,纯 AI 回复）' : '(empty, pure AI reply)')} />
                <SummaryRow
                  label={isZh ? '每次回复' : 'Per run'}
                  value={`${dailyMin} ~ ${dailyMax} ${isZh ? '条 (随机)' : '(random)'}`} />
                <SummaryRow
                  label={isZh ? '单篇上限' : 'Per-note cap'}
                  value={`${perNoteCap} ${isZh ? '条' : 'replies'}`} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
                <SummaryRow
                  label={isZh ? '安全节奏' : 'Pacing'}
                  value={isZh ? '评论间 30~90s · 笔记间 45~150s' : 'Reply 30-90s · Note 45-150s'} />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
                </div>
                {[
                  isZh
                    ? '我理解 NoobClaw 会在我本地浏览器里打开创作者中心 + 小红书主站,使用我自己的账号身份回复'
                    : 'I understand NoobClaw drives Creator Center + Xiaohongshu main site in my own browser using my account.',
                  isZh
                    ? '我理解每条成功回复会额外扣平台 token (跟点赞模式类似),失败 / 跳过不扣'
                    : 'I understand each successful reply incurs a platform token charge (similar to the like model); failed/skipped = no charge.',
                ].map((term, i) => (
                  <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={termsAccepted[i]}
                      onChange={e => {
                        const next = [...termsAccepted];
                        next[i] = e.target.checked;
                        setTermsAccepted(next);
                      }}
                      disabled={saving}
                      className="mt-0.5 h-4 w-4 accent-fuchsia-500 cursor-pointer shrink-0"
                    />
                    <span className="leading-relaxed">{term}</span>
                  </label>
                ))}
              </div>
            </>
          )}

        </div>

        {(!canAdvance[step].ok || saveError) && (
          <div className="px-6 pt-2 pb-1 shrink-0">
            <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              saveError
                ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
                : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300'
            }`}>
              {saveError
                ? `❌ ${saveError}`
                : `⚠️ ${canAdvance[step].reason || (isZh ? '当前步骤还有必填项未完成' : 'Required fields incomplete on this step')}`}
            </div>
          </div>
        )}

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
          {step < 2 ? (
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '💌 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
          )}
        </div>
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs">
    <span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 break-all">{value}</span>
  </div>
);

export default XhsReplyFansCommentWizard;
