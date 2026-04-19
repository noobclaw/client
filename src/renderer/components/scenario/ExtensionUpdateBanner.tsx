/**
 * ExtensionUpdateBanner
 *
 * Polls the desktop main process every 5s for the list of connected
 * browser extensions. If ANY extension is outdated (version < required
 * minimum, or empty meaning pre-1.2.0 which didn't report version), shows
 * a yellow warning banner telling the user to reload / update.
 *
 * Why we care: features like multi-browser routing (1.2.0), tab group
 * indicator (1.2.2), and brand-color polish (1.2.3) need a recent
 * extension. Without it the user hits weird bugs (one task killing
 * another, no visual indicator, etc.) and blames the desktop app.
 *
 * Shown on: XhsWorkflowsPage, XWorkflowsPage. Cheap to render — null
 * result short-circuits, no DOM if everything is fine.
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { scenarioService } from '../../services/scenario';

// Bump this whenever a new extension feature lands that the renderer
// depends on. Currently 1.2.0 is the bare minimum (multi-browser hello
// protocol). Below that, multi-browser tasks silently break.
const REQUIRED_EXTENSION_VERSION = '1.2.0';

/** Compare semver-like strings "1.2.3" vs "1.2.0". Returns negative if a<b,
 *  positive if a>b, 0 if equal. Treats missing parts as 0. */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export const ExtensionUpdateBanner: React.FC = () => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [outdated, setOutdated] = useState<Array<{ version: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const exts = await scenarioService.getConnectedExtensions();
      if (cancelled) return;
      // Empty version = pre-1.2.0 (before we started reporting). Treat as
      // outdated. Connected extensions only — disconnected ones aren't
      // relevant for the warning.
      const old = exts.filter(e =>
        !e.version || compareVersion(e.version, REQUIRED_EXTENSION_VERSION) < 0
      );
      setOutdated(old);
    };
    void tick();
    const h = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(h); };
  }, []);

  if (outdated.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
      <div className="font-semibold mb-1">
        ⚠️ {isZh
          ? '浏览器扩展版本过旧 — 多浏览器并行任务可能不工作'
          : 'Browser extension is outdated — multi-browser parallel tasks may not work'}
      </div>
      <div className="leading-relaxed">
        {isZh
          ? <>检测到 {outdated.length} 个浏览器还在用旧扩展（{outdated.map(o => o.version || '< 1.2.0').join(', ')}）。
            <strong> 请更新到 v{REQUIRED_EXTENSION_VERSION}+</strong>：</>
          : <>{outdated.length} browser(s) on outdated extension ({outdated.map(o => o.version || '< 1.2.0').join(', ')}).
            <strong> Update to v{REQUIRED_EXTENSION_VERSION}+</strong>:</>}
      </div>
      <ul className="list-disc list-inside mt-1 space-y-0.5">
        <li>{isZh
          ? <>商店版：访问 <code className="px-1 py-0.5 rounded bg-amber-500/20">chrome://extensions</code> 找到 NoobClaw → 重新加载（等商店推送 v1.2.0+）</>
          : <>Store install: open <code className="px-1 py-0.5 rounded bg-amber-500/20">chrome://extensions</code>, find NoobClaw, hit reload (waits for store push of v1.2.0+).</>}
        </li>
        <li>{isZh
          ? <>开发者模式：卸载商店版 → 加载 NoobClaw 安装目录下的 <code className="px-1 py-0.5 rounded bg-amber-500/20">chrome-extension/</code> 文件夹（立即拿到最新）</>
          : <>Dev mode: uninstall store version, "Load unpacked" → pick NoobClaw's bundled <code className="px-1 py-0.5 rounded bg-amber-500/20">chrome-extension/</code> folder (instant).</>}
        </li>
      </ul>
    </div>
  );
};
