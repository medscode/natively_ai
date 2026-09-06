// src/intelligence/SuggestModeCoordinator.ts
// Event-driven subscriber for Suggest Mode in the Meeting Copilot chat.
//
// Replaces the prior 5s polling loop (POLL_INTERVAL_MS) with a direct
// subscription to the main-process IPC channel `suggestion:progressive`.
// The main process fires SuggestionPipeline.onTranscriptFinal() on every
// interviewer-final transcript segment; SuggestionPipeline streams tokens
// back to the renderer via this channel.
//
// Behavior:
// - start(): subscribe to IPC events from main process.
// - stop(): unsubscribe.
// - onSuggestion(): invoked as tokens stream in (start → token* → done).
//   Stale events (revision older than current) are dropped silently.
//
// Manual triggers (Sparkles button, ••• More menu) still go through the
// legacy `kb:suggest` IPC, which routes to the non-streaming shim.
//
// Latency budget:
// - Old: 3-7s (5s polling + ~2s LLM)
// - New: 0.8-1.7s (event-driven + streaming LLM TTFT)

export interface SuggestionPayload {
    id?: string;
    suggestion: string;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    source: 'live' | 'mock';
    at: number;
    question?: string;
    isDone?: boolean;
}

export interface SuggestionProgressiveEvent {
    kind: 'start' | 'token' | 'citation' | 'done' | 'cancelled' | 'error';
    revision: number;
    suggestionId?: string;
    question?: string;
    text?: string;
    delta?: string;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    error?: string;
    ttftMs?: number;
    totalMs?: number;
}

export interface CoordinatorCallbacks {
    onSuggestion: (s: SuggestionPayload) => void;
    getMode: () => 'manual' | 'suggest';
}

export class SuggestModeCoordinator {
    private currentRevision: number = -1;
    private currentQuestion: string = '';
    private lastSuggestionText: string = '';
    private currentRevisionStartTime: number = 0;
    private onSuggestion: (s: SuggestionPayload) => void;
    private getMode: () => 'manual' | 'suggest';
    private unsubscribe: (() => void) | null = null;

    constructor(callbacks: CoordinatorCallbacks) {
        this.onSuggestion = callbacks.onSuggestion;
        this.getMode = callbacks.getMode;
    }

    start(): void {
        if (this.unsubscribe) return;
        // Wire to main-process progressive IPC channel.
        const api = (window as any).electronAPI;
        if (!api?.onSuggestionProgressive) {
            console.warn('[SuggestModeCoordinator] electronAPI.onSuggestionProgressive unavailable; falling back to no-op');
            return;
        }
        this.unsubscribe = api.onSuggestionProgressive((event: SuggestionProgressiveEvent) => {
            this.handleEvent(event);
        });
    }

    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }

    isRunning(): boolean {
        return this.unsubscribe != null;
    }

    private handleEvent(event: SuggestionProgressiveEvent): void {
        // No mode gate here: in Suggest mode events come from the auto-fired
        // pipeline; in Manual mode events come from the Sparkles button click.
        // Both should render as bubbles. The panel decides what to do with
        // suggestions in the suggestionSave IPC (uses the cached meetingId).

        // Drop stale events from superseded jobs.
        if (event.revision < this.currentRevision) return;

        switch (event.kind) {
            case 'start':
                this.currentRevision = event.revision;
                this.currentQuestion = event.question || '';
                this.lastSuggestionText = '';
                this.currentRevisionStartTime = Date.now();
                return;

            case 'token': {
                const text = event.text || '';
                this.lastSuggestionText = text;
                const id = event.suggestionId || `sugg_${event.revision}`;
                // Emit a live payload with whatever we've streamed so far.
                // Consumers can re-render on every token; the SuggestionPayload
                // is the *latest snapshot*, not a delta.
                this.onSuggestion({
                    id,
                    suggestion: text,
                    citations: undefined,
                    source: 'live',
                    at: this.currentRevisionStartTime || Date.now(),
                    question: this.currentQuestion || event.question,
                    isDone: false,
                });
                return;
            }

            case 'citation': {
                // Could be merged into the final payload later. For now we
                // attach citations on done; this event is reserved for
                // future per-citation streaming.
                return;
            }

            case 'done': {
                const text = event.text ?? this.lastSuggestionText;
                const id = event.suggestionId || `sugg_${event.revision}`;
                // Phase P: include question (the transcript snippet that triggered
                // this suggestion) so the Suggestions tab + chat-bubble history
                // can render it. The renderer previously had no way to know
                // which transcript line produced each suggestion.
                this.onSuggestion({
                    id,
                    suggestion: text,
                    citations: event.citations,
                    source: 'live',
                    question: this.currentQuestion || event.question || undefined,
                    at: this.currentRevisionStartTime || Date.now(),
                    isDone: true,
                });
                // Telemetry hook (optional). Plan target: TTFT <1.4s, total <1.8s.
                if (event.totalMs != null) {
                    try {
                        (window as any).electronAPI?.sendTelemetry?.('live_suggestion_done', {
                            ttftMs: event.ttftMs ?? null,
                            totalMs: event.totalMs,
                            revision: event.revision,
                            hasCitations: !!event.citations?.length,
                        });
                    } catch { /* ignore */ }
                }
                return;
            }

            case 'cancelled':
            case 'error':
                // Renderer treats this as "discard"; the next start() event
                // for a new revision will open a fresh suggestion.
                return;

            default:
                return;
        }
    }
}