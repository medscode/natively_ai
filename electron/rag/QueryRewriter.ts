// electron/rag/QueryRewriter.ts
// HyDE-Lite: Translates layman client speech into formal legal terminology
// before searching the vector DB, dramatically improving retrieval for
// informal questions like "my brother grabbed the ancestral land".
//
// Design:
//   - Runs in PARALLEL with the raw query search (doesn't add latency)
//   - 500ms hard timeout — if LLM doesn't respond, raw query proceeds alone
//   - LRU cache (50 entries) to avoid redundant API calls for similar questions
//   - Uses the cheapest/fastest available LLM (Gemini Flash)
//   - Falls through gracefully on any error — never blocks suggestions

const REWRITE_TIMEOUT_MS = 500;
const CACHE_MAX_SIZE = 50;

// ── LRU Cache ──────────────────────────────────────────────────────────

class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict least recently used (first entry)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    get size(): number {
        return this.cache.size;
    }
}

// ── System prompt ──────────────────────────────────────────────────────

const REWRITE_SYSTEM_PROMPT = `You are an Indian legal terminology expert. Your ONLY job is to rephrase a client's casual/layman question into a formal Indian legal query.

RULES:
- Output ONLY the rewritten query, nothing else (no explanation, no preamble)
- Include relevant Indian Act names and Section numbers when you can identify them
- Use formal legal terminology (e.g., "dispossession" not "grabbed", "partition suit" not "splitting property")
- Keep it under 50 words
- If the question is already legal/formal, return it unchanged
- Use Indian legal system references (IPC, CPC, Hindu Succession Act, Transfer of Property Act, etc.)
- Use "Sec." notation for sections (e.g., "Sec. 6 of Hindu Succession Act, 1956")

EXAMPLES:
Client: "my brother grabbed the ancestral land"
→ Partition suit for ancestral property and coparcenary rights under Sec. 6 of Hindu Succession Act, 1956

Client: "can I take back the gift I gave to my son?"
→ Revocation of gift and conditions under Sec. 126 of Transfer of Property Act, 1882

Client: "my tenant won't leave even after the lease ended"
→ Eviction of tenant after expiry of lease period, rights of landlord under rent control legislation

Client: "someone forged my signature on a property document"
→ Forgery of property documents, remedies under Sec. 463-465 IPC and civil suit for declaration`;

// ── Normalize for cache key ────────────────────────────────────────────

function normalizeForCache(query: string): string {
    return query.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Module-level cache ─────────────────────────────────────────────────

const rewriteCache = new LRUCache<string, string>(CACHE_MAX_SIZE);

// ── Core rewrite function ──────────────────────────────────────────────

export interface RewriteResult {
    /** The rewritten legal query (or original if rewrite failed/timed out). */
    rewrittenQuery: string;
    /** Whether the rewrite actually ran (false = cache hit, timeout, or error). */
    wasRewritten: boolean;
    /** Source of the result. */
    source: 'llm' | 'cache' | 'passthrough';
    /** Time taken in ms. */
    durationMs: number;
}

/**
 * Rewrite a layman client question into formal legal terminology.
 *
 * This function is designed to be called in PARALLEL with the raw query search.
 * It has a hard timeout and never throws — always returns a usable result.
 *
 * @param question - The raw client speech/question
 * @param llmHelper - The LLMHelper instance for Gemini calls
 * @returns RewriteResult with the rewritten (or original) query
 */
export async function rewriteQuery(
    question: string,
    llmHelper: { chatWithGemini?: (prompt: string, systemPrompt?: string, history?: any, json?: boolean) => Promise<string> } | null,
): Promise<RewriteResult> {
    const startedAt = Date.now();
    const trimmed = question.trim();

    // Skip very short or empty queries
    if (trimmed.length < 10) {
        return {
            rewrittenQuery: trimmed,
            wasRewritten: false,
            source: 'passthrough',
            durationMs: Date.now() - startedAt,
        };
    }

    // Check cache first
    const cacheKey = normalizeForCache(trimmed);
    const cached = rewriteCache.get(cacheKey);
    if (cached) {
        console.log(`[QueryRewriter] Cache hit for "${trimmed.slice(0, 40)}…"`);
        return {
            rewrittenQuery: cached,
            wasRewritten: true,
            source: 'cache',
            durationMs: Date.now() - startedAt,
        };
    }

    // No LLM helper available — passthrough
    if (!llmHelper || typeof llmHelper.chatWithGemini !== 'function') {
        console.log('[QueryRewriter] No LLM available — passthrough');
        return {
            rewrittenQuery: trimmed,
            wasRewritten: false,
            source: 'passthrough',
            durationMs: Date.now() - startedAt,
        };
    }

    // Call LLM with timeout
    try {
        const prompt = `Client question: "${trimmed}"`;

        const rewritten = await Promise.race([
            llmHelper.chatWithGemini(prompt, REWRITE_SYSTEM_PROMPT),
            new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('QueryRewriter timeout')), REWRITE_TIMEOUT_MS)
            ),
        ]);

        const cleaned = (rewritten || '').trim();

        // Sanity check: if the LLM returned garbage or empty, use original
        if (cleaned.length < 5 || cleaned.length > 300) {
            console.warn(`[QueryRewriter] LLM returned bad result (len=${cleaned.length}), using original`);
            return {
                rewrittenQuery: trimmed,
                wasRewritten: false,
                source: 'passthrough',
                durationMs: Date.now() - startedAt,
            };
        }

        // Strip any leading "→" or quotes the LLM might have added
        const finalQuery = cleaned
            .replace(/^[→►▸•\-]\s*/, '')
            .replace(/^["']|["']$/g, '')
            .trim();

        // Cache the successful rewrite
        rewriteCache.set(cacheKey, finalQuery);

        console.log(`[QueryRewriter] Rewrote in ${Date.now() - startedAt}ms: "${trimmed.slice(0, 30)}…" → "${finalQuery.slice(0, 50)}…"`);

        return {
            rewrittenQuery: finalQuery,
            wasRewritten: true,
            source: 'llm',
            durationMs: Date.now() - startedAt,
        };
    } catch (err: any) {
        // Timeout or API error — use original query
        const reason = err?.message?.includes('timeout') ? 'timeout' : 'error';
        console.warn(`[QueryRewriter] ${reason}: ${err?.message || err} — using original query`);
        return {
            rewrittenQuery: trimmed,
            wasRewritten: false,
            source: 'passthrough',
            durationMs: Date.now() - startedAt,
        };
    }
}

/**
 * Run both the raw query and a rewritten query search in parallel,
 * merging and deduplicating the results.
 *
 * @param question - Raw client question
 * @param searchFn - The search function to call with each query variant
 * @param llmHelper - LLMHelper for the rewrite call
 * @returns Merged, deduplicated results from both searches
 */
export async function searchWithRewrite<T extends { id: number; similarity?: number; authorityScore?: number }>(
    question: string,
    searchFn: (query: string) => Promise<{ chunks: T[]; formattedContext: string; [key: string]: any }>,
    llmHelper: { chatWithGemini?: (...args: any[]) => Promise<string> } | null,
): Promise<{ chunks: T[]; formattedContext: string; rewriteResult: RewriteResult; [key: string]: any }> {
    // Fire both in parallel
    const [rawResult, rewriteResult] = await Promise.all([
        searchFn(question),
        rewriteQuery(question, llmHelper),
    ]);

    // If rewrite produced the same query or failed, just return raw results
    if (!rewriteResult.wasRewritten || normalizeForCache(rewriteResult.rewrittenQuery) === normalizeForCache(question)) {
        return { ...rawResult, rewriteResult };
    }

    // Search with the rewritten query
    let rewrittenResult: { chunks: T[]; formattedContext: string; [key: string]: any };
    try {
        rewrittenResult = await searchFn(rewriteResult.rewrittenQuery);
    } catch {
        return { ...rawResult, rewriteResult };
    }

    // Merge and deduplicate by chunk ID, keeping the higher score
    const seen = new Map<number, T>();
    for (const chunk of [...rawResult.chunks, ...rewrittenResult.chunks]) {
        const existing = seen.get(chunk.id);
        const score = (chunk as any).authorityScore ?? (chunk as any).similarity ?? 0;
        const existingScore = existing ? ((existing as any).authorityScore ?? (existing as any).similarity ?? 0) : -1;
        if (!existing || score > existingScore) {
            seen.set(chunk.id, chunk);
        }
    }

    // Sort merged by score descending
    const mergedChunks = Array.from(seen.values()).sort((a, b) => {
        const sa = (a as any).authorityScore ?? (a as any).similarity ?? 0;
        const sb = (b as any).authorityScore ?? (b as any).similarity ?? 0;
        return sb - sa;
    });

    // Rebuild formatted context from merged chunks
    const mergedContext = mergedChunks
        .map((c: any, i: number) => `[${i + 1}] ${c.sourceTitle || c.meetingId || 'source'}: ${(c.text || '').slice(0, 500)}`)
        .join('\n\n');

    return {
        chunks: mergedChunks,
        formattedContext: rawResult.formattedContext || mergedContext,
        rewriteResult,
    };
}

// Export cache for testing
export { rewriteCache as _rewriteCacheForTesting };
