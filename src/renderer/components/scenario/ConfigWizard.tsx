/**
 * ConfigWizard — 3-step modal for creating/editing a scenario task.
 *
 * Steps:
 *   1. Track (dropdown) + Keywords + Persona (all on one page)
 *   2. Daily execution time + per-day count
 *   3. Confirm + usage warning + terms
 */

import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

// ── Track presets ──
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
  return raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

export const ConfigWizard: React.FC<Props> = ({ scenario, initialTask, onCancel, onSave }) => {
  const defaults = scenario.default_config;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Track
  const initialTrackId = initialTask?.track || TRACK_PRESETS[0].id;
  const [trackId, setTrackId] = useState<string>(initialTrackId);
  const selectedTrack = TRACK_PRESETS.find(t => t.id === trackId) || TRACK_PRESETS[0];

  // Keywords
  const [customKeywordsText, setCustomKeywordsText] = useState<string>(() => {
    if (initialTask?.keywords && initialTask.keywords.length > 0) return initialTask.keywords.join(' ');
    return selectedTrack.keywords.join(' ');
  });

  // Persona (auto-set from track, not user-editable)
  const persona = selectedTrack.persona_hint;

  // Schedule
  const [dailyCount, setDailyCount] = useState(initialTask?.daily_count ?? defaults.daily_count);
  const [variants, setVariants] = useState(initialTask?.variants_per_post ?? defaults.variants_per_post);
  const [runInterval, setRunInterval] = useState<string>((initialTask as any)?.run_interval || 'daily');
  const [dailyTime, setDailyTime] = useState<string>(() => {
    if (initialTask?.daily_time) return initialTask.daily_time;
    return '08:00';
  });

  // Confirm
  const [termsAccepted, setTermsAccepted] = useState([false, false]);

  const keywordList = useMemo(() => parseKeywords(customKeywordsText), [customKeywordsText]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const canFinish = allTermsAccepted && keywordList.length > 0 && persona.trim().length > 0 && trackId;
  const dailyHardCap = 3;

  // When track changes, update keywords + persona
  const handleTrackChange = (newTrackId: string) => {
    const preset = TRACK_PRESETS.find(t => t.id === newTrackId);
    if (!preset) return;
    setTrackId(newTrackId);
    setCustomKeywordsText(preset.keywords.join(' '));
    // persona auto-follows track
  };

  const handleFinish = async () => {
    if (!canFinish || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: trackId,
        keywords: keywordList,
        persona: persona.trim(),
        daily_count: Math.min(dailyCount, dailyHardCap),
        variants_per_post: variants,
        daily_time: dailyTime,
        run_interval: runInterval,
      } as any);
    } catch (err) {
      console.error('[ConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || '保存失败，请重试');
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
            配置赛道
          </div>
          <div className="text-xs px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
            第 {step} / 3 步
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {/* Step 1: Track + Keywords + Persona (all in one) */}
          {step === 1 && (
            <div className="space-y-5">
              {/* Track dropdown */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  选择赛道
                </label>
                <select
                  value={trackId}
                  onChange={e => handleTrackChange(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                >
                  {TRACK_PRESETS.map(preset => (
                    <option key={preset.id} value={preset.id}>
                      {preset.icon} {preset.name_zh}
                    </option>
                  ))}
                </select>
              </div>

              {/* Keywords */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  关键词 <span className="text-xs text-gray-400 font-normal">（每次运行随机选 3 个搜索，建议 15-25 个）</span>
                </label>
                <textarea
                  value={customKeywordsText}
                  onChange={e => setCustomKeywordsText(e.target.value)}
                  placeholder="用空格或逗号分隔，越多越好"
                  rows={6}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  关键词越多，每次搜索内容越不重复，降低风控风险
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Schedule */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  ⏰ 运行间隔
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: '30min', label: '每 30 分钟' },
                    { value: '1h', label: '每小时' },
                    { value: '6h', label: '每 6 小时' },
                    { value: 'daily', label: '每天' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-4 py-2 rounded-lg text-sm border transition-colors ${
                        runInterval === opt.value
                          ? 'border-green-500 bg-green-500/10 text-green-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-green-500/50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {runInterval === 'daily' && (
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                    触发时间
                  </label>
                  <input
                    type="time"
                    value={dailyTime}
                    onChange={e => setDailyTime(e.target.value)}
                    className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                    前后 ±15 分钟随机偏移模拟人类节奏
                  </p>
                </div>
              )}

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  每天采集爆款数量
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={dailyHardCap} value={dailyCount}
                    onChange={e => setDailyCount(parseInt(e.target.value, 10))}
                    className="flex-1"
                  />
                  <div className="w-12 text-center font-semibold text-green-500">{dailyCount}</div>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  每条生成仿写版本数
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={5} value={variants}
                    onChange={e => setVariants(parseInt(e.target.value, 10))}
                    className="flex-1"
                  />
                  <div className="w-12 text-center font-semibold text-green-500">{variants}</div>
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                  ⚠️ 安全提示
                </div>
                <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1 leading-relaxed">
                  <li>· 每次运行会在你已登录的小红书上模拟人类浏览</li>
                  <li>· 运行期间请不要切换浏览器标签页</li>
                  <li>· 推送草稿后，发布由你手动完成</li>
                </ul>
              </div>
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && (
            <div>
              <h3 className="text-lg font-bold dark:text-white mb-4">
                确认并启用
              </h3>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 mb-4 space-y-2 text-sm">
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">赛道:</span>
                  <div className="dark:text-white">{selectedTrack.icon} {selectedTrack.name_zh}</div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">关键词:</span>
                  <div className="dark:text-white">{keywordList.join(' · ')}</div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">频次:</span>
                  <div className="dark:text-white">
                    ⏰ {{ '30min': '每30分钟', '1h': '每小时', '6h': '每6小时', 'daily': '每天 ' + dailyTime }[runInterval] || runInterval} · {dailyCount} 条/次 · {variants} 份改写
                  </div>
                </div>
              </div>

              {/* Usage warning */}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 mb-4">
                <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                  ⚠️ 使用须知（重要）
                </div>
                <ul className="text-xs text-gray-700 dark:text-gray-300 space-y-1.5 leading-relaxed">
                  <li>🤖 所有操作都是<strong>模拟你本人在小红书上的行为</strong></li>
                  <li>🌐 任务运行期间请<strong>不要关闭 Chrome 中的小红书页面</strong></li>
                  <li>🔐 请<strong>不要退出小红书登录</strong>，否则任务会中断</li>
                  <li>🔄 每次执行前会<strong>自动检查登录状态</strong></li>
                  <li>⏰ 任务运行时你可以正常使用电脑，但请保持 Chrome 打开</li>
                </ul>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  📋 使用条款
                </div>
                {[
                  i18nService.t('scenarioWizardConfirmTerm1'),
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

              {saveError && (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                  ❌ {saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button type="button" onClick={onCancel} disabled={saving}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
            取消
          </button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button type="button" onClick={() => setStep((step - 1) as 1 | 2 | 3)} disabled={saving}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                ← 上一步
              </button>
            )}
            {step < 3 ? (
              <button type="button"
                onClick={() => setStep((step + 1) as 1 | 2 | 3)}
                disabled={step === 1 && (keywordList.length === 0 || !persona.trim())}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-50">
                下一步 →
              </button>
            ) : (
              <button type="button" onClick={handleFinish} disabled={!canFinish || saving}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? '...' : '保存并启用'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigWizard;
