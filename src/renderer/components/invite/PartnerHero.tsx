// PartnerHero — 尊贵版邀请页顶部 banner,只在 profile.partner.is_partner=true 时渲染。
//
// Design:
//   - 黑底 + 香槟金 (#facc15) + 玫瑰金渐变,自带 4s shimmer 光带
//   - 大字突出"L1 返佣 N%" + 等级勋章 + "您是普通用户的 X 倍"对比
//   - 数字滚动入场(react-countup 没装,自己用 requestAnimationFrame 写一个轻量版)
//
// Props 来源:GET /api/me/profile.partner block(step 6 后端已下发)。
// 普通用户拿到 profile.partner === null,父组件直接不渲染 PartnerHero。

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';

interface PartnerInfo {
  is_partner: boolean;
  rate_pct: number;
  tier: string | null;
  l1_share_pct: number;        // pool_pct × 50%
  default_pool_pct: number;    // system default,通常 10
  granted_at: string | null;
}

interface PartnerHeroProps {
  partner: PartnerInfo;
}

// 完整每档主题色:每档独立的渐变背景 / shimmer 颜色 / 描边 / 阴影
// 不再是"全部金色 + 文字颜色微调",而是整张 banner 完全换色调,炫酷感
// bronze 暖铜  silver 冷银  gold 暖金  diamond 冰蓝
interface TierTheme {
  emoji: string;
  label: string;
  color: string;          // 主色
  bgGrad: string;         // 整张背景渐变
  shimmerColor: string;   // 光带扫过颜色
}
const TIER_VISUAL: Record<string, TierTheme> = {
  bronze: {
    emoji: '🥉', label: 'Bronze', color: '#cd7f32',
    bgGrad: 'linear-gradient(135deg, #1a0e07 0%, #2d1a09 50%, #1a0e07 100%)',
    shimmerColor: 'rgba(205, 127, 50, 0.18)',
  },
  silver: {
    emoji: '🥈', label: 'Silver', color: '#c8c8c8',
    bgGrad: 'linear-gradient(135deg, #0e0e10 0%, #1c1e22 50%, #0e0e10 100%)',
    shimmerColor: 'rgba(200, 200, 200, 0.20)',
  },
  gold: {
    emoji: '👑', label: 'Gold', color: '#facc15',
    bgGrad: 'linear-gradient(135deg, #1a1208 0%, #2d2208 50%, #1a1208 100%)',
    shimmerColor: 'rgba(250, 204, 21, 0.18)',
  },
  diamond: {
    emoji: '💎', label: 'Diamond', color: '#b9f2ff',
    bgGrad: 'linear-gradient(135deg, #08151a 0%, #0e2530 50%, #08151a 100%)',
    shimmerColor: 'rgba(185, 242, 255, 0.22)',
  },
};
const DEFAULT_VISUAL: TierTheme = TIER_VISUAL.gold;

// 轻量数字滚动 — 600ms ease-out,从 0 到 target。
function useCountUp(target: number, durationMs = 600): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);  // ease-out cubic
      setVal(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

export const PartnerHero: React.FC<PartnerHeroProps> = ({ partner }) => {
  const visual = (partner.tier && TIER_VISUAL[partner.tier]) || DEFAULT_VISUAL;
  // Display rate_pct (admin-set pool size) as the headline number, not the
  // derived L1 share. Admin sets "30%" → user sees "30%"; the internal
  // 50/10/10/10/10/10 split is a hidden detail. Multiplier compares total
  // pool vs system default pool (e.g. 30 / 10 = 3x).
  const multiplier = partner.default_pool_pct > 0 ? partner.rate_pct / partner.default_pool_pct : 0;

  const animatedRate = useCountUp(partner.rate_pct);
  const animatedMult = useCountUp(multiplier);

  return (
    <div
      className="relative overflow-hidden rounded-2xl mb-3 px-5 py-4 border"
      style={{
        background: visual.bgGrad,
        borderColor: visual.color + '60',
        boxShadow: `0 0 24px ${visual.color}25, inset 0 0 14px ${visual.color}10`,
      }}
    >
      {/* shimmer 光带 — 颜色跟着等级走 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${visual.shimmerColor} 50%, transparent 100%)`,
          animation: 'partner-hero-shimmer 4s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes partner-hero-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>

      <div className="relative z-10 flex items-center gap-4 flex-wrap">
        {/* 等级勋章 */}
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 32, lineHeight: 1 }}>{visual.emoji}</span>
          <div>
            <div className="text-[10px] tracking-wider font-semibold uppercase" style={{ color: visual.color }}>
              {i18nService.t('partnerBannerTitle') || 'Partner'}
            </div>
            <div className="text-sm font-bold text-white">{visual.label}</div>
          </div>
        </div>

        <div className="h-10 w-px" style={{ background: visual.color + '40' }} />

        {/* 返佣总比例(大字 + 滚动) */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: visual.color + 'cc' }}>
            {i18nService.t('partnerRebateRate') || '您的返佣比例'}
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="font-bold tabular-nums"
              style={{
                fontSize: 32,
                lineHeight: 1.1,
                color: visual.color,
                textShadow: `0 0 12px ${visual.color}40`,
                letterSpacing: '0.5px',
              }}
            >
              {animatedRate.toFixed(1)}%
            </span>
            {multiplier >= 1.1 && (
              <span className="text-xs font-medium" style={{ color: visual.color + 'cc' }}>
                ({i18nService.t('partnerVsRegular') || 'vs 普通用户'} {partner.default_pool_pct.toFixed(0)}% · {animatedMult.toFixed(1)}x)
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PartnerHero;
