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
                if (!cancelled) setSuggestions(Array.isArray(persisted) ? persisted : []);
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
                            <div className="text-[11px] italic text-white/50 mb-1.5 break-words">
                                <span className="text-white/40 not-italic font-medium">Triggered by: </span>
                                {s.question}
                            </div>
                        )}
                        <div className="whitespace-pre-wrap break-words">{s.text}</div>
                        {s.citations && s.citations.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                                {s.citations.map((c: any, i: number) => (
                                    <span
                                        key={i}
                                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-white/5 border border-white/10 text-white/60"
                                    >
                                        {c.title ?? `Source ${i + 1}`}
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
