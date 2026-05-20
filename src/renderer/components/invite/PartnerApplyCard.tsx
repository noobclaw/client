// PartnerApplyCard — 邀请返佣页"非合伙人"普通邀请人的入口卡片。
//
// 跟 PartnerHero 是互斥关系:
//   profile.partner.is_partner === true  → 渲染 PartnerHero(尊贵金色 banner)
//   profile.partner.is_partner !== true  → 渲染本组件
//
// 内容刻意简单 — 一行展示当前返佣比例(系统默认 10%),一行 CTA 引导申请合伙人。
// 点击 CTA → 走 Electron/Tauri opener 打开外部浏览器到官网申请页(不在客户端内
// iframe / webview 跑表单,跟现有 InviteView 的"打开外部"链接行为一致)。
//
// i18n:走 i18nService 自动 fallback,只要在 zh/en 加 partnerApplyTitle /
// partnerApplyHint / partnerApplyCta 三个 key 即可。

import React from 'react';
import { i18nService } from '../../services/i18n';
import { getWebsiteUrl } from '../../services/endpoints';

const PartnerApplyCard: React.FC = () => {
  // 默认返佣比例 10% — 跟 InviteView 其它地方的硬编码 default 保持一致;
  // 真改值时一起搜 "10%" 改。Backend 那边 system_config.rebate_pool_pct 是
  // 真值,这里只是展示卡片不参与实际计算。
  const defaultRate = 10;

  const handleApply = () => {
    // 走外部浏览器,URL 用干净的 /partner-apply 路径(website 那边是一个 thin
    // redirect html,会 location.replace 到 #page-partner-apply SPA 路由)。
    // 这样地址栏第一眼看到的是 /partner-apply,不是 /#page-partner-apply,
    // 也方便外部分享 / SEO meta(redirect 设了 noindex)。SPA 仍然负责页面
    // chrome / auth / 语言系统。
    const url = `${getWebsiteUrl()}/partner-apply.html`;
    try {
      window.electron?.shell?.openExternal?.(url);
    } catch {
      // ignore — shell.openExternal 失败基本是 macOS sandbox / Linux 缺 xdg-open,
      // 此时用户最多没动作,不会 crash。
    }
  };

  return (
    <div
      className="mb-3 p-4 rounded-xl border"
      style={{
        background: 'linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(20,184,166,0.08) 100%)',
        borderColor: 'rgba(34,197,94,0.3)',
      }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
            {i18nService.t('partnerApplyTitle')}
          </div>
          <div className="text-2xl font-bold" style={{ color: '#22c55e' }}>
            {defaultRate}%
            <span className="text-xs font-normal ml-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('partnerApplyRateHint')}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleApply}
          className="px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-opacity hover:opacity-90"
          style={{
            background: 'linear-gradient(135deg, #22c55e 0%, #14b8a6 100%)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(34,197,94,0.25)',
          }}
        >
          {i18nService.t('partnerApplyCta')}
        </button>
      </div>
    </div>
  );
};

export default PartnerApplyCard;
