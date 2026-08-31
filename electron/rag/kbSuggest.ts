// electron/rag/kbSuggest.ts
// KB-grounded live suggestion: pull active case KB chunks, build a coaching
// prompt, call llmHelper.generateSuggestion, broadcast suggestion-generated.
//
// Body extracted from the original `kb:suggest` IPC handler (ipcHandlers.ts:737)
// so both the IPC channel and the live auto-trigger in main.ts can call it
// without going through IPC plumbing.
//
// 2026-08 enhancements:
//   - Query rewriting (HyDE-Lite) for layman-to-legal vocabulary bridging
//   - Citation verification (hallucination gate) post-generation

import type { AppState } from '../main';
import { rewriteQuery } from './QueryRewriter';
import { verifyCitations } from './CitationVerifier';

export interface KbSuggestInput {
    question: string;
    transcriptContext?: string;
}

export interface KbSuggestResult {
    success: boolean;
    suggestion?: string;
    citations?: Array<{ id: string; sourceType: string; title: string; similarity?: number; snippet?: string }>;
    question?: string;
    error?: string;
    /** Query rewrite info (for debugging/eval). */
    rewriteInfo?: { wasRewritten: boolean; rewrittenQuery?: string; durationMs: number };
    /** Citation verification info (for debugging/eval). */
    verificationInfo?: { score: number; verifiedCount: number; unverifiedCount: number };
}

export async function runKbSuggest(
    input: KbSuggestInput,
    appState: AppState
): Promise<KbSuggestResult> {
    const question = (input?.question || '').trim();
    const transcriptContext = (input?.transcriptContext || '').trim();
    if (!question) {
        return { success: false, error: 'question is required' };
    }

    const { getActiveClientCase } = await import('./suggest/KnowledgeBaseGate');
    const { KnowledgeBaseManager } = await import('./KnowledgeBaseManager');
    const active = getActiveClientCase();

    const kb = KnowledgeBaseManager.getInstance();
    const ragManager = appState.getRAGManager();
    if (!kb.isReady() && ragManager && ragManager.isReady()) {
        const vs = (ragManager as any).vectorStore;
        const ep = (ragManager as any).embeddingPipeline;
        if (vs && ep) kb.setPipeline(vs, ep);
    }

    // ── Phase 2: Query Rewriting (HyDE-Lite) ──────────────────────────
    // Fire the rewrite in parallel with the raw query search.
    // If rewrite succeeds, we search with BOTH queries and merge results.
    const llmHelper = appState.processingHelper.getLLMHelper();
    const [rawResult, rewriteResult] = await Promise.all([
        kb.querySharedAndCaseKB(question, active.clientCaseId, { limit: 4 }),
        rewriteQuery(question, llmHelper).catch(() => null),
    ]);

    // If rewrite produced a different query, search with it too and merge
    let chunks = rawResult?.chunks || [];
    let formattedContext = rawResult?.formattedContext || '';

    if (rewriteResult?.wasRewritten && rewriteResult.rewrittenQuery !== question) {
        try {
            const rewrittenResult = await kb.querySharedAndCaseKB(
                rewriteResult.rewrittenQuery,
                active.clientCaseId,
                { limit: 4 },
            );
            if (rewrittenResult?.chunks?.length > 0) {
                // Merge & deduplicate by chunk ID, keeping higher authority score
                const seen = new Map<number, typeof chunks[0]>();
                for (const c of [...chunks, ...rewrittenResult.chunks]) {
                    const existing = seen.get(c.id);
                    if (!existing || c.authorityScore > existing.authorityScore) {
                        seen.set(c.id, c);
                    }
                }
                chunks = Array.from(seen.values()).sort((a, b) => b.authorityScore - a.authorityScore);
                // Rebuild formatted context from merged chunks
                if (chunks.length > rawResult.chunks.length) {
                    formattedContext = rawResult.formattedContext || '';
                }
                console.log(`[kbSuggest] Merged raw (${rawResult.chunks.length}) + rewritten (${rewrittenResult.chunks.length}) → ${chunks.length} unique chunks`);
            }
        } catch (e: any) {
            console.warn('[kbSuggest] Rewritten query search failed:', e?.message);
        }
    }

    const citations = chunks.map((c, idx: number) => ({
        id: c.id != null ? String(c.id) : `chunk-${idx}`,
        sourceType: c.sourceCategory ?? 'file',
        title: c.needsVerification
            ? `⚠️ ${c.sourceTitle} [Needs Verification]`
            : `📖 ${c.sourceTitle}`,
        similarity: c.authorityScore,
        snippet: (c.text || '').slice(0, 250),
    }));

    if (chunks.length === 0) {
        return { success: false, error: 'no_relevant_chunks', question };
    }

    // Build suggestion prompt with authority-labeled context and strict Indian legal formatting
    const ctxBlock = formattedContext || chunks.map((c, i: number) =>
        `[${i + 1} — ${c.sourceTitle} (${c.sourceCategory})]\n${c.text || ''}`
    ).join('\n\n');

    const prompt = `You are an expert legal co-counsel coaching a lawyer during a live client meeting.
The client just said / asked:
"${question}"

${transcriptContext ? `Recent conversation transcript:\n${transcriptContext.slice(0, 800)}\n\n` : ''}Retrieved Knowledge Base Context:
${ctxBlock}

STRUCTURE YOUR RESPONSE IN THIS EXACT ORDER:
1. DIRECT ANSWER (BOTTOM LINE): Provide a direct, clear 1-2 sentence answer that the lawyer can speak immediately to address the client's question. No preamble (do NOT say "Here is what to say" or "As a lawyer...").
2. KEY POINTS & STATUTORY BASIS: Follow with 2-3 concise bullet points with legal reasoning, conditions, exceptions, or procedural steps.
3. CITATION CONVENTION: Use the Indian legal notation format: use "Sec." or "Section" (e.g. "Sec. 126 of the Transfer of Property Act, 1882", "Sec. 6 of the Hindu Succession Act, 1956", "Order XXXIX of CPC, 1908"). NEVER use the "§" symbol.
4. EXACT DOCUMENT CITATION: Explicitly name the document/Act from which the rule is drawn. If relying on secondary sources (⚠️), note that it requires verification.`;

    let suggestion = '';
    try {
        suggestion = await llmHelper.chatWithGemini(prompt, undefined, undefined, true);
    } catch (e) {
        suggestion = await llmHelper.generateSuggestion(transcriptContext || ctxBlock, question);
    }

    // ── Phase 4: Citation Verification (Hallucination Gate) ───────────
    const verification = verifyCitations(suggestion, chunks);
    suggestion = verification.verifiedResponse;

    // Send to all renderer windows so MeetingChatPanel picks it up via its
    // own onSuggestion listener
    const { BrowserWindow } = await import('electron');
    BrowserWindow.getAllWindows().forEach((win: any) => {
        if (!win.isDestroyed()) {
            win.webContents.send('suggestion-generated', {
                question,
                suggestion,
                confidence: verification.score,
                citations,
                verificationScore: verification.score,
                unverifiedCitations: verification.citations.filter(c => !c.verified).map(c => c.citationText),
            });
        }
    });

    return {
        success: true,
        suggestion,
        citations,
        question,
        rewriteInfo: rewriteResult ? {
            wasRewritten: rewriteResult.wasRewritten,
            rewrittenQuery: rewriteResult.rewrittenQuery,
            durationMs: rewriteResult.durationMs,
        } : undefined,
        verificationInfo: {
            score: verification.score,
            verifiedCount: verification.verifiedCount,
            unverifiedCount: verification.unverifiedCount,
        },
    };
}
