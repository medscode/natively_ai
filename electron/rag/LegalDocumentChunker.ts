// electron/rag/LegalDocumentChunker.ts
// Structure-aware chunking for Indian legal documents (Acts, Judgements, etc.)
//
// Unlike SemanticChunker.ts (designed for live transcript speaker-turns), this
// module understands legal document hierarchy:
//   Act → Chapter → Part → Section → Sub-section → Proviso → Explanation
//
// Key design decisions:
//   1. A section + its provisos/explanations = one chunk (never split)
//   2. Each chunk gets a contextual header: "Transfer of Property Act, 1882 > Chapter VII > Section 126"
//   3. Chunks are larger (400-800 tokens) because legal sections need full context
//   4. Falls back to paragraph-based splitting for non-statutory text (commentaries, articles)
//   5. Outputs the same Chunk interface so VectorStore.saveChunks() works unchanged

import type { Chunk } from './SemanticChunker';

// ── Token estimation (shared with TranscriptPreprocessor) ──────────────
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ── Chunking parameters ──────────────────────────────────────────────
const LEGAL_TARGET_TOKENS = 500;
const LEGAL_MAX_TOKENS = 800;
const LEGAL_MIN_TOKENS = 80;
/** If a section exceeds MAX, split into sub-chunks of this size. */
const OVERFLOW_SPLIT_TOKENS = 600;
/** For non-statutory text, use paragraph-based splitting at this target. */
const PARAGRAPH_TARGET_TOKENS = 400;
const PARAGRAPH_MAX_TOKENS = 600;

// ── Section detection patterns ────────────────────────────────────────

/**
 * Pattern to detect Act/Statute title lines.
 * Matches: "THE TRANSFER OF PROPERTY ACT, 1882" or "Indian Succession Act, 1925"
 */
const ACT_TITLE_PATTERN = /^(?:THE\s+)?[A-Z][A-Za-z\s,.'()-]+(?:ACT|ADHINIYAM|CODE|RULES|REGULATION)[,\s]+\d{4}/m;

/**
 * Pattern for chapter headings.
 * Matches: "CHAPTER VII", "Chapter 3", "CHAPTER VII — Of Gifts"
 */
const CHAPTER_PATTERN = /^(?:CHAPTER|Chapter)\s+([IVXLCDM]+|\d+)[\s.—:-]*(.*)/m;

/**
 * Pattern for part headings.
 * Matches: "PART II", "Part A"
 */
const PART_PATTERN = /^(?:PART|Part)\s+([IVXLCDM]+|[A-Z]|\d+)[\s.—:-]*(.*)/m;

/**
 * Pattern for section headings — the primary unit of chunking.
 * Matches: "Section 126.", "126.", "Sec. 126", "S. 126", "126.—"
 * Also handles "Section 6A" and "Section 10(1)" variants.
 */
const SECTION_PATTERN = /^(?:(?:Section|Sec\.|S\.)\s*)?(\d+[A-Z]?(?:\(\d+\))?)[\s.—:-]+/m;

/**
 * Pattern for Order/Rule headings (CPC, Evidence Act).
 * Matches: "ORDER XXXIX", "Order 39", "Rule 1"
 */
const ORDER_PATTERN = /^(?:ORDER|Order|RULE|Rule)\s+([IVXLCDM]+|\d+)[\s.—:-]*(.*)/m;

/**
 * Pattern for Schedule headings.
 * Matches: "SCHEDULE I", "First Schedule", "THE FIRST SCHEDULE"
 */
const SCHEDULE_PATTERN = /^(?:THE\s+)?(?:FIRST|SECOND|THIRD|FOURTH|FIFTH|\d+(?:ST|ND|RD|TH)?)\s+SCHEDULE/im;

/**
 * Proviso / Explanation / Exception patterns — these belong WITH their parent section.
 */
const PROVISO_PATTERN = /^(?:Provided\s+that|Proviso|Explanation|Exception|Illustration|Note)\s*[.:—-]/im;

/**
 * Detect if text looks like a legal statute (vs a commentary/article).
 * Heuristic: has section numbers and formal structure.
 */
function isStatutoryText(text: string): boolean {
    const lines = text.split('\n').slice(0, 100); // Check first 100 lines
    let sectionCount = 0;
    let chapterCount = 0;
    for (const line of lines) {
        if (SECTION_PATTERN.test(line.trim())) sectionCount++;
        if (CHAPTER_PATTERN.test(line.trim())) chapterCount++;
    }
    // If we find at least 3 section-like patterns in the first 100 lines, treat as statutory
    return sectionCount >= 3 || (chapterCount >= 1 && sectionCount >= 1);
}

// ── Hierarchical context tracking ────────────────────────────────────

interface LegalHierarchy {
    actTitle: string;
    chapter: string;
    part: string;
    order: string;
    schedule: string;
}

function buildContextHeader(hierarchy: LegalHierarchy, sectionLabel: string): string {
    const parts: string[] = [];
    if (hierarchy.actTitle) parts.push(hierarchy.actTitle);
    if (hierarchy.schedule) parts.push(hierarchy.schedule);
    if (hierarchy.part) parts.push(hierarchy.part);
    if (hierarchy.chapter) parts.push(hierarchy.chapter);
    if (hierarchy.order) parts.push(hierarchy.order);
    if (sectionLabel) parts.push(sectionLabel);
    return parts.length > 0 ? `[${parts.join(' > ')}]` : '';
}

// ── Parsed section representation ────────────────────────────────────

interface ParsedSection {
    /** Full header like "Section 126" or "Order XXXIX Rule 1" */
    sectionLabel: string;
    /** The section title/heading text if any */
    title: string;
    /** The body text of the section including provisos and explanations */
    body: string;
    /** Hierarchical context at the time this section was parsed */
    hierarchy: LegalHierarchy;
    /** Whether this section has attached provisos */
    hasProviso: boolean;
    /** Whether this section has attached explanations */
    hasExplanation: boolean;
}

// ── Core parsing: split text into sections ───────────────────────────

/**
 * Parse a legal document into hierarchical sections.
 * This is a line-by-line state machine that tracks the current chapter/part/section
 * and accumulates body text until the next section boundary.
 */
function parseStatutoryText(text: string, docTitle: string): ParsedSection[] {
    const lines = text.split('\n');
    const sections: ParsedSection[] = [];

    const hierarchy: LegalHierarchy = {
        actTitle: docTitle || '',
        chapter: '',
        part: '',
        order: '',
        schedule: '',
    };

    let currentSection: ParsedSection | null = null;
    let preambleLines: string[] = [];

    const flushSection = () => {
        if (currentSection) {
            currentSection.body = currentSection.body.trim();
            if (currentSection.body.length > 0 || currentSection.title.length > 0) {
                sections.push(currentSection);
            }
            currentSection = null;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines (but preserve them in body for readability)
        if (trimmed === '') {
            if (currentSection) currentSection.body += '\n';
            continue;
        }

        // ── Detect Act title (usually appears once at the top) ─────────
        if (!hierarchy.actTitle && ACT_TITLE_PATTERN.test(trimmed)) {
            hierarchy.actTitle = trimmed.replace(/[[\]]/g, '').trim();
            continue;
        }

        // ── Detect Schedule headings ──────────────────────────────────
        if (SCHEDULE_PATTERN.test(trimmed)) {
            flushSection();
            hierarchy.schedule = trimmed.replace(/[[\]]/g, '').trim();
            // Reset sub-hierarchy
            hierarchy.chapter = '';
            hierarchy.part = '';
            hierarchy.order = '';
            continue;
        }

        // ── Detect Part headings ─────────────────────────────────────
        const partMatch = trimmed.match(PART_PATTERN);
        if (partMatch) {
            flushSection();
            const partNum = partMatch[1];
            const partTitle = (partMatch[2] || '').trim();
            hierarchy.part = `Part ${partNum}${partTitle ? ' — ' + partTitle : ''}`;
            // Reset chapter/order under new part
            hierarchy.chapter = '';
            hierarchy.order = '';
            continue;
        }

        // ── Detect Chapter headings ──────────────────────────────────
        const chapterMatch = trimmed.match(CHAPTER_PATTERN);
        if (chapterMatch) {
            flushSection();
            const chapNum = chapterMatch[1];
            const chapTitle = (chapterMatch[2] || '').trim();
            hierarchy.chapter = `Chapter ${chapNum}${chapTitle ? ' — ' + chapTitle : ''}`;
            // Reset order under new chapter
            hierarchy.order = '';
            continue;
        }

        // ── Detect Order/Rule headings ───────────────────────────────
        const orderMatch = trimmed.match(ORDER_PATTERN);
        if (orderMatch) {
            flushSection();
            const orderNum = orderMatch[1];
            const orderTitle = (orderMatch[2] || '').trim();
            const prefix = /^(?:ORDER|Order)/i.test(trimmed) ? 'Order' : 'Rule';
            hierarchy.order = `${prefix} ${orderNum}${orderTitle ? ' — ' + orderTitle : ''}`;
            continue;
        }

        // ── Detect Section headings (primary chunk boundary) ─────────
        const sectionMatch = trimmed.match(SECTION_PATTERN);
        if (sectionMatch && !PROVISO_PATTERN.test(trimmed)) {
            flushSection();
            const secNum = sectionMatch[1];
            const remainder = trimmed.slice(sectionMatch[0].length).trim();

            currentSection = {
                sectionLabel: `Section ${secNum}`,
                title: remainder,
                body: '',
                hierarchy: { ...hierarchy },
                hasProviso: false,
                hasExplanation: false,
            };
            continue;
        }

        // ── Proviso / Explanation / Exception → attach to current section
        if (PROVISO_PATTERN.test(trimmed)) {
            if (currentSection) {
                currentSection.body += '\n' + trimmed;
                if (/^Provided\s+that|^Proviso/i.test(trimmed)) {
                    currentSection.hasProviso = true;
                }
                if (/^Explanation/i.test(trimmed)) {
                    currentSection.hasExplanation = true;
                }
                continue;
            }
        }

        // ── Regular body text → append to current section or preamble ─
        if (currentSection) {
            currentSection.body += '\n' + trimmed;
        } else {
            preambleLines.push(trimmed);
        }
    }

    // Flush the last section
    flushSection();

    // If there's preamble text before the first section, create a preamble chunk
    if (preambleLines.length > 0) {
        const preambleText = preambleLines.join('\n').trim();
        if (preambleText.length > 50) {
            sections.unshift({
                sectionLabel: 'Preamble',
                title: 'Preamble & Definitions',
                body: preambleText,
                hierarchy: { ...hierarchy },
                hasProviso: false,
                hasExplanation: false,
            });
        }
    }

    return sections;
}

// ── Convert parsed sections to Chunk[] ───────────────────────────────

/**
 * Convert a parsed section into one or more Chunks.
 * If a section exceeds LEGAL_MAX_TOKENS, it's split into sub-chunks
 * with the context header repeated on each sub-chunk.
 */
function sectionToChunks(
    section: ParsedSection,
    meetingId: string,
    startIndex: number,
): Chunk[] {
    const contextHeader = buildContextHeader(section.hierarchy, section.sectionLabel);

    // Build the full text: context header + title + body
    const fullText = [
        contextHeader,
        section.title ? section.title : '',
        section.body,
    ].filter(Boolean).join('\n').trim();

    const tokens = estimateTokens(fullText);

    // If it fits in one chunk, return as-is
    if (tokens <= LEGAL_MAX_TOKENS) {
        return [{
            meetingId,
            chunkIndex: startIndex,
            speaker: 'source',
            startMs: 0,
            endMs: 0,
            text: fullText,
            tokenCount: tokens,
        }];
    }

    // Overflow: split the body into paragraphs and group them into sub-chunks
    // Always prepend the context header to each sub-chunk
    const paragraphs = section.body.split(/\n{2,}/);
    const chunks: Chunk[] = [];
    let currentText = contextHeader + '\n' + (section.title || '');
    let currentTokens = estimateTokens(currentText);
    let chunkIdx = startIndex;

    for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);

        if (currentTokens + paraTokens > OVERFLOW_SPLIT_TOKENS && currentTokens > LEGAL_MIN_TOKENS) {
            // Flush current sub-chunk
            const text = currentText.trim();
            chunks.push({
                meetingId,
                chunkIndex: chunkIdx++,
                speaker: 'source',
                startMs: 0,
                endMs: 0,
                text,
                tokenCount: estimateTokens(text),
            });
            // Start new sub-chunk with context header for continuity
            currentText = contextHeader + ' (continued)\n';
            currentTokens = estimateTokens(currentText);
        }

        currentText += '\n' + para;
        currentTokens += paraTokens;
    }

    // Flush remaining
    if (currentTokens > LEGAL_MIN_TOKENS) {
        const text = currentText.trim();
        chunks.push({
            meetingId,
            chunkIndex: chunkIdx++,
            speaker: 'source',
            startMs: 0,
            endMs: 0,
            text,
            tokenCount: estimateTokens(text),
        });
    }

    return chunks;
}

// ── Paragraph-based fallback for non-statutory text ──────────────────

/**
 * For commentaries, articles, whitepapers, etc. that don't follow
 * statutory structure, split by paragraph boundaries.
 * Still prepends the document title as context.
 */
function chunkByParagraphs(
    text: string,
    meetingId: string,
    docTitle: string,
): Chunk[] {
    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 20);
    const chunks: Chunk[] = [];
    let currentText = docTitle ? `[${docTitle}]\n` : '';
    let currentTokens = estimateTokens(currentText);
    let chunkIdx = 0;

    for (const para of paragraphs) {
        const paraText = para.trim();
        const paraTokens = estimateTokens(paraText);

        // Skip very short paragraphs (headers, page numbers, etc.)
        if (paraTokens < 10) continue;

        if (currentTokens + paraTokens > PARAGRAPH_MAX_TOKENS && currentTokens > LEGAL_MIN_TOKENS) {
            const finalText = currentText.trim();
            chunks.push({
                meetingId,
                chunkIndex: chunkIdx++,
                speaker: 'source',
                startMs: 0,
                endMs: 0,
                text: finalText,
                tokenCount: estimateTokens(finalText),
            });
            currentText = docTitle ? `[${docTitle}]\n` : '';
            currentTokens = estimateTokens(currentText);
        }

        currentText += '\n' + paraText;
        currentTokens += paraTokens;
    }

    // Flush remaining
    if (currentTokens > LEGAL_MIN_TOKENS) {
        const finalText = currentText.trim();
        chunks.push({
            meetingId,
            chunkIndex: chunkIdx++,
            speaker: 'source',
            startMs: 0,
            endMs: 0,
            text: finalText,
            tokenCount: estimateTokens(finalText),
        });
    }

    return chunks;
}

// ── Public API ───────────────────────────────────────────────────────

export interface LegalChunkingOptions {
    /** Override document title (used in context headers). */
    docTitle?: string;
    /** Force statutory parsing even if heuristic says no. */
    forceStatutory?: boolean;
    /** Force paragraph-based splitting even for statutory text. */
    forceParagraph?: boolean;
}

/**
 * Chunk a legal document into retrieval-optimized units.
 *
 * For statutory text (Acts, Rules, Orders): splits by Section boundaries,
 * keeps provisos/explanations with their parent, prepends hierarchy context.
 *
 * For non-statutory text (articles, commentaries): splits by paragraph,
 * prepends document title.
 *
 * @param meetingId - The case/meeting ID (used as foreign key in VectorStore)
 * @param text - The full extracted document text
 * @param options - Optional overrides
 * @returns Array of Chunk objects compatible with VectorStore.saveChunks()
 */
export function chunkLegalDocument(
    meetingId: string,
    text: string,
    options: LegalChunkingOptions = {},
): Chunk[] {
    if (!text || text.trim().length === 0) return [];

    const docTitle = options.docTitle || '';
    const useStatutory = options.forceParagraph
        ? false
        : (options.forceStatutory || isStatutoryText(text));

    if (!useStatutory) {
        return chunkByParagraphs(text, meetingId, docTitle);
    }

    // Parse into hierarchical sections
    const sections = parseStatutoryText(text, docTitle);

    if (sections.length === 0) {
        // Fallback if parsing found no sections
        return chunkByParagraphs(text, meetingId, docTitle);
    }

    // Convert each section into one or more chunks
    const allChunks: Chunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
        const sectionChunks = sectionToChunks(section, meetingId, chunkIndex);
        allChunks.push(...sectionChunks);
        chunkIndex += sectionChunks.length;
    }

    return allChunks;
}

/**
 * Utility: check if a document's text appears to be a statutory legal document.
 * Exported for use by KnowledgeBaseManager to decide which chunker to use.
 */
export { isStatutoryText };
