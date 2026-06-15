/**
 * videoRunWindow —— 视频类任务【运行窗口】(取材 + 发布共用一个窗口)。
 *
 * 背景:热搜成片取材(抖音搜索)以前走 pubCmd 的 tabPattern 路由 → 命中【任意】抖音 tab,
 * 跟 scenario 的抖音任务、甚至另一条视频 pipeline 抢同一个 tab → 串台(口播 A 配画面 B)。
 *
 * 这里复用发布侧已有的【专用 video_publish 窗口】(见 runPublish.openPublishTab,windowKey
 * 幂等 → 同一个窗口):取材也开/复用它、把驱动命令【按 tabId 钉到这个窗口的固定 tab】,
 * 于是抖音搜索在视频自己的窗口里跑,物理隔离 scenario,也不跟别的视频 pipeline 抢
 * (视频侧另有串行锁 + videoQueue 单槽兜着)。一个窗口、一个 tab、navigate 串行复用,不爆炸。
 *
 * 拿不到 tabId(旧扩展无 window_registry_v6 / 开窗失败)→ 返回 undefined,调用方回退原
 * tabPattern 路由(行为同改动前,不阻断取材)。
 */

import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';
import { groupTitle as buildGroupTitle, getStandardBounds } from '../scenario/subPlatformRegistry';

/** 跟发布共用同一个窗口(见 subPlatformRegistry.video_publish / runPublish.PUBLISH_WINDOW_KEY)。 */
const RUN_SUB_PLATFORM = 'video_publish';
const RUN_WINDOW_KEY = `${RUN_SUB_PLATFORM}::default`;

let _runTabId: number | undefined;

/**
 * 开/复用视频运行窗口的固定 tab,返回 tabId。
 *   · 初始 url 用 about:blank —— 不预先停在任何平台页(免得 checkPlatformLogin 误判),
 *     驱动跑起来会自己 navigate 到目标平台。
 *   · windowKey 幂等:第一次开新窗、之后复用;跟 runPublish 用同一个 windowKey → 同一个窗口。
 * 拿不到 → undefined(调用方回退 tabPattern)。
 */
export async function ensureVideoRunTab(onLog?: (m: string) => void): Promise<number | undefined> {
  if (typeof _runTabId === 'number') return _runTabId;
  if (!connectionHasCapability(undefined, 'window_registry_v6')) {
    try { onLog?.('ℹ️ 扩展无 v6 窗口注册表,取材回退共享 tab 模式'); } catch { /* ignore */ }
    return undefined;
  }
  try {
    const idleTitle = buildGroupTitle(RUN_SUB_PLATFORM, 'default', null);
    const bounds = getStandardBounds(RUN_SUB_PLATFORM, 'default');
    const res: any = await sendBrowserCommand(
      'task_open_tab',
      {
        windowKey: RUN_WINDOW_KEY,
        groupTitle: idleTitle,
        role: 'main',
        url: 'about:blank',
        bounds,
        // taskId omitted —— 视频任务不进 scenario 的 taskTabRegistry。
      },
      12000,
    );
    const tabId = res?.tabId ?? res?.data?.tabId;
    if (typeof tabId === 'number') { _runTabId = tabId; return tabId; }
  } catch { /* 开窗失败 → 回退 */ }
  return undefined;
}

/** 视频运行窗口的 tab 可能被关 / 失效时调用,下次重开。 */
export function resetVideoRunTab(): void {
  _runTabId = undefined;
}
