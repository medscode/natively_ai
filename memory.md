# Memory for the Next Agent

> **Status snapshot (2026-07-20):** The KB feature is partially built. UI shell + backend skeleton + chat grounding are wired and boot-clean. Three pieces of work remain — see **Outstanding Work** below. The previous version of this file had stale paths and an inaccurate schema snippet; both are corrected.

---

## 📋 Context & Previously Fixed Issues

Two prior bugs were resolved and remain in place:

1. **Onboarding Orchestrator Infinite Loop** — `quiet_window` stage was triggering a re-evaluation loop and a major memory leak in the launcher window.
   - **File**: `src/lib/onboarding/stageCatalog.ts`
   - **Fix**: `onceEver: true` on `QUIET_WINDOW_STAGE` (line 191). Do not remove — removing it reintroduces the leak.

2. **`ReferenceError: KnowledgeBaseManager is not defined`** — dynamic `require('./rag/KnowledgeBaseManager')` inside esbuild-bundled handlers tripped a deferred-`__esm` ReferenceError on first invocation.
   - **Files**: `electron/ipcHandlers.ts:23`, `electron/main.ts:910`
   - **Fix**: top-level static `import { KnowledgeBaseManager } from './rag/KnowledgeBaseManager'`.

---

## 🎯 Current State of the Knowledge Base Feature

### What works today

- **DB schema** (`electron/db/DatabaseManager.ts`, migration v25 → v26):
  ```sql
  CREATE TABLE IF NOT EXISTS client_cases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      client_case_id TEXT NOT NULL,
      source_type TEXT NOT NULL,            -- 'file' | 'web_page' | 'ppt' | 'youtube'
      title TEXT NOT NULL,
      metadata_json TEXT,
      index_status TEXT DEFAULT 'pending',  -- 'pending' | 'indexed' | 'failed'
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_case_id) REFERENCES client_cases(id) ON DELETE CASCADE
  );
  ```

- **Backend**:
  - `electron/rag/KnowledgeBaseManager.ts` — `getClientCases`, `createClientCase`, `addSource`, `getSourcesForClient`, `deleteClientCase`, `deleteAllSources`.
  - `addSource()` now routes to **one of four extractors** by `sourceType`:
    - `'file'` → `extractSafeDocumentText` (PDF/DOCX/TXT/MD via existing `SafeDocumentTextExtractor`).
    - `'web_page'` → `extractWebPage` (Node `fetch` + regex; **does not handle JS-rendered SPAs**).
    - `'ppt'` → `extractPptSlides` (parses .pptx ZIP via `adm-zip`; **older .ppt binary not supported**).
    - `'youtube'` → `extractYouTubeTranscript` (third-party `youtubetranscript.com`; **not production-grade**, see warning in file header).
  - All extractors live in `electron/rag/extractors/`. They return `ExtractedContent` (text + title + metadata) which feeds the existing chunk-and-embed pipeline.
  - `electron/rag/suggest/KnowledgeBaseGate.ts` — provides `getActiveClientCase`, `setActiveClientCase`, `injectKBContext`.

- **Wiring**:
  - `electron/main.ts:910` imports `KnowledgeBaseManager` and calls `setPipeline(vectorStore, embeddingPipeline)` during `AppState` init (`electron/main.ts:2020–2032`).
  - `electron/llm/WhatToAnswerLLM.ts` (around line 426) calls `injectKBContext(query)` when an active case is set. **Uses dynamic `await import()`** (not `require()`) to avoid the same esbuild deferred-init ReferenceError that hit `ipcHandlers.ts`. Do not change to `require()`.

- **Frontend**:
  - `src/components/settings/KnowledgeBaseSettings.tsx` — main settings panel with create-case form, source tabs (file / web page / YouTube), and source list.
  - `src/components/ClientCaseSelector.tsx` — case selector + inline create form (used in chat overlays).
  - Both wired into `electron/preload.ts` + `src/types/electron.d.ts` IPC surface.

---

## 🛠 Outstanding Work (in priority order)

### Phase 1 polish — DONE
Compulsory case-name validation:
- ✅ Save button disabled when `newName.trim() === ''`.
- ✅ Red `*` and "Case name is required" helper text below the input (added 2026-07-20).
- ✅ `aria-required`, `aria-invalid`, `aria-describedby` for screen readers.

### Phase 2 — UI works, backend extractors wired. **Two follow-ups:**

1. **YouTube extractor hardening** — `extractYouTubeTranscript` uses a third-party service that can disappear without notice. For production:
   - swap to the official YouTube Data API + captions endpoint (needs an API key), OR
   - self-host a `youtube-transcript`-style package that scrapes the timedtext endpoint directly.
   - Add retries and a graceful fallback message in the UI when extraction fails.
   - See the WARNING block in `electron/rag/extractors/YouTubeExtractor.ts`.

2. **Web-page extractor for SPAs** — the regex-based `extractWebPage` returns < 200 chars of text for JS-rendered sites (Notion, React apps). It logs a warning. Consider:
   - adding `puppeteer-core` or `playwright` as an optional path, OR
   - clearly telling users in the UI when a page yields too little text.

### Phase 3 — DONE
Chat grounding via `injectKBContext`. Active when a user picks a client case in the chat overlay (`KbStatusIndicator` shows the active case).

### ⚠️ App-boot issue (not KB-specific, but discovered while debugging KB)

When KB work was in-flight, `npm start` showed a black screen. **Root cause** was a TypeScript compile failure: `SettingsOverlay.tsx` imported `./settings/KnowledgeBaseSettings` while the file lived at `./KnowledgeBaseSettings` (and was moved again during bisection). The build aborted, electron never opened, the user saw a black window from a stale Electron session.

**Lesson:** before debugging a black screen, check the build output for `error TS` lines. If the build fails, the renderer never gets a bundle and there's nothing to debug.

There's also a separate **renderer memory leak** (~4 GB transient native growth during boot) that's partly fixed by the `setUserState` short-circuit in `src/lib/onboarding/orchestrator.ts:592` (only call `notify()` when the patch actually changed a key). That patch was reverted to get the user unblocked — re-apply it after Phase 1/2 are done.

---

## 📁 File map (where everything actually lives today)

```
electron/
  rag/
    KnowledgeBaseManager.ts          ← addSource() routes to extractors/
    extractors/
      types.ts                       ← ExtractedContent interface
      WebPageExtractor.ts            ← fetch + regex HTML→text
      PptExtractor.ts                ← adm-zip .pptx parser
      YouTubeExtractor.ts            ← transcript via 3rd-party API
      index.ts                       ← barrel export
    suggest/
      KnowledgeBaseGate.ts           ← getActiveClientCase / setActiveClientCase / injectKBContext
    index.ts                         ← exports extractors & KB types
  db/
    DatabaseManager.ts               ← migration v25→v26 creates KB tables
  llm/
    WhatToAnswerLLM.ts               ← await import() of KnowledgeBaseGate
  main.ts:910                        ← top-level KB import + setPipeline wiring
  ipcHandlers.ts:23                  ← top-level KB import + kb:* handlers

src/
  components/
    settings/
      KnowledgeBaseSettings.tsx      ← settings panel (file/web/youtube tabs)
    ClientCaseSelector.tsx           ← inline case picker + create form
  types/
    electron.d.ts                    ← IPC surface for kbGetClientCases etc.
```

---

## ⚡ Quick checks for the next agent

- **Build failure on `npm start`?** → check terminal for `error TS` lines first. Black screen + no errors in renderer logs almost always means the renderer bundle never loaded.
- **Adding a new IPC method?** → declare in `electron/preload.ts` interface AND `src/types/electron.d.ts` interface AND register handler in `electron/ipcHandlers.ts`. TypeScript will catch mismatches.
- **Adding a new extractor?** → implement in `electron/rag/extractors/<Name>Extractor.ts`, export from `extractors/index.ts`, branch in `KnowledgeBaseManager.addSource()` based on `sourceType`.
- **Touching the orchestrator?** → keep the `setUserState` short-circuit at line 592; re-arm timer fires during boot otherwise.

---

## 📝 Session log — 2026-07-20 (Claude Code GUI)

**What changed in this session:**

- Wired the three pending extractors (`WebPageExtractor`, `PptExtractor`, `YouTubeExtractor`) into `KnowledgeBaseManager.addSource()` via lazy `require('./extractors')`. Previously `web_page` was a stub (`[Web page source: ${url}]`) and `ppt`/`youtube` errored out.
- Created `electron/rag/extractors/{types,index,WebPageExtractor,PptExtractor,YouTubeExtractor}.ts`. Shared `ExtractedContent` interface keeps the rest of the pipeline unchanged.
- Added `ExtractedContent` type + 4 new function re-exports to `electron/rag/index.ts`.
- Lazy `await import` of `KnowledgeBaseGate` in `electron/llm/WhatToAnswerLLM.ts` (parity fix for the `__esm` ReferenceError already applied to `ipcHandlers.ts` / `main.ts`).
- `ClientCaseSelector.tsx`: case-name input now has `aria-required`, dynamic red-border, and "Case name is required" helper text. No new state, JSX-only.

**Open issues / known gaps (still on the punch list):**

1. `adm-zip` is transitive only — must `npm install adm-zip` to make PPT extraction reliable across dep updates.
2. `YouTubeExtractor` uses `youtubetranscript.com` (unofficial). For production, swap for the official YouTube Data API or `youtube-transcript` npm package.
3. `WebPageExtractor` can't render JS — SPAs will return near-empty text. No headless browser wired in.
4. Cannot launch the Electron app from the current Claude sandbox (`process_singleton_posix.cc` socket creation blocked). User must launch from a normal terminal — see "How to run" below.

**How to run (from user's normal terminal, not this sandbox):**

```bash
cd /Users/ravipandey/Dev/IA/natively
git submodule update --init --recursive   # one-time: premium/ is empty
npm install
npm install adm-zip                       # one-time: explicit dep
npm run build:native                      # one-time: Rust native module
npm run build:electron                    # compile TS → dist-electron/
npm start                                 # = npm run app:dev (vite + electron)
```

If "Another instance is already running" appears:

```bash
rm -f "/Users/ravipandey/Library/Application Support/natively/SingletonLock"
rm -f "/Users/ravipandey/Library/Application Support/natively/SingletonSocket"
```

**Repo remote:** `https://github.com/medscode/natively_ai.git`, branch `develop`.

---

## 📝 Session log — 2026-07-21 (Claude Code GUI, CTO demo prep)

**Goal:** Get end-to-end KB → chat retrieval working for tomorrow's CTO demo.

**Settings menu cleanup:** Removed Natively API / Pro / Skills / Calendar / Sync / Intelligence / Help / About from sidebar. Sidebar now shows: General, AI Providers, Knowledge Base, Suggest Mode, Web Search, Audio, Keybinds. (`src/components/SettingsOverlay.tsx`, ~271 lines removed)

**KB-aware chat wired:**
- New `RAGManager.queryKB()` generator — resolves active case, retrieves chunks, streams LLM answer grounded in KB
- New IPC `kb:ask` + `kb:cancel-ask` + `kb:stream-chunk` / `kb:stream-citations` / `kb:stream-complete` / `kb:stream-error`
- `GlobalChatOverlay` now prefers `kbAsk` over meeting/global RAG when an active case is set
- Citations render as BookOpen-iconed badges below the answer

**KB query fix:** `queryKnowledgeBase` now uses `vectorStore.searchSimilar()` (which actually exists) instead of the non-existent `vectorStore.search()`. Embedding obtained via `getEmbeddingWithFallback()`.

**Builds:** `npm run build` ✓, `npm run build:electron` ✓, KBIpcValidation tests 13/13 pass.

**Pending:** Suggest Mode wired to live transcript, Web Search toggle actually enforced.

---

## 📝 Session log — 2026-07-21 (continued, Claude Code GUI, chat UI redesign v3)

**Test summary from user:**
- KB upload now works (two files: `NovaGrid_Pitch_Deck.pptx`, `NovaGrid_Company_Profile.pdf`)
- KB chat works for follow-up questions
- BUT: 5 chat presets (What to answer, Clarify, Recap, Follow Up Question, Answer) cram the input bar
- Interview Mode toggles (Detectable / Fast Response / Transcript / Interview Mode) clutter the panel
- Live transcript not actually running (`STT provider is 'none'`, Rust native module missing)
- Audio capture not working — permissions dialog keeps nagging

**User's design preferences confirmed (2026-07-21):**
- Keep all 5 chat presets, but collapse them into a "••• More" dropdown
- Suggest Mode + Web Search toggles go in the More menu or chat header
- Remove Interview Mode UI entirely
- Suggest Mode = auto-detect live transcript if available; fallback to mock-mode on last chat context
- Live KB indicator above chat input showing which case is grounded

**Planned (not yet implemented):**
- New `MeetingChatPanel.tsx` (active-KB header + message scroll + footer with More menu + Sparkles Suggest button + Web search toggle inside More)
- `LiveTranscriptBrain` integration in main process — poll every 5s when transcript context is non-empty AND Suggest Mode is ON
- `kbSuggest` already works for mock-mode (uses last chat message) — wired in last session
- Settings menu cleanup of unnecessary tabs (already done)
- Pending confirmation on: where to mount new chat, exact toggle placement, live-transcript polling cadence

**Architectural note:** `src/components/NativelyInterface.tsx` is 6,581 lines — main interactive chat. Don't refactor blindly; build new component first, then transition.

**Suggest Mode (KB-grounded follow-ups):**
- New IPC `kb:suggest` — combines current question + active KB chunks → emits `suggestion-generated` event with text + citations.
- New `electron/rag/WebSearchProvider.ts` (DuckDuckGo HTML endpoint, no key; falls back to Tavily if key set).
- Added `DefaultWebSearchProvider` and integrated into `RAGManager.queryKB` as a fallback when KB has no answer AND web search is enabled.
- Suggest button (Sparkles icon) added next to chat send arrow in `GlobalChatOverlay` — uses current input or last user message.
- SuggestionOverlay now shows citations below the suggestion text.

**Status:**
- Settings: ✅ Cleaned
- KB upload: ✅ Fixed (queryKnowledgeBase uses real `searchSimilar`, FK existence check)
- KB chat: ✅ End-to-end with citations
- Suggest: ✅ KB-grounded button wired
- Web search: ✅ Toggle works, fallback in chat works
- Build: ✅ Both `npm run build` + `npm run build:electron` succeed
- Tests: ✅ 13/13 KB validation tests pass

**For tomorrow's demo:** Start app → Settings → Knowledge Base → create case → upload files → "Set Active" → close Settings → open chat → ask questions about the files → citations appear. Use Sparkles button for KB-grounded suggestions. Toggle Web Search in Settings to enable web fallback.

---

## 🐛 Issue hit on 2026-07-20

**Symptom:** `Error: No handler registered for 'kb:create-client-case'` when the user clicked "create case" in the UI.

**Cause:** User's running Electron process loaded a stale `dist-electron/electron/main.js` from before my `npm run build:electron` rebuild in this session. The kb handlers ARE in source (`ipcHandlers.ts:10796`) and in the freshly-compiled `dist-electron/electron/ipcHandlers.js:189083`, but the running process didn't have them.

**Fix:**
1. Stop the Electron app
2. `npm run build:electron`
3. Re-launch

**Why this matters for future sessions:** whenever I make changes to `electron/` TypeScript files, the user MUST run `npm run build:electron` (or restart via `npm start` which does it automatically) before the running app picks them up. Hot-reload only covers the renderer (`src/`); the main process always needs a full restart.
