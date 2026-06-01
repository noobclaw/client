/**
 * VideoWorkflowsPage — 「多平台视频创作」工作流页面.
 *
 * 这是个本地合成工具,不走 backend scenario 任务体系,自己渲染卡片 + 表单。
 *
 * 卡片:
 *   1. 原创短视频 · 单次成片  —— 可用。填人设/赛道/关键词/参考文案/参考图,
 *        选「AI分镜+在线素材库」模式,本地出 mp4。(纯 AI 原创模式占位灰掉)
 *   2. 每日热点短视频 · 自动成片 —— 占位,点不了(后续里程碑)。
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

export const VideoWorkflowsPage: React.FC = () => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [formOpen, setFormOpen] = useState(false);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* 页面标题 —— 视频页自带,不复用 scenario 的 create header */}
      <div className="mb-5">
        <h2 className="text-xl font-bold dark:text-white text-gray-900 flex items-center gap-2">
          🎬 {isZh ? '多平台视频创作' : 'Multi-Platform Video'}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {isZh
            ? '把文案变成配好音、带字幕、有画面的竖屏短视频，先存本地，满意后再一键发到各平台。'
            : 'Turn a script into a narrated, subtitled portrait short video — saved locally first, publish to platforms later.'}
        </p>
      </div>

      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <OriginalShortVideoCard isZh={isZh} onStart={() => setFormOpen(true)} />
        <DailyHotVideoCard isZh={isZh} />
      </section>

      {/* Feature pills */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2 justify-center">
          {[
            { icon: '💻', zh: '本地合成 · 零服务器成本', en: 'Local synthesis · zero server cost' },
            { icon: '🎙️', zh: 'AI 配音 + 自动字幕', en: 'AI voiceover + auto subtitles' },
            { icon: '🖼️', zh: '参考图 + 在线素材库', en: 'Your images + stock library' },
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

      {formOpen && (
        <OriginalVideoFormModal isZh={isZh} onClose={() => setFormOpen(false)} />
      )}
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
            ? '给定人设、赛道、关键词和一段参考文案，再传几张参考图（选填），AI 自动逐句拆分镜、配音、配字幕，用你的图加在线素材库凑齐画面，本地合成一条竖屏短视频。出片满意后可一键发到抖音 / 小红书 / 币安，也可只存本地。'
            : 'Give a persona, track, keywords and a reference script (plus optional images). AI splits it into scenes, narrates, subtitles, and fills visuals from your images + a stock library, then composes a portrait short locally. Publish to Douyin / XHS / Binance after, or just keep it local.'}
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
            ? '每天自动抓取你赛道下的当下热点选题，自动写稿、配音、配画面，按计划批量出片并定时分发。无需人工选题，全自动运转。'
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

// ── 原创短视频表单 modal ────────────────────────────────────────────

type GenMode = 'stock' | 'pure_ai';

const OriginalVideoFormModal: React.FC<{ isZh: boolean; onClose: () => void }> = ({ isZh, onClose }) => {
  const [persona, setPersona] = useState('');
  const [track, setTrack] = useState('');
  const [keywords, setKeywords] = useState('');
  const [script, setScript] = useState('');
  const [refImages, setRefImages] = useState<string[]>([]);
  const [bgmPath, setBgmPath] = useState<string>('');
  const [mode, setMode] = useState<GenMode>('stock');
  const [publishTarget, setPublishTarget] = useState<VideoPublishTarget>('local');

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<VideoCreationProgress | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pickImages = async () => {
    const remaining = 3 - refImages.length;
    if (remaining <= 0) return;
    const paths = await videoCreationService.pickReferenceImages(remaining);
    if (paths.length) {
      setRefImages(prev => [...prev, ...paths].slice(0, 3));
    }
  };

  const removeImage = (idx: number) => {
    setRefImages(prev => prev.filter((_, i) => i !== idx));
  };

  const pickBgm = async () => {
    const p = await videoCreationService.pickBgm();
    if (p) setBgmPath(p);
  };

  const canSubmit = script.trim().length > 0 && !generating;

  const handleGenerate = async () => {
    if (!canSubmit) {
      if (!script.trim()) alert(isZh ? '请先填写参考文案' : 'Please fill in the reference script');
      return;
    }
    setGenerating(true);
    setErrorMsg(null);
    setResultPath(null);
    setProgress(null);

    const input: VideoCreationInput = {
      persona: persona.trim(),
      track: track.trim(),
      keywords: keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean),
      script: script.trim(),
      referenceImages: refImages,
      aspect: '9:16',
      publishTarget,
      bgmPath: bgmPath || undefined,
    };

    const res = await videoCreationService.generate(input, (p) => setProgress(p));
    setGenerating(false);
    if (res.ok && res.outputPath) {
      setResultPath(res.outputPath);
    } else {
      setErrorMsg(res.error || (isZh ? '生成失败' : 'Generation failed'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl">
        <div className="sticky top-0 bg-white dark:bg-gray-900 px-6 pt-6 pb-3 border-b border-gray-100 dark:border-gray-800 z-10">
          <h3 className="text-lg font-bold dark:text-white flex items-center gap-2">
            🎬 {isZh ? '原创短视频 · 单次成片' : 'Original Short · One-shot'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {isZh
              ? '一期先用你粘贴的参考文案直接出片（AI 帮写下个版本上）。'
              : 'For now it uses your pasted script directly (AI writing comes next version).'}
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* 人设 */}
          <Field label={isZh ? '人设' : 'Persona'} hint={isZh ? '比如：分享日本生活的留学生博主' : 'e.g. a student blogger sharing life in Japan'}>
            <input
              value={persona}
              onChange={e => setPersona(e.target.value)}
              disabled={generating}
              placeholder={isZh ? '你是谁、对谁说话、什么口吻' : 'Who you are and your tone'}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
            />
          </Field>

          {/* 赛道 + 关键词 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={isZh ? '赛道' : 'Track'}>
              <input
                value={track}
                onChange={e => setTrack(e.target.value)}
                disabled={generating}
                placeholder={isZh ? '海外生活 / 美食 / 数码…' : 'Lifestyle / Food / Tech…'}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
              />
            </Field>
            <Field label={isZh ? '关键词' : 'Keywords'} hint={isZh ? '逗号分隔，用于搜画面素材' : 'comma-separated, used to search stock'}>
              <input
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                disabled={generating}
                placeholder={isZh ? '东京, 租房, 省钱' : 'tokyo, rent, save money'}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50"
              />
            </Field>
          </div>

          {/* 参考文案 */}
          <Field label={isZh ? '参考文案（必填）' : 'Reference script (required)'} hint={isZh ? '一期会逐句拆成分镜并配音' : 'split into scenes & narrated line by line'}>
            <textarea
              value={script}
              onChange={e => setScript(e.target.value)}
              disabled={generating}
              rows={6}
              placeholder={isZh ? '把你想讲的内容粘进来…' : 'Paste your script here…'}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/50 resize-y min-h-[120px]"
            />
          </Field>

          {/* 参考图 */}
          <Field label={isZh ? '参考图（选填，最多 3 张）' : 'Reference images (optional, max 3)'}>
            <div className="flex flex-wrap items-center gap-2">
              {refImages.map((p, i) => (
                <div key={i} className="relative group">
                  <div className="w-16 h-16 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-[10px] text-gray-500 overflow-hidden px-1 text-center break-all">
                    {p.split(/[\\/]/).pop()}
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

          {/* 背景音乐 */}
          <Field label={isZh ? '背景音乐（选填）' : 'Background music (optional)'} hint={isZh ? '低音量混入旁白，结尾自动淡出' : 'low-volume under narration, auto fade-out'}>
            {bgmPath ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate">
                  🎵 {bgmPath.split(/[\\/]/).pop()}
                </div>
                <button
                  type="button"
                  onClick={() => setBgmPath('')}
                  disabled={generating}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 text-gray-500 hover:text-red-500 hover:border-red-400"
                >
                  {isZh ? '移除' : 'Remove'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={pickBgm}
                disabled={generating}
                className="px-4 py-2 text-sm rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 text-gray-500 hover:border-rose-400 hover:text-rose-400 transition-colors"
              >
                + {isZh ? '选择背景音乐' : 'Choose music'}
              </button>
            )}
          </Field>

          {/* 生成模式 */}
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

          {/* 发布去向 */}
          <Field label={isZh ? '出片后' : 'After generation'}>
            <div className="flex flex-wrap gap-2">
              <PublishChip active={publishTarget === 'local'} disabled={generating} onClick={() => setPublishTarget('local')} label={isZh ? '存本地不上传' : 'Save local'} />
              <PublishChip active={publishTarget === 'douyin'} disabled onClick={() => {}} label={isZh ? '发抖音' : 'Douyin'} soon />
              <PublishChip active={publishTarget === 'xhs'} disabled onClick={() => {}} label={isZh ? '发小红书' : 'XHS'} soon />
              <PublishChip active={publishTarget === 'binance'} disabled onClick={() => {}} label={isZh ? '发币安' : 'Binance'} soon />
            </div>
          </Field>

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
        </div>

        {/* 底部按钮 */}
        <div className="sticky bottom-0 bg-white dark:bg-gray-900 px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex gap-2">
          <button
            type="button"
            onClick={() => !generating && onClose()}
            disabled={generating}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {isZh ? (resultPath ? '关闭' : '取消') : (resultPath ? 'Close' : 'Cancel')}
          </button>
          {!resultPath && (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canSubmit}
              className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50"
            >
              {generating ? (isZh ? '生成中…' : 'Generating…') : '🎬 ' + (isZh ? '开始生成' : 'Generate')}
            </button>
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

const PublishChip: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  soon?: boolean;
}> = ({ active, disabled, onClick, label, soon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-full border transition-colors ${
      active
        ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium'
        : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-rose-300'}`}
  >
    {label}
    {soon && <span className="text-[9px] px-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">soon</span>}
  </button>
);
