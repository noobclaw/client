import React, { useState, useEffect, useRef } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';

interface TickerItem {
  symbol: string;
  price: number;
  change: number;
}

interface Announcement {
  id: string;
  content_zh: string;
  content_en: string;
  link: string;
}

const coinMeta: Record<string, { logo: string; url: string }> = {
  BTC:  { logo: 'https://cryptologos.cc/logos/bitcoin-btc-logo.svg',       url: 'https://www.binance.com/trade/BTC_USDT' },
  ETH:  { logo: 'https://cryptologos.cc/logos/ethereum-eth-logo.svg',      url: 'https://www.binance.com/trade/ETH_USDT' },
  BNB:  { logo: 'https://cryptologos.cc/logos/bnb-bnb-logo.svg',           url: 'https://www.binance.com/trade/BNB_USDT' },
  SOL:  { logo: 'https://cryptologos.cc/logos/solana-sol-logo.svg',         url: 'https://www.binance.com/trade/SOL_USDT' },
  XRP:  { logo: 'https://cryptologos.cc/logos/xrp-xrp-logo.svg',           url: 'https://www.binance.com/trade/XRP_USDT' },
  DOGE: { logo: 'https://cryptologos.cc/logos/dogecoin-doge-logo.svg',      url: 'https://www.binance.com/trade/DOGE_USDT' },
  ADA:  { logo: 'https://cryptologos.cc/logos/cardano-ada-logo.svg',        url: 'https://www.binance.com/trade/ADA_USDT' },
  AVAX: { logo: 'https://cryptologos.cc/logos/avalanche-avax-logo.svg',     url: 'https://www.binance.com/trade/AVAX_USDT' },
  DOT:  { logo: 'https://cryptologos.cc/logos/polkadot-new-dot-logo.svg',   url: 'https://www.binance.com/trade/DOT_USDT' },
  TRX:  { logo: 'https://cryptologos.cc/logos/tron-trx-logo.svg',           url: 'https://www.binance.com/trade/TRX_USDT' },
};

// Module-level cache so data persists across component mounts
let _cachedTickers: TickerItem[] = [];
let _cachedAnnouncements: Announcement[] = [];
let _fetchTimer: ReturnType<typeof setInterval> | null = null;

function getTickerBaseUrl(): string {
  return getBackendApiUrl();
}

async function fetchTickerData(): Promise<TickerItem[]> {
  try {
    const resp = await fetch(`${getTickerBaseUrl()}/api/ticker`);
    if (resp.ok) {
      const data = await resp.json();
      _cachedTickers = data;
      return data;
    }
  } catch { /* ignore */ }
  return _cachedTickers;
}

async function fetchAnnouncements(): Promise<Announcement[]> {
  try {
    const resp = await fetch(`${getBackendApiUrl()}/api/announcements`);
    if (resp.ok) {
      const data = await resp.json();
      _cachedAnnouncements = data.announcements || [];
      return _cachedAnnouncements;
    }
  } catch { /* ignore */ }
  return _cachedAnnouncements;
}

// Start global polling (only once)
function ensurePolling() {
  if (_fetchTimer) return;
  fetchTickerData();
  fetchAnnouncements();
  _fetchTimer = setInterval(fetchTickerData, 30000);
  setInterval(fetchAnnouncements, 60000);
}

const TickerMarquee: React.FC = () => {
  const [tickers, setTickers] = useState<TickerItem[]>(_cachedTickers);
  const [announcements, setAnnouncements] = useState<Announcement[]>(_cachedAnnouncements);
  const [announcementDismissed, setAnnouncementDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensurePolling();
    if (_cachedTickers.length > 0) setTickers(_cachedTickers);
    if (_cachedAnnouncements.length > 0) setAnnouncements(_cachedAnnouncements);
    fetchTickerData().then(setTickers);
    fetchAnnouncements().then(setAnnouncements);
    const interval = setInterval(() => {
      setTickers([..._cachedTickers]);
      setAnnouncements([..._cachedAnnouncements]);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const openLink = (url: string) => {
    try {
      window.electron?.shell?.openExternal(url);
    } catch { /* ignore */ }
  };

  // If there are active announcements and not dismissed, show them with close button
  if (announcements.length > 0 && !announcementDismissed) {
    return (
      <div className="ticker-marquee-wrapper non-draggable w-full overflow-hidden border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-claude-surface/30 shrink-0" style={{ height: 36, position: 'relative', zIndex: 1 }}>
        <div
          ref={containerRef}
          className="ticker-scroll whitespace-nowrap flex items-center h-full"
          style={{ animation: `ticker-scroll ${Math.max(20, announcements.length * 15)}s linear infinite`, paddingRight: 36 }}
        >
          {[0, 1].map((i) => (
            <span key={i} className="inline-block px-4">
              {announcements.map((a, idx) => (
                <button
                  type="button"
                  key={`${i}-${idx}`}
                  className="non-draggable inline-flex items-center mx-6 cursor-pointer hover:opacity-80 bg-transparent border-none p-0"
                  onClick={(e) => { e.stopPropagation(); if (a.link) openLink(a.link); }}
                >
                  <span className="text-sm font-medium text-yellow-500 mr-2">📢</span>
                  <span className="text-sm dark:text-claude-darkText text-claude-text">
                    {(() => { const currentLang = i18nService.getLanguage(); return (currentLang === 'zh' || currentLang === 'zh-TW') ? a.content_zh : a.content_en; })()}
                  </span>
                  {a.link && <span className="text-xs text-primary ml-2">→</span>}
                </button>
              ))}
            </span>
          ))}
        </div>
        {/* Close button */}
        <button
          type="button"
          className="non-draggable absolute right-0 top-0 h-full w-9 flex items-center justify-center dark:bg-claude-darkSurface/80 bg-claude-surface/80 backdrop-blur-sm border-l dark:border-claude-darkBorder border-claude-border hover:text-red-400 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
          onClick={(e) => { e.stopPropagation(); setAnnouncementDismissed(true); }}
          title={i18nService.t('tickerDismiss')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <style>{`
          @keyframes ticker-scroll {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
          }
          .ticker-marquee-wrapper:hover .ticker-scroll {
            animation-play-state: paused;
          }
        `}</style>
      </div>
    );
  }

  // Default: show crypto tickers
  if (tickers.length === 0) return null;

  const renderItem = (t: TickerItem, idx: number) => {
    const meta = coinMeta[t.symbol];
    const color = t.change >= 0 ? '#22c55e' : '#ef4444';
    const arrow = t.change >= 0 ? '\u25B2' : '\u25BC';
    return (
      <button
        type="button"
        key={idx}
        className="non-draggable inline-flex items-center mx-4 cursor-pointer hover:opacity-80 bg-transparent border-none p-0"
        onClick={(e) => { e.stopPropagation(); if (meta) openLink(meta.url); }}
        title={`${t.symbol}/USDT on Binance`}
      >
        {meta && <img src={(window as any).__TAURI__ ? `http://127.0.0.1:18800/api/img?url=${encodeURIComponent(meta.logo)}` : meta.logo} alt={t.symbol} className="w-5 h-5 mr-1.5" />}
        <span className="text-sm dark:text-claude-darkText text-claude-text font-semibold">{t.symbol}</span>
        <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary ml-1.5">
          ${t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span className="text-sm font-medium ml-1.5" style={{ color }}>{arrow}{Math.abs(t.change).toFixed(2)}%</span>
      </button>
    );
  };

  return (
    <div className="ticker-marquee-wrapper non-draggable w-full overflow-hidden border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-claude-surface/30 shrink-0" style={{ height: 36, position: 'relative', zIndex: 1 }}>
      <div
        ref={containerRef}
        className="ticker-scroll whitespace-nowrap flex items-center h-full"
        style={{ animation: 'ticker-scroll 40s linear infinite' }}
      >
        {[0, 1].map((i) => (
          <span key={i} className="inline-block px-4">
            {tickers.map(renderItem)}
          </span>
        ))}
      </div>
      <style>{`
        @keyframes ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ticker-marquee-wrapper:hover .ticker-scroll {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
};

export default TickerMarquee;
