// electron/rag/__tests__/CitationVerifier.test.mjs
// Unit tests for post-generation hallucination gating and citation verification

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/rag/CitationVerifier.js');
const { verifyCitations, hasLegalCitations } = await import(pathToFileURL(modPath).href);

describe('CitationVerifier', () => {
    test('identifies and marks citations found in chunks as VERIFIED', () => {
        const generatedResponse = `
1. DIRECT ANSWER: You cannot unilaterally cancel the gift deed without court intervention.
2. KEY POINTS: Under Sec. 126 of the Transfer of Property Act, 1882, a gift can only be revoked on specific conditions agreed at the time of the transfer.
3. CITATIONS: Sec. 126 of Transfer of Property Act, 1882.
`;
        const chunks = [
            { text: '[Transfer of Property Act, 1882 > Chapter VII > Section 126] When gift may be suspended or revoked. The donor and donee may agree...' },
            { text: '[Transfer of Property Act, 1882 > Chapter VII > Section 122] "Gift" defined.' }
        ];

        const res = verifyCitations(generatedResponse, chunks);

        assert.equal(res.hasCitations, true);
        assert.equal(res.verifiedCount, 1);
        assert.equal(res.unverifiedCount, 0);
        assert.equal(res.score, 1.0);
        assert.equal(res.citations[0].verified, true);
        assert.equal(res.verifiedResponse, generatedResponse, 'No warning footer should be added for 100% verified citations');
    });

    test('flags fabricated/hallucinated sections with warning footer', () => {
        const hallucinatedResponse = `
Under Sec. 999 of the Transfer of Property Act, 1882, you have an immediate right to cancel.
Also refer to Order XXXIX of CPC, 1908 for injunction.
`;
        const chunks = [
            { text: 'Order XXXIX — TEMPORARY INJUNCTIONS AND INTERLOCUTORY ORDERS. Rule 1. Cases in which temporary injunction may be granted.' }
        ];

        const res = verifyCitations(hallucinatedResponse, chunks);

        assert.equal(res.hasCitations, true);
        assert.equal(res.verifiedCount, 1, 'Order XXXIX is verified in chunks');
        assert.equal(res.unverifiedCount, 1, 'Sec. 999 is not in chunks');
        assert.ok(res.score < 1.0);
        assert.ok(res.verifiedResponse.includes('⚠️ Note: The following reference'), 'Must append warning footer');
        assert.ok(res.verifiedResponse.includes('Sec. 999'));
    });

    test('passes through text with no citations cleanly', () => {
        const plainResponse = 'You should file a police complaint immediately regarding the dispute.';
        const chunks = [{ text: 'Some random text' }];

        const res = verifyCitations(plainResponse, chunks);
        assert.equal(res.hasCitations, false);
        assert.equal(res.verifiedCount, 0);
        assert.equal(res.unverifiedCount, 0);
        assert.equal(res.score, 1.0);
        assert.equal(res.verifiedResponse, plainResponse);
    });

    test('hasLegalCitations detects presence of legal section citations', () => {
        assert.equal(hasLegalCitations('Please check Sec. 6 of Hindu Succession Act'), true);
        assert.equal(hasLegalCitations('Under Section 126 of TPA'), true);
        assert.equal(hasLegalCitations('Order XXXIX of CPC'), true);
        assert.equal(hasLegalCitations('No citations here just general advice'), false);
    });
});
