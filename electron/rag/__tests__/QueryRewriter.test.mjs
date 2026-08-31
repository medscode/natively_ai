// electron/rag/__tests__/QueryRewriter.test.mjs
// Unit tests for HyDE-Lite query rewriting & LRU caching

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/rag/QueryRewriter.js');
const { rewriteQuery, _rewriteCacheForTesting } = await import(pathToFileURL(modPath).href);

describe('QueryRewriter', () => {
    test('passes through very short queries without calling LLM', async () => {
        const result = await rewriteQuery('hi', null);
        assert.equal(result.wasRewritten, false);
        assert.equal(result.source, 'passthrough');
    });

    test('calls mock LLM and returns formal legal query with caching', async () => {
        let callCount = 0;
        const mockLLM = {
            async chatWithGemini(prompt, systemPrompt) {
                callCount++;
                return 'Partition suit for ancestral property under Sec. 6 of Hindu Succession Act, 1956';
            }
        };

        const question = 'my brother grabbed the ancestral land what can I do?';
        const res1 = await rewriteQuery(question, mockLLM);

        assert.equal(res1.wasRewritten, true);
        assert.equal(res1.source, 'llm');
        assert.ok(res1.rewrittenQuery.includes('Sec. 6 of Hindu Succession Act'));
        assert.equal(callCount, 1, 'LLM called on first attempt');

        // Second call with same question must hit LRU cache (0 additional LLM calls)
        const res2 = await rewriteQuery(question, mockLLM);
        assert.equal(res2.wasRewritten, true);
        assert.equal(res2.source, 'cache');
        assert.equal(callCount, 1, 'Must use cached result without re-invoking LLM');
    });

    test('recovers gracefully from LLM timeout or error', async () => {
        const timeoutLLM = {
            async chatWithGemini() {
                // Simulate delay exceeding 500ms timeout
                await new Promise(r => setTimeout(r, 700));
                return 'Late answer';
            }
        };

        const question = 'can I cancel the registered gift deed?';
        const res = await rewriteQuery(question, timeoutLLM);

        assert.equal(res.wasRewritten, false);
        assert.equal(res.source, 'passthrough');
        assert.equal(res.rewrittenQuery, question, 'Must return original question on timeout');
    });
});
