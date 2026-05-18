// PartnerHero — 尊贵版邀请页顶部 banner,只在 profile.partner.is_partner=true 时渲染。
//
// v2.x "炫酷" upgrade:
//   - 黑底 + tier 色渐变 + 旋转 conic gradient 光环边框
//   - 4s shimmer 光带 + 8 个 twinkle 金粉粒子
//   - emoji 上下浮动 + drop-shadow 发光
//   - 数字 background-clip:text 渐变金属字效
//   - 右上 ✦ VIP ✦ 角标
//
// Props 来源:GET /api/me/profile.partner block(step 6 后端已下发)。
// 普通用户拿到 profile.partner === null,父组件直接不渲染 PartnerHero。

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';

interface PartnerInfo {
  is_partner: boolean;
  rate_pct: number;
  tier: string | null;
  l1_share_pct: number;
  default_pool_pct: number;
  granted_at: string | null;
}

interface PartnerHeroProps {
  partner: PartnerInfo;
}

interface TierTheme {
  emoji: string;
  label: string;
  color: string;
  bgGrad: string;
  shimmerColor: string;
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

// 颜色 helper:基于主色做 lighter / darker,用于数字三色金属渐变。
function shiftColor(hex: string, delta: number): string {
  return (
    '#' +
    (hex.slice(1).match(/.{2}/g) || []).map((c) =>
      Math.max(0, Math.min(255, parseInt(c, 16) + delta)).toString(16).padStart(2, '0'),
    ).join('')
  );
}

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

// Sparkle particles — 8 个固定位置 + 错开 delay,各自 twinkle 节奏
const SPARK_POSITIONS = [
  { top: '18%', left: '8%',  delay: '0s'   },
  { top: '60%', left: '18%', delay: '1.1s' },
  { top: '28%', left: '34%', delay: '2.3s' },
  { top: '78%', left: '42%', delay: '0.6s' },
  { top: '22%', left: '62%', delay: '1.8s' },
  { top: '68%', left: '74%', delay: '2.7s' },
  { top: '38%', left: '88%', delay: '0.4s' },
  { top: '82%', left: '92%', delay: '1.5s' },
];

export const PartnerHero: React.FC<PartnerHeroProps> = ({ partner }) => {
  const visual = (partner.tier && TIER_VISUAL[partner.tier]) || DEFAULT_VISUAL;
  const animatedRate = useCountUp(partner.rate_pct);
  const colorLight = shiftColor(visual.color, 60);
  const colorDark = shiftColor(visual.color, -60);

  return (
    <div
      className="relative overflow-hidden rounded-2xl mb-3 px-6 py-5 border"
      style={{
        background: visual.bgGrad,
        borderColor: visual.color + '60',
        boxShadow: `0 0 24px ${visual.color}25, inset 0 0 14px ${visual.color}10`,
      }}
    >
      {/* 旋转 conic gradient 光环边框 — 比静态描边更 premium */}
      <div
        className="absolute pointer-events-none"
        style={{
          inset: -2,
          borderRadius: 18,
          padding: 2,
          background: `conic-gradient(from 0deg, transparent 0%, ${visual.color} 20%, transparent 40%, transparent 60%, ${visual.color} 80%, transparent 100%)`,
          WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          animation: 'partner-conic 6s linear infinite',
          opacity: 0.55,
        }}
      />

      {/* shimmer 光带 — 颜色跟 tier 走 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${visual.shimmerColor} 50%, transparent 100%)`,
          animation: 'partner-hero-shimmer 4s ease-in-out infinite',
        }}
      />

      {/* 金粉粒子 — 8 个 */}
      {SPARK_POSITIONS.map((p, i) => (
        <span
          key={i}
          className="absolute pointer-events-none"
          style={{
            top: p.top,
            left: p.left,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${visual.color} 0%, transparent 70%)`,
            animation: `partner-spark-twinkle 3s ease-in-out infinite`,
            animationDelay: p.delay,
          }}
        />
      ))}

      {/* 右上 VIP 角标 */}
      <div
        className="absolute font-bold"
        style={{
          top: 8,
          right: 14,
          fontSize: 9,
          letterSpacing: 2,
          padding: '2px 8px',
          borderRadius: 10,
          background: `linear-gradient(135deg, ${visual.color}, ${colorDark})`,
          color: '#0a0a0a',
          boxShadow: `0 0 8px ${visual.color}80`,
        }}
      >
        ✦ VIP ✦
      </div>

      <style>{`
        @keyframes partner-hero-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes partner-conic {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes partner-spark-twinkle {
          0%, 100% { opacity: 0; transform: scale(0.4); }
          50%      { opacity: 1; transform: scale(1.2); }
        }
        @keyframes partner-emoji-float {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          50%      { transform: translateY(-3px) rotate(2deg); }
        }
      `}</style>

      <div className="relative z-10 flex items-center gap-4 flex-wrap">
        {/* 等级勋章 + 浮动 */}
        <div className="flex items-center gap-3">
          <span
            style={{
              fontSize: 42,
              lineHeight: 1,
              display: 'inline-block',
              animation: 'partner-emoji-float 3.5s ease-in-out infinite',
              filter: `drop-shadow(0 0 8px ${visual.color}60)`,
            }}
          >
            {visual.emoji}
          </span>
          <div>
            <div
              className="text-[10px] font-semibold uppercase"
              style={{ color: visual.color, letterSpacing: 3 }}
            >
              {i18nService.t('partnerBannerTitle') || 'Partner'}
            </div>
            <div className="text-base font-bold text-white tracking-wider">
              {visual.label}
            </div>
          </div>
        </div>

        <div
          className="h-12 w-px"
          style={{ background: `linear-gradient(180deg, transparent, ${visual.color}80, transparent)` }}
        />

        {/* 返佣总比例 — 金属渐变文本填充 */}
        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] uppercase font-semibold"
            style={{ color: visual.color + 'cc', letterSpacing: 2 }}
          >
            {i18nService.t('partnerRebateRate') || '您的返佣比例'}
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="font-bold tabular-nums"
              style={{
                fontSize: 42,
                lineHeight: 1.05,
                letterSpacing: 1,
                background: `linear-gradient(135deg, ${colorLight} 0%, ${visual.color} 50%, ${colorDark} 100%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                filter: `drop-shadow(0 0 8px ${visual.color}30)`,
              }}
            >
              {animatedRate.toFixed(1)}%
            </span>
            <span className="text-xs font-medium" style={{ color: visual.color + 'cc' }}>
              ({i18nService.t('partnerByDepositAmount') || '按充值金额'})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PartnerHero;
