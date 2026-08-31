// electron/rag/CitationVerifier.ts
// Post-generation hallucination gate for legal citations.
//
// After the LLM generates a suggestion, this module:
//   1. Extracts all legal citations (Sec. X, Section Y, Order Z, Rule N)
//   2. Checks each citation against the text of the retrieved chunks
//   3. Marks each as VERIFIED or UNVERIFIED
//   4. Appends a warning footer for unverified citations
//
// This is a DETERMINISTIC check — no LLM involved, pure regex + string matching.
// Runs in <5ms for typical responses.

// ── Citation patterns ─────────────────────────────────────────────────

/**
 * Patterns to extract legal citations from generated text.
 * Each pattern captures:
 *   - group 1: the citation label (e.g., "Sec. 126", "Section 6A", "Order XXXIX")
 *   - group 2: optional Act/law name following "of" or "under"
 */
const CITATION_PATTERNS: RegExp[] = [
    // "Sec. 126", "Sec.126", "Sec. 6A", "Sec. 10(1)"
    /\b(Sec\.\s*\d+[A-Z]?(?:\(\d+\))?)\s*(?:of|under)?\s*(?:the\s+)?([A-Za-z][A-Za-z\s,.'()-]+(?:Act|Code|Rules?|Adhiniyam|Regulation)[,\s]*\d{4})?/gi,
    // "Section 126", "Section 6A", "Section 10(1)"
    /\b(Section\s+\d+[A-Z]?(?:\(\d+\))?)\s*(?:of|under)?\s*(?:the\s+)?([A-Za-z][A-Za-z\s,.'()-]+(?:Act|Code|Rules?|Adhiniyam|Regulation)[,\s]*\d{4})?/gi,
    // "Order XXXIX", "Order 39"
    /\b(Order\s+[IVXLCDM]+|\bOrder\s+\d+)\s*(?:of|under)?\s*(?:the\s+)?([A-Za-z][A-Za-z\s,.'()-]+(?:Act|Code|Rules?)[,\s]*\d{4})?/gi,
    // "Rule 1", "Rule 14"
    /\b(Rule\s+\d+[A-Z]?)\s*(?:of|under)?\s*(?:the\s+)?([A-Za-z][A-Za-z\s,.'()-]+(?:Act|Code|Rules?)[,\s]*\d{4})?/gi,
    // "Article 14", "Article 21" (Constitutional)
    /\b(Article\s+\d+[A-Z]?)\s*(?:of|under)?\s*(?:the\s+)?(Constitution[A-Za-z\s,]*)?/gi,
];

// ── Types ──────────────────────────────────────────────────────────────

export interface ExtractedCitation {
    /** The citation text as it appears in the response (e.g., "Sec. 126") */
    citationText: string;
    /** Normalized form for matching (e.g., "section 126") */
    normalized: string;
    /** The section/order/rule number extracted */
    number: string;
    /** Optional Act name if mentioned (e.g., "Transfer of Property Act, 1882") */
    actName?: string;
    /** Whether this citation was found in the retrieved chunks */
    verified: boolean;
    /** The chunk text snippet where this citation was found (if verified) */
    verifiedIn?: string;
}

export interface VerificationResult {
    /** The original LLM response */
    originalResponse: string;
    /** The response with any warning footers appended */
    verifiedResponse: string;
    /** All extracted citations and their verification status */
    citations: ExtractedCitation[];
    /** Count of verified citations */
    verifiedCount: number;
    /** Count of unverified citations */
    unverifiedCount: number;
    /** Overall verification score (0-1, 1 = all verified) */
    score: number;
    /** Whether any citations were found at all */
    hasCitations: boolean;
}

// ── Normalization ─────────────────────────────────────────────────────

/**
 * Normalize a citation for fuzzy matching.
 * "Sec. 126" and "Section 126" should match the same chunk text.
 */
function normalizeCitation(citation: string): string {
    return citation
        .toLowerCase()
        .replace(/sec\.\s*/g, 'section ')
        .replace(/s\.\s*/g, 'section ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extract the numeric part from a citation for broad matching.
 * "Sec. 126A(1)" → "126"
 */
function extractNumber(citation: string): string {
    const match = citation.match(/(\d+)/);
    return match ? match[1] : '';
}

// ── Core extraction ───────────────────────────────────────────────────

/**
 * Extract all legal citations from an LLM-generated response.
 */
function extractCitations(text: string): ExtractedCitation[] {
    const citations: ExtractedCitation[] = [];
    const seen = new Set<string>();

    for (const pattern of CITATION_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
            const citationText = match[1].trim();
            const actName = (match[2] || '').trim() || undefined;
            const normalized = normalizeCitation(citationText);
            const number = extractNumber(citationText);

            // Deduplicate
            const dedupeKey = normalized + (actName ? '|' + actName.toLowerCase() : '');
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            citations.push({
                citationText,
                normalized,
                number,
                actName,
                verified: false, // Will be set during verification
            });
        }
    }

    return citations;
}

// ── Verification against chunks ───────────────────────────────────────

/**
 * Check if a citation exists in any of the retrieved chunk texts.
 *
 * Matching strategy (ordered by strictness):
 *   1. Exact normalized match: "section 126" found literally in chunk
 *   2. Number + context match: "126" found near "section" or "sec." in chunk
 *   3. Act name + number match: chunk mentions both the Act and the section number
 */
function verifyCitationInChunks(
    citation: ExtractedCitation,
    chunkTexts: string[],
): { verified: boolean; snippet?: string } {
    for (const chunkText of chunkTexts) {
        const lowerChunk = chunkText.toLowerCase();

        // Strategy 1: Exact normalized match
        if (lowerChunk.includes(citation.normalized)) {
            const idx = lowerChunk.indexOf(citation.normalized);
            const snippet = chunkText.slice(Math.max(0, idx - 30), idx + citation.normalized.length + 50).trim();
            return { verified: true, snippet };
        }

        // Strategy 2: Number in context — look for the number near "section" or "sec."
        if (citation.number) {
            // Check for "section 126" or "sec. 126" or just "126." in the chunk
            const numberPatterns = [
                new RegExp(`\\bsection\\s+${citation.number}\\b`, 'i'),
                new RegExp(`\\bsec\\.\\s*${citation.number}\\b`, 'i'),
                new RegExp(`\\bs\\.\\s*${citation.number}\\b`, 'i'),
                new RegExp(`\\b${citation.number}[\\.\\s—:-]`, 'i'),
            ];

            // For Order/Rule/Article, use their specific prefix
            if (citation.normalized.startsWith('order')) {
                numberPatterns.push(new RegExp(`\\border\\s+${citation.number}\\b`, 'i'));
            }
            if (citation.normalized.startsWith('rule')) {
                numberPatterns.push(new RegExp(`\\brule\\s+${citation.number}\\b`, 'i'));
            }
            if (citation.normalized.startsWith('article')) {
                numberPatterns.push(new RegExp(`\\barticle\\s+${citation.number}\\b`, 'i'));
            }

            for (const numPattern of numberPatterns) {
                const numMatch = numPattern.exec(lowerChunk);
                if (numMatch) {
                    const idx = numMatch.index;
                    const snippet = chunkText.slice(Math.max(0, idx - 20), idx + numMatch[0].length + 50).trim();
                    return { verified: true, snippet };
                }
            }
        }

        // Strategy 3: Act name + number co-occurrence
        if (citation.actName && citation.number) {
            const actLower = citation.actName.toLowerCase();
            // Check if both the Act name (partial) and the number appear in the chunk
            const actWords = actLower.split(/\s+/).filter(w => w.length > 3);
            const actPresent = actWords.length > 0 && actWords.every(w => lowerChunk.includes(w));
            const numberPresent = lowerChunk.includes(citation.number);
            if (actPresent && numberPresent) {
                const idx = lowerChunk.indexOf(citation.number);
                const snippet = chunkText.slice(Math.max(0, idx - 40), idx + 60).trim();
                return { verified: true, snippet };
            }
        }
    }

    return { verified: false };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Verify all legal citations in an LLM-generated response against
 * the retrieved knowledge base chunks.
 *
 * @param response - The LLM-generated suggestion text
 * @param chunks - The retrieved chunks that were fed to the LLM
 * @returns VerificationResult with verified/flagged response and citation details
 */
export function verifyCitations(
    response: string,
    chunks: Array<{ text?: string; cleaned_text?: string; [key: string]: any }>,
): VerificationResult {
    // Extract all citations from the response
    const citations = extractCitations(response);

    if (citations.length === 0) {
        return {
            originalResponse: response,
            verifiedResponse: response,
            citations: [],
            verifiedCount: 0,
            unverifiedCount: 0,
            score: 1.0, // No citations to verify = perfect score
            hasCitations: false,
        };
    }

    // Collect all chunk texts for matching
    const chunkTexts = chunks
        .map(c => c.text || c.cleaned_text || '')
        .filter(t => t.length > 0);

    // Verify each citation
    let verifiedCount = 0;
    let unverifiedCount = 0;

    for (const citation of citations) {
        const result = verifyCitationInChunks(citation, chunkTexts);
        citation.verified = result.verified;
        citation.verifiedIn = result.snippet;

        if (result.verified) {
            verifiedCount++;
        } else {
            unverifiedCount++;
        }
    }

    // Build the verified response with warning footer if needed
    let verifiedResponse = response;

    if (unverifiedCount > 0) {
        const unverifiedCitations = citations
            .filter(c => !c.verified)
            .map(c => c.citationText + (c.actName ? ` of ${c.actName}` : ''));

        const warningFooter = `\n\n⚠️ Note: The following reference${unverifiedCitations.length > 1 ? 's' : ''} could not be verified against the source documents: ${unverifiedCitations.join(', ')}. Please verify independently.`;

        verifiedResponse = response + warningFooter;

        console.warn(`[CitationVerifier] ${unverifiedCount} unverified citation(s): ${unverifiedCitations.join(', ')}`);
    }

    const total = verifiedCount + unverifiedCount;
    const score = total > 0 ? verifiedCount / total : 1.0;

    console.log(`[CitationVerifier] Score: ${(score * 100).toFixed(0)}% (${verifiedCount}/${total} verified)`);

    return {
        originalResponse: response,
        verifiedResponse,
        citations,
        verifiedCount,
        unverifiedCount,
        score,
        hasCitations: true,
    };
}

/**
 * Quick check: does this response contain any legal citations at all?
 * Useful for gating whether to run full verification.
 */
export function hasLegalCitations(text: string): boolean {
    return extractCitations(text).length > 0;
}
