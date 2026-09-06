// src/components/MeetingSuggestions.tsx
// Phase P: Suggestions tab content for the meeting detail view. Shows every
// chat-bubble suggestion the AI made during the meeting, each with the
// transcript question that triggered it.
//
// Style matches the live panel's chat-bubble look (left-border indigo,
// plain text, no card chrome). Each bubble shows the question in italic
// gray above or below the suggestion text.

import React, { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface PersistedSuggestion {
    suggestionId: string;
    text: string;
    citations: any[];
    source: 'live' | 'mock' | 'manual';
    firedAt: number;
    question?: string;
}

export const MeetingSuggestions: React.FC<{ meetingId: string }> = ({ meetingId }) => {
    const [suggestions, setSuggestions] = useState<PersistedSuggestion[] | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const api: any = (window as any).electronAPI;
                const persisted = api?.chatGetSuggestions
                    ? await api.chatGetSuggestions(meetingId)
                    : [];
                const raw = Array.isArray(persisted) ? persisted : [];
                // Self-heal: filter out any intermediate token fragments that are prefixes of a longer entry
                const deduplicated = raw.filter((s, idx, arr) => {
                    const text = (s.text || '').trim();
                    if (text.length < 10) return false;
                    const hasFullerDuplicate = arr.some((other, oIdx) =>
                        oIdx !== idx &&
                        other.text &&
                        other.text.length > text.length &&
                        (other.text.startsWith(text) || other.text.includes(text))
                    );
                    return !hasFullerDuplicate;
                });
                if (!cancelled) setSuggestions(deduplicated);
            } catch {
                if (!cancelled) setSuggestions([]);
            }
        })();
        return () => { cancelled = true; };
    }, [meetingId]);

    if (suggestions === null) {
        return <div className="text-text-tertiary text-sm py-8 text-center">Loading suggestions…</div>;
    }

    if (suggestions.length === 0) {
        return (
            <div className="text-text-tertiary text-sm py-8 text-center">
                No suggestions were made during this meeting.
            </div>
        );
    }

    const sorted = [...suggestions].sort((a, b) => a.firedAt - b.firedAt);

    return (
        <div className="space-y-3 pb-10">
            {sorted.map((s) => {
                const isCopied = copiedId === s.suggestionId;
                return (
                    <div
                        key={s.suggestionId}
                        className="group relative pl-3 pr-9 py-2.5 rounded-lg border-l-2 border-indigo-500/60 bg-white/[0.02] text-[13px] text-white/90 leading-relaxed hover:bg-white/[0.04] transition-colors"
                    >
                        {s.question && (
                            <div className="text-[11px] text-indigo-400/90 font-medium mb-1.5 flex items-center gap-1.5 break-words">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                                <span>Triggered by: &ldquo;{s.question}&rdquo;</span>
                            </div>
                        )}
                        <div className="whitespace-pre-wrap break-words">{s.text}</div>
                        {s.citations && s.citations.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-white/[0.06] flex flex-wrap gap-1.5 items-center">
                                <span className="text-[11px] text-white/40 font-medium mr-1">Sources:</span>
                                {s.citations.map((c: any, i: number) => (
                                    <span
                                        key={i}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/10 border border-indigo-500/20 text-indigo-300"
                                        title={c.snippet || c.title}
                                    >
                                        <span>{c.title ?? `Source ${i + 1}`}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white/10 text-white/60 hover:text-white"
                            title="Copy to clipboard"
                            onClick={() => {
                                try {
                                    navigator.clipboard?.writeText(s.text);
                                    setCopiedId(s.suggestionId);
                                    setTimeout(() => {
                                        setCopiedId((cur) => (cur === s.suggestionId ? null : cur));
                                    }, 1500);
                                } catch { /* ignore */ }
                            }}
                        >
                            {isCopied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

export default MeetingSuggestions;
