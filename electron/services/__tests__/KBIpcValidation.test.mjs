// electron/services/__tests__/KBIpcValidation.test.mjs
// Unit tests for KB IPC handler validation logic.
// Mirrors the validation added in electron/ipcHandlers.ts to the
// kb:create-client-case and kb:add-source handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the validation in initializeIpcHandlers' kb:create-client-case handler.
function validateCreateClientCase(data) {
  if (!data || typeof data.id !== 'string' || data.id.trim().length === 0) {
    return { ok: false, error: 'id is required' };
  }
  if (typeof data.name !== 'string' || data.name.trim().length === 0) {
    return { ok: false, error: 'name is required' };
  }
  return { ok: true };
}

// Mirror of the validation in initializeIpcHandlers' kb:add-source handler.
function validateAddSource(params) {
  if (!params || typeof params.clientCaseId !== 'string' || params.clientCaseId.trim().length === 0) {
    return { ok: false, error: 'clientCaseId is required' };
  }
  if (!params.sourceType || !['file', 'web_page', 'ppt', 'youtube'].includes(params.sourceType)) {
    return { ok: false, error: `sourceType must be one of: file, web_page, ppt, youtube (got: ${params.sourceType})` };
  }
  return { ok: true };
}

test('kb:create-client-case accepts a valid case', () => {
  const result = validateCreateClientCase({ id: 'case_1', name: 'Acme Corp' });
  assert.equal(result.ok, true);
});

test('kb:create-client-case rejects missing id', () => {
  const result = validateCreateClientCase({ name: 'Acme Corp' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'id is required');
});

test('kb:create-client-case rejects empty id', () => {
  const result = validateCreateClientCase({ id: '   ', name: 'Acme Corp' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'id is required');
});

test('kb:create-client-case rejects missing name', () => {
  const result = validateCreateClientCase({ id: 'case_1' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'name is required');
});

test('kb:create-client-case rejects empty name', () => {
  const result = validateCreateClientCase({ id: 'case_1', name: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'name is required');
});

test('kb:create-client-case rejects null data', () => {
  const result = validateCreateClientCase(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'id is required');
});

test('kb:add-source accepts valid file source', () => {
  const result = validateAddSource({ clientCaseId: 'case_1', sourceType: 'file' });
  assert.equal(result.ok, true);
});

test('kb:add-source accepts valid web_page source', () => {
  const result = validateAddSource({ clientCaseId: 'case_1', sourceType: 'web_page' });
  assert.equal(result.ok, true);
});

test('kb:add-source accepts valid ppt source', () => {
  const result = validateAddSource({ clientCaseId: 'case_1', sourceType: 'ppt' });
  assert.equal(result.ok, true);
});

test('kb:add-source accepts valid youtube source', () => {
  const result = validateAddSource({ clientCaseId: 'case_1', sourceType: 'youtube' });
  assert.equal(result.ok, true);
});

test('kb:add-source rejects missing clientCaseId', () => {
  const result = validateAddSource({ sourceType: 'file' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'clientCaseId is required');
});

test('kb:add-source rejects invalid sourceType', () => {
  const result = validateAddSource({ clientCaseId: 'case_1', sourceType: 'ftp' });
  assert.equal(result.ok, false);
  assert.match(result.error, /sourceType must be one of/);
});

test('kb:add-source rejects null params', () => {
  const result = validateAddSource(null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'clientCaseId is required');
});