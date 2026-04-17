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

// 关键词经过 2026 小红书流量数据（千瓜 / 新榜 / TopMarketing）筛选：
// 长尾词 > 大词（例："减脂餐" > "减肥"、"小个子穿搭" > "穿搭"）
// 场景+人群修饰词（"0基础"、"通勤"、"租房党" 等）转化率最高
const TRACK_PRESETS: TrackPreset[] = [
  { id: 'career_side_hustle', icon: '💼', name_zh: '副业 · 打工人赚钱', keywords: ['副业', '下班变现', '兼职', '月入过万', '副业推荐', '在家赚钱', 'AI副业', '小红书副业', '蒲公英接单', '副业项目', '0基础副业', '打工人副业', '副业变现', '周末副业', '宝妈副业'], persona_hint: '一个想在下班后搞点副业的普通打工人，真诚不装' },
  { id: 'indie_dev', icon: '👩‍💻', name_zh: '独立开发 · 程序员记录', keywords: ['独立开发', 'indie hacker', 'SaaS出海', '程序员副业', '全栈开发', '个人开发者', '副业编程', '独立产品', 'AI工具开发', '出海产品', '技术博客', '前端学习', '程序员日常', '远程工作', '程序员女朋友'], persona_hint: '独立开发者，前后端都写，真诚记录产品和收入' },
  { id: 'personal_finance', icon: '💰', name_zh: '理财 · 记账攻略', keywords: ['攒钱', '存钱方法', '记账app', '工资理财', '基金定投', '攒钱挑战', '理财入门', '记账日记', '工资分配', '穷人理财', '月光族', '攒钱100天', '家庭理财', '钱生钱', '极简生活攒钱'], persona_hint: '月薪 1 万的普通白领，认真记账、稳健理财' },
  { id: 'travel', icon: '✈️', name_zh: '旅行 · 攻略分享', keywords: ['穷游攻略', '周末去哪玩', '周边游', '小众目的地', 'citywalk', '特种兵旅行', '一人旅行', '亲子游', '海岛游', '自驾游', '民宿推荐', '机票便宜', '反向旅游', '旅行vlog', '出境游'], persona_hint: '爱说走就走的旅行爱好者，分享性价比攻略' },
  { id: 'food', icon: '🍲', name_zh: '美食 · 探店做饭', keywords: ['减脂餐', '一人食', '懒人菜', '低卡', '早餐', '便当', '空气炸锅食谱', '家常菜', '烘焙', '探店', '本地美食', '周末美食', '养生汤', '气血食谱', '学生餐'], persona_hint: '喜欢折腾吃喝的上班族，每天做饭给自己' },
  { id: 'outfit', icon: '👗', name_zh: '穿搭 · 风格分享', keywords: ['小个子穿搭', '通勤穿搭', '梨形身材穿搭', '苹果身材穿搭', '法式穿搭', '韩系穿搭', 'OOTD', '大码穿搭', '秋冬穿搭', '奶甜系', '清冷风', '氛围感穿搭', '约会穿搭', '微胖穿搭', '气质穿搭'], persona_hint: '小个子职场穿搭爱好者' },
  { id: 'beauty', icon: '💄', name_zh: '美妆 · 产品测评', keywords: ['平价彩妆', '敏感肌护肤', '成分党', '粉底液测评', '口红试色', '眼影教程', '素颜霜', '新手化妆', '早C晚A', '抗老', '美白', '防晒', '空瓶记', '化妆包常驻', '护肤步骤'], persona_hint: '敏感肌护肤爱好者，只买成分党认证的' },
  { id: 'fitness', icon: '💪', name_zh: '健身 · 减脂日记', keywords: ['居家健身', '减脂打卡', '21天减脂', '马甲线', '普拉提', 'HIIT', '瑜伽入门', '塑形', '体态矫正', '减脂餐', '健身小白', '跑步日记', '拉伸', '徒手训练', '核心训练'], persona_hint: '上班族，边工作边坚持居家健身一年' },
  { id: 'reading', icon: '📚', name_zh: '读书 · 书单笔记', keywords: ['读书笔记', '年度书单', '好书推荐', '读书打卡', '实体书', '小说推荐', '非虚构', '人物传记', '心理学书单', '成长书单', 'kindle', '读书方法', '写读后感', '女性主义书单', '书评'], persona_hint: '一年读 50 本书的普通读者' },
  { id: 'parenting', icon: '🧸', name_zh: '育儿 · 亲子日常', keywords: ['科学育儿', '早教', '绘本推荐', '辅食', '亲子游戏', '母婴好物', '新手妈妈', '孕期', '产后恢复', '幼儿园', '亲子手工', '带娃神器', '育儿日记', '0-3岁早教', '亲子阅读'], persona_hint: '3 岁娃妈妈，理性育儿不焦虑' },
  { id: 'exam_prep', icon: '🎓', name_zh: '考研 · 备考党', keywords: ['考研日记', '考研英语', '考研经验', '考研数学', '考研政治', '单词打卡', '备考计划', '真题', '四六级', '考公', '考研上岸', '二战考研', '保研', '教资', '雅思'], persona_hint: '二战考研人，记录每日学习节奏' },
  { id: 'pets', icon: '🐱', name_zh: '宠物 · 猫狗日常', keywords: ['养猫日常', '养狗日常', '橘猫', '柯基', '金毛', '宠物医院', '猫粮测评', '狗粮', '训狗', '宠物穿搭', '养宠新手', '流浪猫', '田园猫', '宠物用品', '布偶猫'], persona_hint: '一只中华田园猫的主人，真实养宠记录' },
  { id: 'home_decor', icon: '🏠', name_zh: '家居 · 小屋布置', keywords: ['租房改造', '小户型', '收纳', '家居好物', '宜家', '一人居', '装修日记', '北欧风', '日式家居', '卫生间改造', '厨房收纳', '客厅软装', '全屋清洁', '极简家居', '出租屋改造'], persona_hint: '租房党，用 2000 预算把小公寓改舒服' },
  { id: 'study_method', icon: '🏆', name_zh: '学习 · 效率工具', keywords: ['Notion', 'flomo', '时间管理', '番茄钟', '自律', '早起', '晨间日记', '习惯养成', 'todolist', '思维导图', '康奈尔笔记', '学习方法', '专注力', 'GTD', '数字极简'], persona_hint: '热爱效率工具的产品经理' },
  { id: 'career_growth', icon: '🎯', name_zh: '职场 · 升级打怪', keywords: ['兼职', '简历', '摆摊', '求职', '应届生', '大厂面试', '跳槽', '升职', '职场穿搭', '职场人设', '打工人', '裸辞', '35岁', '职业规划', '副业'], persona_hint: '互联网行业工作 5 年的打工人' },
  { id: 'emotional_wellness', icon: '🧘', name_zh: '情感 · 心理疗愈', keywords: ['MBTI', 'INFJ', '原生家庭', '亲密关系', '分手', '自我接纳', '情绪管理', '疗愈', '心理学', '正念', '冥想', '孤独', '恋爱日记', 'ENFP', '人际关系'], persona_hint: '正在做自我探索的 30 岁女性' },
  { id: 'photography', icon: '📷', name_zh: '摄影 · 日常记录', keywords: ['手机摄影', '胶片相机', '富士相机', '人像摄影', '扫街', '构图', '修图教程', 'lightroom', 'vsco', '日系摄影', '情侣拍照', '自拍姿势', '风光摄影', '黑白摄影', '街头摄影'], persona_hint: '业余摄影爱好者，周末扫街' },
  { id: 'crafts', icon: '🎨', name_zh: '手工 · DIY', keywords: ['手账', '胶带手账', '手工DIY', '超轻粘土', '刺绣', '编织', '水彩', '贴纸收集', '手作', '拼豆', '折纸', '粘土教程', '手工课', 'bujo', '手绘'], persona_hint: '热爱动手做点小东西的文艺青年' },
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
  const isZh = i18nService.currentLanguage === 'zh';
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
  // 自动上传草稿箱开关；默认 true 保持向后兼容
  const [autoUpload, setAutoUpload] = useState<boolean>(
    (initialTask as any)?.auto_upload !== undefined ? !!(initialTask as any).auto_upload : true
  );

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
        auto_upload: autoUpload,
      } as any);
    } catch (err) {
      console.error('[ConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败，请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-visible flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            {isZh ? '配置赛道' : 'Configure Track'}
          </div>
          <div className="text-xs px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500">
            {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
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
                  {isZh ? '选择赛道' : 'Select Track'}
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
                  {isZh ? '关键词' : 'Keywords'} <span className="text-xs text-gray-400 font-normal">{isZh ? '（每次运行随机选 1 个搜索，建议 15-25 个降低风控）' : '(1 random keyword per run, 15-25 recommended)'}</span>
                </label>
                {/* 2026 流量报告说明条 */}
                <div className="mb-2 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-[11px] text-green-700 dark:text-green-400 leading-relaxed">
                  {isZh
                    ? <>✨ 预填关键词基于 <strong>2026 小红书流量报告</strong>（千瓜数据 / 新榜 / 官方趋势）整理的各赛道热度词，你可以直接用或按需增删。</>
                    : <>✨ Pre-filled keywords are curated from <strong>2026 Xiaohongshu traffic reports</strong> (千瓜数据 / 新榜 / official trends). Use as-is or tweak.</>}
                </div>
                <textarea
                  value={customKeywordsText}
                  onChange={e => setCustomKeywordsText(e.target.value)}
                  placeholder={isZh ? '用空格或逗号分隔，越多越好' : 'Space or comma separated'}
                  rows={6}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50"
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {isZh ? '关键词越多，每次搜索内容越不重复，降低风控风险' : 'More keywords = less detection risk'}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Schedule */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 运行间隔' : '⏰ Run Interval'}
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once', label: isZh ? '不重复' : 'Once' },
                    { value: '30min', label: isZh ? '每 30 分钟' : 'Every 30min' },
                    { value: '1h', label: isZh ? '每小时' : 'Hourly' },
                    { value: '6h', label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily', label: isZh ? '每天' : 'Daily' },
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

              {(runInterval === 'daily' || runInterval === 'once') && (
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                    {isZh ? '触发时间' : 'Trigger Time'}
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={dailyTime.split(':')[0] || '08'}
                      onChange={e => setDailyTime(e.target.value.padStart(2, '0') + ':' + (dailyTime.split(':')[1] || '00'))}
                      style={{ appearance: 'auto', WebkitAppearance: 'menulist', minWidth: 70 }}
                      className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50 cursor-pointer"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={String(i).padStart(2, '0')}>{String(i).padStart(2, '0')}</option>
                      ))}
                    </select>
                    <span className="text-lg font-mono dark:text-white">:</span>
                    <select
                      value={dailyTime.split(':')[1] || '00'}
                      onChange={e => setDailyTime((dailyTime.split(':')[0] || '08') + ':' + e.target.value.padStart(2, '0'))}
                      style={{ appearance: 'auto', WebkitAppearance: 'menulist', minWidth: 70 }}
                      className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50 cursor-pointer"
                    >
                      {[0, 15, 30, 45].map(m => (
                        <option key={m} value={String(m).padStart(2, '0')}>{String(m).padStart(2, '0')}</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
                    {isZh ? '前后 ±15 分钟随机偏移模拟人类节奏' : '±15 min random offset for human-like behavior'}
                  </p>
                </div>
              )}

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '每天采集爆款数量' : 'Articles per run'}
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
                  {isZh ? '每条生成仿写版本数' : 'Rewrites per article'}
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

              {/* 自动上传草稿箱 / 仅生成本地 开关 */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '生成后的处理' : 'After generation'}
                </label>
                <div className="space-y-2">
                  <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${autoUpload ? 'border-green-500 bg-green-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                    <input
                      type="radio"
                      name="auto_upload"
                      checked={autoUpload}
                      onChange={() => setAutoUpload(true)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 text-xs leading-relaxed">
                      <div className="font-semibold dark:text-white mb-0.5">
                        {isZh ? '📤 自动上传到小红书草稿箱' : '📤 Auto-upload to XHS drafts'}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400">
                        {isZh ? '全流程无人值守。⚠️ 新号/低粉号单日 >3 篇有封号风险。' : 'Fully unattended. ⚠️ >3/day risks ban on new accounts.'}
                      </div>
                    </div>
                  </label>
                  <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!autoUpload ? 'border-green-500 bg-green-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
                    <input
                      type="radio"
                      name="auto_upload"
                      checked={!autoUpload}
                      onChange={() => setAutoUpload(false)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 text-xs leading-relaxed">
                      <div className="font-semibold dark:text-white mb-0.5">
                        {isZh ? '📁 仅生成保存到本地（更安全）' : '📁 Generate only (safer)'}
                      </div>
                      <div className="text-gray-500 dark:text-gray-400">
                        {isZh ? '改写+生图后存盘，你人工审核挑选后再手动一键上传。封号风险最低。' : 'Saved locally; you review and upload manually later.'}
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                  {isZh ? '⚠️ 安全提示' : '⚠️ Safety Notice'}
                </div>
                <ul className="text-xs text-gray-600 dark:text-gray-300 space-y-1 leading-relaxed">
                  <li>{isZh ? '· 每次运行会在你已登录的小红书上模拟人类浏览' : '· Each run simulates human browsing on your logged-in Xiaohongshu'}</li>
                  <li>{isZh ? '· 运行期间请不要切换浏览器标签页' : '· Do not switch browser tabs during a run'}</li>
                  <li>{isZh ? '· 推送草稿后，发布由你手动完成' : '· After drafts are pushed, publishing is done manually by you'}</li>
                </ul>
              </div>
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === 3 && (
            <div>
              <h3 className="text-lg font-bold dark:text-white mb-4">
                {isZh ? '确认并启用' : 'Confirm & Enable'}
              </h3>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4 mb-4 space-y-2 text-sm">
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{isZh ? '赛道:' : 'Track:'}</span>
                  <div className="dark:text-white">{selectedTrack.icon} {selectedTrack.name_zh}</div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{isZh ? '关键词:' : 'Keywords:'}</span>
                  <div className="dark:text-white">{keywordList.join(' · ')}</div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{isZh ? '频次:' : 'Schedule:'}</span>
                  <div className="dark:text-white">
                    ⏰ {(isZh ? { 'once': '不重复 ' + dailyTime, '30min': '每30分钟', '1h': '每小时', '6h': '每6小时', 'daily': '每天 ' + dailyTime } : { 'once': 'Once ' + dailyTime, '30min': 'Every 30min', '1h': 'Hourly', '6h': 'Every 6h', 'daily': 'Daily ' + dailyTime } as Record<string, string>)[runInterval] || runInterval} · {dailyCount} {isZh ? '条/次' : '/run'} · {variants} {isZh ? '份改写' : 'rewrites'}
                  </div>
                </div>
              </div>

              {/* Usage warning — compacted into 2 lines */}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 mb-4">
                <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1.5">
                  {isZh ? '⚠️ 使用须知（重要）' : '⚠️ Usage Notes (Important)'}
                </div>
                <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                  {isZh
                    ? <>任务会<strong>模拟你本人</strong>在小红书上的行为。运行期间请<strong>保持浏览器打开</strong>、<strong>不要关闭小红书页面</strong>或退出登录，否则任务会中断。每次执行前会自动检查登录状态。</>
                    : <>The task <strong>simulates your own behavior</strong> on Xiaohongshu. Keep the browser open, don't close the Xiaohongshu tab, and don't log out — otherwise the run will be interrupted. Login status is auto-checked before each run.</>}
                </p>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
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
            {isZh ? '取消' : 'Cancel'}
          </button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button type="button" onClick={() => setStep((step - 1) as 1 | 2 | 3)} disabled={saving}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                ← {isZh ? '上一步' : 'Back'}
              </button>
            )}
            {step < 3 ? (
              <button type="button"
                onClick={() => setStep((step + 1) as 1 | 2 | 3)}
                disabled={step === 1 && (keywordList.length === 0 || !persona.trim())}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-50">
                {isZh ? '下一步' : 'Next'} →
              </button>
            ) : (
              <button type="button" onClick={handleFinish} disabled={!canFinish || saving}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? '...' : (isZh ? '保存并启用' : 'Save & Create Task')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigWizard;
