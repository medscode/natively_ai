// electron/rag/WebSearchProvider.ts
// Meeting Copilot PRD Phase 4: Web Search toggle (off by default).
//
// Lightweight web-search provider. Uses DuckDuckGo's HTML endpoint as a
// zero-key fallback (free, no API key required). If a Tavily key is set
// via the user's API-key UI, falls back to Tavily's REST API for richer
// snippets.
//
// Always gated by `SettingsManager.get('webSearchEnabled') === true`.
// If disabled, `search()` returns empty results so the assistant pipeline
// cannot reach the web regardless of how it was triggered.

import { SettingsManager } from '../services/SettingsManager';

export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
    source: 'duckduckgo' | 'tavily';
}

export interface WebSearchProvider {
    search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]>;
}

function isEnabled(): boolean {
    try {
        return SettingsManager.getInstance().get('webSearchEnabled') === true;
    } catch {
        return false;
    }
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
                Accept: 'text/html',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        // Naive parse: extract result blocks. DuckDuckGo's HTML format uses
        // <a class="result__a" href="...">title</a> followed by <a class="result__snippet">snippet</a>.
        const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const results: WebSearchResult[] = [];
        let lm: RegExpExecArray | null;
        const titles: { url: string; title: string }[] = [];
        while ((lm = linkRe.exec(html)) !== null) {
            titles.push({
                url: lm[1],
                title: lm[2].replace(/<[^>]+>/g, '').trim(),
            });
        }
        let sm: RegExpExecArray | null;
        const snippets: string[] = [];
        while ((sm = snippetRe.exec(html)) !== null) {
            snippets.push(sm[1].replace(/<[^>]+>/g, '').trim());
        }
        const limit = Math.min(titles.length, snippets.length, maxResults);
        for (let i = 0; i < limit; i += 1) {
            results.push({
                title: titles[i].title || '(untitled)',
                url: titles[i].url,
                snippet: snippets[i] || '',
                source: 'duckduckgo',
            });
        }
        return results;
    } catch (e: any) {
        console.warn('[WebSearchProvider] DuckDuckGo search failed:', e?.message);
        return [];
    }
}

async function searchTavily(query: string, apiKey: string, maxResults: number): Promise<WebSearchResult[]> {
    try {
        const resp = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_results: maxResults,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return [];
        const data: any = await resp.json();
        const items: any[] = data?.results || [];
        return items.slice(0, maxResults).map((it) => ({
            title: it.title || '(untitled)',
            url: it.url || '',
            snippet: it.content || '',
            source: 'tavily' as const,
        }));
    } catch (e: any) {
        console.warn('[WebSearchProvider] Tavily search failed:', e?.message);
        return [];
    }
}

export class DefaultWebSearchProvider implements WebSearchProvider {
    async search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]> {
        if (!isEnabled()) {
            return [];
        }
        const maxResults = Math.min(opts?.maxResults ?? 5, 10);
        const trimmed = (query || '').trim();
        if (!trimmed) return [];

        // Try Tavily first if a key is configured
        try {
            const { CredentialsManager } = await import('../services/CredentialsManager');
            const cm = CredentialsManager.getInstance();
            const tavilyKey = cm.getTavilyApiKey();
            if (tavilyKey && tavilyKey.startsWith('tvly-')) {
                const tavily = await searchTavily(trimmed, tavilyKey, maxResults);
                if (tavily.length > 0) return tavily;
            }
        } catch {
            // ignore — fall through to DuckDuckGo
        }

        // Fallback: DuckDuckGo (no key required)
        return await searchDuckDuckGo(trimmed, maxResults);
    }
}