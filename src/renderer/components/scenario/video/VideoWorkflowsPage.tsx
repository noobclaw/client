/**
 * VideoWorkflowsPage — 「多平台视频创作」工作流页面.
 *
 * 这是个本地合成工具,不走 backend scenario 任务体系,自己渲染卡片 + 表单。
 *
 * 交互跟其他平台 tab 保持一致(由 ScenarioView 统一套 L1 头部 + 返回按钮):
 *   - mode='landing' —— 落地页。看「当前视频创作任务」,目前本地工具没有持久
 *       任务列表,所以显示占位框提示去创建 + 两张工作流卡片(点占位框 / 卡片 /
 *       右上「新建视频创作任务」CTA 都进入创建流)。
 *   - mode='create'  —— 创建流(两步向导,内联渲染,不再是 modal):
 *       ① 内容(选赛道→自动带出人设/关键词,可改;参考文案;视频参考图)
 *       ② 出片(存本地 / 上传各平台)。返回由 ScenarioView 顶部返回按钮处理,
 *       向导内部也有「取消 / 上一步」。
 *
 * 一期只做到「存本地不上传」,自动上传到抖音/小红书/币安先占位。
 */

import React, { useState } from 'react';
import { i18nService } from '../../../services/i18n';
import {
  videoCreationService,
  type VideoCreationInput,
  type VideoCreationProgress,
  type VideoPublishTarget,
} from '../../../services/videoCreation';

interface VideoWorkflowsPageProps {
  /** landing = 落地页(看任务/占位框);create = 创建向导。由 ScenarioView 的 section 决定。 */
  mode: 'landing' | 'create';
  /** 从落地页进入创建流(ScenarioView 把 section 切到 'create')。 */
  onGoCreate: () => void;
  /** 从创建流返回落地页(ScenarioView 把 section 切回 'tasks')。 */
  onBack: () => void;
}

export const VideoWorkflowsPage: React.FC<VideoWorkflowsPageProps> = ({ mode, onGoCreate, onBack }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  if (mode === 'create') {
    return <VideoCreateFlow isZh={isZh} onBack={onBack} />;
  }
  return <VideoLanding isZh={isZh} onGoCreate={onGoCreate} />;
};

// ── 落地页:只放「当前任务」占位框,不掺工作流卡片 ─────────────────────
// 本地工具暂无持久任务列表 → 显示空状态占位框引导去创建。等接了任务列表,
// 有任务时这里换成 list,没任务才显示占位。卡片(单次成片/自动成片)挪到
// 「新建」后的选择页(VideoTypeChooser),不再跟占位框同屏出现。

const VideoLanding: React.FC<{ isZh: boolean; onGoCreate: () => void }> = ({ isZh, onGoCreate }) => {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button
        type="button"
        onClick={onGoCreate}
        className="w-full rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center hover:border-rose-400 dark:hover:border-rose-500 transition-colors group"
      >
        <div className="text-5xl mb-3">🎬</div>
        <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
          {isZh ? '还没有视频创作任务' : 'No video tasks yet'}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-md mx-auto">
          {isZh
            ? '把文案变成配好音、带字幕、有画面的竖屏短视频,先存本地,满意后再发各平台。'
            : 'Turn a script into a narrated, subtitled portrait short — saved locally first, publish later.'}
        </div>
        <span className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-rose-500 group-hover:bg-rose-600 text-white text-sm font-bold shadow-lg shadow-rose-500/25 transition-colors">
          ✨ {isZh ? '新建视频创作任务' : 'Create a video task'} →
        </span>
      </button>

      {/* Feature pills */}
      <section className="mt-6">
        <div className="flex flex-wrap gap-2 justify-center">
          {[
            { icon: '💻', zh: '本地合成 · 零服务器成本', en: 'Local synthesis · zero server cost' },
            { icon: '🎙️', zh: 'AI 配音 + 自动字幕', en: 'AI voiceover + auto subtitles' },
            { icon: '🖼️', zh: '视频参考图 + 在线素材库', en: 'Your images + stock library' },
            { icon: '🚀', zh: '一键发抖音/小红书/币安', en: 'One-click to Douyin / XHS / Binance' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-rose-500/20 bg-rose-500/5 text-gray-700 dark:text-gray-300"
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
};

// ── 创建流:先选创作方式(单次成片/自动成片),选完再进对应向导 ──────────
// 「新建」后落到这里(ScenarioView section='create')。内部用本地 state 管
// 第二层(选卡片)→ 第三层(向导)的切换;ScenarioView 顶部返回按钮负责退回
// 落地页,向导内的「取消」退回这层选择页。

const VideoCreateFlow: React.FC<{ isZh: boolean; onBack: () => void }> = ({ isZh }) => {
  const [picked, setPicked] = useState<'original' | null>(null);
  if (picked === 'original') {
    return <VideoCreatePanel isZh={isZh} onBack={() => setPicked(null)} />;
  }
  return <VideoTypeChooser isZh={isZh} onPickOriginal={() => setPicked('original')} />;
};

// ── 第二层:创作方式选择页(单次成片 / 自动成片) ──────────────────────

const VideoTypeChooser: React.FC<{ isZh: boolean; onPickOriginal: () => void }> = ({ isZh, onPickOriginal }) => {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-5 text-center">
        <h2 className="text-lg font-bold dark:text-white">
          {isZh ? '选择创作方式' : 'Choose how to create'}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {isZh ? '先从「单次成片」开始,自动成片即将推出' : 'Start with one-shot — auto mode coming soon'}
        </p>
      </div>
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <OriginalShortVideoCard isZh={isZh} onStart={onPickOriginal} />
        <DailyHotVideoCard isZh={isZh} />
      </section>
    </div>
  );
};

// ── 卡片 1:原创短视频 · 单次成片 ───────────────────────────────────

const OriginalShortVideoCard: React.FC<{ isZh: boolean; onStart: () => void }> = ({ isZh, onStart }) => {
  return (
    <div className="relative rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-orange-500/5 to-transparent p-5 overflow-hidden flex flex-col">
      <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-rose-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-500 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
          {isZh ? '单次成片' : 'One-shot'}
        </div>
        <h3 className="text-base font-bold dark:text-white mb-1.5">
          🎬 {isZh ? '原创短视频 · 单次成片' : 'Original Short · One-shot'}
        </h3>
        <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">
          {isZh
            ? '先选赛道,自动带出人设和关键词(可改),再粘一段参考文案、传几张视频参考图(选填)。AI 自动逐句拆分镜、配音、配字幕,用你的图加在线素材库凑齐画面,本地合成一条竖屏短视频。出片满意后可一键发到抖音 / 小红书 / 币安,也可只存本地。'
            : 'Pick a track to auto-fill persona & keywords (editable), paste a reference script and optional images. AI splits it into scenes, narrates, subtitles, and fills visuals from your images + a stock library, then composes a portrait short locally. Publish to Douyin / XHS / Binance after, or just keep it local.'}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="w-full px-4 py-2.5 text-sm font-bold rounded-xl bg-rose-500 hover:bg-rose-600 text-white shadow-lg shadow-rose-500/25 transition-all active:scale-95"
        >
          🎬 {isZh ? '开始创作' : 'Start'} →
        </button>
      </div>
    </div>
  );
};

// ── 卡片 2:每日热点短视频 · 自动成片(占位,灰掉) ──────────────────

const DailyHotVideoCard: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  return (
    <div className="relative rounded-2xl border border-gray-300/60 dark:border-gray-700/60 bg-gradient-to-br from-gray-500/5 to-transparent p-5 overflow-hidden flex flex-col opacity-70">
      <div className="relative flex flex-col flex-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 mb-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
          {isZh ? '自动成片' : 'Auto'}
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">
            {isZh ? '即将推出' : 'Coming Soon'}
          </span>
        </div>
        <h3 className="text-base font-bold text-gray-500 dark:text-gray-400 mb-1.5">
          🔥 {isZh ? '每日热点短视频 · 自动成片' : 'Daily Hot · Auto'}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-3 flex-1">
          {isZh
            ? '每天自动抓取你赛道下的当下热点选题,自动写稿、配音、配画面,按计划批量出片并定时分发。无需人工选题,全自动运转。'
            : 'Auto-fetches trending topics in your niche daily, writes / narrates / fills visuals, batch-produces and schedules distribution — fully hands-off.'}
        </p>
        <button
          type="button"
          disabled
          className="w-full px-4 py-2.5 text-sm font-bold rounded-xl bg-gray-300 dark:bg-gray-700 text-gray-500 cursor-not-allowed"
        >
          {isZh ? '敬请期待' : 'Coming Soon'}
        </button>
      </div>
    </div>
  );
};

// ── 赛道预设库:选赛道自动带出人设 + 关键词(用户可改) ─────────────────
// 内置一份「赛道 → 人设/关键词」预设(参考小红书的细分领域),离线即时,
// 零 token 成本。财经/加密类人设刻意写「不喊单/不荐股」,定位是内容科普,
// 不做个性化投资建议。'custom' = 自定义,什么都不带,用户自己填。
// 关键词跟其他任务(ConfigWizard)一致用【空格】分隔,不用逗号。

interface TrackPreset {
  id: string;
  zh: string;
  en: string;
  persona: { zh: string; en: string };
  keywords: { zh: string; en: string };
}

const TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'overseas_life', zh: '🌏 海外生活 · 在日华人', en: 'Overseas Life',
    persona: { zh: '在东京生活 5 年的华人博主，30 岁，普通上班族。租房、通勤、超市囤货都自己搞，分享真实接地气的日本日常，不滤镜、不贩卖焦虑', en: 'An overseas-Chinese blogger who has lived in Tokyo for 5 years — real, down-to-earth daily life in Japan, no sugar-coating' },
    keywords: { zh: '东京生活 日本租房 在日华人 日本超市 省钱攻略 日本通勤 海外生活 日本签证', en: 'tokyo japan-life rent overseas-chinese supermarket save-money commute visa' },
  },
  {
    id: 'food', zh: '🍲 美食 · 探店做饭', en: 'Food',
    persona: { zh: '爱折腾吃喝的上班族，每天给自己做饭，也爱探店。说话热情、会种草，重点讲性价比和踩雷避坑，不浮夸', en: 'A food-loving office worker who cooks daily and explores restaurants — enthusiastic, focused on value and avoiding tourist traps' },
    keywords: { zh: '美食探店 一人食 家常菜 减脂餐 必吃榜 本地美食 空气炸锅 探店打卡', en: 'food restaurant home-cooking healthy-meal must-eat local airfryer foodie' },
  },
  {
    id: 'tech', zh: '💻 数码科技 · 测评', en: 'Tech',
    persona: { zh: '懂行的数码测评博主，自费买机、理性测评。技术名词直接说，优缺点都讲，绝不收钱吹，帮人避坑做选择', en: 'A knowledgeable gadget reviewer who buys his own gear — rational, names the pros and cons, no paid hype' },
    keywords: { zh: '数码测评 手机评测 笔记本 智能硬件 新品上手 科技 数码好物 选购指南', en: 'gadget review smartphone laptop smart-hardware hands-on tech buying-guide' },
  },
  {
    id: 'ai_tools', zh: '🤖 AI 工具 · 效率', en: 'AI Tools',
    persona: { zh: '天天用 AI 干活的效率党，把 ChatGPT / 各种 AI 工具用到飞起。讲人话、给可复制的实操，不空谈概念', en: 'A productivity nerd who uses AI daily — plain talk, copy-paste workflows, no empty hype' },
    keywords: { zh: 'AI工具 ChatGPT 效率提升 AI办公 提示词 自动化 AI神器 副业AI', en: 'ai-tools chatgpt productivity ai-office prompts automation ai-gems' },
  },
  {
    id: 'finance', zh: '💰 财经 · 理财科普', en: 'Finance',
    persona: { zh: '通俗讲钱的财经科普博主，冷静中立。只做知识科普,不荐股、不喊单、不给个性化投资建议,帮人建立常识', en: 'A finance explainer — calm and neutral, knowledge only, no stock tips, no personalized advice' },
    keywords: { zh: '财经科普 理财入门 攒钱方法 基金定投 经济趋势 记账 工资理财 钱生钱', en: 'finance personal-finance saving fund-investing economy budgeting salary money' },
  },
  {
    id: 'crypto', zh: '₿ 加密货币 · Web3', en: 'Crypto · Web3',
    persona: { zh: '把区块链讲清楚的 Web3 科普博主，客观中立。只讲原理和行业动态,不喊单、不带单、不预测价格,提示风险', en: 'A Web3 explainer who makes blockchain clear — objective, no shilling, no price calls, always flags risk' },
    keywords: { zh: '加密货币 区块链 web3 比特币 以太坊 行情解读 链上数据 钱包安全', en: 'crypto blockchain web3 bitcoin ethereum market-analysis on-chain wallet-security' },
  },
  {
    id: 'fitness', zh: '💪 健身 · 减脂日记', en: 'Fitness',
    persona: { zh: '边上班边坚持健身一年的过来人，167cm 从 130 减到 108 斤。正能量但不打鸡血，讲可执行的方法,反对极端节食', en: 'A 9-to-5 worker who lost weight over a year — positive, actionable, anti crash-dieting' },
    keywords: { zh: '居家健身 减脂打卡 增肌 体态矫正 减脂餐 HIIT 健身小白 拉伸', en: 'home-workout fat-loss muscle posture healthy-meal hiit beginner stretching' },
  },
  {
    id: 'travel', zh: '✈️ 旅行 · 攻略分享', en: 'Travel',
    persona: { zh: '爱说走就走的旅行爱好者，一年出去 6-8 次。分享性价比攻略和小众目的地，治愈、令人向往，重实操路线', en: 'A spontaneous traveler — value-focused guides and hidden gems, soothing and aspirational' },
    keywords: { zh: '旅行攻略 周末去哪 小众目的地 citywalk 自驾游 机票便宜 民宿推荐 旅行vlog', en: 'travel-guide weekend-trip hidden-gems citywalk road-trip cheap-flights homestay vlog' },
  },
  {
    id: 'outfit', zh: '👗 穿搭 · 风格分享', en: 'Outfit',
    persona: { zh: '小个子职场穿搭爱好者，155cm。分享通勤、约会、微胖显瘦的实穿搭配，精致但不端着，重点给平价替代', en: 'A petite office-wear blogger (155cm) — wearable commute/date looks, polished, affordable picks' },
    keywords: { zh: '小个子穿搭 通勤穿搭 OOTD 微胖穿搭 法式穿搭 显瘦 气质穿搭 平价单品', en: 'petite-outfit commute-wear ootd plus-size french-style slimming chic affordable' },
  },
  {
    id: 'beauty', zh: '💄 美妆 · 护肤测评', en: 'Beauty',
    persona: { zh: '敏感肌护肤爱好者，研究护肤 8 年、被坑过很多钱。成分党、只推真用过的，讲实测感受不夸大,帮新手避雷', en: 'A sensitive-skin skincare nerd of 8 years — ingredient-driven, only recommends what she has tested' },
    keywords: { zh: '平价护肤 敏感肌 成分党 粉底测评 口红试色 早C晚A 防晒 空瓶记', en: 'affordable-skincare sensitive-skin ingredients foundation lipstick vitamin-c sunscreen empties' },
  },
  {
    id: 'career', zh: '📈 职场 · 成长干货', en: 'Career',
    persona: { zh: '过来人式的职场博主，互联网公司中层。分享沟通、汇报、升职、跳槽的实操干货，实在不灌鸡汤,讲方法和案例', en: 'A been-there career blogger (mid-level in tech) — concrete tips on comms, promotion, job-hopping; no fluff' },
    keywords: { zh: '职场成长 沟通技巧 升职加薪 跳槽 简历 汇报 副业 效率工具', en: 'career-growth communication promotion job-hopping resume reporting side-hustle productivity' },
  },
  {
    id: 'side_hustle', zh: '💼 副业 · 打工人赚钱', en: 'Side Hustle',
    persona: { zh: '下班搞副业一年的普通打工人，杭州互联网运营。真诚不装,只分享自己真做过的副业、真实收入和踩过的坑,不卖课', en: 'A regular worker doing a side hustle after hours — honest, only shares what he actually tried, no course-selling' },
    keywords: { zh: '副业推荐 下班变现 0基础副业 AI副业 在家赚钱 自媒体 兼职 副业项目', en: 'side-hustle monetize beginner-friendly ai-side-hustle work-from-home creator part-time projects' },
  },
  {
    id: 'study_abroad', zh: '🎓 留学 · 申请经验', en: 'Study Abroad',
    persona: { zh: '过来人留学博主，自己申过、踩过坑。耐心细致地讲选校、文书、签证、落地生活，给可照做的清单,不贩卖焦虑', en: 'A study-abroad veteran — patient, detailed guidance on school choice, essays, visas, settling in' },
    keywords: { zh: '留学申请 选校 文书 签证 语言考试 留学生活 落地攻略 奖学金', en: 'study-abroad school-choice essays visa language-test student-life settling scholarship' },
  },
  {
    id: 'parenting', zh: '🧸 育儿 · 亲子日常', en: 'Parenting',
    persona: { zh: '理性育儿不焦虑的妈妈，娃 3 岁。分享科学育儿、绘本、辅食、亲子游戏，温和实在,讲方法不制造焦虑', en: 'A calm, science-minded mom of a 3-year-old — gentle, practical tips on early-ed, books, feeding' },
    keywords: { zh: '科学育儿 早教 绘本推荐 辅食 亲子游戏 母婴好物 新手妈妈 亲子阅读', en: 'parenting early-education picture-books baby-food games baby-gear new-mom reading' },
  },
  {
    id: 'reading', zh: '📚 读书 · 书单笔记', en: 'Reading',
    persona: { zh: '一年读 40-50 本书的普通读者，从事文化行业。分享书单、读后感、读书方法，安静走心,推荐真读过的书', en: 'A reader of ~45 books a year in the culture industry — book lists, reflections, reading methods' },
    keywords: { zh: '读书笔记 年度书单 好书推荐 读书打卡 小说推荐 非虚构 读书方法 书评', en: 'reading-notes annual-booklist recommendations reading-log fiction nonfiction methods reviews' },
  },
  {
    id: 'custom', zh: '✏️ 自定义', en: 'Custom',
    persona: { zh: '', en: '' },
    keywords: { zh: '', en: '' },
  },
];

// ── 原创短视频创建向导(两步,内联渲染) ──────────────────────────────

type GenMode = 'stock' | 'pure_ai';
type OutputMode = 'local' | 'upload';
type Platform = 'douyin' | 'xhs' | 'binance';

const SCRIPT_MIN = 10;
const SCRIPT_MAX = 800;

const VideoCreatePanel: React.FC<{ isZh: boolean; onBack: () => void }> = ({ isZh, onBack }) => {
  const [step, setStep] = useState<1 | 2>(1);

  // 步骤 1:内容
  const [trackId, setTrackId] = useState('');
  const [persona, setPersona] = useState('');
  const [keywords, setKeywords] = useState('');
  const [script, setScript] = useState('');
  const [refImages, setRefImages] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<GenMode>('stock');

  // 步骤 2:出片去向
  const [outputMode, setOutputMode] = useState<OutputMode>('local');
  const [platforms, setPlatforms] = useState<Record<Platform, boolean>>({
    douyin: true,
    xhs: true,
    binance: true,
  });

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<VideoCreationProgress | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 选赛道 → 自动带出人设/关键词(用户随后可改)
  const onPickTrack = (id: string) => {
    setTrackId(id);
    const preset = TRACK_PRESETS.find(t => t.id === id);
    if (preset && id !== 'custom') {
      setPersona(isZh ? preset.persona.zh : preset.persona.en);
      setKeywords(isZh ? preset.keywords.zh : preset.keywords.en);
    }
  };

  const pickImages = async () => {
    const remaining = 3 - refImages.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickReferenceImages(remaining);
    if (paths.length) {
      setRefImages(prev => [...prev, ...paths].slice(0, 3));
      // 异步拉缩略图(真实图片预览,不再只显示文件名)
      for (const p of paths) {
        videoCreationService.readImageDataUrl(p).then(url => {
          if (url) setThumbs(prev => ({ ...prev, [p]: url }));
        });
      }
    }
  };

  const removeImage = (idx: number) => {
    setRefImages(prev => prev.filter((_, i) => i !== idx));
  };

  const togglePlatform = (p: Platform) => {
    setPlatforms(prev => ({ ...prev, [p]: !prev[p] }));
  };

  const scriptLen = script.trim().length;
  const scriptValid = scriptLen >= SCRIPT_MIN && scriptLen <= SCRIPT_MAX;
  const step1Valid = trackId !== '' && scriptValid;

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setErrorMsg(null);
    setResultPath(null);
    setProgress(null);

    // 一期 upload 还没接,publishTarget 一律按 'local' 出片(上传去向只先收集意图)。
    const input: VideoCreationInput = {
      persona: persona.trim(),
      track: (TRACK_PRESETS.find(t => t.id === trackId)?.[isZh ? 'zh' : 'en']) || '',
      // 关键词跟其他任务一致:空格 / 逗号都能拆(split 同时吃 ，, 和空白)。
      keywords: keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean),
      script: script.trim(),
      referenceImages: refImages,
      aspect: '9:16',
      publishTarget: 'local' as VideoPublishTarget,
    };

    const res = await videoCreationService.generate(input, (p) => setProgress(p));
    setGenerating(false);
    if (res.ok && res.outputPath) {
      setResultPath(res.outputPath);
    } else {
      setErrorMsg(res.error || (isZh ? '生成失败' : 'Generation failed'));
    }
  };

  const selectedPlatformLabels = (Object.keys(platforms) as Platform[])
    .filter(p => platforms[p])
    .map(p => (p === 'douyin' ? (isZh ? '抖音' : 'Douyin') : p === 'xhs' ? (isZh ? '小红书' : 'XHS') : (isZh ? '币安' : 'Binance')));

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-sm">
        {/* 头部 + 步骤指示 */}
        <div className="px-6 pt-6 pb-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-lg font-bold dark:text-white flex items-center gap-2">
            🎬 {isZh ? '原创短视频 · 单次成片' : 'Original Short · One-shot'}
          </h3>
          <div className="flex items-center gap-2 mt-3">
            <StepDot n={1} active={step === 1} done={step > 1} label={isZh ? '内容' : 'Content'} />
            <div className={`h-px flex-1 ${step > 1 ? 'bg-rose-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
            <StepDot n={2} active={step === 2} done={false} label={isZh ? '出片' : 'Output'} />
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* ───── 步骤 1:内容 ───── */}
          {step === 1 && (
            <>
              {/* 赛道(下拉,选完自动带出人设/关键词) */}
              <Field label={isZh ? '赛道（必选）' : 'Track (required)'} hint={isZh ? '选完自动带出人设和关键词，可再改' : 'auto-fills persona & keywords, editable'}>
                <select
                  value={trackId}
                  onChange={e => onPickTrack(e.target.value)}
                  disabled={generating}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                >
                  <option value="">{isZh ? '— 请选择赛道 —' : '— Select a track —'}</option>
                  {TRACK_PRESETS.map(t => (
                    <option key={t.id} value={t.id}>{isZh ? t.zh : t.en}</option>
                  ))}
                </select>
              </Field>

              {/* 人设(自动带出,可改) */}
              <Field label={isZh ? '人设' : 'Persona'} hint={isZh ? '你是谁、对谁说话、什么口吻' : 'who you are and your tone'}>
                <input
                  value={persona}
                  onChange={e => setPersona(e.target.value)}
                  disabled={generating}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                />
              </Field>

              {/* 关键词(自动带出,可改;空格分隔,跟其他任务一致) */}
              <Field label={isZh ? '关键词' : 'Keywords'} hint={isZh ? '空格分隔，用于搜画面素材' : 'space-separated, used to search stock'}>
                <input
                  value={keywords}
                  onChange={e => setKeywords(e.target.value)}
                  disabled={generating}
                  placeholder={isZh ? '选赛道后自动带出，可修改' : 'auto-filled after picking a track'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
                />
              </Field>

              {/* 参考文案(10~800 字) */}
              <Field
                label={isZh ? '参考文案（必填）' : 'Reference script (required)'}
                hint={isZh ? '逐句拆成分镜并配音' : 'split into scenes & narrated line by line'}
              >
                <textarea
                  value={script}
                  onChange={e => setScript(e.target.value)}
                  disabled={generating}
                  rows={6}
                  placeholder={isZh ? `把你想讲的内容粘进来…（${SCRIPT_MIN}~${SCRIPT_MAX} 字）` : `Paste your script here… (${SCRIPT_MIN}-${SCRIPT_MAX} chars)`}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y min-h-[120px]"
                />
                <div className={`mt-1 text-[11px] text-right ${scriptLen === 0 ? 'text-gray-400' : scriptValid ? 'text-gray-400' : 'text-red-500'}`}>
                  {scriptLen}/{SCRIPT_MAX}
                  {scriptLen > 0 && scriptLen < SCRIPT_MIN && (isZh ? `（至少 ${SCRIPT_MIN} 字）` : ` (min ${SCRIPT_MIN})`)}
                  {scriptLen > SCRIPT_MAX && (isZh ? '（超出上限）' : ' (over limit)')}
                </div>
              </Field>
            </>
          )}

          {/* ───── 步骤 2:画面 + 出片去向 ───── */}
          {step === 2 && (
            <>
              {/* 视频参考图(真实缩略图预览) —— 从第一步挪过来,第一步只留文字内容 */}
              <Field label={isZh ? '视频参考图（选填，最多 3 张）' : 'Video reference images (optional, max 3)'}>
                <div className="flex flex-wrap items-center gap-2">
                  {refImages.map((p, i) => (
                    <div key={i} className="relative group">
                      <div className="w-16 h-16 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 flex items-center justify-center overflow-hidden">
                        {thumbs[p] ? (
                          <img src={thumbs[p]} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[10px] text-gray-500 px-1 text-center break-all">
                            {p.split(/[\\/]/).pop()}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        disabled={generating}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-800 text-white text-xs flex items-center justify-center hover:bg-red-500"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {refImages.length < 3 && (
                    <button
                      type="button"
                      onClick={pickImages}
                      disabled={generating}
                      className="w-16 h-16 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-2xl text-gray-400 hover:border-rose-400 hover:text-rose-400 transition-colors"
                    >
                      +
                    </button>
                  )}
                </div>
              </Field>

              {/* 生成模式 —— 从第一步挪过来 */}
              <Field label={isZh ? '生成模式' : 'Generation mode'}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ModeOption
                    active={mode === 'stock'}
                    disabled={generating}
                    onClick={() => setMode('stock')}
                    title={isZh ? 'AI 分镜 + 在线素材库' : 'AI scenes + stock library'}
                    desc={isZh ? '参考图 + 免费素材库凑画面，便宜快' : 'your images + free stock, cheap & fast'}
                  />
                  <ModeOption
                    active={mode === 'pure_ai'}
                    disabled
                    onClick={() => {}}
                    title={isZh ? '纯 AI 原创' : 'Pure AI original'}
                    desc={isZh ? '画面全 AI 生成（即将推出）' : 'fully AI-generated (coming soon)'}
                    soon={isZh ? '即将推出' : 'Soon'}
                  />
                </div>
              </Field>

              <Field label={isZh ? '出片后' : 'After generation'}>
                <div className="space-y-2">
                  <RadioCard
                    active={outputMode === 'local'}
                    disabled={generating}
                    onClick={() => setOutputMode('local')}
                    title={isZh ? '存本地不上传' : 'Save locally, no upload'}
                    desc={isZh ? '只在本机生成 mp4，自己看 / 手动发都行' : 'just produce an mp4 on this machine'}
                  />
                  <RadioCard
                    active={outputMode === 'upload'}
                    disabled={generating}
                    onClick={() => setOutputMode('upload')}
                    title={isZh ? '上传到各大平台' : 'Upload to platforms'}
                    desc={isZh ? '出片后自动发到选中的平台' : 'auto-publish to selected platforms after'}
                    soon={isZh ? '即将推出' : 'Soon'}
                  />
                </div>
              </Field>

              {/* 平台多选(默认全选) */}
              {outputMode === 'upload' && (
                <Field label={isZh ? '发布平台（可多选）' : 'Target platforms (multi-select)'}>
                  <div className="flex flex-wrap gap-2">
                    <PlatformCheck checked={platforms.douyin} disabled={generating} onClick={() => togglePlatform('douyin')} label={isZh ? '抖音' : 'Douyin'} />
                    <PlatformCheck checked={platforms.xhs} disabled={generating} onClick={() => togglePlatform('xhs')} label={isZh ? '小红书' : 'XHS'} />
                    <PlatformCheck checked={platforms.binance} disabled={generating} onClick={() => togglePlatform('binance')} label={isZh ? '币安' : 'Binance'} />
                  </div>
                  <div className="mt-2 text-[11px] text-amber-500">
                    {isZh
                      ? `⚠️ 上传功能即将上线，本次仍会先存到本地${selectedPlatformLabels.length ? `（已记下要发：${selectedPlatformLabels.join(' / ')}）` : ''}。`
                      : 'Upload is coming soon — this run still saves locally first.'}
                  </div>
                </Field>
              )}

              {/* 出片概要 */}
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 text-[11px] text-gray-500 dark:text-gray-400 space-y-1">
                <div>🎯 {isZh ? '赛道' : 'Track'}：{TRACK_PRESETS.find(t => t.id === trackId)?.[isZh ? 'zh' : 'en'] || '-'}</div>
                <div>📝 {isZh ? '文案' : 'Script'}：{scriptLen} {isZh ? '字' : 'chars'}</div>
                <div>🖼️ {isZh ? '参考图' : 'Images'}：{refImages.length}</div>
              </div>

              {/* 进度 */}
              {progress && (
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-1.5">
                  {progress.steps.map(s => (
                    <div key={s.key} className="flex items-center gap-2 text-xs">
                      <span>
                        {s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : '○'}
                      </span>
                      <span className={s.status === 'running' ? 'text-rose-500 font-medium' : 'text-gray-600 dark:text-gray-300'}>
                        {s.label}
                      </span>
                    </div>
                  ))}
                  {progress.message && (
                    <div className="text-[11px] text-gray-400 pt-1">{progress.message}</div>
                  )}
                </div>
              )}

              {/* 结果 */}
              {resultPath && (
                <div className="rounded-lg border border-green-500/40 bg-green-500/5 p-3">
                  <div className="text-sm font-medium text-green-600 dark:text-green-400 mb-1">
                    ✅ {isZh ? '生成成功' : 'Done'}
                  </div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 break-all mb-2">{resultPath}</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => videoCreationService.openFile(resultPath)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500 text-white hover:bg-rose-600"
                    >
                      ▶ {isZh ? '预览' : 'Preview'}
                    </button>
                    <button
                      type="button"
                      onClick={() => videoCreationService.revealInFolder(resultPath)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      📂 {isZh ? '打开文件夹' : 'Open folder'}
                    </button>
                  </div>
                </div>
              )}

              {errorMsg && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-500 break-all">
                  {errorMsg}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={onBack}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!trackId) { alert(isZh ? '请先选择赛道' : 'Please pick a track'); return; }
                  if (!scriptValid) { alert(isZh ? `参考文案需 ${SCRIPT_MIN}~${SCRIPT_MAX} 字` : `Script must be ${SCRIPT_MIN}-${SCRIPT_MAX} chars`); return; }
                  setStep(2);
                }}
                disabled={!step1Valid}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
              >
                {isZh ? '下一步' : 'Next'} →
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => !generating && (resultPath ? onBack() : setStep(1))}
                disabled={generating}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {resultPath ? (isZh ? '完成' : 'Done') : (isZh ? '← 上一步' : '← Back')}
              </button>
              {!resultPath && (
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={generating}
                  className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
                >
                  {generating ? (isZh ? '生成中…' : 'Generating…') : '🎬 ' + (isZh ? '开始生成' : 'Generate')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ── 小组件 ──────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-1.5 flex items-center gap-2">
      {label}
      {hint && <span className="text-[11px] font-normal text-gray-400">{hint}</span>}
    </label>
    {children}
  </div>
);

const StepDot: React.FC<{ n: number; active: boolean; done: boolean; label: string }> = ({ n, active, done, label }) => (
  <div className="flex items-center gap-1.5">
    <span
      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
        active ? 'bg-rose-500 text-white' : done ? 'bg-rose-500/20 text-rose-500' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
      }`}
    >
      {done ? '✓' : n}
    </span>
    <span className={`text-xs font-medium ${active ? 'text-rose-500' : 'text-gray-500'}`}>{label}</span>
  </div>
);

const ModeOption: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
}> = ({ active, disabled, onClick, title, desc, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`text-left rounded-lg border p-3 transition-colors ${
      active
        ? 'border-rose-500 bg-rose-500/10'
        : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <div className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
      {title}
      {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
    </div>
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</div>
  </button>
);

const RadioCard: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  soon?: string;
}> = ({ active, disabled, onClick, title, desc, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors ${
      active ? 'border-rose-500 bg-rose-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-rose-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
  >
    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-rose-500' : 'border-gray-400'}`}>
      {active && <span className="w-2 h-2 rounded-full bg-rose-500" />}
    </span>
    <span>
      <span className="text-sm font-semibold dark:text-white flex items-center gap-1.5">
        {title}
        {soon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">{soon}</span>}
      </span>
      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{desc}</span>
    </span>
  </button>
);

const PlatformCheck: React.FC<{
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}> = ({ checked, disabled, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 text-xs px-3 py-2 rounded-lg border transition-colors ${
      checked
        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-rose-300'}`}
  >
    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-rose-500 border-rose-500 text-white' : 'border-gray-400'}`}>
      {checked ? '✓' : ''}
    </span>
    {label}
  </button>
);
