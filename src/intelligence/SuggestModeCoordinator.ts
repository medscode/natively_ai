// src/intelligence/SuggestModeCoordinator.ts
// Auto-detecting polling coordinator for Suggest Mode in the Meeting Copilot chat.
//
// Behavior:
// - When Suggest Mode is ON, polls every 5s.
// - On each tick, picks context:
//   (a) live transcript if chatGetTranscriptContext returns available && non-empty text
//   (b) otherwise falls back to the last user chat message (mock mode — useful when
//       audio capture is unavailable on the user's machine).
// - Calls kb:suggest with that context.
// - No-spam guards: skip if a previous kb:suggest is in flight; skip if the last
//   user message has not changed since the last successful suggestion.
// - Toggling OFF stops the interval; toggling ON does NOT replay history (no
//   catch-up pass) — matches the SuggestModeSettings copy.

export interface SuggestionPayload {
    suggestion: string;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    source: 'live' | 'mock';
    at: number;
}

export interface CoordinatorCallbacks {
    onSuggestion: (s: SuggestionPayload) => void;
    getMode: () => 'manual' | 'suggest';
    getWebSearch: () => boolean;
    getLastUserMessage: () => string;
    getActiveTranscript: () => Promise<string>;
}

const POLL_INTERVAL_MS = 5_000;
const FALLBACK_QUESTION = 'What should I say or ask next in this conversation?';

export class SuggestModeCoordinator {
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private inflight: boolean = false;
    private lastTriggeredQuestion: string = '';
    private lastTickAt: number = 0;
    private onSuggestion: (s: SuggestionPayload) => void;
    private getMode: () => 'manual' | 'suggest';
    private getWebSearch: () => boolean;
    private getLastUserMessage: () => string;
    private getActiveTranscript: () => Promise<string>;

    constructor(callbacks: CoordinatorCallbacks) {
        this.onSuggestion = callbacks.onSuggestion;
        this.getMode = callbacks.getMode;
        this.getWebSearch = callbacks.getWebSearch;
        this.getLastUserMessage = callbacks.getLastUserMessage;
        this.getActiveTranscript = callbacks.getActiveTranscript;
    }

    start(): void {
        if (this.intervalId != null) return;
        this.intervalId = setInterval(() => { this.tick(); }, POLL_INTERVAL_MS);
        // Fire one immediate tick so the user sees something fast on enable.
        setTimeout(() => this.tick(), 250);
    }

    stop(): void {
        if (this.intervalId != null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    isRunning(): boolean {
        return this.intervalId != null;
    }

    private async tick(): Promise<void> {
        // Skip if mode toggled off between scheduled intervals
        if (this.getMode() !== 'suggest') return;
        if (this.inflight) return;

        const lastUser = this.getLastUserMessage();
        const candidate = (lastUser && lastUser.trim().length > 0) ? lastUser.trim() : FALLBACK_QUESTION;

        // No-spam: skip if we already produced a suggestion for the same question.
        if (candidate === this.lastTriggeredQuestion) return;

        // Pick context source: live transcript vs mock (last user message).
        let transcript = '';
        try {
            transcript = (await this.getActiveTranscript()) || '';
        } catch {
            transcript = '';
        }

        const source: 'live' | 'mock' = transcript.length > 0 ? 'live' : 'mock';
        const question = source === 'mock' && !lastUser ? FALLBACK_QUESTION : candidate;

        this.inflight = true;
        this.lastTickAt = Date.now();

        try {
            const result = await (window as any).electronAPI?.kbSuggest?.({ question, transcriptContext: transcript });
            if (!result || !result.success || !result.suggestion) {
                return;
            }
            this.lastTriggeredQuestion = candidate;
            this.onSuggestion({
                suggestion: result.suggestion,
                citations: result.citations,
                source,
                at: this.lastTickAt,
            });
        } catch (e: any) {
            console.warn('[SuggestModeCoordinator] kb:suggest failed:', e?.message || e);
        } finally {
            this.inflight = false;
        }
    }
}
