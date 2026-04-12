/**
 * ConfigWizard — 4-step modal for creating/editing a scenario task.
 *
 * Steps:
 *   1. Track picker (fine-grained niche — seeds default keywords)
 *   2. Persona
 *   3. Daily execution time + per-day count
 *   4. Confirm + login check + terms
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

// ── Track presets (mirrors main-process XHS_TRACK_PRESETS) ──
type TrackPreset = {
  id: string;
  icon: string;
  name_zh: string;
  keywords: string[];
  persona_hint: string;
};

const TRACK_PRESETS: TrackPreset[] = [
  { id: 'career_side_hustle', icon: '💼', name_zh: '副业 · 打工人赚钱', keywords: ['副业', '下班变现', '兼职', '月入'], persona_hint: '一个想在下班后搞点副业的普通打工人，真诚不装' },
  { id: 'indie_dev', icon: '👩‍💻', name_zh: '独立开发 · 程序员记录', keywords: ['独立开发', '程序员副业', 'indie hacker', '个人开发者'], persona_hint: '独立开发者，前后端都写，真诚记录产品和收入' },
  { id: 'personal_finance', icon: '💰', name_zh: '理财 · 记账攻略', keywords: ['理财', '攒钱', '记账', '定投'], persona_hint: '月薪 1 万的普通白领，认真记账、稳健理财' },
  { id: 'travel', icon: '✈️', name_zh: '旅行 · 攻略分享', keywords: ['旅行攻略', '穷游', '周末游', '小众目的地'], persona_hint: '爱说走就走的旅行爱好者，分享性价比攻略' },
  { id: 'food', icon: '🍲', name_zh: '美食 · 探店做饭', keywords: ['探店', '做饭', '日常晚餐', '健康餐'], persona_hint: '喜欢折腾吃喝的上班族，每天做饭给自己' },
  { id: 'outfit', icon: '👗', name_zh: '穿搭 · 风格分享', keywords: ['穿搭', 'OOTD', '通勤穿搭', '小个子穿搭'], persona_hint: '小个子职场穿搭爱好者' },
  { id: 'beauty', icon: '💄', name_zh: '美妆 · 产品测评', keywords: ['美妆', '护肤', '平价彩妆', '粉底液测评'], persona_hint: '敏感肌护肤爱好者，只买成分党认证的' },
  { id: 'fitness', icon: '💪', name_zh: '健身 · 减脂日记', keywords: ['健身', '减脂', '塑形', '居家健身'], persona_hint: '上班族，边工作边坚持居家健身一年' },
  { id: 'reading', icon: '📚', name_zh: '读书 · 书单笔记', keywords: ['读书', '书单', '读书笔记', '年度书单'], persona_hint: '一年读 50 本书的普通读者' },
  { id: 'parenting', icon: '🧸', name_zh: '育儿 · 亲子日常', keywords: ['育儿', '亲子', '早教', '母婴好物'], persona_hint: '3 岁娃妈妈，理性育儿不焦虑' },
  { id: 'exam_prep', icon: '🎓', name_zh: '考研 · 备考党', keywords: ['考研', '考研经验', '英语学习', '备考'], persona_hint: '二战考研人，记录每日学习节奏' },
  { id: 'pets', icon: '🐱', name_zh: '宠物 · 猫狗日常', keywords: ['猫咪', '狗狗', '宠物日常', '宠物用品'], persona_hint: '一只中华田园猫的主人，真实养宠记录' },
  { id: 'home_decor', icon: '🏠', name_zh: '家居 · 小屋布置', keywords: ['家居', '小户型', '租房改造', '收纳'], persona_hint: '租房党，用 2000 预算把小公寓改舒服' },
  { id: 'study_method', icon: '🏆', name_zh: '学习 · 效率工具', keywords: ['效率', '时间管理', '学习方法', 'Notion'], persona_hint: '热爱效率工具的产品经理' },
  { id: 'career_growth', icon: '🎯', name_zh: '职场 · 升级打怪', keywords: ['职场', '升职', '面试', '跳槽'], persona_hint: '互联网行业工作 5 年的打工人' },
  { id: 'emotional_wellness', icon: '🧘', name_zh: '情感 · 心理疗愈', keywords: ['情感', '心理', 'MBTI', '自我成长'], persona_hint: '正在做自我探索的 30 岁女性' },
  { id: 'photography', icon: '📷', name_zh: '摄影 · 日常记录', keywords: ['摄影', '手机摄影', '胶片', '构图'], persona_hint: '业余摄影爱好者，周末扫街' },
  { id: 'crafts', icon: '🎨', name_zh: '手工 · DIY', keywords: ['手工', 'DIY', '手账', '手工教程'], persona_hint: '热爱动手做点小东西的文艺青年' },
];

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: {
    scenario_id: string;
    track: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    daily_time: string;
  }) => Promise<void> | void;
}

function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export const ConfigWizard: React.FC<Props> = ({ scenario, initialTask, onCancel, onSave }) => {
  const defaults = scenario.default_config;
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [saving, setSaving] = useState(false);

  // Track
  const initialTrackId =
    initialTask?.track && TRACK_PRESETS.find(t => t.id === initialTask.track)
      ? initialTask.track
      : TRACK_PRESETS[0].id;
  const [trackId, setTrackId] = useState<string>(initialTrackId);
  const selectedTrack = TRACK_PRESETS.find(t => t.id === trackId) || TRACK_PRESETS[0];

  // Keywords (seeded from selected track, user can further edit in step 1)
  const [customKeywordsText, setCustomKeywordsText] = useState<string>(() => {
    if (initialTask?.keywords && initialTask.keywords.length > 0) {
      return initialTask.keywords.join(' ');
    }
    return selectedTrack.keywords.join(' ');
  });

  // Persona
  const [persona, setPersona] = useState(
    initialTask?.persona ?? (defaults.persona || selectedTrack.persona_hint)
  );

  // Schedule
  const [dailyCount, setDailyCount] = useState(
    Math.min(scenario.risk_caps.max_daily_runs * 3, initialTask?.daily_count ?? defaults.daily_count)
  );
  const [variants, setVariants] = useState(initialTask?.variants_per_post ?? defaults.variants_per_post);
  const [dailyTime, setDailyTime] = useState<string>(() => {
    if (initialTask?.daily_time) return initialTask.daily_time;
    const window = initialTask?.schedule_window ?? defaults.schedule_window ?? '08:00-08:30';
    return window.split('-')[0] || '08:00';
  });

  // Confirm step
  const [termsAccepted, setTermsAccepted] = useState([false, false, false]);
  // Login check removed from wizard — save creates the task without requiring
  // XHS login. Login is only checked when user clicks "立即运行" in the task
  // detail page.

  const keywordList = useMemo(() => parseKeywords(customKeywordsText), [customKeywordsText]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const canFinish = allTermsAccepted && keywordList.length > 0 && persona.trim().length > 0 && trackId;

  const dailyHardCap = 3;

  // When user switches track in step 1, re-seed the keyword box and persona
  // hint (unless they already typed something custom in persona).
  const handleTrackSelect = (preset: TrackPreset) => {
    setTrackId(preset.id);
    setCustomKeywordsText(preset.keywords.join(' '));
    if (!initialTask && !persona.trim()) {
      setPersona(preset.persona_hint);
    }
  };

  const doSave = async () => {
    if (!canFinish || saving) return;
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: trackId,
        keywords: keywordList,
        persona: persona.trim(),
        daily_count: Math.min(dailyCount, dailyHardCap),
        variants_per_post: variants,
        daily_time: dailyTime,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    await doSave();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {i18nService.t('scenarioWizardConfigTitle')}
              </div>
              <div className="text-base font-semibold dark:text-white">
                {scenario.icon} {scenario.name_zh}
              </div>
            </div>
            <div className="text-xs px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
              {i18nService.t('scenarioWizardStep').replace('{n}', String(step))}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {/* Step 1: track picker */}
            {step === 1 && (
              <div>
                <h3 className="text-lg font-bold dark:text-white mb-2">
                  {i18nService.t('scenarioWizardStep1Title')}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {i18nService.t('scenarioWizardStep1Desc')}
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
                  {TRACK_PRESETS.map(preset => {
                    const active = preset.id === trackId;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => handleTrackSelect(preset)}
                        className={`text-left rounded-xl border p-3 transition-all ${
                          active
                            ? 'border-green-500 bg-green-500/10 ring-1 ring-green-500/40'
                            : 'border-gray-200 dark:border-gray-700 hover:border-green-500/40 bg-white dark:bg-gray-800'
                        }`}
                      >
                        <div className="text-xl mb-1">{preset.icon}</div>
                        <div className="text-xs font-medium dark:text-white line-clamp-1">
                          {preset.name_zh}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div>
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
                    {i18nService.t('scenarioWizardKeywordsLabel')}
                  </div>
                  <textarea
                    value={customKeywordsText}
                    onChange={e => setCustomKeywordsText(e.target.value)}
                    placeholder={i18nService.t('scenarioWizardKeywordsPlaceholder')}
                    rows={2}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                  />
                  <div className="text-[11px] text-gray-400 mt-1">
                    {i18nService.t('scenarioWizardKeywordsHint')}
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: persona */}
            {step === 2 && (
              <div>
                <h3 className="text-lg font-bold dark:text-white mb-2">
                  {i18nService.t('scenarioWizardStep2Title')}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {i18nService.t('scenarioWizardStep2Desc')}
                </p>
                <textarea
                  value={persona}
                  onChange={e => setPersona(e.target.value)}
                  placeholder={i18nService.t('scenarioWizardPersonaPlaceholder')}
                  rows={4}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                />
                <div className="mt-3 text-xs text-gray-400">
                  💡 {i18nService.t('scenarioWizardPersonaSuggestion')}: <span className="italic">{selectedTrack.persona_hint}</span>
                  <button
                    type="button"
                    onClick={() => setPersona(selectedTrack.persona_hint)}
                    className="ml-2 text-green-500 hover:underline"
                  >
                    {i18nService.t('scenarioWizardPersonaUseHint')}
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: daily time + count */}
            {step === 3 && (
              <div>
                <h3 className="text-lg font-bold dark:text-white mb-4">
                  {i18nService.t('scenarioWizardStep3Title')}
                </h3>
                <div className="space-y-5">
                  <div>
                    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                      ⏰ {i18nService.t('scenarioWizardDailyTime')}
                    </label>
                    <input
                      type="time"
                      value={dailyTime}
                      onChange={e => setDailyTime(e.target.value)}
                      className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                      {i18nService.t('scenarioWizardDailyTimeHint')}
                    </p>
                  </div>

                  <div>
                    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                      {i18nService.t('scenarioWizardDailyCount')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={dailyHardCap}
                        value={dailyCount}
                        onChange={e => setDailyCount(parseInt(e.target.value, 10))}
                        className="flex-1"
                      />
                      <div className="w-12 text-center font-semibold text-green-500">{dailyCount}</div>
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                      {i18nService.t('scenarioWizardVariants')}
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={5}
                        value={variants}
                        onChange={e => setVariants(parseInt(e.target.value, 10))}
                        className="flex-1"
                      />
                      <div className="w-12 text-center font-semibold text-green-500">{variants}</div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                    <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                      ⚠️ {i18nService.t('scenarioWizardSafetyTitle')}
                    </div>
                    <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1 leading-relaxed">
                      <li>· {i18nService.t('scenarioWizardSafetyPoint1')}</li>
                      <li>· {i18nService.t('scenarioWizardSafetyPoint2')}</li>
                      <li>· {i18nService.t('scenarioWizardSafetyPoint3')}</li>
                      <li>· {i18nService.t('scenarioWizardSafetyPoint4')}</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Step 4: confirm */}
            {step === 4 && (
              <div>
                <h3 className="text-lg font-bold dark:text-white mb-4">
                  {i18nService.t('scenarioWizardStep4Title')}
                </h3>

                <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 mb-4 space-y-2 text-sm">
                  <div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {i18nService.t('scenarioWizardConfirmTrack')}:
                    </span>
                    <div className="dark:text-white">
                      {selectedTrack.icon} {selectedTrack.name_zh}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {i18nService.t('scenarioWizardConfirmKeywords')}:
                    </span>
                    <div className="dark:text-white">{keywordList.join(' · ')}</div>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {i18nService.t('scenarioWizardConfirmPersona')}:
                    </span>
                    <div className="dark:text-white line-clamp-2">{persona}</div>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {i18nService.t('scenarioWizardConfirmSchedule')}:
                    </span>
                    <div className="dark:text-white">
                      ⏰ {dailyTime} · {dailyCount} {i18nService.t('scenarioWizardConfirmPostsPerDay')} ·{' '}
                      {variants} {i18nService.t('scenarioWizardConfirmVariantsEach')}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    📋 {i18nService.t('scenarioWizardConfirmTermsTitle')}
                  </div>
                  {[
                    i18nService.t('scenarioWizardConfirmTerm1'),
                    i18nService.t('scenarioWizardConfirmTerm2'),
                    i18nService.t('scenarioWizardConfirmTerm3'),
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
                        className="mt-0.5 shrink-0"
                      />
                      <span className="leading-relaxed">{term}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              {i18nService.t('scenarioWizardCancel')}
            </button>
            <div className="flex items-center gap-2">
              {step > 1 && (
                <button
                  type="button"
                  onClick={() => setStep((step - 1) as 1 | 2 | 3 | 4)}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  ← {i18nService.t('scenarioWizardBack')}
                </button>
              )}
              {step < 4 ? (
                <button
                  type="button"
                  onClick={() => setStep((step + 1) as 1 | 2 | 3 | 4)}
                  disabled={step === 1 && (keywordList.length === 0 || !trackId)}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {i18nService.t('scenarioWizardNext')} →
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleFinish}
                  disabled={!canFinish || saving}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? '...' : i18nService.t('scenarioWizardFinish')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

    </>
  );
};

export default ConfigWizard;
