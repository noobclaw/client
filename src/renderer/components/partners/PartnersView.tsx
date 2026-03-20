import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';

interface Partner {
  id: string;
  name: string;
  logo_url: string;
  banner_url: string;
  description: string;
  link: string;
}

interface PartnersViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
}

const PartnersView: React.FC<PartnersViewProps> = ({ isSidebarCollapsed: _isSidebarCollapsed, onToggleSidebar: _onToggleSidebar, onNewChat: _onNewChat, updateBadge: _updateBadge }) => {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const baseUrl = getBackendApiUrl();
    fetch(`${baseUrl}/api/partners`)
      .then(r => r.json())
      .then(data => { setPartners(data.partners || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm dark:text-claude-darkTextSecondary">{i18nService.t('partnersLoading')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6">
      <h2 className="text-xl font-bold dark:text-claude-darkText text-claude-text mb-6">
        {i18nService.t('partnersTitle')}
      </h2>
      {partners.length === 0 ? (
        <div className="text-sm dark:text-claude-darkTextSecondary text-center py-12">
          {i18nService.t('partnersEmpty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {partners.map(p => (
            <div
              key={p.id}
              className="group relative rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all cursor-pointer"
              onClick={() => p.link && window.electron?.shell?.openExternal(p.link)}
            >
              {/* 16:9 banner as full card background */}
              <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                {p.banner_url ? (
                  <img src={p.banner_url} alt={p.name} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-gray-700 to-gray-900" />
                )}
                {/* Gradient overlay at bottom for text readability */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                {/* Content overlay */}
                <div className="absolute bottom-0 left-0 right-0 p-4">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    {p.logo_url && (
                      <img src={p.logo_url} alt={p.name} className="w-8 h-8 rounded-full object-cover border border-white/20" />
                    )}
                    <h3 className="font-semibold text-white text-sm">{p.name}</h3>
                  </div>
                  {p.description && (
                    <p className="text-xs text-white/70 line-clamp-2">{p.description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PartnersView;
