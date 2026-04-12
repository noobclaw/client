/**
 * ConfigWizard — 4-step modal for creating/editing a scenario task.
 *
 * Steps:
 *   1. Keywords
 *   2. Persona
 *   3. Schedule + frequency
 *   4. Confirm + terms + API key status
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: {
    scenario_id: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    schedule_window: string;
  }) => Promise<void> | void;
}

const KEYWORD_SUGGESTIONS = ['副业', '程序员', '宝妈', '兼职', '下班赚钱', '独立开发', '月入过万'];
const PERSONA_TEMPLATES: Array<{ key: string; value: string }> = [
  { key: 'scenarioWizardPersonaIndieDev', value: '独立开发者，前端 + 后端都能写，真诚记录产品和收入' },
  { key: 'scenarioWizardPersonaMomDev', value: '3 岁娃宝妈 + 程序员，真诚不装，喜欢用表情分段' },
  { key: 'scenarioWizardPersonaExamPrep', value: '备考党，边打工边啃书，分享学习节奏' },
  { key: 'scenarioWizardPersonaNewGrad', value: '职场新人，踩坑中学习，记录真实成长' },
];

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
  const [keywordsText, setKeywordsText] = useState(
    (initialTask?.keywords ?? defaults.keywords).join(' ')
  );
  const [persona, setPersona] = useState(initialTask?.persona ?? defaults.persona);
  const [dailyCount, setDailyCount] = useState(
    Math.min(scenario.risk_caps.max_daily_runs * 3, initialTask?.daily_count ?? defaults.daily_count)
  );
  const [variants, setVariants] = useState(initialTask?.variants_per_post ?? defaults.variants_per_post);
  const [scheduleWindow, setScheduleWindow] = useState(
    initialTask?.schedule_window ?? defaults.schedule_window
  );
  const [termsAccepted, setTermsAccepted] = useState([false, false, false]);
  const [apiKeyPresent, setApiKeyPresent] = useState<boolean | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const key = await window.electron.store.get('apiKey');
        setApiKeyPresent(Boolean(key && String(key).trim().length > 0));
      } catch {
        setApiKeyPresent(false);
      }
    })();
  }, []);

  const keywordList = useMemo(() => parseKeywords(keywordsText), [keywordsText]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const canFinish = allTermsAccepted && keywordList.length > 0 && persona.trim().length > 0;

  const dailyHardCap = 3; // XHS risk cap — do not allow above 3

  const handleFinish = async () => {
    if (!canFinish || saving) return;
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        keywords: keywordList,
        persona: persona.trim(),
        daily_count: Math.min(dailyCount, dailyHardCap),
        variants_per_post: variants,
        schedule_window: scheduleWindow,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
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
          {/* Step 1: keywords */}
          {step === 1 && (
            <div>
              <h3 className="text-lg font-bold dark:text-white mb-2">
                {i18nService.t('scenarioWizardStep1Title')}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {i18nService.t('scenarioWizardStep1Desc')}
              </p>
              <textarea
                value={keywordsText}
                onChange={e => setKeywordsText(e.target.value)}
                placeholder={i18nService.t('scenarioWizardKeywordsPlaceholder')}
                rows={3}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
              />
              <div className="mt-4">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  💡 {i18nService.t('scenarioWizardKeywordsPresets')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {KEYWORD_SUGGESTIONS.map(kw => (
                    <button
                      key={kw}
                      type="button"
                      onClick={() => {
                        if (!keywordList.includes(kw)) setKeywordsText(prev => (prev ? `${prev} ${kw}` : kw));
                      }}
                      className="text-xs px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-700 hover:border-green-500/50 hover:bg-green-500/10 hover:text-green-500 transition-colors"
                    >
                      + {kw}
                    </button>
                  ))}
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
              <div className="mt-4">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  {i18nService.t('scenarioWizardPersonaPresets')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {PERSONA_TEMPLATES.map(t => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setPersona(t.value)}
                      className="text-xs px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-700 hover:border-green-500/50 hover:bg-green-500/10 hover:text-green-500 transition-colors"
                    >
                      {i18nService.t(t.key)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: schedule */}
          {step === 3 && (
            <div>
              <h3 className="text-lg font-bold dark:text-white mb-4">
                {i18nService.t('scenarioWizardStep3Title')}
              </h3>
              <div className="space-y-5">
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

                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                    {i18nService.t('scenarioWizardWindow')}
                  </label>
                  <input
                    type="text"
                    value={scheduleWindow}
                    onChange={e => setScheduleWindow(e.target.value)}
                    placeholder="08:00-09:00"
                    className="w-48 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                    {i18nService.t('scenarioWizardWindowHint')}
                  </p>
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
                    {dailyCount}/day · {variants} variants · {scheduleWindow}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 mb-4">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  🔑 {i18nService.t('scenarioWizardConfirmApiKey')}
                </div>
                <div
                  className={`text-sm ${
                    apiKeyPresent === false ? 'text-amber-500' : 'dark:text-white'
                  }`}
                >
                  {apiKeyPresent === null
                    ? '...'
                    : apiKeyPresent
                      ? i18nService.t('scenarioWizardConfirmApiKeySet')
                      : i18nService.t('scenarioWizardConfirmApiKeyMissing')}
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
                disabled={step === 1 && keywordList.length === 0}
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
  );
};

export default ConfigWizard;
