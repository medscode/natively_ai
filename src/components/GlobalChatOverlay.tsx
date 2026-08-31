import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStreamBuffer } from '../hooks/useStreamBuffer';
import { X, Copy, Check, Globe, ArrowUp, BookOpen, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { genMessageId } from '../utils/messageId';
import nativelyIcon from './icon.png';

// ============================================
// Types
// ============================================

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming?: boolean;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
}

interface GlobalChatOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    initialQuery?: string;
}

// ============================================
// Typing Indicator Component
// ============================================

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

// ============================================
// Message Components
// ============================================

const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex justify-end mb-6"
    >
        <div className="bg-[#2C2C2E] text-white px-5 py-3 rounded-2xl rounded-tr-md max-w-[70%] text-[15px] leading-relaxed">
            {content}
        </div>
    </motion.div>
);

const AssistantMessage: React.FC<{
    content: string;
    isStreaming?: boolean;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
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
                        {citations.map((c) => {
                            const isNeedsVerification = c.title?.includes('[Needs Verification]') || c.title?.startsWith('⚠️');
                            return (
                                <span
                                    key={c.id}
                                    title={c.snippet ? `${c.title}\n\nDocument Excerpt:\n${c.snippet}` : c.title}
                                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium ${
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
                        })}
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

// ============================================
// Main Component
// ============================================

type ChatState = 'idle' | 'waiting_for_llm' | 'streaming_response' | 'error';

const GlobalChatOverlay: React.FC<GlobalChatOverlayProps> = ({
    isOpen,
    onClose,
    initialQuery = ''
}) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [chatState, setChatState] = useState<ChatState>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const streamBuffer = useStreamBuffer();

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);

    // Submit initial query when overlay opens
    useEffect(() => {
        if (isOpen && initialQuery && messages.length === 0) {
            setTimeout(() => {
                submitQuestion(initialQuery);
            }, 100);
        }
    }, [isOpen, initialQuery]);

    // Listen for new queries from parent
    useEffect(() => {
        if (isOpen && initialQuery && messages.length > 0) {
            // This is a follow-up query
            submitQuestion(initialQuery);
        }
    }, [initialQuery]);

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

    // Click outside handler
    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    }, [onClose]);

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            submitQuestion(query);
            setQuery('');
        }
    };

    // Submit question using global RAG
    const submitQuestion = useCallback(async (question: string) => {
        if (!question.trim() || chatState === 'waiting_for_llm' || chatState === 'streaming_response') return;

        const userMessage: Message = {
            id: genMessageId(),
            role: 'user',
            content: question
        };
        setMessages(prev => [...prev, userMessage]);
        setChatState('waiting_for_llm');
        setErrorMessage(null);

        // Scroll to bottom when user sends message
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);

        const assistantMessageId = genMessageId();

        try {
            // Add typing indicator delay (200ms) - makes the AI feel "thoughtful"
            await new Promise(resolve => setTimeout(resolve, 200));

            // Create assistant message placeholder
            setMessages(prev => [...prev, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                isStreaming: true
            }]);

            // Detect whether an active client case is set; if yes, prefer KB over meeting RAG.
            let useKB = false;
            try {
                const activeResult = await window.electronAPI?.suggestGetActiveCase?.();
                useKB = !!(activeResult?.success && activeResult.clientCaseId);
            } catch {
                useKB = false;
            }

            if (useKB) {
                // KB-aware streaming: chunks + citations from active client case
                streamBuffer.reset();
                let citations: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }> = [];

                const citationsCleanup = window.electronAPI?.onKBStreamCitations((data) => {
                    citations = data.citations || [];
                });
                const tokenCleanup = window.electronAPI?.onKBStreamChunk((data: { text: string }) => {
                    setChatState('streaming_response');
                    streamBuffer.appendToken(data.text, (content) => {
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content, citations: citations.length > 0 ? citations : msg.citations }
                                : msg
                        ));
                    });
                });
                const doneCleanup = window.electronAPI?.onKBStreamComplete(() => {
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
                    citationsCleanup?.();
                });
                const errorCleanup = window.electronAPI?.onKBStreamError((data: { error: string }) => {
                    console.error('[GlobalChat] KB stream error:', data.error);
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    setErrorMessage(data?.error || "Couldn't get a response from the knowledge base.");
                    setChatState('error');
                    streamBuffer.reset();
                    tokenCleanup?.();
                    doneCleanup?.();
                    errorCleanup?.();
                    citationsCleanup?.();
                });

                const result = await window.electronAPI?.kbAsk?.({ question });
                if (result?.fallback) {
                    // KB pipeline not ready; fall through to meeting/global RAG below
                    tokenCleanup?.();
                    doneCleanup?.();
                    errorCleanup?.();
                    citationsCleanup?.();
                    // Reset the message and continue with the existing global RAG path
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: '', isStreaming: true }
                            : msg
                    ));
                } else if (!result?.success) {
                    setErrorMessage(result?.error || 'KB query failed');
                    setChatState('error');
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    return;
                } else {
                    return; // streaming handles the rest
                }
            }

            // Fallback: meeting/global RAG (preserves existing behavior)
            // Set up RAG streaming listeners (RAF-batched)
            streamBuffer.reset();
            const tokenCleanup = window.electronAPI?.onRAGStreamChunk((data: { chunk: string }) => {
                setChatState('streaming_response');
                streamBuffer.appendToken(data.chunk, (content) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content }
                            : msg
                    ));
                });
            });

            const doneCleanup = window.electronAPI?.onRAGStreamComplete(() => {
                const finalContent = streamBuffer.getBufferedContent();
                setMessages(prev => prev.map(msg =>
                    msg.id === assistantMessageId
                        ? { ...msg, content: finalContent, isStreaming: false }
                        : msg
                ));
                setChatState('idle');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            const errorCleanup = window.electronAPI?.onRAGStreamError((data: { error: string }) => {
                console.error('[GlobalChat] RAG stream error:', data.error);
                setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                setErrorMessage("Couldn't get a response. Please try again.");
                setChatState('error');
                streamBuffer.reset();
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();
            });

            // Use global RAG query
            const result = await window.electronAPI?.ragQueryGlobal(question);

            if (result?.fallback) {
                console.log("[GlobalChat] RAG unavailable, falling back to standard chat");
                // Cleanup RAG listeners
                tokenCleanup?.();
                doneCleanup?.();
                errorCleanup?.();

                // Setup fallback listeners (Standard Gemini)
                streamBuffer.reset();
                const oldTokenCleanup = window.electronAPI?.onGeminiStreamToken((token: string) => {
                    setChatState('streaming_response');
                    streamBuffer.appendToken(token, (content) => {
                        setMessages(prev => prev.map(msg =>
                            msg.id === assistantMessageId
                                ? { ...msg, content }
                                : msg
                        ));
                    });
                });

                const oldDoneCleanup = window.electronAPI?.onGeminiStreamDone(() => {
                    const finalContent = streamBuffer.getBufferedContent();
                    setMessages(prev => prev.map(msg =>
                        msg.id === assistantMessageId
                            ? { ...msg, content: finalContent, isStreaming: false }
                            : msg
                    ));
                    setChatState('idle');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                const oldErrorCleanup = window.electronAPI?.onGeminiStreamError((error: string) => {
                    console.error('[GlobalChat] Gemini stream error:', error);
                    setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
                    setErrorMessage("Couldn't get a response. Please check your settings.");
                    setChatState('error');
                    streamBuffer.reset();
                    oldTokenCleanup?.();
                    oldDoneCleanup?.();
                    oldErrorCleanup?.();
                });

                // Call standard chat
                await window.electronAPI?.streamGeminiChat(question, undefined, undefined, { skipSystemPrompt: false });
            }

        } catch (error) {
            console.error('[GlobalChat] Error:', error);
            setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
            setErrorMessage("Something went wrong. Please try again.");
            setChatState('error');
        }
    }, [chatState]);

    return (
        <AnimatePresence
            onExitComplete={() => {
                setChatState('idle');
                setMessages([]);
                setErrorMessage(null);
            }}
        >
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="absolute inset-0 z-40 flex flex-col justify-end"
                    onClick={handleBackdropClick}
                >
                    {/* Backdrop with blur */}
                    <motion.div
                        initial={{ backdropFilter: 'blur(0px)' }}
                        animate={{ backdropFilter: 'blur(8px)' }}
                        exit={{ backdropFilter: 'blur(0px)' }}
                        transition={{ duration: 0.16 }}
                        className="absolute inset-0 bg-black/40"
                    />

                    {/* Chat Window */}
                    <motion.div
                        ref={chatWindowRef}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "85vh", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                            height: { type: "spring", stiffness: 300, damping: 30, mass: 0.8 },
                            opacity: { duration: 0.2 }
                        }}
                        className="relative mx-auto w-full max-w-[680px] mb-0 bg-bg-secondary rounded-t-[24px] border-t border-x border-border-subtle shadow-2xl overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
                            <div className="flex items-center gap-2 text-text-tertiary">
                                <img src={nativelyIcon} className="w-3.5 h-3.5 force-black-icon opacity-50" alt="logo" />
                                <span className="text-[13px] font-medium">Search all meetings</span>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 transition-colors group"
                            >
                                <X size={16} className="text-text-tertiary group-hover:text-red-500 group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.5)] transition-all duration-300" />
                            </button>
                        </div>

                        {/* Messages area - scrollable */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 pb-32 custom-scrollbar">
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

                        {/* Floating Footer (Ask Bar) */}
                        <div className="absolute bottom-0 left-0 right-0 p-6 flex justify-center z-50 pointer-events-none">
                            <div className="w-full max-w-[440px] relative group pointer-events-auto">
                                {/* Dark Glass Effect Input */}
                                <input
                                    type="text"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder="Ask me anything..."
                                    className="w-full pl-5 pr-24 py-3 bg-bg-elevated shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-border-muted rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-all"
                                />
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
                                                setErrorMessage(result?.error || 'KB suggestion failed. Make sure a client case is active in Settings → Knowledge Base.');
                                                return;
                                            }
                                            setQuery('');
                                        }}
                                        title="Generate a follow-up suggestion grounded in your active knowledge base"
                                        className="p-1.5 rounded-full transition-all duration-200 border border-white/5 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25"
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
                                        className={`p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                                            }`}
                                    >
                                        <ArrowUp size={16} className="transform rotate-45" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default GlobalChatOverlay;
