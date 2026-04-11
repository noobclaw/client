/**
 * Token usage panel — compact daily / weekly / monthly token totals
 * plus a 14-day bar histogram. Reads from `window.electron.cowork`:
 *
 *   - getCostSummary('today' | 'week' | 'month')
 *   - getCostHistogramDaily(14)
 *
 * Both are backed by the SQLite `cost_records` table populated in the
 * coworkRunner's `usage` event handler. This is raw token counts only
 * (no dollar/currency conversion) — NoobClaw's token economy is
 * opaque to the client, this is just "how much are we burning".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

interface CostBucket {
  dayStart: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turnCount: number;
}

interface CostSummary {
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const TokenUsagePanel: React.FC = () => {
  const [todaySummary, setTodaySummary] = useState<CostSummary | null>(null);
  const [weekSummary, setWeekSummary] = useState<CostSummary | null>(null);
  const [monthSummary, setMonthSummary] = useState<CostSummary | null>(null);
  const [buckets, setBuckets] = useState<CostBucket[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const anyCowork = (window.electron as unknown as {
        cowork: {
          getCostSummary?: (range: 'today' | 'week' | 'month' | 'all') => Promise<{ success: boolean; summary?: CostSummary }>;
          getCostHistogramDaily?: (days?: number) => Promise<{ success: boolean; buckets?: CostBucket[] }>;
        };
      }).cowork;
      if (typeof anyCowork?.getCostSummary !== 'function') {
        setLoading(false);
        return;
      }
      const [t, w, m, h] = await Promise.all([
        anyCowork.getCostSummary!('today'),
        anyCowork.getCostSummary!('week'),
        anyCowork.getCostSummary!('month'),
        anyCowork.getCostHistogramDaily?.(14),
      ]);
      if (t?.success && t.summary) setTodaySummary(t.summary);
      if (w?.success && w.summary) setWeekSummary(w.summary);
      if (m?.success && m.summary) setMonthSummary(m.summary);
      if (h?.success && h.buckets) setBuckets(h.buckets);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const maxBucketTotal = useMemo(() => {
    if (!buckets || buckets.length === 0) return 1;
    return Math.max(
      1,
      ...buckets.map((b) => b.inputTokens + b.outputTokens),
    );
  }, [buckets]);

  if (loading && !todaySummary) {
    return null; // quiet first-load; fall back to invisible
  }

  const renderCell = (label: string, summary: CostSummary | null) => {
    const total =
      (summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0);
    return (
      <div className="flex-1 min-w-0">
        <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wide">
          {label}
        </p>
        <p className="text-lg font-semibold tabular-nums dark:text-claude-darkText text-claude-text">
          {formatTokenCount(total)}
        </p>
        {summary && summary.turnCount > 0 && (
          <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {summary.turnCount} {i18nService.t('walletUsageTurns') || 'turns'}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('walletUsageTitle') || 'Token 消耗'}
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent"
        >
          {i18nService.t('walletUsageRefresh') || 'Refresh'}
        </button>
      </div>

      <div className="flex items-stretch gap-4 mb-4">
        {renderCell(i18nService.t('walletUsageToday') || 'Today', todaySummary)}
        <div className="w-px bg-claude-border dark:bg-claude-darkBorder" />
        {renderCell(i18nService.t('walletUsageWeek') || 'Week', weekSummary)}
        <div className="w-px bg-claude-border dark:bg-claude-darkBorder" />
        {renderCell(i18nService.t('walletUsageMonth') || 'Month', monthSummary)}
      </div>

      {buckets && buckets.length > 0 && (
        <div>
          <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1.5 uppercase tracking-wide">
            {i18nService.t('walletUsage14Days') || 'Last 14 days'}
          </p>
          <div className="flex items-end gap-[2px] h-16">
            {buckets.map((b) => {
              const total = b.inputTokens + b.outputTokens;
              const heightPct = Math.max(2, (total / maxBucketTotal) * 100);
              return (
                <div
                  key={b.dayStart}
                  className="flex-1 bg-claude-accent/25 hover:bg-claude-accent/50 rounded-sm transition-colors"
                  style={{ height: `${heightPct}%` }}
                  title={`${new Date(b.dayStart).toLocaleDateString()}\n↓ ${formatTokenCount(b.inputTokens)}\n↑ ${formatTokenCount(b.outputTokens)}\n${b.turnCount} turns`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default TokenUsagePanel;
