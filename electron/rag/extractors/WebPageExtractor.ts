// electron/rag/extractors/WebPageExtractor.ts
// Extracts readable text from a web page URL.
// Fetches the page, strips scripts/styles/navigation, and returns clean text.

import { ExtractedContent } from './types';

const MAX_PAGE_CHARS = 100_000; // Cap extraction to avoid unbounded memory

/**
 * Extract clean readable text from a web page URL.
 * Uses a simple fetch + regex approach.
 *
 * Limitations: pages that render via client-side JavaScript (SPAs, React apps)
 * will yield very little text. The extractor logs a warning when this happens.
 * For SPAs a headless-browser extractor (puppeteer/playwright) is needed.
 */
export async function extractWebPage(url: string): Promise<ExtractedContent> {
    const startTime = Date.now();
    const warnings: string[] = [];

    // Validate URL
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
        }
    } catch (e: any) {
        throw new Error(`Invalid URL: ${e?.message || e}`);
    }

    // Fetch the page
    let html: string;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MeetingCopilot/1.0; +https://natively.ai)',
                'Accept': 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(15_000), // 15s timeout
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        html = await response.text();
    } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error('Page fetch timed out after 15s');
        }
        throw new Error(`Failed to fetch page: ${e?.message || e}`);
    }

    if (html.length > MAX_PAGE_CHARS) {
        html = html.slice(0, MAX_PAGE_CHARS);
        warnings.push('Page was truncated at 100,000 characters');
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : parsedUrl.hostname;

    // Extract readable text — strip scripts, styles, navigation, and decode entities
    let text = html
        // Remove scripts and styles
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        // Remove HTML tags
        .replace(/<[^>]+>/g, ' ')
        // Decode common HTML entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
        // Collapse whitespace
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+|\s+$/gm, '')
        .trim();

    // If text is very short, the page likely requires JS — note this
    if (text.length < 200) {
        warnings.push('Page yielded very little text — may be a JavaScript-rendered site that requires a browser');
    }

    const estimatedTokens = Math.round(text.length / 4);

    return {
        text,
        title,
        estimatedTokens,
        warnings: warnings.length > 0 ? warnings : undefined,
        metadata: {
            sourceUrl: url,
            sourceType: 'web_page',
            extractedAt: new Date().toISOString(),
        },
    };
}

/**
 * Quick heuristic: is a URL likely a web page (vs a direct file download)?
 */
export function isWebPageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.toLowerCase();
        // Common file extensions that aren't web pages
        const nonPageExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.mp3', '.zip'];
        return !nonPageExts.some(ext => path.endsWith(ext));
    } catch {
        return false;
    }
}
