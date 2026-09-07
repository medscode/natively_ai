// src/components/MeetingChatPanel.tsx
// Meeting Copilot chat surface (analyst/lawyer use case).
//
// Replaces the interview-coach GlobalChatOverlay. Bottom-anchored floating
// panel with: LiveKBIndicator row, ••• More popover (5 quick-action presets
// collapsed), Manual/Suggest toggle (with auto-detect fallback mock context),
// Globe web-search toggle, + action sheet (KB picker / Upload / URL /
// Persona / Web-search toggle), inline citation badges.
//
// Stream listeners + RAF batching reuse patterns from GlobalChatOverlay.tsx.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import {
    X, Copy, Check, Globe, ArrowUp, BookOpen, Sparkles, Plus,
    FileText, Link2, UserCog, MoreHorizontal, Pencil, MessageSquare,
    RefreshCw, HelpCircle, Zap, ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { genMessageId } from '../utils/messageId';
import { ClientCaseSelector } from './ClientCaseSelector';
import { SuggestModeCoordinator } from '../intelligence/SuggestModeCoordinator';

interface Citation {
    id: string;
    sourceType: string;
    title: string;
    similarity?: number;
    snippet?: string;
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    citations?: Citation[];
}

interface ActiveCase {
    clientCaseId: string | null;
    clientCaseName: string;
    clientCaseCompany: string;
}

interface MeetingChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
}

type ChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';
type Mode = 'manual' | 'suggest';

// --- Subcomponents --------------------------------------------------------

const TypingIndicator: React.FC = () => (
    <div className="flex items-center gap-1 py-4">
        <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
                <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-text-tertiary"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{
                        duration: 0.6,
                        repeat: Infinity,
                        delay: i * 0.15,
                        ease: "easeInOut"
                    }}
                />
            ))}
        </div>
    </div>
);

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-6"
    >
        <div className="bg-bg-elevated text-text-primary px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed">
            {content}
        </div>
    </motion.div>
);

const CitationBadge: React.FC<{ c: Citation }> = ({ c }) => {
    const isNeedsVerification = c.title?.includes('[Needs Verification]') || c.title?.startsWith('⚠️');
    const isAuthoritative = c.title?.startsWith('📖');
    return (
        <span
            title={c.snippet ? `${c.title}\n\nDocument Excerpt:\n${c.snippet}` : c.title}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-colors ${
                c.sourceType === 'web'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : isNeedsVerification
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                        : 'bg-indigo-500/15 text-indigo-200 border-indigo-500/40'
            }`}
        >
            {c.sourceType === 'web' ? <Globe size={11} strokeWidth={2.5} /> : <BookOpen size={11} strokeWidth={2.5} />}
            <span className="max-w-[320px] truncate">{c.title || c.sourceType}</span>
            {typeof c.similarity === 'number' && (
                <span className="opacity-60 font-mono text-[9px]">({c.similarity.toFixed(2)})</span>
            )}
        </span>
    );
};

const AssistantMessage: React.FC<{
    content: string;
    isStreaming?: boolean;
    citations?: Citation[];
}> = ({ content, isStreaming, citations }) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-start mb-6"
        >
            <div className="text-white text-[15px] leading-relaxed max-w-[85%]">
                {content}
                {citations && citations.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {citations.map((c) => <CitationBadge key={c.id} c={c} />)}
                    </div>
                )}
                {isStreaming && (
                    <motion.span
                        className="inline-block w-0.5 h-4 bg-white ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}
            </div>
            {!isStreaming && content && (
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-2 mt-3 text-[13px] text-white/50 hover:text-white/80 transition-colors"
                >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy message'}
                </button>
            )}
        </motion.div>
    );
};

// --- Main component -------------------------------------------------------

const MeetingChatPanel: React.FC<MeetingChatPanelProps> = ({
    isOpen,
    onClose,
    initialQuery = ''
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [activeCase, setActiveCase] = useState<ActiveCase>({ clientCaseId: null, clientCaseName: '', clientCaseCompany: '' });
    const [mode, setMode] = useState<Mode>('manual');
    const [webSearch, setWebSearch] = useState(false);
    const [showActions, setShowActions] = useState(false);
    // Resizable panel height (px). User drags the top handle to resize.
    const [panelHeight, setPanelHeight] = useState<number>(Math.floor(typeof window !== 'undefined' ? window.innerHeight * 0.85 : 600));
    const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);
    const [showMore, setShowMore] = useState(false);
    const [showKbPicker, setShowKbPicker] = useState(false);
    const [showPersonaPicker, setShowPersonaPicker] = useState(false);
    const [activePersona, setActivePersona] = useState('Manual');
    const [copiedSuggestionId, setCopiedSuggestionId] = useState<string | null>(null);
    // Suggestion history — each STT-final trigger appends a new entry. Inline
    // append, newest at bottom, auto-scrolls. Each entry has a stable id so
    // click-to-fill can remove just that card. Capped at MAX_SUGGESTIONS to
    // bound memory + render cost during long meetings.
    interface SuggestionItem {
        id: string;
        suggestion: string;
        citations?: Citation[];
        source: 'live' | 'mock';
        at: number;
        question?: string;
    }
    const MAX_SUGGESTIONS = 50;
    const [proactiveSuggestions, setProactiveSuggestions] = useState<SuggestionItem[]>([]);
    // Tracks the id of the suggestion currently streaming so subsequent token
    // events update the SAME entry instead of appending a new one every token.
    const [streamingId, setStreamingId] = useState<string | null>(null);
    // Manual-mode ambient slot: in Manual mode the pipeline keeps firing in
    // the background, but the streamed events are stashed here (single slot,
    // most-recent-wins) instead of being appended to proactiveSuggestions.
    // Clicking the Sparkles button promotes this slot into a visible bubble
    // so the user sees the suggestion for the most recent topic they paused
    // on. In Suggest mode this stays null (everything is visible directly).
    const [pendingSuggestion, setPendingSuggestion] = useState<SuggestionItem | null>(null);
    // Single-slot alias for places in the JSX that still expect a nullable.
    const proactiveSuggestion = streamingId
        ? proactiveSuggestions.find(s => s.id === streamingId) ?? null
        : null;
    const setProactiveSuggestion = (_value: any) => {
        // Legacy single-slot setter is a no-op now; the coordinator drives
        // setProactiveSuggestions directly. Kept so older code paths don't crash.
    };
    // Live transcript strip in the panel footer — pulls from chatGetTranscriptContext
    // (last 120s of conversation). Default ON; footer toggle hides it.
    const [liveTranscriptEnabled, setLiveTranscriptEnabled] = useState(true);
    const [liveSegments, setLiveSegments] = useState<Array<{ role: 'interviewer' | 'user' | 'assistant'; text: string; timestamp: number }>>([]);
    // Mirror of liveSegments used by intervals/effects that need the latest
    // length without depending on the array reference. Reading from a ref
    // avoids re-mounting the polling effect on every transcript update.
    const liveSegmentsRef = useRef<typeof liveSegments>(liveSegments);
    useEffect(() => { liveSegmentsRef.current = liveSegments; }, [liveSegments]);

    // Phase D / Bug D: cache the real meeting UUID from main process. Used by
    // suggestionSave so we don't fall back to the virtual 'live-meeting-current'
    // id (which gets cascade-deleted at meeting end). Clear the cache when
    // the broadcast reports meetingId=null so a stale id from a prior meeting
    // can't leak into the next session's saves.
    useEffect(() => {
        try {
            const api: any = (window as any).electronAPI;
            const unsub = api?.onMeetingStateChanged?.((state: any) => {
                if (state?.meetingId) {
                    (window as any).__currentMeetingId = state.meetingId;
                } else if (state && (state.meetingId === null || state.isActive === false)) {
                    // Meeting ended — drop the cached id so the next meeting
                    // (or a panel reopen mid-teardown) can't save under the
                    // prior meeting's id and orphan the row.
                    delete (window as any).__currentMeetingId;
                }
            });
            // Initial fetch in case we missed the event.
            api?.getCurrentMeetingId?.().then((id: string) => {
                if (id) (window as any).__currentMeetingId = id;
            }).catch(() => {});
            return () => { unsub?.(); };
        } catch { /* ignore */ }
    }, []);

    // Auto-scroll the suggestion history to the newest entry as cards stream in.
    useEffect(() => {
        if (proactiveSuggestions.length === 0) return;
        const t = setTimeout(() => {
            suggestionsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }, 60);
        return () => clearTimeout(t);
    }, [proactiveSuggestions.length, proactiveSuggestions[proactiveSuggestions.length - 1]?.suggestion]);

    // Mode-switch flush: when the user toggles Manual → Suggest, promote the
    // stashed pending suggestion (if any) into the visible bubble list so it
    // doesn't get orphaned. Suggest → Manual clears the visible list of any
    // auto-streamed bubbles (they stay in the DB either way).
    useEffect(() => {
        if (mode === 'suggest' && pendingSuggestion) {
            const revealed = pendingSuggestion;
            setPendingSuggestion(null);
            setProactiveSuggestions(prev => {
                const next = [...prev, revealed];
                if (next.length > MAX_SUGGESTIONS) next.shift();
                return next;
            });
        } else if (mode === 'manual') {
            setProactiveSuggestions([]);
            setStreamingId(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const [liveDot, setLiveDot] = useState(false);
    const streamBuffer = useStreamBuffer();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const suggestionsEndRef = useRef<HTMLDivElement>(null);
    const coordinatorRef = useRef<SuggestModeCoordinator | null>(null);
    const lastQuestionRef = useRef('');

    // Load initial state from IPC on open + subscribe to changes
    useEffect(() => {
        if (!isOpen) return;
        let active = true;

        const load = async () => {
            try {
                const [caseRes, modeRes, webRes, liveRes, transcriptRes] = await Promise.all([
                    window.electronAPI?.suggestGetActiveCase?.(),
                    window.electronAPI?.chatGetMode?.(),
                    window.electronAPI?.chatGetWebSearch?.(),
                    window.electronAPI?.chatGetLiveTranscript?.(),
                    window.electronAPI?.chatGetTranscriptContext?.(),
                ]);
                if (!active) return;
                if (caseRes?.success) {
                    setActiveCase({
                        clientCaseId: caseRes.clientCaseId,
                        clientCaseName: caseRes.clientCaseName || '',
                        clientCaseCompany: caseRes.clientCaseCompany || '',
                    });
                }
                if (modeRes?.mode) setMode(modeRes.mode as Mode);
                if (webRes && typeof webRes.enabled === 'boolean') setWebSearch(webRes.enabled);
                if (liveRes && typeof liveRes.enabled === 'boolean') setLiveTranscriptEnabled(liveRes.enabled);
                if (transcriptRes?.segments) setLiveSegments(transcriptRes.segments);
            } catch (e) {
                // non-fatal — defaults are fine
            }
        };
        void load();

        const unsubCase = window.electronAPI?.onActiveCaseChanged?.((data: { clientCaseId: string | null; name: string; company: string }) => {
            setActiveCase({
                clientCaseId: data.clientCaseId ?? null,
                clientCaseName: data.name || '',
                clientCaseCompany: data.company || '',
            });
        });

        return () => {
            active = false;
            unsubCase?.();
        };
    }, [isOpen]);

    // Lightweight polling for the live transcript strip — fires the same IPC
    // SuggestModeCoordinator uses, but only while the panel is open AND
    // live-transcript toggle is on. 4s cadence is enough for human speech;
    // (removed) SuggestionOverlay used to handle the rich per-segment updates.
    //
    // NOTE: We deliberately do NOT include `liveSegments.length` in the dep
    // array. The previous version did, which created a re-render loop: every
    // poll called setLiveSegments(r.segments), the array reference changed,
    // the effect tore down and re-mounted its intervals, and React raised
    // "Maximum update depth exceeded". The pulse-dot read uses a ref so the
    // interval sees the latest value without re-running the effect.
    useEffect(() => {
        if (!isOpen || !liveTranscriptEnabled) return;
        let active = true;
        const refresh = async () => {
            try {
                const r = await window.electronAPI?.chatGetTranscriptContext?.();
                if (active && r?.segments) setLiveSegments(r.segments);
            } catch { /* non-fatal */ }
        };
        const id = window.setInterval(refresh, 4000);
        // Refresh once immediately so the strip isn't blank for 4s on open.
        void refresh();
        // Pulse the dot while segments are fresh (any non-empty response).
        let dotTimer: number | null = null;
        const pulse = () => {
            setLiveDot(true);
            if (dotTimer) window.clearTimeout(dotTimer);
            dotTimer = window.setTimeout(() => setLiveDot(false), 2000);
        };
        const id2 = window.setInterval(() => {
            // Read length from a ref so we don't need it in the dep array
            // (which would re-mount this interval every segment update and
            // trigger React's maximum-update-depth warning).
            if (liveSegmentsRef.current.length > 0) pulse();
        }, 4000);
        return () => {
            active = false;
            window.clearInterval(id);
            window.clearInterval(id2);
            if (dotTimer) window.clearTimeout(dotTimer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
        // excluding liveSegmentsRef (stable ref, never changes) and
        // liveSegments (would cause re-mount loop on every transcript update).
    }, [isOpen, liveTranscriptEnabled]);

    // Persist mode + web search toggles
    useEffect(() => {
        if (!isOpen) return;
        window.electronAPI?.chatSetMode?.(mode).catch(() => {});
    }, [mode, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        window.electronAPI?.chatSetWebSearch?.(webSearch).catch(() => {});
    }, [webSearch, isOpen]);

    // Coordinator: start/stop based on Suggest Mode toggle + open state
    useEffect(() => {
        if (!isOpen) {
            coordinatorRef.current?.stop();
            coordinatorRef.current = null;
            return;
        }
        // The coordinator subscribes to `suggestion:progressive` IPC events in
        // BOTH modes now. In Suggest mode the pipeline auto-fires on transcript
        // finals; in Manual mode only the Sparkles button fires it. The
        // coordinator's handleEvent no longer gates on mode, so both paths
        // render the streamed bubble + persist it via suggestionSave.
        // Phase D / Bug D: read the real meeting UUID from main process instead
        // of using the literal 'live-meeting-current' which causes FK cascade
        // wipes when the meeting row is deleted at end-of-meeting.
        // getCurrentMeetingId returns a Promise — read it synchronously from
        // the cached field if available, otherwise default to the legacy id.
        const currentMeetingId: string =
            (window as any).__currentMeetingId ?? 'live-meeting-current';
        const coord = new SuggestModeCoordinator({
            onSuggestion: (s) => {
                // Append-or-update logic. The coordinator fires once per token
                // for streaming suggestions, plus once on done. We dedupe by
                // timestamp + source so the same suggestion doesn't get appended
                // multiple times when only its `at` differs by a few ms.
                //
                // Mode routing:
                //   suggest → append to proactiveSuggestions (visible bubbles)
                //   manual  → overwrite pendingSuggestion (single-slot, most-
                //             recent-wins). The Sparkles button reveals this.
                const suggestionKey = s.id || `${s.at}`;

                if (mode === 'manual') {
                    setPendingSuggestion(cur => {
                        const updated: SuggestionItem = {
                            id: suggestionKey,
                            suggestion: s.suggestion,
                            citations: s.citations ?? cur?.citations,
                            source: s.source,
                            at: s.at,
                            question: s.question ?? cur?.question,
                        };
                        // Only persist when the suggestion is finished (isDone)
                        if (s.isDone) {
                            window.electronAPI?.suggestionSave?.({
                                meetingId: currentMeetingId,
                                item: {
                                    suggestionId: updated.id,
                                    text: updated.suggestion,
                                    citations: updated.citations ?? [],
                                    source: updated.source,
                                    firedAt: updated.at,
                                    question: updated.question,
                                },
                            });
                        }
                        return updated;
                    });
                    return;
                }

                setProactiveSuggestions(prev => {
                    // Match by stable suggestion ID
                    const existingIdx = prev.findIndex(item => item.id === suggestionKey);
                    if (existingIdx >= 0) {
                        // Update in-place smoothly
                        const updated = [...prev];
                        updated[existingIdx] = {
                            ...updated[existingIdx],
                            suggestion: s.suggestion,
                            citations: s.citations ?? updated[existingIdx].citations,
                            question: s.question ?? updated[existingIdx].question,
                        };
                        // Only persist when the suggestion is completely finished
                        if (s.isDone) {
                            window.electronAPI?.suggestionSave?.({
                                meetingId: currentMeetingId,
                                item: {
                                    suggestionId: updated[existingIdx].id,
                                    text: updated[existingIdx].suggestion,
                                    citations: updated[existingIdx].citations ?? [],
                                    source: updated[existingIdx].source,
                                    firedAt: updated[existingIdx].at,
                                    question: updated[existingIdx].question,
                                },
                            });
                        }
                        return updated;
                    }

                    // Otherwise append a new entry
                    const item: SuggestionItem = {
                        id: suggestionKey,
                        suggestion: s.suggestion,
                        citations: s.citations,
                        source: s.source,
                        at: s.at,
                        question: s.question,
                    };
                    setStreamingId(suggestionKey);
                    const next = [...prev, item];
                    if (next.length > MAX_SUGGESTIONS) next.shift();
                    if (s.isDone) {
                        window.electronAPI?.suggestionSave?.({
                            meetingId: currentMeetingId,
                            item: {
                                suggestionId: item.id,
                                text: item.suggestion,
                                citations: item.citations ?? [],
                                source: item.source,
                                firedAt: item.at,
                                question: item.question,
                            },
                        });
                    }
                    return next;
                });
            },
            getMode: () => mode,
        });
        coord.start();
        coordinatorRef.current = coord;
        return () => {
            coord.stop();
            coordinatorRef.current = null;
        };
    }, [mode, isOpen, webSearch]);

    // Phase P: replay persisted suggestion history on mount. The bubble
    // history lives in SQLite keyed by meetingId; on every panel open we
    // fetch and seed proactiveSuggestions so the user sees their previous
    // suggestions (e.g. after a page refresh or app restart mid-meeting).
    // Bug-fix: read the real meeting UUID from the cached window field
    // populated by the meeting-state-changed listener above, instead of
    // hardcoding 'live-meeting-current' (which never matches because live
    // suggestions are saved under the real uuid).
    const replayAttemptedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        const meetingId: string =
            (window as any).__currentMeetingId ?? 'live-meeting-current';
        if (replayAttemptedRef.current === meetingId) return;
        replayAttemptedRef.current = meetingId;
        let cancelled = false;
        (async () => {
            try {
                const persisted = await window.electronAPI?.chatGetSuggestions?.(meetingId);
                if (cancelled || !persisted || persisted.length === 0) return;
                setProactiveSuggestions((prev) => {
                    // De-dupe by suggestionId so live suggestions that arrive
                    // during replay don't get appended twice.
                    const existingIds = new Set(prev.map((s) => s.id));
                    const additions: SuggestionItem[] = [];
                    for (const p of persisted) {
                        if (!existingIds.has(p.suggestionId)) {
                            additions.push({
                                id: p.suggestionId,
                                suggestion: p.text,
                                citations: (p.citations as any) ?? undefined,
                                source: p.source,
                                at: p.firedAt,
                            });
                            existingIds.add(p.suggestionId);
                        }
                    }
                    if (additions.length === 0) return prev;
                    additions.sort((a, b) => a.at - b.at);
                    const next = [...prev, ...additions];
                    if (next.length > MAX_SUGGESTIONS) next.splice(0, next.length - MAX_SUGGESTIONS);
                    return next;
                });
            } catch (e) {
                // Non-fatal: just skip replay.
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen]);

    // Submit initial query when overlay opens — but only AFTER activeCase is loaded,
    // so the chat is grounded in the right client case instead of running before
    // the async suggestGetActiveCase IPC resolves.
    const [initialQueryConsumed, setInitialQueryConsumed] = useState(false);
    useEffect(() => {
        if (!isOpen || !initialQuery || initialQueryConsumed) return;
        // If we already have an active case, submit immediately.
        if (activeCase.clientCaseId) {
            setTimeout(() => submitQuestion(initialQuery), 50);
            setInitialQueryConsumed(true);
        }
        // Otherwise the load effect will trigger us once the case arrives.
    }, [isOpen, initialQuery, activeCase.clientCaseId, initialQueryConsumed]);

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Resize the overlay BrowserWindow when the panel opens/closes.
    // On open: expand to full screen + slight transparency so the meeting app
    // underneath stays visible. On close: restore previous bounds + opacity.
    useEffect(() => {
        if (isOpen) {
            window.electronAPI?.chatExpandOverlay?.();
        } else {
            window.electronAPI?.chatRestoreOverlay?.();
        }
        // Restore on unmount as a safety net (e.g. if the component unmounts
        // while isOpen is true, e.g. user kills the window).
        return () => {
            window.electronAPI?.chatRestoreOverlay?.();
        };
    }, [isOpen]);

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    }, [onClose]);

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey && query.trim()) {
            e.preventDefault();
            submitQuestion(query);
            setQuery('');
        }
    };

    // Submit question — Manual mode uses kb:ask (RAG over active case, falls back to web when toggle ON)
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === 'waiting_for_llm' || chatState === 'streaming_response') return;

        lastQuestionRef.current = question.trim();

        const userMessage: Message = {
            id: genMessageId(),
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);

        const assistantMessageId = genMessageId();
        let citeCleanup: (() => void) | undefined;
        let tokenCleanup: (() => void) | undefined;
        let doneCleanup: (() => void) | undefined;
        let errorCleanup: (() => void) | undefined;
        let streamTimer: ReturnType<typeof setTimeout> | undefined;

        const cleanupAll = () => {
            if (streamTimer) clearTimeout(streamTimer);
            tokenCleanup?.();
            doneCleanup?.();
            errorCleanup?.();
            citeCleanup?.();
        };

        try {
            await new Promise(resolve => setTimeout(resolve, 200));

            setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                isStreaming: true
            }]);

            streamBuffer.reset();
            let citations: Citation[] = [];

            // Safety deadman timeout (18 seconds max for response)
            streamTimer = setTimeout(() => {
                const currentBuffered = streamBuffer.getBufferedContent();
                if (currentBuffered.trim().length > 0) {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: currentBuffered, isStreaming: false, citations }
                            : msg
                    ));
                } else {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: "Could not retrieve knowledge base response within the timeout. Please check your network or try asking directly.", isStreaming: false }
                            : msg
                    ));
                }
                setChatState('idle');
                streamBuffer.reset();
                cleanupAll();
            }, 18000);

            citeCleanup = window.electronAPI?.onKBStreamCitations?.((data) => {
                citations = data.citations || [];
            });
            tokenCleanup = window.electronAPI?.onKBStreamChunk?.((data: { text: string }) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(data.text, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content, citations: citations.length > 0 ? citations : msg.citations }
                            : msg
                    ));
                });
            });
            doneCleanup = window.electronAPI?.onKBStreamComplete?.(() => {
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent || 'No additional details found.', isStreaming: false, citations }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                cleanupAll();
            });
            errorCleanup = window.electronAPI?.onKBStreamError?.((data: { error: string }) => {
                console.error('[MeetingChatPanel] KB stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage(data?.error || "Couldn't get a response from the knowledge base.");
                setChatState('error');
                streamBuffer.reset();
                cleanupAll();
            });

            // Use kb:ask; falls back to web search internally when toggle is on
            const result = await window.electronAPI?.kbAsk?.({ question });

            if (result && !result.success && !result.fallback) {
                cleanupAll();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: result.error || 'No answer available.', isStreaming: false }
                        : msg
                ));
                setChatState('idle');
                return;
            }
        } catch (e: any) {
            console.error('[MeetingChatPanel] submitQuestion failed:', e);
            cleanupAll();
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage(e?.message || 'Something went wrong.');
            setChatState('error');
        }
    }, [chatState]);

    return (
        <AnimatePresence
            onExitComplete={() => {
                setChatState('idle');
                setMessages([]);
                setErrorMessage(null);
                setProactiveSuggestions([]);
                setStreamingId(null);
                setPendingSuggestion(null);
            }}
        >
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="fixed inset-0 z-[99999] flex flex-col justify-end pointer-events-none"
                    onClick={handleBackdropClick}
                >
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.16 }}
                        className="fixed inset-0 bg-black/10 backdrop-blur-[2px]"
                    />

                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: panelHeight || '85vh', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="mx-auto w-full max-w-[720px] mb-0 bg-black/40 backdrop-blur-2xl rounded-t-[24px] border-t border-x border-white/15 shadow-[0_-12px_40px_rgba(0,0,0,0.3)] overflow-hidden flex flex-col pointer-events-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Drag-to-resize handle */}
                        <div
                            className="flex items-center justify-center pt-2 pb-1 cursor-ns-resize select-none"
                            onMouseDown={(e) => {
                                dragStartRef.current = { startY: e.clientY, startHeight: panelHeight };
                                const onMove = (ev: MouseEvent) => {
                                    if (!dragStartRef.current) return;
                                    const delta = dragStartRef.current.startY - ev.clientY;
                                    const maxH = window.innerHeight - 60;
                                    const newH = Math.max(200, Math.min(maxH, dragStartRef.current.startHeight + delta));
                                    setPanelHeight(newH);
                                };
                                const onUp = () => {
                                    dragStartRef.current = null;
                                    window.removeEventListener('mousemove', onMove);
                                    window.removeEventListener('mouseup', onUp);
                                };
                                window.addEventListener('mousemove', onMove);
                                window.addEventListener('mouseup', onUp);
                                e.preventDefault();
                            }}
                            title="Drag to resize"
                        >
                            <div className="w-12 h-1.5 rounded-full bg-white/30 hover:bg-white/50 transition-colors" />
                        </div>
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-2.5 border-b border-white/10 bg-transparent shrink-0">
                            <div className="flex items-center gap-2 text-white">
                                <Sparkles size={14} className="opacity-80 text-indigo-300" />
                                <span className="text-[13px] font-medium text-white">Meeting Copilot</span>
                            </div>
                            <button onClick={onClose} className="p-2 transition-colors group">
                                <X size={16} className="text-white/70 group-hover:text-red-400 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages & Suggestions Area (flex-1 min-h-0 ensures it ends strictly above the bottom footer) */}
                        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 custom-scrollbar">
                            {messages.length === 0 && (
                                <div className="text-center text-white/70 py-8">
                                    <Sparkles size={28} className="mx-auto mb-2.5 opacity-50 text-indigo-300" />
                                    <p className="text-sm text-white/90">Ask anything — your legal knowledge base has the answers.</p>
                                    {activeCase.clientCaseId ? (
                                        <p className="text-xs mt-1.5 text-white/60">Grounded in: <span className="font-medium text-indigo-200">{activeCase.clientCaseName}</span></p>
                                    ) : (
                                        <p className="text-xs mt-1.5 text-white/60">Shared Legal Knowledge Base active.</p>
                                    )}
                                </div>
                            )}
                            {/* Proactive Suggestion History */}
                            <div ref={suggestionsEndRef} className="mb-3 space-y-2.5">
                                <AnimatePresence initial={false}>
                                    {proactiveSuggestions.map((s) => {
                                        const hasText = s.suggestion && s.suggestion.length > 0;
                                        const isStreaming = s.id === streamingId && s.source === 'live' && !s.citations;
                                        return (
                                            <motion.div
                                                key={s.id}
                                                layout
                                                initial={{ opacity: 0, y: 6 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.22, ease: 'easeOut' }}
                                                className="group relative pl-3.5 pr-3 py-2.5 rounded-xl border-l-2 border-indigo-400/80 bg-white/[0.04] backdrop-blur-md text-[13px] text-white/95 leading-relaxed hover:bg-white/[0.06] transition-all shadow-sm"
                                            >
                                                {/* Header row with Trigger question and action buttons */}
                                                <div className="flex items-center justify-between gap-2 mb-1">
                                                    {s.question ? (
                                                        <div className="text-[11px] font-semibold text-indigo-300/90 flex items-center gap-1.5 truncate" title={`Triggered by: "${s.question}"`}>
                                                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                                                            <span className="truncate">Triggered by: &ldquo;{s.question}&rdquo;</span>
                                                        </div>
                                                    ) : (
                                                        <div className="text-[11px] font-medium text-indigo-300/70 flex items-center gap-1">
                                                            <Sparkles size={11} className="text-indigo-400" />
                                                            <span>Live Co-Counsel</span>
                                                        </div>
                                                    )}

                                                    {/* Quick Action Buttons */}
                                                    {hasText && (
                                                        <div className="flex items-center gap-1.5 shrink-0">
                                                            <button
                                                                type="button"
                                                                className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md bg-indigo-500/25 hover:bg-indigo-500/40 text-indigo-100 border border-indigo-400/40 transition-all cursor-pointer font-medium"
                                                                title="Get a deeper, more detailed statutory explanation grounded in the cited sources"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    const sources = (s.citations || [])
                                                                        .map(c => c.title)
                                                                        .filter(Boolean)
                                                                        .join('; ');
                                                                    const seed = s.question || s.suggestion.slice(0, 100);
                                                                    const clarifyPrompt = sources
                                                                        ? `Explain in depth, citing the same sources [${sources}], the statutory reasoning behind: "${seed}"`
                                                                        : `Explain in depth the statutory reasoning behind: "${seed}"`;
                                                                    submitQuestion(clarifyPrompt);
                                                                }}
                                                            >
                                                                <HelpCircle size={11} strokeWidth={2.5} />
                                                                <span>Clarify</span>
                                                            </button>

                                                            <button
                                                                type="button"
                                                                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md hover:bg-white/10 text-white/70 hover:text-white border border-white/10 transition-all cursor-pointer"
                                                                title="Copy the speakable lines to clipboard"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    try {
                                                                        navigator.clipboard?.writeText(s.suggestion);
                                                                        setCopiedSuggestionId(s.id);
                                                                        setTimeout(() => setCopiedSuggestionId(null), 1500);
                                                                    } catch { /* ignore */ }
                                                                }}
                                                            >
                                                                {copiedSuggestionId === s.id ? (
                                                                    <>
                                                                        <Check size={11} className="text-emerald-400" />
                                                                        <span>Copied</span>
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <Copy size={11} />
                                                                        <span>Copy</span>
                                                                    </>
                                                                )}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Streaming caret & suggestion body */}
                                                {hasText ? (
                                                    <div className="whitespace-pre-wrap break-words text-white/90 font-normal">
                                                        {s.suggestion}
                                                        {isStreaming && <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-indigo-300 animate-pulse" />}
                                                    </div>
                                                ) : isStreaming ? (
                                                    <div className="text-white/50 italic">Generating…</div>
                                                ) : null}

                                                {/* Citations — badges below the bubble */}
                                                {s.citations && s.citations.length > 0 && (
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        {s.citations.map(c => <CitationBadge key={c.id} c={c} />)}
                                                    </div>
                                                )}

                                                {/* Streaming indicator dots */}
                                                {isStreaming && (
                                                    <span className="absolute top-2.5 right-2 flex gap-0.5" aria-label="streaming">
                                                        <span className="w-1 h-1 rounded-full bg-indigo-300 animate-pulse" style={{ animationDelay: '0ms' }} />
                                                        <span className="w-1 h-1 rounded-full bg-indigo-300 animate-pulse" style={{ animationDelay: '120ms' }} />
                                                        <span className="w-1 h-1 rounded-full bg-indigo-300 animate-pulse" style={{ animationDelay: '240ms' }} />
                                                    </span>
                                                )}
                                            </motion.div>
                                        );
                                    })}
                                </AnimatePresence>
                            </div>
                            {messages.map((msg) => (
                                msg.role === 'user'
                                    ? <UserMessage key={msg.id} content={msg.content} />
                                    : <AssistantMessage key={msg.id} content={msg.content} isStreaming={msg.isStreaming} citations={msg.citations} />
                            ))}
                            {chatState === 'waiting_for_llm' && <TypingIndicator />}
                            {errorMessage && (
                                <motion.div
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="text-[#FF6B6B] text-[13px] py-2"
                                >
                                    {errorMessage}
                                </motion.div>
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Bottom Docked Section — seamlessly transparent, strictly beneath suggestions */}
                        <div className="shrink-0 w-full px-5 pt-2.5 pb-4 border-t border-white/10 bg-transparent flex flex-col items-center z-20">
                            <div className="w-full max-w-[540px] relative group">

                                {/* Live transcript strip — strictly inside the bottom dock */}
                                {liveTranscriptEnabled && liveSegments.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.18 }}
                                        className="w-full mb-2.5 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/10 text-[12px] text-white/90 max-h-24 overflow-y-auto custom-scrollbar backdrop-blur-md shadow-sm"
                                    >
                                        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/50 mb-1">
                                            <span className={`w-1.5 h-1.5 rounded-full ${liveDot ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/60'}`} />
                                            <span>Live transcript</span>
                                            <span className="ml-auto text-white/40">{liveSegments.length}</span>
                                        </div>
                                        <div className="space-y-1">
                                            {liveSegments.slice(-6).map((seg, idx) => (
                                                <div key={`${seg.timestamp}-${idx}`} className="leading-snug">
                                                    <span className={`font-medium ${seg.role === 'interviewer' ? 'text-blue-300' : seg.role === 'user' ? 'text-emerald-300' : 'text-indigo-300'}`}>
                                                        {seg.role === 'interviewer' ? '🎤 ' : seg.role === 'user' ? '👤 ' : '🤖 '}
                                                    </span>
                                                    <span className="text-white/85">{seg.text}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </motion.div>
                                )}

                                {/* KB indicator & controls row */}
                                <div className="flex items-center gap-2 mb-2 px-1">
                                    {activeCase.clientCaseId ? (
                                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-[11px]">
                                            <BookOpen size={11} className="text-indigo-400" />
                                            <span className="text-indigo-200 font-medium max-w-[160px] truncate">{activeCase.clientCaseName}</span>
                                            {activeCase.clientCaseCompany && <span className="text-indigo-300/60">— {activeCase.clientCaseCompany}</span>}
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 border border-white/20 text-[11px] text-white/70">
                                            <span>Shared Legal KB</span>
                                        </div>
                                    )}

                                    {/* Manual / Suggest toggle */}
                                    <div className="flex items-center rounded-full border border-white/20 bg-white/5 overflow-hidden text-[11px]">
                                        <button
                                            onClick={() => setMode('manual')}
                                            className={`px-2.5 py-1 transition-colors ${mode === 'manual' ? 'bg-white text-[#1c1c1e] font-medium' : 'text-white/70 hover:text-white'}`}
                                            title="Manual mode — answers only when you ask"
                                        >
                                            Manual
                                        </button>
                                        <button
                                            onClick={() => setMode('suggest')}
                                            className={`px-2.5 py-1 transition-colors ${mode === 'suggest' ? 'bg-indigo-500 text-white font-medium' : 'text-white/70 hover:text-white'}`}
                                            title="Suggest mode — proactive suggestions based on live transcript or last chat message"
                                        >
                                            Suggest
                                        </button>
                                    </div>

                                    {/* Globe web search toggle */}
                                    <button
                                        onClick={() => setWebSearch(!webSearch)}
                                        className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                                            webSearch
                                                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                                                : 'border-border-subtle text-text-tertiary hover:text-text-secondary'
                                        }`}
                                        title={webSearch ? 'Web search enabled (used when KB has no answer)' : 'Web search disabled'}
                                    >
                                        <Globe size={11} />
                                    </button>

                                    {/* Live transcript toggle — controls whether the
                                        footer strip renders AND whether kb:ask injects
                                        a <live_transcript> block into the prompt. */}
                                    <button
                                        onClick={async () => {
                                            const next = !liveTranscriptEnabled;
                                            setLiveTranscriptEnabled(next);
                                            try { await window.electronAPI?.chatSetLiveTranscript?.(next); } catch { /* non-fatal */ }
                                        }}
                                        className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                                            liveTranscriptEnabled
                                                ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
                                                : 'border-border-subtle text-text-tertiary hover:text-text-secondary'
                                        }`}
                                        title={liveTranscriptEnabled ? 'Live transcript: on (Copilot answers use the last 120s)' : 'Live transcript: off'}
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full ${liveTranscriptEnabled ? (liveDot ? 'bg-emerald-400 animate-pulse' : 'bg-emerald-500/70') : 'bg-white/30'}`} />
                                        <span>Live</span>
                                    </button>
                                </div>

                                {/* Input */}
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        onKeyDown={handleInputKeyDown}
                                        placeholder={mode === 'suggest' ? 'Ask — or wait for a suggestion above' : 'Ask me anything...'}
                                        className="w-full pl-12 pr-28 py-2.5 bg-white/[0.05] border border-white/15 rounded-full text-sm text-white placeholder-white/40 focus:outline-none focus:border-indigo-400/60 backdrop-blur-md transition-all shadow-inner"
                                    />

                                    {/* + Action button */}
                                    <button
                                        onClick={() => setShowActions(v => !v)}
                                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all border border-white/15 bg-white/5 text-white/70 hover:bg-white/15 hover:text-white"
                                        title="Add context, switch case/persona, enable web search"
                                    >
                                        <Plus size={14} className={showActions ? 'rotate-45 transition-transform' : 'transition-transform text-white'} />
                                    </button>

                                    {/* ••• More popover */}
                                    <div className="absolute left-12 top-1/2 -translate-y-1/2">
                                        <button
                                            onClick={() => setShowMore(v => !v)}
                                            className="p-1.5 rounded-full text-white/60 hover:text-white hover:bg-white/10"
                                            title="Quick actions (legacy interview presets — preserved)"
                                        >
                                            <MoreHorizontal size={14} />
                                        </button>
                                        {showMore && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.12 }}
                                                className="absolute bottom-full left-0 mb-2 w-52 bg-[#1c1c20] border border-white/15 rounded-xl shadow-2xl p-1 text-[12px] z-50"
                                            >
                                                {[
                                                    { label: 'What to say', icon: <Pencil size={11} />, action: 'whatToSay' },
                                                    { label: 'Clarify', icon: <MessageSquare size={11} />, action: 'clarify' },
                                                    { label: 'Recap', icon: <RefreshCw size={11} />, action: 'recap' },
                                                    { label: 'Follow-up question', icon: <HelpCircle size={11} />, action: 'followUp' },
                                                    { label: 'Answer now', icon: <Zap size={11} />, action: 'answerNow' },
                                                ].map(item => (
                                                    <button
                                                        key={item.action}
                                                        onClick={async () => {
                                                            setShowMore(false);
                                                            if (item.action === 'whatToSay') window.electronAPI?.generateWhatToSay?.();
                                                            else if (item.action === 'clarify') {
                                                                // Mode-aware Clarify: pull the latest
                                                                // interviewer/user/chat line, then route
                                                                // through the SuggestionPipeline with the
                                                                // `clarify: true` flag. The main process
                                                                // detects the active mode (Lawyer →
                                                                // sharpening directive, other modes → passthrough).
                                                                const segs = liveSegmentsRef.current || [];
                                                                const lastInterviewer = [...segs].reverse().find(s => s.role === 'interviewer' && s.text?.trim());
                                                                const lastUserSeg = [...segs].reverse().find(s => s.role === 'user' && s.text?.trim());
                                                                const lastChat = [...messages].reverse().find(m => m.role === 'user')?.content;
                                                                const latest = (lastInterviewer?.text || lastUserSeg?.text || lastChat || '').trim();
                                                                if (!latest) return;
                                                                await window.electronAPI?.suggestionRunOnce?.(latest, { clarify: true });
                                                            }
                                                            else if (item.action === 'recap') window.electronAPI?.generateRecap?.();
                                                            else if (item.action === 'followUp') window.electronAPI?.generateFollowUpQuestions?.();
                                                            else if (item.action === 'answerNow') window.electronAPI?.generateCodeHint?.();
                                                        }}
                                                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-white/90 hover:bg-white/10"
                                                    >
                                                        {item.icon}
                                                        <span>{item.label}</span>
                                                    </button>
                                                ))}
                                            </motion.div>
                                        )}
                                    </div>

                                    {/* Right side buttons: Sparkles (Manual mode only) + Send.
                                        In Suggest mode suggestions stream automatically from the
                                        live transcript, so the manual-trigger button is redundant. */}
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                        {mode === 'manual' && (
                                        <button
                                            onClick={async () => {
                                                // Manual-mode ambient reveal: if the input is empty
                                                // AND the pipeline has a stashed pending suggestion
                                                // (the most recent one it has been quietly
                                                // generating in the background), promote it to a
                                                // visible bubble. No typing, no fresh LLM call —
                                                // just reveal the latest ambient result.
                                                const typed = query.trim();
                                                if (!typed && pendingSuggestion) {
                                                    const revealed = pendingSuggestion;
                                                    setPendingSuggestion(null);
                                                    setProactiveSuggestions(prev => {
                                                        const next = [...prev, revealed];
                                                        if (next.length > MAX_SUGGESTIONS) next.shift();
                                                        return next;
                                                    });
                                                    setStreamingId(null);
                                                    return;
                                                }
                                                // Otherwise, with a typed question OR no pending
                                                // available, ask the pipeline to generate a fresh
                                                // one. Resolution priority: 1) input, 2) last
                                                // interviewer final, 3) last user final, 4) last
                                                // chat user message. Silent no-op if all empty.
                                                let resolved = typed;
                                                if (!resolved) {
                                                    const segs = liveSegmentsRef.current || [];
                                                    const lastInterviewer = [...segs].reverse().find(s => s.role === 'interviewer' && s.text?.trim());
                                                    const lastUserSeg = [...segs].reverse().find(s => s.role === 'user' && s.text?.trim());
                                                    const lastChat = [...messages].reverse().find(m => m.role === 'user')?.content;
                                                    resolved = (lastInterviewer?.text || lastUserSeg?.text || lastChat || '').trim();
                                                }
                                                if (!resolved) return;
                                                setErrorMessage(null);
                                                const result = await window.electronAPI?.suggestionRunOnce?.(resolved);
                                                if (result && !result.success && result.error) {
                                                    setErrorMessage(result.error);
                                                    return;
                                                }
                                                if (typed) setQuery('');
                                            }}
                                            title="Reveal the latest ambient suggestion (or generate a fresh one from your text)"
                                            className="p-1.5 rounded-full transition-all border border-white/5 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25"
                                        >
                                            <Sparkles size={14} />
                                        </button>
                                        )}
                                        <button
                                            onClick={() => {
                                                if (query.trim()) {
                                                    submitQuestion(query);
                                                    setQuery('');
                                                }
                                            }}
                                            className={`p-1.5 rounded-full transition-all border ${query.trim() ? 'bg-white text-[#1c1c1e] border-white hover:scale-105' : 'bg-white/10 text-white/40 border-white/10'}`}
                                        >
                                            <ArrowUp size={16} className="transform rotate-45" />
                                        </button>
                                    </div>

                                    {/* Action sheet */}
                                    {showActions && (
                                        <motion.div
                                            initial={{ opacity: 0, y: 4 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ duration: 0.12 }}
                                            className="absolute bottom-full left-0 mb-2 w-72 bg-[#1c1c20] border border-white/15 rounded-xl shadow-2xl p-2 z-50"
                                        >
                                            <button
                                                onClick={() => { setShowActions(false); setShowKbPicker(true); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-white/10 text-left"
                                            >
                                                <BookOpen size={14} className="mt-0.5 text-indigo-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Pick KB case</div>
                                                    <div className="text-[11px] text-white/60">{activeCase.clientCaseId ? `Active: ${activeCase.clientCaseName}` : 'Switch which client/case grounds answers'}</div>
                                                </div>
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setShowActions(false);
                                                    const dialogResult = await window.electronAPI?.kbOpenFileDialog?.([
                                                        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'csv'] },
                                                        { name: 'Presentations', extensions: ['pptx', 'ppt'] },
                                                        { name: 'All Files', extensions: ['*'] },
                                                    ]);
                                                    if (dialogResult?.cancelled || !dialogResult?.filePaths?.length) return;
                                                    if (!activeCase.clientCaseId) { setErrorMessage('Pick a KB case first.'); return; }
                                                    const filePath = dialogResult.filePaths[0];
                                                    const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Untitled';
                                                    const isPpt = fileName.match(/\.(pptx|ppt)$/i);
                                                    const res = await window.electronAPI?.kbAddSource?.({
                                                        clientCaseId: activeCase.clientCaseId,
                                                        sourceType: isPpt ? 'ppt' : 'file',
                                                        title: fileName,
                                                        sourcePath: filePath,
                                                    });
                                                    if (res?.success) setErrorMessage(null);
                                                    else setErrorMessage(res?.error || 'Upload failed.');
                                                }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-white/10 text-left"
                                            >
                                                <FileText size={14} className="mt-0.5 text-blue-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Upload file</div>
                                                    <div className="text-[11px] text-white/60">PDF, DOCX, TXT, MD, PPTX</div>
                                                </div>
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setShowActions(false);
                                                    const url = window.prompt('Paste URL to add (http or https):');
                                                    if (!url || !activeCase.clientCaseId) return;
                                                    if (!url.startsWith('http://') && !url.startsWith('https://')) {
                                                        setErrorMessage('URL must start with http:// or https://');
                                                        return;
                                                    }
                                                    const res = await window.electronAPI?.kbAddSource?.({
                                                        clientCaseId: activeCase.clientCaseId,
                                                        sourceType: 'web_page',
                                                        sourcePath: url,
                                                        title: url,
                                                    });
                                                    if (res?.success) setErrorMessage(null);
                                                    else setErrorMessage(res?.error || 'Add URL failed.');
                                                }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-white/10 text-left"
                                            >
                                                <Link2 size={14} className="mt-0.5 text-emerald-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Add URL</div>
                                                    <div className="text-[11px] text-white/60">Fetch page text and index it</div>
                                                </div>
                                            </button>
                                            <button
                                                onClick={() => { setShowActions(false); setShowPersonaPicker(v => !v); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-white/10 text-left"
                                            >
                                                <UserCog size={14} className="mt-0.5 text-amber-400" />
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[13px] font-medium text-white">Persona</span>
                                                        <span className="text-[11px] text-white/60">{activePersona}</span>
                                                        <ChevronDown size={11} className={`text-white/60 ml-auto transition-transform ${showPersonaPicker ? 'rotate-180' : ''}`} />
                                                    </div>
                                                    <div className="text-[11px] text-white/60">Tone & priorities for the assistant</div>
                                                </div>
                                            </button>
                                            {showPersonaPicker && (
                                                <div className="ml-6 mt-1 mb-1 space-y-0.5 border-l border-white/15 pl-2">
                                                    {['Manual', 'VC Diligence', 'Lawyer — Wills', 'Sales call', 'Recruiting'].map(p => (
                                                        <button
                                                            key={p}
                                                            onClick={() => { setActivePersona(p); setShowPersonaPicker(false); }}
                                                            className={`w-full text-left px-2 py-1 rounded text-[12px] ${activePersona === p ? 'bg-amber-500/20 text-amber-200' : 'text-white/80 hover:bg-white/10'}`}
                                                        >
                                                            {p}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="h-px bg-white/10 my-1" />
                                            <button
                                                onClick={() => { setWebSearch(v => !v); setShowActions(false); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-white/10 text-left"
                                            >
                                                <Globe size={14} className={`mt-0.5 ${webSearch ? 'text-emerald-400' : 'text-white/60'}`} />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Web search</div>
                                                    <div className="text-[11px] text-white/60">{webSearch ? 'Enabled — falls back when KB has no answer' : 'Disabled — KB only'}</div>
                                                </div>
                                            </button>
                                        </motion.div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Case picker overlay (lazy) */}
                        <AnimatePresence>
                            {showKbPicker && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="absolute inset-0 z-50 bg-black/60 flex items-end justify-center pb-32"
                                    onClick={() => setShowKbPicker(false)}
                                >
                                    <motion.div
                                        initial={{ y: 20, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        exit={{ y: 20, opacity: 0 }}
                                        onClick={(e) => e.stopPropagation()}
                                        className="bg-[#1c1c20] border border-white/15 rounded-xl p-4 w-[440px] max-h-[60vh] overflow-y-auto"
                                    >
                                        <h3 className="text-sm font-semibold text-white mb-3">Pick a client case</h3>
                                        <ClientCaseSelector
                                            selectedCaseId={activeCase.clientCaseId || undefined}
                                            onCaseSelected={() => setShowKbPicker(false)}
                                            label=""
                                        />
                                    </motion.div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default MeetingChatPanel;
