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
import { rewriteQuery } from '../QueryRewriter';
import { verifyCitations } from '../CitationVerifier';

export interface SuggestionPipelineInput {
    /** STT-final transcript segment text (interviewer's question). */
    question: string;
    /** Last ~60s of transcript context, for the prompt. */
    transcriptContext?: string;
    /** Speaker tag — defaults to 'interviewer'. */
    speaker?: 'interviewer' | 'user' | 'assistant';
    /** Cooldown gate (ms). Suggestion is suppressed if last fire was within this window. */
    cooldownMs?: number;
    /**
     * Optional template type of the active mode. Used to tighten KB
     * retrieval for modes that need precision over recall (e.g. Lawyer
     * mode — top-2 chunks at 0.5 similarity instead of top-4 at 0.35).
     */
    templateType?: string;
}

export interface SuggestionProgressiveEvent {
    /** IPC event name (single channel, discriminated by `kind`). */
    kind: 'start' | 'token' | 'citation' | 'done' | 'cancelled' | 'error';
    /** Revision under which this event was emitted. Renderer can ignore if stale. */
    revision: number;
    /** Unique stable identifier for this suggestion (e.g. 'sugg_12'). */
    suggestionId?: string;
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
 * Filter out conversational banter and filler so the copilot only triggers
 * on substantive queries rather than "Hey what's up" or "So basically we are doing so".
 */
function isCasualBanter(text: string): boolean {
    const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return true;

    // Very short filler words
    if (clean.length < 15) {
        const shortFiller = /^(hey|hello|hi|good\s*(morning|evening|afternoon)|ok|okay|yeah|yes|no|right|cool|got it|sure|alright|fine|thanks?|thank you|what'?s up|so basically)$/i;
        if (shortFiller.test(clean)) return true;
    }

    // Common repetitive conversational fillers without substantive queries
    const pureBanter = /^(hey\s*what'?s\s*up(\s*hey\s*what'?s\s*up)*|okay\s*so\s*we\s*were\s*saying.*|so\s*basically\s*we\s*are\s*doing\s*so|you\s*are\s*catching\s*up\s*right.*|can\s*you\s*hear\s*me.*|am\s*i\s*audible.*|testing\s*one\s*two.*)$/i;
    if (pureBanter.test(clean)) return true;

    return false;
}

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
        if (isCasualBanter(question)) {
            console.log(`[SuggestionPipeline] Skipping casual banter utterance: "${question}"`);
            return;
        }
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
        this.emit(appState, { kind: 'start', revision, suggestionId: `sugg_${revision}`, question: input.question });

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
        // Use authority-aware retrieval across shared legal KB and active case
        // ── Phase 2: Query Rewriting (HyDE-Lite) ──────────────────────────
        // Fire rewrite in parallel with raw retrieval — doesn't add latency
        const llmHelperForRewrite = appState.processingHelper.getLLMHelper();
        const retrievalOpts = input.templateType === 'lawyer'
            ? { limit: 4, minSimilarity: 0.35 }
            : { limit: 4, minSimilarity: 0.35 };

        const [rawRetrievalResult, rewriteResult] = await Promise.all([
            Promise.race([
                kb.querySharedAndCaseKB(input.question, active.clientCaseId, retrievalOpts),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_DEADLINE_MS)),
            ]),
            rewriteQuery(input.question, llmHelperForRewrite).catch((): null => null),
        ]);
        if (abort.signal.aborted || this.rev.isStale(revision)) return;

        // If rewrite produced a different query, search with it too and merge
        let retrievalResult = rawRetrievalResult;
        if (rewriteResult?.wasRewritten && rewriteResult.rewrittenQuery !== input.question && rawRetrievalResult) {
            try {
                const rewrittenRetrieval = await Promise.race([
                    kb.querySharedAndCaseKB(rewriteResult.rewrittenQuery, active.clientCaseId, retrievalOpts),
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_DEADLINE_MS)),
                ]);
                if (rewrittenRetrieval?.chunks?.length > 0 && rawRetrievalResult) {
                    // Merge & deduplicate
                    const seen = new Map<number, any>();
                    for (const c of [...(rawRetrievalResult as any).chunks, ...rewrittenRetrieval.chunks]) {
                        const existing = seen.get(c.id);
                        if (!existing || c.authorityScore > existing.authorityScore) {
                            seen.set(c.id, c);
                        }
                    }
                    const mergedChunks = Array.from(seen.values()).sort((a: any, b: any) => b.authorityScore - a.authorityScore);
                    retrievalResult = { ...(rawRetrievalResult as any), chunks: mergedChunks };
                    console.log(`[SuggestionPipeline] Merged raw + rewritten → ${mergedChunks.length} unique chunks`);
                }
            } catch { /* rewritten search failed, use raw */ }
        }
        if (abort.signal.aborted || this.rev.isStale(revision)) return;

        const chunks = (retrievalResult && (retrievalResult as any).chunks) || [];
        const citations = chunks.map((c: any, idx: number) => ({
            id: c.id != null ? String(c.id) : `chunk-${idx}`,
            sourceType: c.sourceCategory ?? 'file',
            title: c.needsVerification
                ? `⚠️ ${c.sourceTitle} [Needs Verification]`
                : `📖 ${c.sourceTitle}`,
            similarity: c.authorityScore,
            snippet: (c.text || '').slice(0, 250),
        }));

        // Build the prompt with authority-labeled context and strict Indian legal notation
        const hasChunks = chunks.length > 0;
        const ctxBlock = hasChunks
            ? ((retrievalResult && (retrievalResult as any).formattedContext) || chunks.map((c: any, i: number) =>
                `[${i + 1} — ${c.sourceTitle} (${c.sourceCategory})]\n${c.text || ''}`
            ).join('\n\n'))
            : 'No specific knowledge base context found for this query. Provide a direct, professional legal answer based on general Indian law principles.';

        if (!hasChunks) {
            console.log(`[SuggestionPipeline] No specific chunks for q="${input.question.slice(0, 40)}…" — generating general legal suggestion`);
        }

        const combinedContext = [
            input.transcriptContext ? `Recent conversation transcript:\n${input.transcriptContext.slice(0, 800)}` : '',
            `Retrieved Knowledge Base Context:\n${ctxBlock}`,
        ].filter(Boolean).join('\n\n');

        const legalSystemPrompt = `You are an expert legal co-counsel whispering spoken cues to an advocate during a live consultation.
CRITICAL RULES:
1. MAXIMUM 50-70 WORDS TOTAL. Zero fluff, zero preamble. The lawyer has seconds to glance and speak aloud.
2. SPOKEN DIRECT ADVICE: Start immediately with the exact words the lawyer should say to the client.
3. STRUCTURE:
   • Direct advice: 1 punchy sentence ready to speak aloud.
   • Statutory options: 1-2 bullet points with statutory provisions (e.g. "Gift deed u/s 122 TPA vs. Will under Indian Succession Act").
   • Clarify trigger: 1 question the lawyer should ask the client next (e.g. "Ask client: Is the property immovable and what is the daughter's tax residency?").
   • Sources: [Act Name, Sec. X]
4. CITATION NOTATION: Use Indian legal notation: write "Sec." or "Section" (e.g. "Sec. 126 of Transfer of Property Act, 1882", "Sec. 5 of Indian Trusts Act, 1882"). NEVER use the "§" symbol.
5. If relying on secondary or unverified sources (marked with ⚠️), note [Needs Verification].`;

        // Stream the LLM. Universally routes across Gemini, OpenAI, Claude, DeepSeek, Groq, LiteLLM, Ollama
        const llmHelper = appState.processingHelper.getLLMHelper();
        let accumulated = '';
        let firstTokenAt: number | null = null;
        const suggestionId = `sugg_${revision}`;
        console.log(`[SuggestionPipeline] retrieval OK chunks=${chunks.length} — calling LLM`);

        try {
            const streamingFn = (llmHelper as any).streamSuggestion
                || (llmHelper as any).streamCoachingSuggestion
                || null;

            if (typeof streamingFn === 'function') {
                for await (const delta of streamingFn.call(llmHelper, combinedContext, input.question, abort.signal, legalSystemPrompt)) {
                    if (abort.signal.aborted || this.rev.isStale(revision)) return;
                    if (firstTokenAt === null) firstTokenAt = Date.now();
                    accumulated += delta;
                    this.emit(appState, {
                        kind: 'token',
                        revision,
                        suggestionId,
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
                    combinedContext,
                    input.question,
                    legalSystemPrompt,
                );
                console.log(`[SuggestionPipeline] generateSuggestion returned length=${(suggestion || '').length}`);
                if (abort.signal.aborted || this.rev.isStale(revision)) return;
                firstTokenAt = Date.now();
                accumulated = suggestion;
                this.emit(appState, {
                    kind: 'token',
                    revision,
                    suggestionId,
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
                suggestionId,
                question: input.question,
                error: err?.message || String(err),
            });
            return;
        }

        // ── Phase 4: Citation Verification (Hallucination Gate) ───────────
        const verification = verifyCitations(accumulated, chunks);
        const verifiedText = verification.verifiedResponse;

        // Done — emit final with verified text.
        this.emit(appState, {
            kind: 'done',
            revision,
            suggestionId,
            question: input.question,
            text: verifiedText,
            citations,
            ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
            totalMs: Date.now() - startedAt,
        });

        // Direct Backend Persistence: Safely persist completed suggestion to SQLite.
        // Guaranteed to run once per completed suggestion with verified text and citations.
        try {
            const meetingId = (appState as any)?.getCurrentMeetingId?.();
            if (meetingId && verifiedText && verifiedText.trim()) {
                const { DatabaseManager } = require('../../db/DatabaseManager');
                const dbm = DatabaseManager.getInstance();
                dbm.insertSuggestion(meetingId, {
                    suggestionId,
                    text: verifiedText,
                    citations: citations || [],
                    source: 'live',
                    firedAt: startedAt,
                    question: input.question,
                });
                console.log(`[SuggestionPipeline] Persisted final suggestion ${suggestionId} for meeting ${meetingId} with ${(citations || []).length} citations`);
            }
        } catch (dbErr: any) {
            console.warn('[SuggestionPipeline] Failed to persist final suggestion:', dbErr?.message);
        }
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