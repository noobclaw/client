/**
 * runPublish —— 给 pipeline 调用的统一 publish step。
 *
 * 用户硬约束(写在 PublisherDriver 契约里 + 这里再实现一遍):
 *   · 单平台未登录 → 跳过,日志推一条「⚠️ 抖音未登录,跳过(登录后下次跑会补传)」
 *   · 单平台上传失败 → 跳过,日志推 reason,继续下一个
 *   · 全部跳过/失败 → 任务仍 done(本地 mp4 还在),不杀任务
 *
 * pipeline.ts 和 template-pipeline.ts 都调这个函数 → 行为一致,Bug 修一处全好。
 */

import type { VideoPlatform, PublishInput } from './types';
import { VIDEO_PLATFORMS } from './types';
import { getDriver } from './registry';

export interface RunPublishOptions {
  /** 用户在向导里勾选的平台 id 列表(来自 input.publishPlatforms)。 */
  platforms: string[];
  /** 视频 mp4 本地路径。 */
  videoPath: string;
  /** 标题(若 task 有的话;用户文案 / AI 生成的标题)。 */
  title?: string;
  /** 描述 / 正文(口播稿 / dataText / scriptMode='strict' 的 script 等,driver 自行 truncate)。 */
  description?: string;
  /** 标签(driver 自行格式化成 #tag / 话题等)。 */
  tags?: string[];
  /** 日志回调:每条进度推给 tracker.progress(让 UI 看到)。 */
  onLog?: (msg: string) => void;
  /** 中断信号:用户停止任务时跳过剩余平台。 */
  signal?: AbortSignal;
}

export interface RunPublishResult {
  /** 真的发出去的平台数。 */
  publishedCount: number;
  /** 跳过的平台数(未登录 / driver 未实装)。 */
  skippedCount: number;
  /** 上传失败的平台数(driver 跑了但返回 ok:false)。 */
  failedCount: number;
  /** 每个平台的最终结果(顺序跟输入一致)。 */
  details: Array<{ platform: string; status: 'published' | 'skipped' | 'failed'; reason?: string }>;
}

function platformLabel(id: string): string {
  const m = VIDEO_PLATFORMS.find((p) => p.id === id);
  return m ? `${m.emoji} ${m.zh}` : id;
}

/**
 * 跑 publish step:iterate 用户勾选的平台 → 对每个调 driver(已登录就上传,未登录跳过)。
 * 任何单平台异常都吞掉、记日志、继续下一个。绝不抛。
 */
export async function runPublishStep(opts: RunPublishOptions): Promise<RunPublishResult> {
  const list = Array.isArray(opts.platforms) ? opts.platforms.filter(Boolean) : [];
  const result: RunPublishResult = {
    publishedCount: 0, skippedCount: 0, failedCount: 0, details: [],
  };

  if (list.length === 0) {
    opts.onLog?.('📂 未选发布平台 · 仅存本地');
    return result;
  }

  opts.onLog?.(`🚀 准备发布到 ${list.length} 个平台:${list.map(platformLabel).join(' / ')}`);

  for (const id of list) {
    if (opts.signal?.aborted) {
      opts.onLog?.('⏹ 已停止 · 后续平台跳过');
      break;
    }
    const label = platformLabel(id);
    const driver = getDriver(id as VideoPlatform);
    if (!driver) {
      // driver 文件还没实装(比如 9 平台分批 land,本期还没做的那几个)
      opts.onLog?.(`⚠️ ${label} driver 未实装 · 跳过(后续版本会补)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'driver_not_implemented' });
      continue;
    }

    // 登录态检查 —— 未登录直接跳过,不打开浏览器
    let loginStatus: 'logged_in' | 'not_logged_in' | 'unknown' = 'unknown';
    try { loginStatus = await driver.checkLogin(); } catch { loginStatus = 'unknown'; }
    if (loginStatus !== 'logged_in') {
      opts.onLog?.(`⚠️ ${label} 未登录 · 跳过(登录后下次运行会补传)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'not_logged_in' });
      continue;
    }

    // 上传 —— 单平台异常吞掉,继续下一个
    opts.onLog?.(`📤 ${label} · 开始上传…`);
    let pr: { ok: boolean; reason?: string };
    try {
      const input: PublishInput = {
        videoPath: opts.videoPath,
        title: opts.title,
        description: opts.description,
        tags: opts.tags,
      };
      pr = await driver.upload(input, (msg) => opts.onLog?.(`   ${msg}`));
    } catch (e: any) {
      pr = { ok: false, reason: 'driver_threw:' + String(e?.message || e).slice(0, 120) };
    }
    if (pr.ok) {
      opts.onLog?.(`✅ ${label} 发布完成`);
      result.publishedCount++;
      result.details.push({ platform: id, status: 'published' });
    } else {
      opts.onLog?.(`❌ ${label} 发布失败:${pr.reason || 'unknown'}`);
      result.failedCount++;
      result.details.push({ platform: id, status: 'failed', reason: pr.reason });
    }
  }

  // 汇总日志
  const parts: string[] = [];
  if (result.publishedCount > 0) parts.push(`✅ ${result.publishedCount} 已发`);
  if (result.skippedCount > 0)   parts.push(`⏭️ ${result.skippedCount} 跳过`);
  if (result.failedCount > 0)    parts.push(`❌ ${result.failedCount} 失败`);
  if (parts.length) opts.onLog?.(`📊 发布汇总:${parts.join(' · ')}`);

  return result;
}
