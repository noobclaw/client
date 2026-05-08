/**
 * DouyinImageTextWizard — 抖音图文创作 wizard
 *
 *   Step 1 — 3 段「参考文案」(textareas)
 *   Step 2 — 每天生成几条 + 自动发布 / 存草稿 / 仅本地
 *   Step 3 — 调度 + 摘要 + 条款 + 创建
 *
 * 用户实测后明确:这个场景不要 persona / 赛道 / 关键词 概念,只需要 3 段
 * 参考文案。AI 拿参考文案直接创作抖音图文。
 *
 * 主色沿用 Douyin 页面的 violet,跟互动涨粉卡片视觉一致。
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

const SEGMENT_MIN_CHARS = 10;
const SEGMENT_MAX_CHARS = 800;
const DAILY_COUNT_MIN = 1;
const DAILY_COUNT_MAX = 5;

export const DouyinImageTextWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── 3 段参考文案 ──
  const initialSegments: string[] = (() => {
    const src = (initialTask as any)?.source_segments;
    if (Array.isArray(src) && src.length > 0) {
      const arr = ['', '', ''];
      for (let i = 0; i < 3; i++) arr[i] = String(src[i] || '');
      return arr;
    }
    return ['', '', ''];
  })();
  const [seg1, setSeg1] = useState<string>(initialSegments[0]);
  const [seg2, setSeg2] = useState<string>(initialSegments[1]);
  const [seg3, setSeg3] = useState<string>(initialSegments[2]);

  // ── 每次运行生成几条 ──
  const [dailyCount, setDailyCount] = useState<number>(
    typeof initialTask?.daily_count === 'number'
      ? Math.max(DAILY_COUNT_MIN, Math.min(DAILY_COUNT_MAX, initialTask.daily_count))
      : 1
  );

  // ── 生成后处理：3 选 1 ──
  //   'publish' (default) — 跑完直接发布。抖音图文草稿只能存 1 篇,后存的会
  //                          覆盖之前的,多篇任务用草稿就没意义,所以默认走发布。
  //   'draft'             — 跑完存到抖音草稿(抖音侧只 1 篇上限,会覆盖)。
  //   'local'             — 仅生成保存到本地,用户去任务详情页手动逐条上传。
  type UploadMode = 'publish' | 'draft' | 'local';
  const initialMode: UploadMode = (() => {
    const t: any = initialTask;
    if (!t) return 'publish';
    if (t.auto_upload === false) return 'local';
    if (t.auto_publish === false) return 'draft';
    return 'publish';
  })();
  const [uploadMode, setUploadMode] = useState<UploadMode>(initialMode);

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
  }, [seg1, seg2, seg3, dailyCount, uploadMode, runInterval]);

  const validSegments = [seg1, seg2, seg3]
    .map(s => s.trim())
    .filter(s => s.length >= SEGMENT_MIN_CHARS);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: validSegments.length >= 1
      ? { ok: true }
      : { ok: false, reason: isZh ? `至少 1 段参考文案（每段 ${SEGMENT_MIN_CHARS} 字以上）` : `Need at least 1 reference text (≥ ${SEGMENT_MIN_CHARS} chars each)` },
    2: dailyCount >= DAILY_COUNT_MIN
      ? { ok: true }
      : { ok: false, reason: isZh ? '每次生成至少 1 条' : 'At least 1 per run' },
    3: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) {
      setSaveError(canAdvance[3].reason || (isZh ? '请确认条款' : 'Please confirm'));
      return;
    }
    if (validSegments.length === 0) {
      setSaveError(isZh ? '至少 1 段参考文案' : 'Need at least 1 reference text');
      setStep(1);
      return;
    }
    setSaving(true);
    try {
      // uploadMode → orchestrator 看 (auto_upload, auto_publish) 两个 flag:
      //   publish: auto_upload=true,  auto_publish=true (默认,直接发布)
      //   draft:   auto_upload=true,  auto_publish=false(进抖音草稿,1 篇上限)
      //   local:   auto_upload=false (压根不上传,只本地存)
      const auto_upload = uploadMode !== 'local';
      const auto_publish = uploadMode === 'publish';
      // 这个场景没有 persona / 赛道 / 关键词概念 —— track 用 'image_text' 占位,
      // persona/keywords 传空给 createTask 兼容旧 schema。
      await onSave({
        scenario_id: scenario.id,
        track: 'image_text',
        keywords: [],
        persona: '',
        daily_count: dailyCount,
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        auto_upload,
        auto_publish,
        source_segments: [seg1, seg2, seg3].map(s => s.trim()).filter(s => s.length > 0),
      });
    } catch (err) {
      console.error('[DouyinImageTextWizard] save failed:', err);
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
            📝 {editing
              ? (isZh ? '编辑抖音图文任务' : 'Edit Douyin Image-Text Task')
              : (isZh ? '配置抖音图文创作' : 'Configure Douyin Image-Text Creation')}
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
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300">
                ✨ {isZh
                  ? <>填 <strong>3 段参考文案</strong>(可以是经历、想法、笔记、随手记)。每次任务运行会从里面<strong>随机抽 1 段</strong>,AI 拿这段参考文案直接创作抖音图文。可以只填 1 段,但 3 段不重复才能让生成多样化。</>
                  : <>Fill in <strong>3 reference texts</strong> (notes, thoughts, experiences). Each run picks one <strong>at random</strong> and AI uses it as the basis to compose a Douyin image-text post. 1 is the minimum, 3 keeps results varied.</>}
              </div>

              {[
                { label: isZh ? '参考文案 ①' : 'Reference ①', value: seg1, set: setSeg1 },
                { label: isZh ? '参考文案 ②' : 'Reference ②', value: seg2, set: setSeg2 },
                { label: isZh ? '参考文案 ③' : 'Reference ③', value: seg3, set: setSeg3 },
              ].map((row, i) => (
                <div key={i}>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    {row.label}
                    <span className="text-xs text-gray-400 font-normal ml-1">
                      {isZh
                        ? `· 建议 ${SEGMENT_MIN_CHARS}-${SEGMENT_MAX_CHARS} 字`
                        : `· ${SEGMENT_MIN_CHARS}-${SEGMENT_MAX_CHARS} chars`}
                    </span>
                  </label>
                  <textarea
                    value={row.value}
                    onChange={e => row.set(e.target.value.slice(0, SEGMENT_MAX_CHARS))}
                    placeholder={isZh
                      ? '比如：上周末跟朋友去喝咖啡，发现店里那杯特调好喝到尖叫，店主说豆子是手冲专用的...'
                      : 'e.g. Went for coffee last weekend, the special blend was insane. Owner said the beans are hand-pour only...'}
                    rows={4}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-y min-h-[90px]"
                    disabled={saving}
                  />
                  <div className="text-[11px] text-gray-400 mt-1 flex items-center gap-2">
                    <span>{row.value.trim().length} {isZh ? '字' : 'chars'}</span>
                    {row.value.trim().length > 0 && row.value.trim().length < SEGMENT_MIN_CHARS && (
                      <span className="text-amber-500">
                        ⚠️ {isZh ? `太短,建议至少 ${SEGMENT_MIN_CHARS} 字` : `too short — at least ${SEGMENT_MIN_CHARS}`}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '每次运行生成几条图文' : 'Posts per run'}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={DAILY_COUNT_MIN}
                    max={DAILY_COUNT_MAX}
                    value={dailyCount}
                    onChange={e => setDailyCount(parseInt(e.target.value, 10))}
                    disabled={saving}
                    className="flex-1 accent-violet-500"
                  />
                  <span className="text-lg font-bold text-violet-500 min-w-[2ch] text-center">{dailyCount}</span>
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                  {isZh
                    ? `每次运行从 3 段里独立随机抽 ${dailyCount} 次（同一段可能被重复选中）。建议 1-2 条,避免单日发太多触发抖音风控。`
                    : `Each run picks ${dailyCount} times independently from your 3 segments. 1-2 recommended — too many per day risks Douyin's rate control.`}
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '生成后的处理' : 'After generation'}
                </label>
                <div className="space-y-2">
                  {([
                    {
                      mode: 'publish' as UploadMode,
                      icon: '📤',
                      titleZh: '直接发布到抖音(推荐)',
                      titleEn: 'Auto-publish to Douyin (recommended)',
                      descZh: '生成完每篇直接走抖音「发布」按钮。⚠️ 一旦发出无法撤回,且单日 >5 篇有封号风险,建议先用「仅本地」模式跑一次审核质量。',
                      descEn: 'Each post hits Douyin Publish on completion. ⚠️ Posts go live immediately and can\'t be unsent; >5/day risks ban. Recommend running "Local only" first to review quality.',
                    },
                    {
                      mode: 'draft' as UploadMode,
                      icon: '📋',
                      titleZh: '存到抖音草稿(只能 1 篇,会被覆盖)',
                      titleEn: 'Save to Douyin drafts (1-only, gets overwritten)',
                      descZh: '抖音创作者中心的图文草稿只能存 1 篇,新草稿会覆盖旧的 — 多篇任务用这个模式只剩最后一篇。',
                      descEn: 'Douyin creator-center keeps only 1 image-text draft — newer overwrites older. Multi-post runs end up with just the last one.',
                    },
                    {
                      mode: 'local' as UploadMode,
                      icon: '📁',
                      titleZh: '仅生成保存到本地(最安全)',
                      titleEn: 'Generate only, save locally (safest)',
                      descZh: '不动浏览器,只把改写文本和配图存盘。任务详情页可以逐条手动上传。',
                      descEn: 'Touches no browser tab; saves rewrite + images to disk. Upload one-by-one from the task detail page.',
                    },
                  ]).map((opt) => {
                    const active = uploadMode === opt.mode;
                    return (
                      <label
                        key={opt.mode}
                        className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${active ? 'border-violet-500 bg-violet-500/5' : 'border-gray-300 dark:border-gray-700'}`}
                      >
                        <input
                          type="radio"
                          name="dy_upload_mode"
                          checked={active}
                          onChange={() => setUploadMode(opt.mode)}
                          className="mt-0.5"
                          disabled={saving}
                        />
                        <div className="flex-1 text-xs leading-relaxed">
                          <div className="font-semibold dark:text-white mb-0.5">
                            {opt.icon} {isZh ? opt.titleZh : opt.titleEn}
                          </div>
                          <div className="text-gray-500 dark:text-gray-400">
                            {isZh ? opt.descZh : opt.descEn}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {uploadMode === 'publish' && (
                    <li>{isZh ? '直接发布模式 — 跑完立即可见,慎用,日 >5 篇有封号风险' : 'Publish mode — posts go live immediately; >5/day risks ban'}</li>
                  )}
                  {uploadMode === 'draft' && (
                    <li>{isZh ? '抖音侧只保留最新 1 篇草稿,daily_count > 1 时只剩最后一篇' : 'Douyin keeps only 1 draft — multi-post runs leave just the last'}</li>
                  )}
                  {uploadMode === 'local' && (
                    <li>{isZh ? '只本地保存,不动浏览器,可在任务详情页手动逐条审核 + 上传' : 'Local only — no browser action; review + upload one-by-one from task detail'}</li>
                  )}
                  <li>{isZh ? '每篇文章会生成 2 张图: 1 张封面(大字标题截停信息流) + 1 张内容图(画面叙事,延续封面色调)' : '2 images per post: 1 cover (big title to stop the feed) + 1 content image (narrative scene, same palette)'}</li>
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
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily',        label: isZh ? '每日固定时间' : 'Daily (fixed time)' },
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
                      ? '✨ 推荐:每天随机时间触发,避免被风控判定为机器人(每次距离上次至少 24 小时)。'
                      : '✨ Recommended: triggers at a different time each day, avoiding bot-pattern detection.'}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">📋 {isZh ? '任务摘要' : 'Task summary'}</div>
                <SummaryRow
                  label={isZh ? '灵感来源' : 'Sources'}
                  value={`${validSegments.length} ${isZh ? '段（每次随机抽 1 段）' : 'segments (1 picked at random per run)'}`} />
                <SummaryRow label={isZh ? '每次生成' : 'Per run'} value={`${dailyCount} ${isZh ? '篇' : 'posts'}`} />
                <SummaryRow label={isZh ? '配图' : 'Image'} value={isZh ? '每篇 2 张 AI 图(1 封面 + 1 内容)' : '2 AI images per post (1 cover + 1 content)'} />
                <SummaryRow label={isZh ? '生成后' : 'After gen'} value={
                  uploadMode === 'publish'
                    ? (isZh ? '直接发布到抖音' : 'Auto-publish to Douyin')
                    : uploadMode === 'draft'
                      ? (isZh ? '存抖音草稿(只 1 篇,会覆盖)' : 'Douyin draft (1-only, overwrites)')
                      : (isZh ? '仅本地保存,人工审核' : 'Local only, manual review')
                } />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
                </div>
                {[
                  isZh
                    ? '我理解 NoobClaw 会在我本地浏览器代我打开抖音创作者中心,所有行为使用我自己的 IP 和账号'
                    : 'I understand NoobClaw drives the Douyin creator center inside my own browser using my IP and my account.',
                  isZh
                    ? '我理解平台账号风险由我自己承担,草稿仅暂存,需自行审核后再发布'
                    : 'I accept platform account risk, and that drafts are stored only — I review them before publishing.',
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
                      className="mt-0.5 h-4 w-4 accent-violet-500 cursor-pointer shrink-0"
                    />
                    <span className="leading-relaxed">{term}</span>
                  </label>
                ))}
              </div>

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
            <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '📝 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
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

export default DouyinImageTextWizard;
