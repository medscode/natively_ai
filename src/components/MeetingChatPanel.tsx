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

const CitationBadge: React.FC<{ c: Citation }> = ({ c }) => (
    <span
        title={c.snippet || c.title}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-medium ${
            c.sourceType === 'web'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-blue-500/10 text-blue-500 border-blue-500/30'
        }`}
    >
        {c.sourceType === 'web' ? <Globe size={10} strokeWidth={2.5} /> : <BookOpen size={10} strokeWidth={2.5} />}
        <span className="max-w-[140px] truncate">{c.title || c.sourceType}</span>
        {typeof c.similarity === 'number' && (
            <span className="opacity-70 font-mono text-[9px]">{c.similarity.toFixed(2)}</span>
        )}
    </span>
);

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
            <div className="text-text-primary text-[15px] leading-relaxed max-w-[85%]">
                {content}
                {citations && citations.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {citations.map((c) => <CitationBadge key={c.id} c={c} />)}
                    </div>
                )}
                {isStreaming && (
                    <motion.span
                        className="inline-block w-0.5 h-4 bg-text-secondary ml-0.5 align-middle"
                        animate={{ opacity: [1, 0] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                    />
                )}
            </div>
            {!isStreaming && content && (
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-2 mt-3 text-[13px] text-text-tertiary hover:text-text-secondary transition-colors"
                >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
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
    const [proactiveSuggestion, setProactiveSuggestion] = useState<{
        suggestion: string;
        citations?: Citation[];
        source: 'live' | 'mock';
    } | null>(null);
    const streamBuffer = useStreamBuffer();
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const coordinatorRef = useRef<SuggestModeCoordinator | null>(null);
    const lastQuestionRef = useRef('');

    // Load initial state from IPC on open + subscribe to changes
    useEffect(() => {
        if (!isOpen) return;
        let active = true;

        const load = async () => {
            try {
                const [caseRes, modeRes, webRes] = await Promise.all([
                    window.electronAPI?.suggestGetActiveCase?.(),
                    window.electronAPI?.chatGetMode?.(),
                    window.electronAPI?.chatGetWebSearch?.(),
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
        if (mode !== 'suggest') {
            coordinatorRef.current?.stop();
            coordinatorRef.current = null;
            return;
        }
        const coord = new SuggestModeCoordinator({
            onSuggestion: (s) => setProactiveSuggestion(s),
            getMode: () => mode,
            getWebSearch: () => webSearch,
            getLastUserMessage: () => lastQuestionRef.current,
            getActiveTranscript: async () => {
                try {
                    const r = await window.electronAPI?.chatGetTranscriptContext?.();
                    return (r?.available && r.text) ? r.text : '';
                } catch { return ''; }
            },
        });
        coord.start();
        coordinatorRef.current = coord;
        return () => {
            coord.stop();
            coordinatorRef.current = null;
        };
    }, [mode, isOpen, webSearch]);

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

            const citeCleanup = window.electronAPI?.onKBStreamCitations?.((data) => {
                citations = data.citations || [];
            });
            const tokenCleanup = window.electronAPI?.onKBStreamChunk?.((data: { text: string }) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(data.text, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content, citations: citations.length > 0 ? citations : msg.citations }
                            : msg
                    ));
                });
            });
            const doneCleanup = window.electronAPI?.onKBStreamComplete?.(() => {
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false, citations }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
                citeCleanup?.();
            });
            const errorCleanup = window.electronAPI?.onKBStreamError?.((data: { error: string }) => {
                console.error('[MeetingChatPanel] KB stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage(data?.error || "Couldn't get a response from the knowledge base.");
                setChatState('error');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
                citeCleanup?.();
            });

            // Use kb:ask; falls back to web search internally when toggle is on
            const result = await window.electronAPI?.kbAsk?.({ question });

            // If KB returned empty (no active case), surface a hint and clear the
            // streaming placeholder
            if (result && !result.success && !result.fallback) {
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: result.error || 'No answer available.', isStreaming: false }
                        : msg
                ));
                setChatState('idle');
                return;
            }
            if (result?.fallback) {
                // Stream listener handles the rest through onKBStream*; nothing to do here.
                return;
            }
        } catch (e: any) {
            console.error('[MeetingChatPanel] submitQuestion failed:', e);
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
                setProactiveSuggestion(null);
            }}
        >
            {isOpen && (console.log('[MeetingChatPanel] rendering, isOpen=true, panelHeight=', panelHeight),
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="fixed inset-0 z-[99999] flex flex-col justify-end pointer-events-none"
                    onClick={handleBackdropClick}
                >
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="fixed inset-0 bg-black/40"
                    />

                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: '85vh', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="mx-auto w-full max-w-[680px] mb-0 bg-[#1f1f23] backdrop-blur-xl rounded-t-[24px] border-t border-x border-white/20 shadow-2xl overflow-hidden flex flex-col pointer-events-auto"
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
                            <div className="w-12 h-1.5 rounded-full bg-text-tertiary/40 hover:bg-text-tertiary/70 transition-colors" />
                        </div>
                        {/* Header */}
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <Sparkles size={14} className="opacity-70" />
                                <span className="text-[13px] font-medium">Meeting Copilot</span>
                            </div>
                            <button onClick={onClose} className="p-2 transition-colors group">
                                <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages area */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 pb-56 custom-scrollbar">
                            {messages.length === 0 && (
                                <div className="text-center text-text-tertiary py-12">
                                    <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
                                    <p className="text-sm">Ask anything — your active knowledge base has the answers.</p>
                                    {activeCase.clientCaseId ? (
                                        <p className="text-xs mt-2 opacity-70">Grounded in: <span className="font-medium">{activeCase.clientCaseName}</span></p>
                                    ) : (
                                        <p className="text-xs mt-2 opacity-70">No active case — open <span className="font-medium">+</span> below to pick one.</p>
                                    )}
                                </div>
                            )}
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

                        {/* Floating Footer */}
                        <div className="absolute bottom-0 left-0 right-0 p-6 flex justify-center z-50 pointer-events-none">
                            <div className="w-full max-w-[440px] relative group pointer-events-auto">

                                {/* Proactive Suggestion Pill (appears above input when Suggest Mode is on) */}
                                {proactiveSuggestion && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="mb-2 p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-[13px] text-white cursor-pointer"
                                        onClick={() => { setQuery(proactiveSuggestion.suggestion); setProactiveSuggestion(null); }}
                                    >
                                        <div className="flex items-center gap-1.5 text-[11px] text-indigo-300 font-medium mb-1">
                                            <Sparkles size={11} />
                                            <span>{proactiveSuggestion.source === 'live' ? 'Live suggestion' : 'Suggested follow-up'}</span>
                                        </div>
                                        <div className="leading-relaxed">{proactiveSuggestion.suggestion}</div>
                                        {proactiveSuggestion.citations && proactiveSuggestion.citations.length > 0 && (
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                                {proactiveSuggestion.citations.map(c => <CitationBadge key={c.id} c={c} />)}
                                            </div>
                                        )}
                                    </motion.div>
                                )}

                                {/* KB indicator row */}
                                <div className="flex items-center gap-2 mb-2 px-1">
                                    {activeCase.clientCaseId ? (
                                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-[11px]">
                                            <BookOpen size={11} className="text-indigo-400" />
                                            <span className="text-indigo-200 font-medium max-w-[160px] truncate">{activeCase.clientCaseName}</span>
                                            {activeCase.clientCaseCompany && <span className="text-indigo-300/60">— {activeCase.clientCaseCompany}</span>}
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-text-tertiary/10 border border-border-subtle text-[11px] text-text-tertiary">
                                            <span>No active case</span>
                                        </div>
                                    )}

                                    {/* Manual / Suggest toggle */}
                                    <div className="flex items-center rounded-full border border-border-subtle bg-bg-elevated overflow-hidden text-[11px]">
                                        <button
                                            onClick={() => setMode('manual')}
                                            className={`px-2.5 py-1 transition-colors ${mode === 'manual' ? 'bg-text-primary text-[#1c1c1e] font-medium' : 'text-text-tertiary hover:text-text-secondary'}`}
                                            title="Manual mode — answers only when you ask"
                                        >
                                            Manual
                                        </button>
                                        <button
                                            onClick={() => setMode('suggest')}
                                            className={`px-2.5 py-1 transition-colors ${mode === 'suggest' ? 'bg-indigo-500 text-white font-medium' : 'text-text-tertiary hover:text-text-secondary'}`}
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
                                </div>

                                {/* Input */}
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        onKeyDown={handleInputKeyDown}
                                        placeholder={mode === 'suggest' ? 'Ask — or wait for a suggestion above' : 'Ask me anything...'}
                                        className="w-full pl-12 pr-28 py-3 bg-bg-elevated shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-border-muted rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-all"
                                    />

                                    {/* + Action button */}
                                    <button
                                        onClick={() => setShowActions(v => !v)}
                                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all border border-white/5 bg-bg-item-active text-text-secondary hover:bg-bg-item-hover"
                                        title="Add context, switch case/persona, enable web search"
                                    >
                                        <Plus size={14} className={showActions ? 'rotate-45 transition-transform' : 'transition-transform'} />
                                    </button>

                                    {/* ••• More popover */}
                                    <div className="absolute left-12 top-1/2 -translate-y-1/2">
                                        <button
                                            onClick={() => setShowMore(v => !v)}
                                            className="p-1.5 rounded-full text-text-tertiary hover:text-text-secondary hover:bg-bg-item-hover"
                                            title="Quick actions (legacy interview presets — preserved)"
                                        >
                                            <MoreHorizontal size={14} />
                                        </button>
                                        {showMore && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -4 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                transition={{ duration: 0.12 }}
                                                className="absolute bottom-full left-0 mb-2 w-52 bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl p-1 text-[12px] z-50"
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
                                                        onClick={() => {
                                                            setShowMore(false);
                                                            if (item.action === 'whatToSay') window.electronAPI?.generateWhatToSay?.();
                                                            else if (item.action === 'clarify') window.electronAPI?.generateClarify?.();
                                                            else if (item.action === 'recap') window.electronAPI?.generateRecap?.();
                                                            else if (item.action === 'followUp') window.electronAPI?.generateFollowUpQuestions?.();
                                                            else if (item.action === 'answerNow') window.electronAPI?.generateCodeHint?.();
                                                        }}
                                                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-text-secondary hover:bg-bg-item-hover"
                                                    >
                                                        {item.icon}
                                                        <span>{item.label}</span>
                                                    </button>
                                                ))}
                                            </motion.div>
                                        )}
                                    </div>

                                    {/* Right side buttons: Sparkles + Send */}
                                    <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                        <button
                                            onClick={async () => {
                                                const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content;
                                                const question = (query.trim() || lastUser || '').trim();
                                                if (!question) {
                                                    setErrorMessage('Type a question first, then click Suggest.');
                                                    return;
                                                }
                                                setErrorMessage(null);
                                                const result = await window.electronAPI?.kbSuggest?.({ question });
                                                if (!result?.success) {
                                                    setErrorMessage(result?.error || 'KB suggestion failed. Make sure a client case is active.');
                                                    return;
                                                }
                                                if (result.suggestion) setProactiveSuggestion({ suggestion: result.suggestion, citations: result.citations, source: 'live' });
                                                setQuery('');
                                            }}
                                            title="Generate a KB-grounded suggestion"
                                            className="p-1.5 rounded-full transition-all border border-white/5 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25"
                                        >
                                            <Sparkles size={14} />
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (query.trim()) {
                                                    submitQuestion(query);
                                                    setQuery('');
                                                }
                                            }}
                                            className={`p-1.5 rounded-full transition-all border border-border-muted ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'}`}
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
                                            className="absolute bottom-full left-0 mb-2 w-72 bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl p-2 z-50"
                                        >
                                            <button
                                                onClick={() => { setShowActions(false); setShowKbPicker(true); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-bg-item-hover text-left"
                                            >
                                                <BookOpen size={14} className="mt-0.5 text-indigo-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Pick KB case</div>
                                                    <div className="text-[11px] text-text-tertiary">{activeCase.clientCaseId ? `Active: ${activeCase.clientCaseName}` : 'Switch which client/case grounds answers'}</div>
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
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-bg-item-hover text-left"
                                            >
                                                <FileText size={14} className="mt-0.5 text-blue-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Upload file</div>
                                                    <div className="text-[11px] text-text-tertiary">PDF, DOCX, TXT, MD, PPTX</div>
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
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-bg-item-hover text-left"
                                            >
                                                <Link2 size={14} className="mt-0.5 text-emerald-400" />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Add URL</div>
                                                    <div className="text-[11px] text-text-tertiary">Fetch page text and index it</div>
                                                </div>
                                            </button>
                                            <button
                                                onClick={() => { setShowActions(false); setShowPersonaPicker(v => !v); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-bg-item-hover text-left"
                                            >
                                                <UserCog size={14} className="mt-0.5 text-amber-400" />
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[13px] font-medium text-white">Persona</span>
                                                        <span className="text-[11px] text-text-tertiary">{activePersona}</span>
                                                        <ChevronDown size={11} className={`text-text-tertiary ml-auto transition-transform ${showPersonaPicker ? 'rotate-180' : ''}`} />
                                                    </div>
                                                    <div className="text-[11px] text-text-tertiary">Tone & priorities for the assistant</div>
                                                </div>
                                            </button>
                                            {showPersonaPicker && (
                                                <div className="ml-6 mt-1 mb-1 space-y-0.5 border-l border-border-subtle pl-2">
                                                    {['Manual', 'VC Diligence', 'Lawyer — Wills', 'Sales call', 'Recruiting'].map(p => (
                                                        <button
                                                            key={p}
                                                            onClick={() => { setActivePersona(p); setShowPersonaPicker(false); }}
                                                            className={`w-full text-left px-2 py-1 rounded text-[12px] ${activePersona === p ? 'bg-amber-500/15 text-amber-300' : 'text-text-secondary hover:bg-bg-item-hover'}`}
                                                        >
                                                            {p}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="h-px bg-border-subtle my-1" />
                                            <button
                                                onClick={() => { setWebSearch(v => !v); setShowActions(false); }}
                                                className="w-full flex items-start gap-2 px-2 py-2 rounded-md hover:bg-bg-item-hover text-left"
                                            >
                                                <Globe size={14} className={`mt-0.5 ${webSearch ? 'text-emerald-400' : 'text-text-tertiary'}`} />
                                                <div>
                                                    <div className="text-[13px] font-medium text-white">Web search</div>
                                                    <div className="text-[11px] text-text-tertiary">{webSearch ? 'Enabled — falls back when KB has no answer' : 'Disabled — KB only'}</div>
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
                                        className="bg-bg-elevated border border-border-subtle rounded-xl p-4 w-[440px] max-h-[60vh] overflow-y-auto"
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
