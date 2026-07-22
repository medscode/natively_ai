// src/components/settings/WebSearchSettings.tsx
// Meeting Copilot PRD Phase 4: per-session Web Search on/off toggle.
//
// Off by default. When off, no code path in the assistant may reach the web.
// When on, the assistant may trigger a web search on its own judgment whenever
// retrieval confidence is low. Citations are mandatory and visually distinct
// from KB-sourced content.

import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { Globe, Info, ShieldAlert } from 'lucide-react';

export function WebSearchSettings() {
  const t = useT();
  const isLight = useResolvedTheme() === 'light';
  const [enabled, setEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI?.getWebSearchEnabled?.();
        if (!cancelled) {
          setEnabled(result?.enabled === true);
          setError(result?.error ?? null);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'failed to load');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = async (next: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.setWebSearchEnabled?.(next);
      if (result?.success) {
        setEnabled(next);
      } else {
        setError(result?.error ?? 'failed to save');
      }
    } catch (err: any) {
      setError(err?.message ?? 'failed to save');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5 animated fadeIn select-text pb-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-bold text-text-primary mb-1">{t('Web Search')}</h3>
          <p className="text-xs text-text-secondary">
            {t('Allow the assistant to search the web when the knowledge base lacks an answer.')}
          </p>
        </div>
      </div>

      <div className="grid gap-4">
        <div
          className={`rounded-xl border p-4 flex items-start justify-between gap-4 ${
            isLight ? 'bg-white border-gray-200' : 'bg-bg-subtle/30 border-border-subtle'
          }`}
        >
          <div className="flex items-start gap-3 flex-1">
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                enabled
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-text-tertiary/10 text-text-tertiary'
              }`}
            >
              <Globe size={18} />
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-text-primary mb-0.5">
                {t('Web search for this meeting')}
              </div>
              <div className="text-xs text-text-secondary">
                {enabled
                  ? t(
                      'The assistant may search the web when retrieval confidence is low. Every web-sourced claim is cited and visually distinct from KB content.',
                    )
                  : t('No web requests will be made. KB and live transcript only.')}
              </div>
              {error && (
                <div className="text-xs text-red-500 mt-1">{error}</div>
              )}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('Web search')}
            disabled={loading}
            onClick={() => handleToggle(!enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-primary/40 shrink-0 disabled:opacity-60 ${
              enabled ? 'bg-emerald-500' : 'bg-text-tertiary/40'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div
          className={`rounded-xl border p-4 flex items-start gap-3 ${
            isLight ? 'bg-blue-50 border-blue-100' : 'bg-blue-500/5 border-blue-500/20'
          }`}
        >
          <Info size={16} className="text-blue-500 mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary leading-relaxed">
            {t(
              'Toggle on once per session — the assistant does not ask permission for each individual search. Citations are mandatory; primary sources are preferred.',
            )}
          </div>
        </div>

        <div
          className={`rounded-xl border p-4 flex items-start gap-3 ${
            isLight ? 'bg-amber-50 border-amber-100' : 'bg-amber-500/5 border-amber-500/20'
          }`}
        >
          <ShieldAlert size={16} className="text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary leading-relaxed">
            {t(
              'Web-sourced content never overrides your uploaded documents. If there is a conflict, the assistant will flag it rather than silently resolving it.',
            )}
          </div>
        </div>
      </div>
    </div>
  );
}