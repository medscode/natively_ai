// Regression test for the "local Whisper always auto-detects" bug (2026-07-29).
//
// Symptom: picking a language in Settings changed nothing. Non-English speech
// (Hindi in the report) transcribed as phonetic-English word salad even on
// whisper-large-v3-turbo, because the decoder was never told the language.
//
// Cause: whisperWorker.ts LANG_MAP was keyed by BCP-47 code ('hi-IN', 'en-US').
// But SettingsManager persists the INTERNAL key from
// electron/config/languages.ts RECOGNITION_LANGUAGES ('hindi', 'english-us') —
// bcp47 is a FIELD on those entries, never the key. So every lookup missed:
//
//     LANG_MAP['hindi']  ->  undefined  ->  `?? null`  ->  auto-detect
//
// The `?? null` fallback made it silent — no throw, no warning, just degraded
// accuracy. Auto-detect on short VAD segments is unreliable, which is why this
// read as "the models are bad" rather than as a config bug.
//
// This test pins the CONTRACT between the two files: every key the settings
// layer can persist must resolve to a Whisper language. It fails loudly if
// someone adds a language to RECOGNITION_LANGUAGES without teaching the worker
// about it — the exact drift that caused the original bug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const registrySrc = fs.readFileSync(
  path.join(repoRoot, 'electron/config/languages.ts'), 'utf8');
const workerSrc = fs.readFileSync(
  path.join(repoRoot, 'electron/audio/whisper/whisperWorker.ts'), 'utf8');

/** Internal keys of RECOGNITION_LANGUAGES / ENGLISH_VARIANTS. */
function registryKeys() {
  return [...registrySrc.matchAll(/^\s*'([a-z0-9-]+)':\s*\{/gm)].map((m) => m[1]);
}

/** Keys declared in the worker's LANG_MAP literal. */
function langMapKeys() {
  const start = workerSrc.indexOf('const LANG_MAP');
  assert.ok(start !== -1, 'LANG_MAP must exist in whisperWorker.ts');
  const end = workerSrc.indexOf('};', start);
  assert.ok(end !== -1, 'LANG_MAP literal must be terminated');
  const block = workerSrc.slice(start, end);
  return new Set([...block.matchAll(/'([a-zA-Z0-9-]+)'\s*:/g)].map((m) => m[1]));
}

describe('whisperWorker LANG_MAP ↔ RECOGNITION_LANGUAGES key contract', () => {
  test('every persistable language key resolves in LANG_MAP', () => {
    const missing = registryKeys().filter((k) => !langMapKeys().has(k));
    assert.deepEqual(
      missing, [],
      `These language keys can be persisted by Settings but are absent from ` +
      `LANG_MAP, so they silently fall through to auto-detect: ${missing.join(', ')}`,
    );
  });

  test('the registry is non-trivial (guards against a regex that matches nothing)', () => {
    // Without this, a refactor that changes the registry's shape would make
    // registryKeys() return [] and the test above would vacuously pass.
    const keys = registryKeys();
    assert.ok(keys.length >= 30, `expected >=30 language entries, got ${keys.length}`);
    assert.ok(keys.includes('hindi'), 'hindi must be a selectable language');
    assert.ok(keys.includes('english-us'), 'english-us must be a selectable language');
  });

  test('hindi maps to the Whisper language name, not a BCP-47 code', () => {
    // 'hi-IN' is the bcp47 FIELD, not a decoder language. Transformers.js
    // expects the spelled-out name.
    assert.match(
      workerSrc, /'hindi':\s*'hindi'/,
      "LANG_MAP must map the 'hindi' key to the Whisper language name 'hindi'",
    );
  });

  test("'auto' still maps to null so auto-detect stays reachable on purpose", () => {
    assert.match(
      workerSrc, /'auto':\s*null/,
      "'auto' must map to null — that is the one legitimate auto-detect path",
    );
  });
});
