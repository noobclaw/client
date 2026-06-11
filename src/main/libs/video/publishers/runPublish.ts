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
import {
  openCreatorCenter, openPlatformLogin, platformHasCreatorCenter,
  checkCreatorCenter, checkPlatformLogin, type LoginPlatform,
} from '../../scenario/platformLoginDriver';
import { sendBrowserCommand } from '../../browserBridge';
import { PUBLISHER_ANCHOR_URL, bridgeOptsFor } from './publisherUtils';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 登录成功后,把该平台的 tab 导航到【上传页】(PUBLISHER_ANCHOR_URL)。
 *
 * 为什么需要:openCreatorCenter 开的是创作中心【首页】,但 driver.upload 要在【上传页】
 * 找 file input。anchor 预检只在「没有匹配 tabPattern 的 tab」时才开新 tab —— 而首页 tab
 * 已存在且 tabPattern(如 creator\.douyin\.com)宽泛匹配它,预检不会导航到上传页 →
 * driver 在首页找不到 file input。所以这里显式 navigate 到精确上传页。失败不阻塞(driver
 * 内部 waitForSelector 还会再等;真不行就 upload 失败,不影响其它平台)。
 */
async function navigateToUploadPage(platform: VideoPlatform, onLog: (m: string) => void): Promise<void> {
  const url = PUBLISHER_ANCHOR_URL[platform];
  if (!url) return;
  try {
    await sendBrowserCommand('navigate', { url }, 30_000, bridgeOptsFor(platform));
    await sleep(1500); // 给页面加载一点时间
  } catch {
    onLog('导航到上传页未成功,driver 将自行等待页面元素');
  }
}

/**
 * 发布前置:打开浏览器对应平台的 tab(创作中心 / 主站)+ 轮询等登录态 OK。
 *
 * 这是修「发布永远跳过」的根因 —— 以前 driver 直接 checkLogin 查 tab_list,但从没
 * 先把创作中心 tab 打开,所以列表里永远没有对应 tab → 恒「未登录」。对齐 scenario 任务:
 * scenario 靠 LoginRequiredModal 让用户手点「打开创作中心」开 tab,视频发布跑在 pipeline
 * 末尾没这个 gate,所以这里【自动开 tab + 轮询等用户登录】,把那套手动流程自动化。
 *
 * 流程:
 *   1. 有 creator 子域(抖音/小红书/快手/B站)→ openCreatorCenter;否则(币安/推特/TikTok/
 *      头条号/视频号)→ openPlatformLogin(主站发布)。
 *   2. 轮询 checkCreatorCenter / checkPlatformLogin,直到 loggedIn 或超时(给扫码留时间)。
 *   3. 返回 'logged_in' / 'not_logged_in'(超时)/ 'browser_not_connected'(浏览器没开)。
 *
 * 绝不抛。浏览器没开时快速返回(不傻等满超时)。
 */
async function ensureLoggedInTab(
  platform: VideoPlatform,
  onLog: (m: string) => void,
  signal?: AbortSignal,
  timeoutMs = 90_000,
): Promise<'logged_in' | 'not_logged_in' | 'browser_not_connected'> {
  const p = platform as unknown as LoginPlatform;
  const hasCreator = platformHasCreatorCenter(p);
  const check = () => (hasCreator ? checkCreatorCenter(p) : checkPlatformLogin(p));

  // 先探一次:可能用户早就开着 tab + 登录了,不用再开。
  let st = await check().catch(() => ({ loggedIn: false, reason: 'check_threw' } as any));
  if (st.loggedIn) return 'logged_in';
  if (st.reason === 'browser_not_connected') {
    onLog('🔌 浏览器未连接(请先打开装了 NoobClaw 插件的 Chrome/Edge)');
    return 'browser_not_connected';
  }

  // 没登录 / tab 不在 → 自动开 tab(创作中心优先)。
  onLog(`🌐 打开${hasCreator ? '创作中心' : '平台'} tab,等待登录…`);
  try {
    const opened = hasCreator ? await openCreatorCenter(p) : await openPlatformLogin(p);
    if (!opened.ok) onLog(`   开 tab 未成功(${opened.reason || 'unknown'}),继续轮询登录态…`);
  } catch { /* 开 tab 失败也继续轮询,也许用户手动开了 */ }

  // 轮询等登录(给扫码 / 加载时间)。
  const deadline = Date.now() + timeoutMs;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'not_logged_in';
    await sleep(2500);
    st = await check().catch(() => ({ loggedIn: false } as any));
    if (st.loggedIn) return 'logged_in';
    if (st.reason === 'browser_not_connected') {
      onLog('🔌 浏览器连接断开,放弃该平台');
      return 'browser_not_connected';
    }
    // 心跳:每 ~15s 提示一次还在等
    const elapsed = timeoutMs - (deadline - Date.now());
    if (elapsed - lastBeat >= 15_000) {
      lastBeat = elapsed;
      onLog(`⏳ 等待登录中… ${Math.round(elapsed / 1000)}s(请在打开的窗口扫码 / 登录)`);
    }
  }
  return 'not_logged_in';
}

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

    // 登录前置:自动开浏览器对应平台 tab(创作中心/主站)+ 轮询等登录态 OK。
    //   这是修「发布永远跳过」的根因 —— 以前直接 driver.checkLogin 查 tab_list,但从没先
    //   把 tab 开出来,所以恒「未登录」。现在对齐 scenario 任务的「开 tab → 等登录」流程
    //   (只是把 scenario 的 LoginRequiredModal 手动 gate 自动化成 pipeline 自动开 tab + 轮询)。
    const loginStatus = await ensureLoggedInTab(id as VideoPlatform, (m) => opts.onLog?.(`   ${m}`), opts.signal);
    if (loginStatus === 'browser_not_connected') {
      opts.onLog?.(`⚠️ ${label} 跳过 · 浏览器未连接(请打开装了 NoobClaw 插件的 Chrome/Edge 再跑)`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'browser_not_connected' });
      continue;
    }
    if (loginStatus !== 'logged_in') {
      opts.onLog?.(`⚠️ ${label} 未登录(等了 90s 仍未登录)· 跳过,下次运行会补传`);
      result.skippedCount++;
      result.details.push({ platform: id, status: 'skipped', reason: 'not_logged_in' });
      continue;
    }
    opts.onLog?.(`✅ ${label} 已登录,准备上传`);
    // 导航到精确上传页(创作中心首页 → 上传页),否则 driver 在首页找不到 file input。
    await navigateToUploadPage(id as VideoPlatform, (m) => opts.onLog?.(`   ${m}`));

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
