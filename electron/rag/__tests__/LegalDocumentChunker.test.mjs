// electron/rag/__tests__/LegalDocumentChunker.test.mjs
// Unit tests for structure-aware legal document chunker

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(__dirname, '../../../dist-electron/electron/rag/LegalDocumentChunker.js');
const { chunkLegalDocument, isStatutoryText } = await import(pathToFileURL(modPath).href);

describe('LegalDocumentChunker', () => {
    test('isStatutoryText identifies statutory documents vs casual text', () => {
        const statutoryDoc = `
        THE TRANSFER OF PROPERTY ACT, 1882
        CHAPTER VII — OF GIFTS
        Section 122. "Gift" defined.
        "Gift" is the transfer of certain existing moveable or immoveable property...
        Section 123. Transfer how effected.
        For the purpose of making a gift of immoveable property...
        Section 126. When gift may be suspended or revoked.
        The donor and donee may agree that on the happening of any specified event...
        `;
        assert.equal(isStatutoryText(statutoryDoc), true, 'Should detect statutory text with sections');

        const casualArticle = `
        Today we are going to discuss real estate laws in India.
        Many people wonder how property transfers work.
        In this blog post, we look at common mistakes buyers make.
        `;
        assert.equal(isStatutoryText(casualArticle), false, 'Should not detect casual blog post as statutory');
    });

    test('preserves section, title, and provisos together without breaking them', () => {
        const statutoryText = `
THE TRANSFER OF PROPERTY ACT, 1882
CHAPTER VII — OF GIFTS

Section 126. When gift may be suspended or revoked.
The donor and donee may agree that on the happening of any specified event which does not depend on the will of the donor a gift shall be suspended or revoked; but a gift which the parties agree shall be revocable wholly or in part, at the mere will of the donor, is void wholly or in part, as the case may be.
A gift may also be revoked in any of the cases (save want or failure of consideration) in which, if it were a contract, it might be rescinded.
Save as aforesaid, a gift cannot be revoked.
Nothing contained in this section shall be deemed to affect the rights of transferees for consideration without notice.

Section 127. Onerous gifts.
Where a gift is in the form of a single transfer to the same person of several things of which one is, and the others are not, burdened by an obligation, the donee can take nothing by his gift unless he accepts it fully.
`;
        const chunks = chunkLegalDocument('test-meeting-1', statutoryText, { docTitle: 'Transfer of Property Act, 1882' });

        assert.ok(chunks.length >= 2, 'Should create at least 2 chunks for two distinct sections');
        const sec126Chunk = chunks.find(c => c.text.includes('Section 126'));
        assert.ok(sec126Chunk, 'Section 126 chunk must exist');
        assert.ok(sec126Chunk.text.includes('[Transfer of Property Act, 1882 > Chapter VII — OF GIFTS > Section 126]'),
            'Context header must include Act, Chapter and Section');
        assert.ok(sec126Chunk.text.includes('When gift may be suspended or revoked'), 'Must include section title');
        assert.ok(sec126Chunk.text.includes('transferees for consideration without notice'), 'Must preserve full body and proviso/savings text');
    });

    test('prepends hierarchical context header accurately (Order / Rule format for CPC)', () => {
        const cpcText = `
THE CODE OF CIVIL PROCEDURE, 1908
ORDER XXXIX — TEMPORARY INJUNCTIONS AND INTERLOCUTORY ORDERS
Rule 1. Cases in which temporary injunction may be granted.
Where in any suit it is proved by affidavit or otherwise:
(a) that any property in dispute in a suit is in danger of being wasted, damaged or alienated by any party to the suit...
the Court may by order grant a temporary injunction to restrain such act.
`;
        const chunks = chunkLegalDocument('test-cpc', cpcText, { docTitle: 'Code of Civil Procedure, 1908' });
        assert.ok(chunks.length >= 1);
        assert.ok(chunks[0].text.includes('ORDER XXXIX') || chunks[0].text.includes('Order XXXIX') || chunks[0].text.includes('Rule 1'));
    });

    test('falls back gracefully to paragraph splitting for non-statutory articles', () => {
        const articleText = `
Overview of Gift Deeds in Indian Law.

A gift deed is a legally binding document through which a person voluntarily transfers their property to another without any consideration or monetary exchange.

Unlike a Will, which takes effect only after the death of the testator, a Gift Deed operates immediately upon registration during the lifetime of both parties.

Under Section 17 of the Registration Act, registration of a gift deed involving immovable property is mandatory to ensure legal validity.
`;
        const chunks = chunkLegalDocument('test-article', articleText, {
            docTitle: 'Gift Deed Overview Article',
            forceParagraph: true,
        });

        assert.ok(chunks.length >= 1, 'Should create chunks for article');
        assert.ok(chunks[0].text.includes('[Gift Deed Overview Article]'), 'Must include title header');
    });
});
