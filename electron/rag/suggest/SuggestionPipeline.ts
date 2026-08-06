// electron/rag/suggest/SuggestionPipeline.ts
// Event-driven, revision-guarded, streaming suggestion pipeline.
//
// Replaces the non-streaming path that lived inside runKbSuggest (kbSuggest.ts:77).
// Wires into the existing event source at electron/main.ts (STT-final segments)
// and emits progressive tokens via IPC channel `suggestion:progressive`.
//
// Lifecycle per utterance:
//   1. IntelligenceManager emits a final transcript segment.
//   2. main.ts calls SuggestionPipeline.onTranscriptFinal(segment).
//   3. Pipeline bumps RevisionTracker, starts a retrieval + streaming LLM call
//      stamped with that revision ID.
//   4. Pipeline emits progressive tokens to renderer via `suggestion:progressive`.
//   5. On any new revision (transcript update), in-flight retrieval/generation
//      is cancelled; previous tokens discarded.
//
// Latency budget (matches plan):
//   - TopicRouter (Phase 1+): <30ms, deterministic, no network
//   - KB retrieval: <300ms hard deadline
//   - LLM first token: 300-500ms (Gemini 2.0 Flash streaming)
//   - First useful line: 0.8-1.7s end-to-end
//
// For Phase 2-lite (this commit): only streaming + revision-guarding are wired.
// TopicRouter / cloud retrieval / cross-persona fusion come in Phase 1+2.

import { getRevisionTracker, RevisionTracker } from './RevisionTracker';
import type { AppState } from '../../main';

export interface SuggestionPipelineInput {
    /** STT-final transcript segment text (interviewer's question). */
    question: string;
    /** Last ~60s of transcript context, for the prompt. */
    transcriptContext?: string;
    /** Speaker tag — defaults to 'interviewer'. */
    speaker?: 'interviewer' | 'user' | 'assistant';
    /** Cooldown gate (ms). Suggestion is suppressed if last fire was within this window. */
    cooldownMs?: number;
}

export interface SuggestionProgressiveEvent {
    /** IPC event name (single channel, discriminated by `kind`). */
    kind: 'start' | 'token' | 'citation' | 'done' | 'cancelled' | 'error';
    /** Revision under which this event was emitted. Renderer can ignore if stale. */
    revision: number;
    /** Question / utterance that triggered this suggestion. */
    question?: string;
    /** Cumulative streamed text so far (set on token/done). */
    text?: string;
    /** Token delta (set on token events only). */
    delta?: string;
    /** Citation list (set on done). */
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    /** Error message (set on error events only). */
    error?: string;
    /** Latency telemetry in ms (set on done). */
    ttftMs?: number;
    totalMs?: number;
}

const DEFAULT_COOLDOWN_MS = 5_000; // matches main.ts LIVE_SUGGEST_COOLDOWN_MS
const RETRIEVAL_DEADLINE_MS = 300;
const STALE_AFTER_MS = 8_000; // give up on an in-flight job after this even without a revision bump

/**
 * SuggestionPipeline owns the latency-critical real-time path.
 *
 * One instance per app (singleton). It does NOT maintain polling state.
 * It listens for caller-invoked `onTranscriptFinal()` and runs the pipeline.
 *
 * The renderer subscribes via the `suggestion:progressive` IPC channel and
 * uses `revision` to drop stale events.
 */
export class SuggestionPipeline {
    private readonly rev: RevisionTracker;
    private lastFireAt: number = 0;
    private lastFireQuestion: string = '';
    private activeAbort: AbortController | null = null;

    constructor() {
        this.rev = getRevisionTracker();
    }

    /**
     * Entry point. Called from main.ts when a final transcript segment arrives.
     *
     * Returns immediately after kicking off the work. Results stream to renderer
     * via the `suggestion:progressive` IPC channel.
     */
    onTranscriptFinal(input: SuggestionPipelineInput, appState: AppState): void {
        const question = (input.question || '').trim();
        if (question.length < 8) return; // matches main.ts:2858 gate
        console.log(`[SuggestionPipeline] onTranscriptFinal speaker=${input.speaker || '?'} q="${question.slice(0, 60)}${question.length > 60 ? '…' : ''}"`);

        const now = Date.now();
        const cooldown = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        if (now - this.lastFireAt < cooldown) return;

        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
        if (norm(question) === norm(this.lastFireQuestion)) return;

        this.lastFireAt = now;
        this.lastFireQuestion = question;

        // Cancel any in-flight job. The new utterance supersedes the old.
        if (this.activeAbort) {
            try { this.activeAbort.abort(); } catch { /* ignore */ }
        }
        const abort = new AbortController();
        this.activeAbort = abort;

        const revision = this.rev.bump();

        // Fire-and-forget. The promise resolves with undefined on stale jobs.
        // Wrap in try/catch so any sync throw inside runPipeline doesn't bubble
        // up to a window.on('unhandledRejection') handler that crashes Electron.
        try {
            this.runPipeline({ ...input, question }, revision, abort, appState).catch((err: any) => {
                console.warn('[SuggestionPipeline] runPipeline rejected:', err?.message || err);
                try {
                    this.emit(appState, {
                        kind: 'error',
                        revision,
                        question,
                        error: err?.message || String(err),
                    });
                } catch { /* emit itself failed — swallow to keep app alive */ }
            });
        } catch (syncErr: any) {
            console.warn('[SuggestionPipeline] runPipeline threw synchronously:', syncErr?.message || syncErr);
        }

        // Auto-clear abort reference if it hangs.
        setTimeout(() => {
            if (this.activeAbort === abort) this.activeAbort = null;
        }, STALE_AFTER_MS).unref?.();
    }

    private async runPipeline(
        input: SuggestionPipelineInput,
        revision: number,
        abort: AbortController,
        appState: AppState,
    ): Promise<void> {
        const startedAt = Date.now();

        // Signal start.
        this.emit(appState, { kind: 'start', revision, question: input.question });

        // Pull KB context. Guarded by revision so a faster-than-retrieval next
        // utterance doesn't cause stale chunks to feed the LLM.
        const { getActiveClientCase } = await import('./KnowledgeBaseGate');
        const { KnowledgeBaseManager } = await import('../KnowledgeBaseManager');
        const active = getActiveClientCase();
        if (!active.clientCaseId) {
            this.emit(appState, { kind: 'done', revision, question: input.question, text: '' });
            return;
        }

        // Wire pipeline if needed.
        const kb = KnowledgeBaseManager.getInstance();
        const ragManager = appState.getRAGManager?.();
        if (!kb.isReady() && ragManager && ragManager.isReady()) {
            const vs = (ragManager as any).vectorStore;
            const ep = (ragManager as any).embeddingPipeline;
            if (vs && ep) kb.setPipeline(vs, ep);
        }

        // Retrieval with a soft deadline.
        const retrievalPromise = kb.queryKnowledgeBase(
            active.clientCaseId,
            input.question,
            { limit: 4, minSimilarity: 0.35 },
        );
        const retrievalResult = await Promise.race([
            retrievalPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_DEADLINE_MS)),
        ]);
        if (abort.signal.aborted || this.rev.isStale(revision)) return;

        const chunks = (retrievalResult && (retrievalResult as any).chunks) || [];
        const citations = chunks.map((c: any, idx: number) => ({
            id: c.id ?? `chunk-${idx}`,
            sourceType: c.sourceType ?? 'file',
            title: c.title ?? 'Knowledge Source',
            similarity: c.score,
            snippet: (c.text || '').slice(0, 200),
        }));

        if (chunks.length === 0) {
            // No KB context — still emit a suggestion, but with NO chunks fed to
            // the prompt (so the LLM doesn't hallucinate a citation). The user
            // sees a generic answer instead of silence. This is intentionally
            // permissive for testing; production deployments should gate on
            // chunks.length > 0 once KBs are populated.
            console.log(`[SuggestionPipeline] NO CHUNKS for q="${input.question.slice(0, 40)}…" — emitting generic suggestion`);
            this.emit(appState, { kind: 'done', revision, question: input.question, text: '', citations: [] });
            // Don't return — fall through to the LLM call below with empty ctxBlock.
        }

        // Build the prompt (matches existing kbSuggest.ts:64-74 shape, kept for parity).
        const ctxBlock = chunks.map((c: any, i: number) =>
            `[${i + 1}${c.title ? ` — ${c.title}` : ''}] ${c.text || ''}`
        ).join('\n\n');
        const prompt = `You are coaching a user during a live conversation. The user just heard/asked:

"${input.question}"

${input.transcriptContext ? `Recent transcript:\n${input.transcriptContext.slice(0, 800)}\n\n` : ''}Reference context from the active client's knowledge base:
${ctxBlock}

Write a SHORT (1-3 sentence) suggested follow-up the user could say next, grounded in the reference context. Be direct, conversational, and natural. Do not include citations, footnotes, or preamble — just the words they could say.`;

        // Stream the LLM. Falls through to LLMHelper's existing streaming path
        // (which itself uses Gemini 2.0 Flash with prompt caching via cachedContent).
        const llmHelper = appState.processingHelper.getLLMHelper();
        let accumulated = '';
        let firstTokenAt: number | null = null;
        console.log(`[SuggestionPipeline] retrieval OK chunks=${chunks.length} — calling LLM`);

        try {
            // Prefer a streaming method if LLMHelper exposes one (it does — see
            // streamGeminiTextCascade). Fall back to the legacy non-streaming
            // generateSuggestion() if no streaming API is available in this build.
            const streamingFn = (llmHelper as any).streamSuggestion
                || (llmHelper as any).streamCoachingSuggestion
                || null;

            if (typeof streamingFn === 'function') {
                for await (const delta of streamingFn.call(llmHelper, input.transcriptContext || ctxBlock, input.question, abort.signal)) {
                    if (abort.signal.aborted || this.rev.isStale(revision)) return;
                    if (firstTokenAt === null) firstTokenAt = Date.now();
                    accumulated += delta;
                    this.emit(appState, {
                        kind: 'token',
                        revision,
                        question: input.question,
                        delta,
                        text: accumulated,
                    });
                }
            } else {
                // Legacy non-streaming fallback (still revision-guarded).
                console.log(`[SuggestionPipeline] using non-streaming generateSuggestion() (no streamingFn on LLMHelper)`);
                if (abort.signal.aborted || this.rev.isStale(revision)) return;
                const suggestion = await llmHelper.generateSuggestion(
                    input.transcriptContext || ctxBlock,
                    input.question,
                );
                console.log(`[SuggestionPipeline] generateSuggestion returned length=${(suggestion || '').length}`);
                if (abort.signal.aborted || this.rev.isStale(revision)) return;
                firstTokenAt = Date.now();
                accumulated = suggestion;
                this.emit(appState, {
                    kind: 'token',
                    revision,
                    question: input.question,
                    delta: suggestion,
                    text: accumulated,
                });
                console.log(`[SuggestionPipeline] emitted token, text="${(accumulated || '').slice(0, 80)}…"`);
            }
        } catch (err: any) {
            if (abort.signal.aborted) return;
            this.emit(appState, {
                kind: 'error',
                revision,
                question: input.question,
                error: err?.message || String(err),
            });
            return;
        }

        // Done — emit final.
        this.emit(appState, {
            kind: 'done',
            revision,
            question: input.question,
            text: accumulated,
            citations,
            ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
            totalMs: Date.now() - startedAt,
        });
    }

    private emit(appState: AppState, event: SuggestionProgressiveEvent): void {
        // Import electron lazily so this module stays importable in tests.
        try {
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach((win: any) => {
                if (!win.isDestroyed()) {
                    win.webContents.send('suggestion:progressive', event);
                }
            });
        } catch {
            /* electron not available (unit tests) */
        }
    }
}

let _instance: SuggestionPipeline | null = null;

export function getSuggestionPipeline(): SuggestionPipeline {
    if (!_instance) {
        _instance = new SuggestionPipeline();
    }
    return _instance;
}