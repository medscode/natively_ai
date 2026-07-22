// src/components/settings/SuggestModeSettings.tsx
// Meeting Copilot PRD Phase 2: per-session Suggest Mode on/off toggle.
//
// Suggest Mode controls whether the assistant surfaces proactive suggestions
// in real time as the meeting progresses. When OFF, no proactive suggestions
// appear — only the chat panel is available. This is the explicit escape hatch
// for users who find constant recommendations distracting.
//
// State is persisted via the main process SettingsManager (`chatMode` key)
// through the new IPCs `chat:set-mode` / `chat:get-mode`. A localStorage
// mirror is kept for instant UI feedback while the IPC resolves.

import React, { useEffect, useState, useCallback } from 'react';
import { useT } from '../../i18n';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { Sparkles, MessageSquare, Info } from 'lucide-react';

const LS_KEY = 'suggestModeEnabled';

function readLS(): boolean | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return null;
    return raw === '1' || raw === 'true';
  } catch {
    return null;
  }
}

function writeLS(value: boolean): void {
  try { localStorage.setItem(LS_KEY, value ? '1' : '0'); } catch { /* noop */ }
}

export function SuggestModeSettings() {
  const t = useT();
  const isLight = useResolvedTheme() === 'light';
  const [enabled, setEnabled] = useState<boolean>(() => readLS() ?? true);
  const [hydrated, setHydrated] = useState(false);

  // Sync from main process on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await (window as any).electronAPI?.chatGetMode?.();
        if (!cancelled && r && (r.mode === 'manual' || r.mode === 'suggest')) {
          const next = r.mode === 'suggest';
          setEnabled(next);
          writeLS(next);
        }
      } catch { /* ignore */ }
      if (!cancelled) setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Push to main on change (after hydration to avoid clobbering with localStorage default)
  useEffect(() => {
    if (!hydrated) return;
    writeLS(enabled);
    void (window as any).electronAPI?.chatSetMode?.(enabled ? 'suggest' : 'manual').catch(() => {});
  }, [enabled, hydrated]);

  const handleToggle = useCallback(() => setEnabled((v) => !v), []);

  return (
    <div className="space-y-5 animated fadeIn select-text pb-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-bold text-text-primary mb-1">{t('Suggest Mode (live transcript)')}</h3>
          <p className="text-xs text-text-secondary">
            {t('Control whether the assistant proactively surfaces suggestions during meetings.')}
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
                  ? 'bg-accent-primary/15 text-accent-primary'
                  : 'bg-text-tertiary/10 text-text-tertiary'
              }`}
            >
              <Sparkles size={18} />
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-text-primary mb-0.5">
                {t('Suggest Mode')}
              </div>
              <div className="text-xs text-text-secondary">
                {enabled
                  ? t(
                      'Suggestions appear in real time, rate-limited and timed to natural pauses. The rolling state stays current even when you toggle off — flipping back on is instant.',
                    )
                  : t(
                      'No proactive suggestions will appear. You can still type questions in the chat panel.',
                    )}
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('Suggest Mode')}
            onClick={handleToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-primary/40 shrink-0 ${
              enabled ? 'bg-accent-primary' : 'bg-text-tertiary/40'
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
              'Suggest Mode runs as a background process that maintains an incrementally updated view of the meeting. Toggling it off stops surfacing suggestions without losing state — turning it back on is instant and does not trigger a catch-up pass.',
            )}
          </div>
        </div>

        <div
          className={`rounded-xl border p-4 flex items-start gap-3 ${
            isLight ? 'bg-emerald-50 border-emerald-100' : 'bg-emerald-500/5 border-emerald-500/20'
          }`}
        >
          <MessageSquare size={16} className="text-emerald-500 mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary leading-relaxed">
            {t(
              'The chat panel is always available regardless of Suggest Mode state. Use it to type direct questions — it reuses the same retrieval and grounding logic as Suggest Mode.',
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
