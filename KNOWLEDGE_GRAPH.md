# Natively — Complete Knowledge Graph

> A complete, expandable educational map of the Natively repository. Built so a complete beginner can:
> 1. Understand every major file, what library it uses, and what it does.
> 2. Predict where a change AI makes will land.
> 3. Manually track diffs and fix small bugs themselves.
> 4. Speak fluently about any layer of the stack.

---

## Table of Contents

1. [What Natively Is](#1-what-natively-is)
2. [The 10-Second Mental Model](#2-the-10-second-mental-model)
3. [Project Layout — Top Level](#3-project-layout--top-level)
4. [How a "Build" Actually Happens](#4-how-a-build-actually-happens)
5. [Process Model — Electron's 3 Worlds](#5-process-model--electrons-3-worlds)
6. [The IPC Bridge — How Frontend ↔ Backend Talk](#6-the-ipc-bridge--how-frontend--backend-talk)
7. [Boot Sequence (what happens when you `npm start`)](#7-boot-sequence)
8. [Dependency Map — Libraries & What They Do](#8-dependency-map)
9. [The Frontend (React) Layer](#9-the-frontend-react-layer)
10. [The Main Process Layer](#10-the-main-process-layer)
11. [The Renderer Code Surface — Every File](#11-the-renderer-code-surface)
12. [The Main Code Surface — Every File](#12-the-main-code-surface)
13. [The Database Layer](#13-the-database-layer)
14. [The RAG (Retrieval-Augmented Generation) Pipeline](#14-the-rag-pipeline)
15. [The Knowledge Base Subsystem](#15-the-knowledge-base-subsystem)
16. [The LLM Layer — How Answers Are Generated](#16-the-llm-layer)
17. [The Intelligence Engine](#17-the-intelligence-engine)
18. [Audio / STT Pipeline](#18-audio--stt-pipeline)
19. [Screenshot / Screen Context Pipeline](#19-screenshot--screen-context-pipeline)
20. [Settings & Services](#20-settings--services)
21. [Window Management](#21-window-management)
22. [The "Modes" System](#22-the-modes-system)
23. [Browser Extension (natively-browser)](#23-browser-extension)
24. [The Tests / Evals / Benchmarks Universe](#24-tests--evals--benchmarks)
25. [CI / Build / Release Pipeline](#25-ci--build--release)
26. [Scripts Directory — Manual Tools](#26-scripts-directory)
27. [Version Control & Daily Workflow](#27-version-control--daily-workflow)
28. [How To Track Changes AI Makes](#28-how-to-track-changes-ai-makes)
29. [Glossary of "Gobbledygook"](#29-glossary)

---

## 1. What Natively Is

**Natively** is a desktop AI assistant that lives in a transparent overlay window. It listens to meeting audio (system audio + mic), watches the screen, and produces real-time answers, summaries, follow-ups, and meeting notes.

It's an **Electron** desktop app, so it ships as `.dmg` / `.exe` / `.AppImage`. Internally it has:
- A **React** UI (the window you see).
- A **Node.js** main process (does the heavy lifting: audio capture, DB, IPC, LLM calls).
- A **vector database** (SQLite + sqlite-vec) for retrieval.
- **On-device models** (Whisper for transcription, embeddings, reranker) plus **cloud LLMs** (Gemini, Claude, OpenAI, Groq).

The fork this repo is based on was originally for interview cheating. **The internal Medhavee team has pivoted Natively into a copilot for law-firm client meetings** (wills, intake). So you'll see "client cases", not "interview questions", in newer files.

**Version:** `2.8.4` (from `package.json`).
**Internal staging appId:** `com.electron.meeting-notes` (packaged product name is "Natively").

---

## 2. The 10-Second Mental Model

```
┌─────────────────────────────────────────────────────────┐
│  USER: launches app → transparent overlay window opens  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  MAIN PROCESS (Node, electron/main.ts)                  │
│  • Spawns window, tray, system audio capture            │
│  • Holds SQLite DB, VectorStore, RAG, LLM clients       │
│  • Listens for "ipcMain.handle(...)" routes             │
└─────────────────────────────────────────────────────────┘
                          ▲  IPC (JSON over WebSocket-like channel)
                          ▼
┌─────────────────────────────────────────────────────────┐
│  RENDERER PROCESS (Chromium, src/main.tsx)              │
│  • React UI: Launcher, MeetingChatPanel, Settings       │
│  • Calls window.electronAPI.xxx() → IPC goes to main    │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │  XHR/HTTPS
                          ▼
┌─────────────────────────────────────────────────────────┐
│  EXTERNAL: Gemini / OpenAI / Claude / Groq / Tavily     │
│  • Cloud LLM providers + web search                     │
└─────────────────────────────────────────────────────────┘
```

**Three boxes, one bridge.** That's the whole app. Everything else is detail.

---

## 3. Project Layout — Top Level

| Folder / File | What It Is | Lines (approx) |
|---|---|---|
| `index.html` | Single HTML entry that loads `/src/main.tsx`. Sets CSP, theme pre-cache, window-type attribute. | 41 |
| `package.json` | npm manifest. Lists deps, scripts, electron-builder config. | 339 |
| `vite.config.mts` | Bundler config for the React renderer. Manual `manualChunks` keeps bundle small. | 99 |
| `tsconfig.json` / `electron/tsconfig.json` | TypeScript configs. Two separate ones: one for renderer (src/), one for main (electron/). | small |
| `src/` | **React UI** (renderer process). The visible app. | ~76MB on disk |
| `electron/` | **Main process** (Node + Electron APIs). Brain of the app. | ~12MB |
| `native-module/` | A **native addon** (Rust/C++) compiled at install time via `@napi-rs/cli`. Used for screen capture / native APIs. | small |
| `natively-browser/` | A **browser extension** (Chrome/Firefox) for the DOM-capture side. Uses its own esbuild pipeline, NOT Vite. | small |
| `renderer/` | A **legacy / alternate** React app that still exists for backwards compat. | small |
| `scripts/` | Node.js scripts (download models, rebuild native, e2e smokes, release). | ~70 files |
| `tests/` | Playwright e2e + integration tests. | several |
| `tools/` | Investigation tools (trace-routing, trace-fastpath). | small |
| `worker-script/` | Worker scripts that run in worker_threads. | small |
| `benchmarks/` | Offline benchmark harnesses (not in source tree main). | — |
| `intelligence-eval-real-ui/` | Real-UI eval harness (Playwright). | — |
| `patches/` | `patch-package` patches to fix upstream npm bugs. | small |
| `build/`, `dist/`, `dist-electron/`, `release/` | **Build outputs** (gitignored). | — |
| `assets/`, `resources/` | Icons, models, sounds. | — |
| `.claude/` | Claude Code config (this assistant's settings). | — |
| `memory.md` | Hand-written session memory (your notes for future agents). | 540+ |
| `natively-api/` | A separate sub-project for the API tests. | — |
| `premium/`, `src/premium/` | Licensing / paid feature flags. | small |
| `fixtures/`, `test-fixtures/` | Static test data (PDFs, mock transcripts). | small |
| `reports/` | Post-mortem audits. | small |
| `patches/` | `patch-package` diffs. | small |
| `contextauthresearchdoc.md` | Internal research notes on context authority. | — |

---

## 4. How a "Build" Actually Happens

You type `npm start`. Here's the chain:

```
$ npm start
    │
    ▼
runs script "app:dev":
   concurrently \
     "npm run dev -- --port 5180 --strictPort" \
     "wait-on http://localhost:5180 && npm run electron:dev"
                            │
                            ▼
       "npm run dev" → vite (dev server on 5180, serves /src/main.tsx + index.html with HMR)
                            │
                            ▼
       once port 5180 is up, "npm run electron:dev" runs:
          npm run build  →  tsc + vite build  →  writes to dist/ + dist-electron/
          npm run build:electron  →  esbuild bundles electron/* into dist-electron/electron/main.js
          cross-env NODE_ENV=development electron .
                            │
                            ▼
       Electron starts → loads dist-electron/electron/main.js → main.ts runs
       → app.whenReady() → creates BrowserWindow pointing at http://localhost:5180
       → React app loads, connects via window.electronAPI
```

**Key scripts** (from `package.json`):
- `npm run dev` — Vite dev server only (no Electron).
- `npm run build` — Full Vite build → `dist/`.
- `npm run build:electron` — esbuild bundles `electron/` → `dist-electron/`.
- `npm run typecheck:electron` — typecheck only, no emit.
- `npm run electron:dev` — start Electron pointing at dev server.
- `npm run app:dev` — both, with `concurrently` (the one `npm start` runs).
- `npm run app:build` — full production build + native rebuild + DMG/zip via electron-builder.
- `npm run postinstall` — runs **after** `npm install` to:
  - patch packages
  - rebuild `sharp` (image lib)
  - rebuild native modules for Electron's Node ABI
  - download ML models (Whisper, embeddings, reranker) into `resources/models/`
  - ensure `sqlite-vec` is built for the right platform
  - patch the macOS plist (info.plist) with screen-capture strings
  - verify native arch matches the Electron build

**`npm start` ≠ magic**: it expects `node_modules/` to be installed and models downloaded. If you just cloned, run `npm install` first.

---

## 5. Process Model — Electron's 3 Worlds

Electron has 3 process tiers. Knowing which is which is critical:

### 5.1 Main process (Node.js)
- **One** of these. Runs `electron/main.ts` → bundled to `dist-electron/electron/main.js`.
- Has full Node.js + OS access (filesystem, sqlite, microphone).
- **Long-lived** — lives for the whole app.
- Owns: `BrowserWindow`s, system tray, audio capture, DB connections, IPC handlers.
- **Can NOT** render UI directly.

### 5.2 Renderer process (Chromium, one per window)
- **One per window**. Runs `src/main.tsx` → bundled to `dist/assets/index-*.js`.
- A sandboxed Chromium tab. No Node.js by default.
- React app lives here. Can only call `window.electronAPI.*` to reach the main process.
- **Can NOT** read filesystem or open a DB. Must go through IPC.

### 5.3 Preload script
- Bridge file. Runs in renderer process but with Node access.
- **`electron/preload.ts`** — exposes `window.electronAPI` to the renderer via `contextBridge.exposeInMainWorld`.
- This is the **only** way the React app reaches the main process. It is the typed contract.

> **For beginners**: think of preload as a "remote control". Renderer holds the remote, main has the TV. The remote only exposes safe buttons.

---

## 6. The IPC Bridge — How Frontend ↔ Backend Talk

### 6.1 The contract lives in 3 places

| File | What it does |
|---|---|
| `electron/preload.ts` (2,644 lines) | `contextBridge.exposeInMainWorld('electronAPI', {...})`. Defines every JS-callable function the React app can use. |
| `src/types/electron.d.ts` | TypeScript types that mirror the preload surface, so the React app can call `window.electronAPI.xxx()` with autocomplete. |
| `electron/ipcHandlers.ts` (11,298 lines) | `ipcMain.handle('namespace:action', async (_evt, args) => {...})`. The actual implementation on the main side. |

### 6.2 The pattern

```ts
// In React (renderer):
const result = await window.electronAPI.kbListCases();

// In preload.ts:
contextBridge.exposeInMainWorld('electronAPI', {
  kbListCases: () => ipcRenderer.invoke('kb:list-cases'),
});

// In ipcHandlers.ts:
ipcMain.handle('kb:list-cases', async () => {
  return knowledgeBaseManager.listClientCases();
});
```

### 6.3 Channels are namespaced strings
- `kb:create-client-case`, `kb:list-sources`, `kb:query`, `kb:suggest` — Knowledge Base.
- `llm:config:get`, `llm:provider:switch` — LLM provider.
- `screenshot:take`, `screenshot:list` — Screenshots.
- `meeting:start`, `meeting:append-transcript` — Meeting capture.
- `settings:get`, `settings:set` — Settings.
- `chat:stream` — Streaming chat completions.
- ~hundreds more.

### 6.4 Streaming
For long-running things (LLM streaming, transcription), main pushes events:
```ts
ipcMain.handle('chat:start', async (evt) => {
  llmStream.on('token', (t) => evt.sender.send('chat:token', t));
});
```
Preload exposes `window.electronAPI.onChatToken((cb) => ipcRenderer.on('chat:token', (_, t) => cb(t)))`.

**This is why IPC count is large**: every callback requires 3 registrations (main + preload + types).

---

## 7. Boot Sequence

When you run `npm start`:

1. **Vite dev server starts** on port 5180 (HMR for React).
2. **esbuild bundles `electron/`** → `dist-electron/electron/main.js`.
3. **Electron starts** → loads `main.js`.
4. **`main.ts` top of file**:
   - Imports `./nativeArchGate` (FIRST, so it can throw if arch mismatch).
   - Overrides `dns.lookup` for `api.natively.software`.
   - Loads `.env` if not packaged.
   - Disables Chromium's "Fontations" font backend on macOS 26+ (crash mitigation).
   - Sets up `uncaughtException` / `unhandledRejection` handlers.
   - Sets up SIGTERM/SIGINT/SIGHUP handlers (close DB cleanly).
5. **`app.whenReady()`** fires.
6. **`initializeApp()`** runs:
   - `WindowHelper.createMainWindow()` → `BrowserWindow` → load `http://localhost:5180`.
   - `WindowHelper.createCropperWindow()` (lazy, when user takes a region screenshot).
   - `DatabaseManager.getInstance()` → opens `app.getPath('userData')/natively.db`.
   - `VectorStore` + `EmbeddingPipeline` + `RAGManager` initialize.
   - `LLMHelper` constructed (provider config from settings).
   - `SessionTracker`, `MeetingPersistence` initialized.
   - `IntelligenceEngine` constructed.
   - `ipcHandlers.register(appState)` wires every IPC channel.
   - Tray menu, global shortcuts (StealthKeyboardManager).
   - Auto-updater check (electron-updater).
7. **Renderer loads**:
   - `src/main.tsx` runs.
   - Cache theme synchronously.
   - Fetch theme from main via `electronAPI.getThemeMode()`.
   - Mount `<App />` inside `<LanguageProvider>`.
   - `App.tsx` decides which overlay to show: Launcher, MeetingChatPanel, etc.

---

## 8. Dependency Map

### 8.1 Runtime deps (from `package.json`)

**AI / LLM providers**
- `@anthropic-ai/sdk` — Claude API.
- `@google/genai` — Gemini API (new SDK).
- `openai` — OpenAI API.
- `groq-sdk` — Groq API.
- `@google-cloud/speech` — Google STT.
- `@deepgram/sdk` — Deepgram streaming STT.
- `@elevenlabs/client` + `@elevenlabs/elevenlabs-js` — ElevenLabs STT/TTS.
- `@tavily/core` — Web search API (used as fallback when KB is empty).

**Vector / RAG / Embeddings**
- `better-sqlite3` — sync SQLite driver (synchronous = simpler code).
- `sqlite-vec` — vector search extension for SQLite.
- `onnxruntime-node` + `onnxruntime-common` — runs local ONNX models (embeddings, reranker).
- `@huggingface/transformers` — runs Whisper, MiniLM, bge-reranker locally.

**Browser/UI in main**
- `electron` itself.
- `electron-store` — settings persistence.
- `electron-updater` — auto-update.
- `keytar` — OS keychain access (API keys).
- `puppeteer`-free approach: no headless browser. Uses system APIs.

**UI (React)**
- `react` 19, `react-dom` 19.
- `framer-motion` 12 — animations.
- `lucide-react` + `react-icons` — icons.
- `@radix-ui/react-dialog`, `@radix-ui/react-toast` — accessible primitives.
- `@tanstack/react-query` — server-state cache.
- `tailwindcss` 3 — utility CSS.
- `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `katex` — render LLM output.
- `react-syntax-highlighter` + `react-code-blocks` — code blocks in chat.
- `marked` — fast markdown→HTML for non-React contexts.
- `liquid-glass-react` — liquid glass effect (Apple-style frosted UI).
- `jspdf` — generate PDFs.
- `qrcode` — QR codes.
- `three` + `@types/three` — 3D background effects.
- `mammoth` — DOCX→text.
- `pdf-parse` — PDF→text.
- `tesseract.js` — OCR fallback.
- `sharp` — fast image processing.
- `screenshot-desktop` — cross-platform screenshot.

**Data / State**
- `axios` — HTTP.
- `diff` — text diffing.
- `uuid` — IDs.
- `adm-zip` — read .pptx, .docx zips.
- `ws` — WebSocket client (for phone mirror).

**Dev deps**
- `electron`, `electron-builder`, `@electron/rebuild`, `@electron/notarize` — packaging.
- `vite` 5 + `@vitejs/plugin-react` — bundler for renderer.
- `typescript` 5.6.
- `tailwindcss`, `postcss`, `autoprefixer`.
- `playwright` + `@playwright/test` — e2e.
- `patch-package` + `husky` — patch + git hooks.
- `react-doctor` — React perf audit.
- `wait-on`, `concurrently` — script orchestration.

### 8.2 Optional deps
- `@vectorize-io/hindsight-client` — long-term memory backend (postgres + pgvector).
- `sqlite-vec-darwin-arm64` / `sqlite-vec-darwin-x64` — platform-specific vec binaries.

---

## 9. The Frontend (React) Layer

### 9.1 Entry chain

```
index.html
   └─ /src/main.tsx         (Vite entry — sets up React, theme, error traps)
       └─ <LanguageProvider> (src/i18n.tsx)
           └─ <App />        (src/App.tsx — the root component)
               └─ <Launcher /> or <NativelyInterface />  (top-level UI)
```

### 9.2 `src/App.tsx` (1,244 lines)
The root. It decides:
- Which window are we? (`?window=launcher|overlay|cropper|settings`)
- What to render based on auth state, mode, current view.

### 9.3 `src/components/` — 40+ components

| File | Lines | Role |
|---|---|---|
| `Launcher.tsx` | 101,693 | The **main chat surface**. Floating chat input + history. |
| `NativelyInterface.tsx` | 299,747 | **The actual chat surface** the user's team uses (lives on top of the launcher). |
| `MeetingChatPanel.tsx` | 55,533 | Lawyer/analyst chat panel with citations. |
| `MeetingChatOverlay.tsx` | 26,938 | Overlay variant of the same. |
| `MeetingDetails.tsx` | 131,579 | Post-meeting view: transcript, notes, action items. |
| `SettingsOverlay.tsx` | 240,809 | **MASSIVE** settings panel (KB, providers, modes, etc.). |
| `SettingsPopup.tsx` | 22,908 | Smaller settings popup. |
| `Settings/` | many | Individual settings tabs (AIProviders, KnowledgeBase, Modes, etc.). |
| `NativelyLogoMark.tsx` | 1,631 | Logo. |
| `WindowControls.tsx` | 3,008 | macOS-style traffic light buttons. |
| `ProfileIntelligenceSettings.tsx` | 87,356 | Profile/identity settings. |
| `LocalWhisperModelPanel.tsx` | 34,869 | Whisper model management UI. |
| `Cropper.tsx` | 12,626 | Region screenshot selector. |
| `GlobalChatOverlay.tsx` | 24,158 | Global hotkey chat. |
| `ClientCaseSelector.tsx` | 12,454 | Pick active client case for KB. |
| `CitationBadge.tsx` | 3,619 | Inline citation chip in chat. |
| `KnowledgeBaseSettings.tsx` | (in Settings/) | KB management UI. |

### 9.4 `src/lib/` — 35+ helpers
Most are paired `.mjs` + `.d.mts` files (the `*.mjs` is the source, `*.d.mts` is types-only). They cover:
- Streaming token queue (`streamingTokenQueue.mjs`).
- Chat de-duplication (`chatStreamGuard.mjs`, `overlaySubmitDedup.mjs`).
- Scroll budgeting.
- STT error mapping.
- Glass-effect displacement map.
- Onboarding stage catalog.
- `analytics/` — GA events.
- `onboarding/` — multi-stage onboarding flow.

### 9.5 `src/intelligence/SuggestModeCoordinator.ts`
Coordinates the **Manual / Suggest** toggle in the chat. Decides whether to auto-fire suggestions or require user click.

### 9.6 `src/hooks/`
- `useResolvedTheme.ts` — read+apply dark/light theme.
- `useShortcuts.ts` — global keyboard shortcut bindings.
- `useStreamBuffer.ts` — token streaming buffer for chat.

### 9.7 `src/utils/`
- `prismLanguage.ts` + `registerPrismLanguages.ts` — code-block syntax highlighting registry.
- `pdfGenerator.ts` — generate PDFs from chat.
- `keyboardUtils.ts`, `messageId.ts`, `modelUtils.ts`, `platformUtils.ts`.

### 9.8 `src/types/`
- `electron.d.ts` — typed contract for `window.electronAPI`.
- `index.tsx` — shared types.
- `audio.ts`, `solutions.ts`.

### 9.9 `src/i18n.tsx` + `.generated.*.ts`
Custom i18n. 6 languages (en, es, ja, ru, zh). Generated from a base + a translator.

### 9.10 `src/index.css` (215KB)
All Tailwind output + custom CSS. Big because it ships Inter, JetBrains Mono, etc.

---

## 10. The Main Process Layer

### 10.1 `electron/main.ts` (7,816 lines)
The single biggest file. Responsibilities:
- App lifecycle (boot, quit, signals).
- Window creation.
- All `app.on(...)` events.
- Global state holder (`AppState` interface).
- Boots every subsystem.
- Top-level: font crash mitigation, dns override, uncaught handlers.

### 10.2 `electron/preload.ts` (2,644 lines)
The typed `window.electronAPI` surface. ~hundreds of methods grouped by domain. Uses `contextBridge.exposeInMainWorld`.

### 10.3 `electron/ipcHandlers.ts` (11,298 lines)
Massive registry. Every `ipcMain.handle(...)` lives here. Some are conditionally registered (gated by `app.isPackaged` or feature flags like `NATIVELY_E2E`).

### 10.4 Top-level `electron/*.ts` helpers

| File | Lines | Role |
|---|---|---|
| `LLMHelper.ts` | 7,691 | The big one. Wraps Gemini/OpenAI/Claude/Groq. Streaming, retries, prompt caching. |
| `IntelligenceEngine.ts` | 3,073 | The "brain" that decides what to answer. |
| `IntelligenceManager.ts` | 307 | Thin wrapper that exposes IntelligenceEngine to the renderer. |
| `MeetingPersistence.ts` | 950 | Save/load meetings to DB. |
| `SessionTracker.ts` | 766 | Active session state, prior assistant responses, memory. |
| `ScreenshotHelper.ts` | 874 | Take screenshots, list, delete. |
| `WindowHelper.ts` | 1,328 | Create/manage all `BrowserWindow`s (launcher, overlay, cropper, settings, model selector). |
| `SettingsWindowHelper.ts` | 333 | Settings window lifecycle. |
| `CropperWindowHelper.ts` | 666 | Cropper (region-select) window. |
| `ModelSelectorWindowHelper.ts` | 305 | Model-selector window. |
| `ProcessingHelper.ts` | 279 | Orchestrates "take screenshot → extract problem → generate solution" pipeline. |
| `DonationManager.ts` | 2,513 | In-app donation flow. |
| `ThemeManager.ts` | 2,945 | Dark/light theme + per-window. |
| `verboseLog.ts` | 889 | Optional verbose logging. |
| `nativeArchGate.ts` | 9,931 | **Boot-time arch check** — throws if you ran x64 build on arm64 (or vice versa). |

---

## 11. The Renderer Code Surface — Every File

(Full list of `src/` files with their purpose, ordered by impact)

```
src/main.tsx                          — 137 lines — Vite entry. Sets up theme, error traps, mounts <App>.
src/App.tsx                          — 1,244 lines — Root. Routes to Launcher / NativelyInterface.
src/index.css                        — 215KB — Tailwind output + custom CSS.
src/i18n.tsx                         — 24KB — i18n provider (en).
src/i18n.*.generated.ts              — 4 large generated translation files (es, ja, ru, zh).

src/types/electron.d.ts              — typed surface for window.electronAPI.
src/types/index.tsx                  — shared component types.
src/types/audio.ts, solutions.ts     — domain types.

src/components/NativelyInterface.tsx — 299,747 lines  ★ ACTIVE CHAT SURFACE FOR INTERNAL TEAM
src/components/Launcher.tsx          — 101,693 lines  ★ ORIG CHAT SURFACE (from fork)
src/components/SettingsOverlay.tsx   — 240,809 lines  ★ MAIN SETTINGS UI
src/components/MeetingDetails.tsx    — 131,579 lines  ★ POST-MEETING VIEW
src/components/ProfileIntelligenceSettings.tsx — 87,356 lines
src/components/MeetingChatPanel.tsx  — 55,533 lines   ★ LAWYER/ANALYST CHAT PANEL
src/components/LocalWhisperModelPanel.tsx — 34,869
src/components/ReviewModal.tsx       — 41,652
src/components/TopSearchPill.tsx     — 21,087
src/components/UpdateModal.tsx       — 22,101
src/components/AboutSection.tsx      — 26,646
src/components/GlobalChatOverlay.tsx — 24,158
src/components/SettingsPopup.tsx     — 22,908
src/components/FollowUpEmailModal.tsx — 14,828
src/components/ModelSelectorWindow.tsx — 11,240
src/components/MeetingChatOverlay.tsx — 26,938
src/components/FeatureSpotlight.tsx  — 18,689
src/components/NativelyInterfaceCard.tsx — 11,651
src/components/HindsightStatusBanner.tsx — 13,252
src/components/StealthKeyboardManager — (in src/hooks) 12,783
src/components/UpdateBanner.tsx      — 8,599
src/components/SupportToaster.tsx    — 16,432
src/components/SuggestionOverlay.tsx — 6,982
src/components/ReviewPromptHost.tsx  — 11,074
src/components/StartupSequence.tsx  — 3,855
src/components/EditableTextBlock.tsx — 5,145
src/components/Cropper.tsx           — 12,626
src/components/CitationBadge.tsx     — 3,619
src/components/NativelyQuotaBanner.tsx — 5,711
src/components/ClientCaseSelector.tsx — 12,454
src/components/ErrorBoundary.tsx     — 5,272
src/components/WindowControls.tsx    — 3,008
src/components/NativelyLogoMark.tsx  — 1,631

src/components/settings/             — Tab components
  Sidebar.tsx
  AIProvidersSettings.tsx
  HelpSettings.tsx
  IntelligenceSettings.tsx
  KnowledgeBaseSettings.tsx          — KB UI
  ModesSettings.tsx
  NativelyApiSettings.tsx
  NativelyProSettings.tsx
  PhoneMirrorSettings.tsx
  ProviderCard.tsx
  SkillsSettings.tsx
  SuggestModeSettings.tsx
  WebSearchSettings.tsx

src/components/onboarding/           — Toaster / permission flows
src/components/ui/                   — Shared atoms (Dialog, Toast, Card, GlassEffect, etc.)
src/components/dynamic-actions/      — Suggested actions UI

src/intelligence/SuggestModeCoordinator.ts — Manual/Suggest toggle logic.

src/lib/                             — Helpers
  chatStreamGuard.mjs                — Prevent duplicate chat completions
  overlayMessagePersistence.mjs      — Persist in-flight messages
  streamingTokenQueue.mjs            — Smooth token stream
  overlayScrollBudget.mjs            — Auto-scroll chat without flicker
  overlayCodeExpansion.mjs           — Code-block expand/collapse
  overlaySttPersistence.mjs          — Persist STT state
  overlaySubmitDedup.mjs             — Submit de-dup
  overlayActionDedup.mjs             — Action de-dup
  overlayStealthFocusGuards.mjs      — Stealth-mode focus checks
  overlayAppearance.mjs              — Look-and-feel
  overlayStreamingCodeUi.mjs         — Streaming code UI tweaks
  overlayIntelligenceGeneration.mjs  — Triggering generation
  glassDisplacementMap.ts            — Liquid-glass effect data
  featureFlags.ts                    — Compile-time feature flags
  meetingInterfaceTheme.ts           — Theme overrides for chat
  sttErrorMapper.ts                  — STT error → user-friendly text
  toasterGating.ts                   — Throttle toasters
  curl-validator.ts                  — Validate curl-like commands

src/hooks/
  useShortcuts.ts                    — Global hotkeys
  useResolvedTheme.ts                — Theme hook
  useStreamBuffer.ts                 — Token buffer

src/utils/
  prismLanguage.ts / registerPrismLanguages.ts — Code highlighting
  pdfGenerator.ts                    — Export chat as PDF
  keyboardUtils.ts, messageId.ts, modelUtils.ts, platformUtils.ts
```

---

## 12. The Main Code Surface — Every File

```
electron/main.ts                      — 7,816 lines — App lifecycle, all subsystem boot, signal handlers.
electron/preload.ts                   — 2,644 lines — window.electronAPI surface.
electron/ipcHandlers.ts               — 11,298 lines — Every ipcMain.handle(...).
electron/LLMHelper.ts                 — 7,691 lines — Provider-agnostic LLM wrapper.
electron/IntelligenceEngine.ts        — 3,073 lines — "What to answer?" brain.
electron/IntelligenceManager.ts       — 307 — Thin wrapper.
electron/MeetingPersistence.ts        — 950 — Save/load meetings.
electron/SessionTracker.ts            — 766 — In-session state, prior responses.
electron/ScreenshotHelper.ts          — 874 — Screenshot capture, list, delete.
electron/WindowHelper.ts              — 1,328 — All BrowserWindows.
electron/SettingsWindowHelper.ts      — 333
electron/CropperWindowHelper.ts       — 666
electron/ModelSelectorWindowHelper.ts — 305
electron/ProcessingHelper.ts          — 279 — screenshot → problem → answer pipeline.
electron/DonationManager.ts           — 2,513
electron/ThemeManager.ts              — 2,945
electron/verboseLog.ts                — 889
electron/nativeArchGate.ts            — 9,931 — Boot arch check.

electron/audio/                       — Speech-to-text subsystem
  AudioDevices.ts                     — 1,226
  DeepgramStreamingSTT.ts             — 13,068 — Deepgram cloud STT
  ElevenLabsStreamingSTT.ts           — 16,334
  GoogleSTT.ts                        — 20,698
  LocalWhisperSTT.ts                  — 38,977 — ON-DEVICE Whisper (HuggingFace transformers)
  MicrophoneCapture.ts                — 14,784 — getUserMedia
  NativelyProSTT.ts                   — 54,026 — Natively's own STT service
  OpenAIStreamingSTT.ts               — 48,824
  RestSTT.ts                          — 19,419
  SonioxStreamingSTT.ts               — 17,800
  SystemAudioCapture.ts               — 13,636 — Capture system audio (loopback)
  relaySession.ts                     — 17,969 — WebSocket relay for remote STT
  nativeModuleLoader.ts               — 12,720 — Load native-module
  dnsHelpers.ts                       — 4,313
  openaiTranscriptTurnCoalescer.ts    — 2,221
  systemAudioHealthClassifier.{mjs,d.mts} — Health check
  whisper/                            — Local Whisper internals
    audioResampler.ts
    hallucinationFilter.ts            — Detect Whisper hallucinations
    hardwareDetect.ts
    inferenceConfig.ts
    modelManager.ts
    modelPreloader.ts
    vadProcessor.ts                   — Voice Activity Detection
    whisperWorker.ts                  — Worker thread entry
    whisperProgressAggregator.ts
    workerPathResolver.ts
    types.ts

electron/db/
  DatabaseManager.ts                  — 3,157 lines — All SQLite schema + migrations + queries.
  seedDemo.ts                         — 765 — Seed demo data.
  test-db.ts                          — 842

electron/intelligence/                — The "brain" module
  ContextFusionEngine.ts              — 11,810 — Merge multi-source context.
  ContextRouter.ts                    — 18,629 — Decide which context sources matter.
  LiveMomentRouter.ts                 — 6,568 — Real-time routing during meetings.
  LiveTranscriptBrain.ts              — 10,177 — Process live transcript.
  MeetingMemoryService.ts             — 9,717 — Cross-meeting memory.
  ConversationMemoryService.ts        — 8,565 — Within-conversation memory.
  ProfileTreeService.ts               — 11,419 — User profile (identity, expertise).
  SearchOrchestrator.ts               — 14,822 — Multi-source search.
  LectureIntelligenceService.ts       — 9,983
  DiagramIntelligenceService.ts       — 11,148
  PromptAssemblerV2.ts                — 8,586 — Compose prompts.
  RrfFusion.ts                        — 8,871 — Reciprocal Rank Fusion for search results.
  OutputShapeNormalizer.ts            — 5,836
  IntelligenceAttribution.ts          — 10,270 — Cite where answers come from.
  IntelligenceTrace.ts                — 13,931
  IntelligenceMetrics.ts              — 4,803
  CodingConversationState.ts          — 9,290
  intelligenceFlags.ts                — 41,170 — ★ GIANT feature-flag registry for intelligence.
  context-os/                         — "Context OS" — source authority
    SourceAuthorityKernel.ts
    ProfileEvidenceService.ts
    EvidenceOrchestrator.ts
    EvidenceResolver.ts
    assistantClaims.ts
    evidencePack.ts
    finalPromptValidation.ts
    generationContext.ts
    hindsightEvidence.ts
    meetingRagEvidence.ts
    promptRenderer.ts
    propertyEvidenceValidator.ts
    renderedEvidenceManifest.ts
    requestedProperty.ts
    requestedPropertyDetector.ts
    sourceKinds.ts
    trace.ts
    types.ts
    + many more
  memory/                             — Long-term memory
    HindsightClientAdapter.ts
    HindsightRetainQueue.ts
    HindsightTagBuilder.ts
    LongTermMemoryService.ts
    MemoryProvider.ts

electron/llm/                         — Provider + answer logic
  AnswerPlanner.ts                    — 195,843 lines — ★ GIANT prompt-planning file.
  WhatToAnswerLLM.ts                  — 49,877 — Decide if a question is answerable.
  AnswerValidator.ts                  — 23,358 — Validate LLM output structure.
  IntentClassifier.ts                 — 27,303 — Classify user intent.
  manualProfileIntelligence.ts        — 87,772 — Manual mode brain.
  ProviderRouter.ts                   — 17,171 — Pick the right provider/model.
  ProfileIntelligenceRouter.ts        — 11,167
  AnswerLLM.ts                        — 1,822
  AssistLLM.ts                        — 1,939
  BrainstormLLM.ts                    — 1,521
  ClarifyLLM.ts                       — 2,756
  CodeHintLLM.ts                      — 1,824
  CodeSanityCheck.ts                  — 15,144
  CodingConversationState.ts          — (also in intelligence/)
  ConversationSummarizer.ts           — 7,788
  FinalAnswerGenerationPolicy.ts      — 6,610
  FollowUpLLM.ts                      — 2,788
  FollowUpQuestionsLLM.ts             — 1,882
  FollowUpResolver.ts                 — 20,608
  GeminiPromptCache.ts                — 8,948 — Cache Gemini system prompts.
  PlannerDecision.ts                  — 3,964
  ProfileJitPromptBuilder.ts          — 9,470
  ProfileOutputValidator.ts           — 36,661
  RecapLLM.ts                         — 3,725
  SessionMemory.ts                    — 12,044
  TemporalContextBuilder.ts           — 7,331
  codeVerification/                   — Sub-folder
  ActiveProfileContext.ts             — 4,872
  answerPolish.ts                     — 21,149
  answerStyle.ts                      — 8,044
  contextRoute.ts                     — 5,641
  codingContract.ts                   — 10,828
  codingFollowup.ts                   — 10,823
  codingStreamGate.ts                 — 3,414
  customContextClassifier.ts          — 10,523
  customModeExecutionContract.ts      — 37,886
  documentGroundedPrompt.ts           — 38,505
  humanLikeness.ts                    — 19,243
  index.ts                            — 10,476 — LLM module barrel.
  intentClassifierWorker.ts           — 2,750 — Worker thread.
  liveDeadlines.ts                    — 9,603 — Latency budgets.
  liveSessionMemory.ts                — 9,004
  liveSessionMemoryConfig.ts          — 10,289
  manualIdentityRouting.ts            — 3,692
  modeProfiles.ts                     — 6,473
  modelCapabilities.ts                — 10,668
  piTelemetry.ts                      — 8,089
  postProcessor.ts                    — 12,043
  profileAnswerBackend.ts             — 4,214
  profileEvidenceValidator.ts         — 10,170
  profileGroundingV2.ts               — 2,655
  prompts.ts                          — 149,351 lines — ★ GIANT prompt library.
  providerErrorClassifier.ts          — 6,966
  sessionFollowupResolver.ts          — 11,373
  sourceOwnership.ts                  — 12,083
  speakability.ts                     — 28,350 — Make text speakable.
  streamContextPolicy.ts              — 4,913
  textStreamFallback.ts               — 3,877
  tinyPrompts.ts                      — 23,525
  transcriptCleaner.ts                — 6,083
  transcriptEntityExtractor.ts        — 6,660
  transcriptQuestionExtractor.ts      — 19,613
  triggerGate.ts                      — 2,132
  turnSourceDecision.ts               — 12,846
  visionCapability.ts                 — 6,234
  visionStreamFallback.ts             — 25,662
  whatToAnswerRequestSnapshot.ts      — 7,901

electron/rag/                         — Retrieval-Augmented Generation
  RAGManager.ts                       — 34,788 lines
  RAGRetriever.ts                     — 11,417
  KnowledgeBaseManager.ts             — 13,964 — ★ CLIENT CASES (internal team pivot)
  VectorStore.ts                      — 33,815 — sqlite-vec wrapper.
  EmbeddingPipeline.ts                — 43,151 — Chunk + embed.
  EmbeddingProviderResolver.ts        — 7,895 — Pick embedder (local/Ollama/OpenAI/Gemini).
  LocalReranker.ts                    — 22,294 — Local bge-reranker ONNX.
  OllamaBootstrap.ts                  — 7,950 — Auto-start Ollama.
  WebSearchProvider.ts                — 5,122 — DuckDuckGo + Tavily.
  SemanticChunker.ts                  — 5,184
  TranscriptPreprocessor.ts           — 5,629
  LiveRAGIndexer.ts                   — 8,243 — Index transcripts as they're captured.
  embeddingSpace.ts                   — 3,486
  extractors/                         — KB content extractors
    PptExtractor.ts                   — Parse .pptx via adm-zip.
    WebPageExtractor.ts               — Node fetch + regex (no JS-render).
    YouTubeExtractor.ts               — Third-party transcript service.
    index.ts                          — Barrel.
    types.ts                          — ExtractedContent type.
  providers/                          — Embedding providers
    GeminiEmbeddingProvider.ts
    LocalEmbeddingProvider.ts
    OllamaEmbeddingProvider.ts
    OpenAIEmbeddingProvider.ts
    IEmbeddingProvider.ts
    localEmbeddingWorker.ts           — Worker thread.
  suggest/
    KnowledgeBaseGate.ts              — Active-case gate for KB suggestions.
  vectorSearchWorker.ts               — 12,694 — Vector search in a worker.
  localRerankerWorker.ts              — 4,101
  rerankerDownloadProvider.ts         — 4,887
  rerankerDownloadWorker.ts           — 4,863
  kbSuggest.ts                        — 3,644 — KB → chat suggest logic.
  prompts.ts                          — 3,606
  index.ts                            — 1,393

electron/services/                    — Domain services
  ModesManager.ts                     — 86,288 lines — ★ Modes (Meeting/Lecture/Coding/etc.)
  ModeContextRetriever.ts             — 96,917 lines — ★ Retrieve context per mode.
  ModeGenerator.ts                    — 17,562 — Generate mode templates.
  HindsightManager.ts                 — 54,218 — Long-term memory client.
  SkillsManager.ts                    — 46,012 — User-defined skills.
  ModelVersionManager.ts              — 46,182 — Manage model versions.
  PhoneMirrorService.ts               — 70,819 — Mirror Android screen via scrcpy.
  CodexCliService.ts                  — 44,904 — Run local codex CLI.
  CodexOAuthService.ts                — 31,684
  CredentialsManager.ts               — 54,189 — Keychain wrapper.
  SettingsManager.ts                  — 19,962 — Persisted settings.
  KeybindManager.ts                   — 23,820
  LocalModelDownloadService.ts        — 28,527
  OllamaManager.ts                    — 15,000
  CalendarManager.ts                  — 19,098
  ReviewService.ts                    — 17,574
  StealthKeyboardManager.ts           — 20,032
  phoneMirrorClient.ts                — 47,181
  modeSourceContract.ts               — 34,934
  SafeDocumentTextExtractor.ts        — 6,598 — PDF/DOCX/TXT extraction.
  ReviewPromptLogic.ts                — 2,926
  LocalFallbackAssets.ts              — 4,523
  LocalFallbackPreflight.ts           — 15,181 — Check local model readiness.
  RateLimiter.ts                      — 4,763
  ImeDetector.ts                      — 3,307
  InstallPingManager.ts               — 6,521
  ForegroundGate.ts                   — 2,640
  ProviderStatusRegistry.ts           — 2,289
  toggleStateReducer.ts               — 2,746
  credentialFallbackCrypto.ts         — 4,297
  providerStatus.ts                   — 678
  knowledge/                          — Profile / KB deep
    KnowledgeManager.ts
    KnowledgeIndexQueue.ts
    KnowledgeCache.ts
    KnowledgePackStore.ts
    EvidenceAssembler.ts
    FrontMatterExtractor.ts
    GraphExtractor.ts
    GraphRetriever.ts
    OkfExtractor.ts                   — Open Knowledge Format
    OkfConformance.ts
    OkfCardBuilder.ts
    OkfCardEditor.ts
    OkfMarkdownExporter.ts
    OkfProfileRetriever.ts
    OkfProfileVerifier.ts
    OkfPromptFormatter.ts
    OkfRetriever.ts
    OkfSlugger.ts
    OkfVerifier.ts
    ProfileCardTemplates.ts
    ProfileGraphExtractor.ts
    ProfileMarkdownExporter.ts
    ProfilePackBuilder.ts
    QuestionClassifier.ts
    RetrievalEvidencePack.ts
  meeting/                            — Meeting-specific services
    MeetingContextAssembler.ts
    MeetingModeDetector.ts
    MeetingRecipes.ts
    MeetingSummaryV3.ts
    MeetingSummaryReducer.ts
    MeetingSummarySchemaValidator.ts
    MeetingSummaryStrategySelector.ts
    SectionPromptCompiler.ts
    SpeakerLabelService.ts
    SummaryPolisher.ts
    TranscriptChunker.ts
    TranscriptNormalizer.ts
    CrossMeetingRecall.ts
    ChunkSummaryGenerator.ts
    FollowUpDraftGenerator.ts
    generateStructured.ts
    index.ts
    types.ts
  modes/
    DocumentMap.ts
    ModeHybridRetriever.ts
  screen/                             — Screen understanding
    ScreenUnderstandingService.ts
    ScreenContextService.ts
    VisionProviderFallbackChain.ts
    VisionProviderRegistry.ts
    OcrProvider.ts
    OcrProviderManager.ts
    ImageHashService.ts
    ImageOptimizer.ts
    visionPrompts.ts
  skills/
    SkillInstaller.ts
    SkillUploader.ts
    SkillValidator.ts
  context/                            — Context OS prompt pieces
    ContextPacket.ts
    PromptAssembler.ts
    TrustLevels.ts
  dev/                                — Dev fixtures
  dynamic-actions/
    DynamicAction.ts
    DynamicActionDetector.ts
    DynamicActionEngine.ts
    DynamicActionStore.ts
  browser-context/                    — DOM capture from extension
    BrowserMetadataClassifierService.ts
    formatEnvelopeForPrompt.ts
    policy.ts
    sanitize.ts
    telemetry.ts
    types.ts
  post-call/
    PostCallWorkflow.ts
  telemetry/                          — Anonymous usage

electron/premium/                     — License / paid features
electron/update/                      — Auto-update logic
electron/test/                        — Test helpers
electron/utils/                       — Misc utilities
electron/lib/                         — Misc libs
electron/config/                      — Misc config
```

---

## 13. The Database Layer

### 13.1 `electron/db/DatabaseManager.ts` (3,157 lines)
- Singleton, opens `app.getPath('userData')/natively.db` via `better-sqlite3`.
- Holds **all schema** as versioned migrations. Each migration is `v_NN: { up: (db) => {...} }`.
- Migrations are versioned with `PRAGMA user_version`. They run sequentially on boot.
- Known schema (v25–v26 added KB tables; v27+ added various):
  - `client_cases` (id, name, company, notes, created_at) — KB client/case.
  - `knowledge_sources` (id, client_case_id FK, source_type, title, metadata_json, index_status, created_at) — KB sources.
  - Plus: meetings, transcripts, embeddings, sessions, settings, action items, etc.
- **Self-heal migrations**: some ALTER TABLE migrations run idempotently to recover from missed `CREATE IF NOT EXISTS` cases (e.g. v25→v26 had a bug; v27+ adds the missing columns).
- All queries prepared; returns plain JS objects.
- Throws on errors — no silent swallowing (after the bug fix noted in `memory.md`).

### 13.2 `electron/db/seedDemo.ts`, `test-db.ts`
Seeding helpers and a test DB factory.

### 13.3 `electron/db/__tests__/`
Heavy test coverage. DB schema, migrations, query correctness.

---

## 14. The RAG Pipeline

### 14.1 What RAG means here
**R**etrieval-**A**ugmented **G**eneration. Before asking the LLM, we **retrieve** relevant context from a vector DB, then **generate** an answer that uses that context.

### 14.2 The pipeline

```
text (transcript / meeting notes / document)
    │
    ▼
electron/rag/TranscriptPreprocessor.ts     — Strip filler, normalize.
    │
    ▼
electron/rag/SemanticChunker.ts            — Split by semantic boundaries (~500 tokens).
    │
    ▼
electron/rag/EmbeddingPipeline.ts          — For each chunk → vector.
    │     │
    │     ├─ ElectronProviderResolver picks: LocalEmbeddingProvider (ONNX) /
    │     │                                   OllamaEmbeddingProvider /
    │     │                                   OpenAIEmbeddingProvider /
    │     │                                   GeminiEmbeddingProvider
    │     └─ Each provider implements IEmbeddingProvider (vectorSearchWorker for local)
    │
    ▼
electron/rag/VectorStore.ts                — sqlite-vec insert. (id, vector, source_id, chunk_id, text, metadata)
    │
    ▼
  (at query time)
    │
    ▼
electron/rag/RAGRetriever.ts               — Embed query → cosine search top-k.
    │
    ▼
electron/rag/LocalReranker.ts              — bge-reranker ONNX re-scores top-k.
    │
    ▼
electron/rag/RAGManager.ts                 — Orchestrates pipeline + expose API.
    │
    ▼
electron/llm/WhatToAnswerLLM.ts / customModeExecutionContract.ts
    — Inject chunks as context into the LLM prompt.
```

### 14.3 `LiveRAGIndexer.ts`
Index transcripts in real-time as they're captured. Used during meetings.

### 14.4 `OllamaBootstrap.ts`
Auto-start Ollama if installed; verify it's running before using it as an embedder.

---

## 15. The Knowledge Base Subsystem

This is the internal team's pivot from the upstream "interview cheating" model. The KB is per-**client case** (a law-firm case, like "Smith will").

### 15.1 The data model
```
client_cases (id, name, company, notes, created_at)
       │  1
       │  │
       ▼  N
knowledge_sources (id, client_case_id FK, source_type, title, metadata_json, index_status)
       │  1
       │  │
       ▼  N
chunks in VectorStore (id, source_id, text, vector, ...)
```

### 15.2 The classes
- **`KnowledgeBaseManager.ts`** (13.9k lines): top-level manager.
  - `getClientCases()`, `createClientCase(name)`, `deleteClientCase(id)`, `setActiveClientCase(id)`.
  - `addSource(caseId, sourceType, payload)` — extract → chunk → embed → index.
  - `getSourcesForClient(caseId)`, `deleteAllSources(caseId)`.
  - `setPipeline(vectorStore, embeddingPipeline)` — wire it up.
- **`extractors/`**: per-source-type extractors.
  - `WebPageExtractor` (fetch + regex, NO JS rendering).
  - `PptExtractor` (adm-zip, .pptx only, NOT legacy .ppt).
  - `YouTubeExtractor` (third-party transcript service — fragile).
  - `SafeDocumentTextExtractor` (PDF/DOCX/TXT/MD, from `services/`).
- **`suggest/KnowledgeBaseGate.ts`**: gates KB use based on active case.

### 15.3 The IPC surface
- `kb:create-client-case`, `kb:list-cases`, `kb:delete-client-case`.
- `kb:set-active-case`, `kb:get-active-case`.
- `kb:add-source`, `kb:list-sources`, `kb:delete-source`.
- `kb:query` — query the KB and return chunks.
- `kb:suggest` — get a KB-grounded suggestion for the chat (called from `MeetingChatPanel` Sparkles button).
- `kb:ask` — fallback when no chunks found → uses WebSearchProvider.

### 15.4 The UI
- `src/components/ClientCaseSelector.tsx` — pick active case in chat overlay.
- `src/components/settings/KnowledgeBaseSettings.tsx` — full KB management panel (in `SettingsOverlay`).

---

## 16. The LLM Layer

### 16.1 `electron/LLMHelper.ts` (7,691 lines)
The single integration point with all LLM providers. Responsibilities:
- Provider config (model, key, base URL).
- Streaming responses via `ipcMain.handle('llm:stream', ...)` → `evt.sender.send('llm:token', chunk)`.
- Retry/backoff on transient errors.
- Gemini prompt cache reuse.
- Token counting.
- Per-provider quirks (e.g. Claude's `system` field, OpenAI's `tools`, Gemini's `safetySettings`).

### 16.2 `electron/llm/prompts.ts` (149,351 lines)
The giant prompt library. Almost every prompt template lives here. Includes system prompts, few-shot examples, output schemas.

### 16.3 `electron/llm/AnswerPlanner.ts` (195,843 lines)
The largest single TS file. Plans how to assemble an answer: which context sources, which order, which model, which prompts. The "before you call the LLM" brain.

### 16.4 `electron/llm/WhatToAnswerLLM.ts` (49,877 lines)
Decides **if** a question is answerable right now and **what** the answer should focus on.

### 16.5 `electron/llm/IntentClassifier.ts` (27,303 lines)
Classifies user intent (question, command, follow-up, etc.) before picking a flow.

### 16.6 `electron/llm/ProviderRouter.ts` (17,171 lines)
Picks provider+model based on capability, cost, availability.

### 16.7 `electron/llm/answerPolish.ts` (21,149 lines)
Post-processes LLM output: trim, humanize, format for speech, mark citations.

### 16.8 `electron/llm/speakability.ts` (28,350 lines)
Makes text read well aloud (TTS-friendly).

### 16.9 `electron/llm/customModeExecutionContract.ts` (37,886 lines)
Defines the contract for "custom modes" (user-configured workflows).

### 16.10 `electron/llm/documentGroundedPrompt.ts` (38,505 lines)
Builds prompts that are grounded in retrieved documents (RAG-style).

### 16.11 `electron/llm/manualProfileIntelligence.ts` (87,772 lines)
Manual-mode brain. When user is in "Manual" rather than "Suggest" mode, this controls the flow.

### 16.12 Workers
- `electron/llm/intentClassifierWorker.ts` — Intent classification in a worker thread.
- `electron/llm/localEmbeddingWorker.ts` — Local embedder in a worker.
- `electron/rag/vectorSearchWorker.ts` — Vector search in a worker.
- `electron/rag/localRerankerWorker.ts` — Reranker in a worker.

---

## 17. The Intelligence Engine

`electron/IntelligenceEngine.ts` (3,073 lines) and its sub-modules in `electron/intelligence/`.

### 17.1 What it does
Decides, given a user query + active context, **what answer to produce**. It is the "AI brain" between IPC and the LLM layer.

### 17.2 The flow
1. **Receive** request: query, mode, active KB case, recent transcript, screen context.
2. **Route** context: `ContextRouter.ts` decides which sources matter (e.g. user is asking about the meeting → meeting memory; about a file → KB; about identity → profile).
3. **Fuse** context: `ContextFusionEngine.ts` + `RrfFusion.ts` (Reciprocal Rank Fusion) merge ranked lists.
4. **Plan** the answer: `AnswerPlanner.ts` (or `manualProfileIntelligence.ts` for manual mode).
5. **Generate**: `LLMHelper` streams.
6. **Validate** output: `AnswerValidator.ts`, `ProfileOutputValidator.ts`, `humanLikeness.ts`.
7. **Polish**: `answerPolish.ts`, `speakability.ts`.
8. **Attribute**: `IntelligenceAttribution.ts` records which sources were used.
9. **Trace**: `IntelligenceTrace.ts` + `IntelligenceMetrics.ts` for observability.

### 17.3 Context OS
`electron/intelligence/context-os/` is the "context operating system":
- `SourceAuthorityKernel.ts` — single source of truth for which source can answer what.
- `EvidenceOrchestrator.ts` — assembles evidence packs.
- `ProfileEvidenceService.ts` — user-profile-specific evidence.
- `MeetingRagEvidence.ts` — meeting-RAG evidence.
- `assistantClaims.ts` — claim ledger.
- `finalPromptValidation.ts` — last gate before the LLM call.

### 17.4 Memory sub-system
`electron/intelligence/memory/`:
- `MemoryProvider.ts` — interface.
- `LongTermMemoryService.ts` — manages memory across sessions.
- `HindsightClientAdapter.ts` — calls the optional Hindsight long-term-memory backend.
- `HindsightRetainQueue.ts` — queue for async retain.
- `HindsightTagBuilder.ts` — build tags for memory entries.

---

## 18. Audio / STT Pipeline

Natively captures **two audio streams**:
1. **System audio** (what's playing on the computer) — `SystemAudioCapture.ts`.
2. **Microphone** (your voice) — `MicrophoneCapture.ts`.

### 18.1 STT providers
- **Local Whisper** (`LocalWhisperSTT.ts` + `audio/whisper/`) — on-device, no cloud.
- **Deepgram** (`DeepgramStreamingSTT.ts`).
- **ElevenLabs** (`ElevenLabsStreamingSTT.ts`).
- **Google STT** (`GoogleSTT.ts`).
- **OpenAI Streaming** (`OpenAIStreamingSTT.ts`).
- **Soniox** (`SonioxStreamingSTT.ts`).
- **Natively Pro** (`NativelyProSTT.ts`) — Natively's own cloud STT.
- **REST** (`RestSTT.ts`) — generic REST STT.

Each implements a common interface and streams transcript events back to the main process.

### 18.2 Native module
`native-module/` is a Rust/C++ NAPI addon. It does:
- Audio device enumeration (`AudioDevices.ts` reads from it).
- Possibly system-audio loopback on platforms where `getDisplayMedia` doesn't work.
- Loaded by `audio/nativeModuleLoader.ts`.

### 18.3 Whisper internals
- `whisperWorker.ts` — runs in worker_threads, holds the Whisper model.
- `vadProcessor.ts` — Voice Activity Detection (skip silence).
- `hallucinationFilter.ts` — drops "thank you for watching" etc. junk outputs.
- `modelManager.ts` — download/load Whisper models.
- `hardwareDetect.ts` — pick CPU vs GPU vs CoreML.
- `inferenceConfig.ts` — model size, language, etc.
- `audioResampler.ts` — Whisper needs 16kHz mono; resample on the way in.
- `whisperProgressAggregator.ts` — emit progress events.

### 18.4 Streaming pipeline
```
mic + system audio ──▶ SystemAudioCapture/MicrophoneCapture
                                 │
                                 ▼
                          audioResampler
                                 │
                                 ▼
                       (provider-specific STT)
                                 │
                                 ▼
                     transcript events ──▶ SessionTracker
                                 │
                                 ▼
                  LiveRAGIndexer indexes chunks in real time
                                 │
                                 ▼
                  LiveTranscriptBrain processes / extracts
                                 │
                                 ▼
                     emit to renderer via IPC
```

---

## 19. Screenshot / Screen Context Pipeline

`electron/ScreenshotHelper.ts` (874 lines) — takes screenshots.
`electron/Cropper.tsx` + `CropperWindowHelper.ts` — user selects a region.

`electron/services/screen/` — screen understanding:
- `ScreenUnderstandingService.ts` — take screenshot → understand it (vision LLM).
- `ScreenContextService.ts` — keep a rolling context of "what's on the user's screen".
- `VisionProviderFallbackChain.ts` — try provider A, fall back to B, etc.
- `VisionProviderRegistry.ts` — registered vision providers.
- `OcrProvider.ts` / `OcrProviderManager.ts` — Tesseract fallback.
- `ImageHashService.ts` — de-dup identical screenshots.
- `ImageOptimizer.ts` — resize before sending to vision LLM.
- `visionPrompts.ts` — prompts for vision tasks.

---

## 20. Settings & Services

### 20.1 `electron/services/SettingsManager.ts` (19,962 lines)
- Wraps `electron-store`.
- Persists to `userData/settings.json`.
- Schema-validated, migration-aware.

### 20.2 `electron/services/CredentialsManager.ts` (54,189 lines)
- Stores API keys in OS keychain via `keytar`.
- Encrypted fallback when keychain unavailable (see `credentialFallbackCrypto.ts`).

### 20.3 `electron/services/HindsightManager.ts` (54,218 lines)
- Long-term-memory client (post-call "what did we discuss last time?").
- Disabled by default; needs `HINDSIGHT_BASE_URL` and feature flags.

### 20.4 `electron/services/PhoneMirrorService.ts` (70,819 lines)
- Mirror Android screen to Natively.
- Uses `scrcpy` under the hood (`phoneMirrorClient.ts`).

### 20.5 `electron/services/SkillsManager.ts` (46,012 lines)
- User-defined "skills" (named instruction sets).
- `services/skills/SkillInstaller.ts`, `SkillUploader.ts`, `SkillValidator.ts`.

### 20.6 `electron/services/CalendarManager.ts` (19,098 lines)
- Google Calendar integration.
- Needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### 20.7 `electron/services/ModesManager.ts` (86,288 lines)
- The "modes" concept: meeting / lecture / coding / interview / sales / custom.
- Each mode has its own prompt template, context filters, and answer style.

### 20.8 `electron/services/ModelVersionManager.ts` (46,182 lines)
- Manages model versions (downgrade, upgrade, validate checksums).

### 20.9 `electron/services/StealthKeyboardManager.ts` (20,032 lines)
- Global hotkeys that "feel" native and don't trigger other apps.
- Important: macOS 13+ requires accessibility permissions.

### 20.10 `electron/services/LocalModelDownloadService.ts` (28,527 lines)
- Download Whisper, embedding, reranker models.
- Resumable downloads.
- Verifies SHA-256.

### 20.11 `electron/services/OllamaManager.ts` (15,000 lines)
- Detect / install / start Ollama.
- Used as an alternative to cloud LLMs.

---

## 21. Window Management

`electron/WindowHelper.ts` (1,328 lines) creates 5 window types:

| Window | Purpose | Opacity |
|---|---|---|
| Launcher | The main floating chat bar. | transparent |
| Overlay | The chat popup. | transparent |
| Cropper | Region screenshot selector. | transparent |
| Settings | Full settings panel. | normal |
| ModelSelector | Pick a model on the fly. | normal |

Each has its own `*Helper.ts` for window-specific logic (e.g. `SettingsWindowHelper.ts`).

---

## 22. The "Modes" System

Natively is multi-mode:
- **Meeting** — full transcript → notes.
- **Lecture** — slide-aware.
- **Coding** — integrates with local Codex.
- **Interview** — original fork mode (still in code).
- **Sales** — sales-call assistant.
- **Custom** — user-defined.

The mode determines:
- Which context sources to retrieve (`ModeContextRetriever.ts`).
- Which prompt template to use.
- Which output format (bullets / script / code / summary).
- Which `WhatToAnswerLLM` flavor to use.

`src/components/SuggestModeSettings.tsx` lets the user pick modes.

---

## 23. Browser Extension

`natively-browser/` is a Chrome/Firefox extension for the **DOM capture** side:
- `src/manifest.json` — extension manifest.
- `src/content-script.ts` — injected into every page; reads DOM.
- `src/service-worker.ts` — background service worker.
- `src/popup.ts` — popup UI.
- `src/extract.ts` — extracts structured content from the page.

Built with **esbuild** (`esbuild.config.mjs`), NOT Vite. There's an explicit note in `vite.config.mts` to ignore this folder so Vite doesn't try to bundle it.

The main process consumes this via `electron/services/browser-context/` (BrowserMetadataClassifierService, formatEnvelopeForPrompt, policy, sanitize, telemetry).

---

## 24. Tests / Evals / Benchmarks

### 24.1 Unit tests
- `electron/**/__tests__/*.test.mjs` (run with `node --test`).
- Pattern: every module's `__tests__/` directory.

### 24.2 E2E
- `tests/e2e/**` — Playwright tests.
- Run: `npx playwright test`.

### 24.3 Mode E2E
- `electron/services/__tests__/Mode*.test.mjs` — run via `npm run test:modes`.
- Includes `RUN_NATIVELY_API_E2E=1 npm run test:modes:e2e` for real API calls.

### 24.4 Intelligence evals
- `intelligence-eval-real-ui/` — Playwright + grader.
- Run: `playwright test --config intelligence-eval-real-ui/playwright.config.ts`.

### 24.5 Benchmarks
- `benchmarks/profile-intelligence/` — runs the LLM over hundreds of questions, scores quality.
- `benchmarks/meeting-notes/` — meeting summary quality eval.
- Common: `npm run benchmark:*`.

### 24.6 Smoke tests
- `scripts/smoke-*.js` — quick health checks.
- E.g. `smoke-onnx-packaging.mjs` verifies the ONNX model is bundled.

### 24.7 Verifiers
- `scripts/verify-*.mjs` — post-build verifications.
- Run as part of release (`npm run release-gate`).

---

## 25. CI / Build / Release

### 25.1 CI tiers
- `ci:tier1` — fast unit tests.
- `ci:tier2` — tier1 + residual failures bench.
- `ci:tier3` — full multimode, followup, longsession, answer-quality.
- `ci:tier4` — live memory, live replay, wta, UI tests.

### 25.2 Release gate
- `scripts/release-gate.mjs` runs all verifiers and refuses release on failure.
- `dist:signed` — builds + signs + notarizes + uploads to GitHub.

### 25.3 electron-builder config
In `package.json` `build` key. Outputs:
- macOS: `.dmg` and `.zip`, x64 + arm64.
- Windows: NSIS installer + portable, x64 + ia32.
- Linux: AppImage + deb.

Native modules are marked `asarUnpack` so they don't get ASAR-bundled (they need real filesystem access).

---

## 26. Scripts Directory

`scripts/` has 60+ scripts. Categories:
- **Build helpers**: `build-electron.js`, `build-native.js`, `rebuild-native-electron.js`, `rebuild-native-for-target.cjs`, `verify-native-arch.js`, `patch-electron-plist.js`, `ensure-sqlite-vec.js`, `ensure-sharp-mac-deps.js`, `download-models.js`, `ad-hoc-sign.js`, `notarize.js`, `afterAllArtifactBuild.cjs`, `staple-with-retry.js`.
- **Smoke tests**: `smoke-*.{js,mjs}`.
- **Verifiers**: `verify-*.mjs`.
- **Hindsight (long-term memory)**: `hindsight-*.{mjs,sh,py}`.
- **E2E scripts**: `e2e-*.js`.
- **Benchmark scripts**: `bench-*.mjs`, `benchmark-*.js`, `thinking-budget-bench.mjs`.
- **Release**: `release-gate.mjs`, `upload-release.mjs`.
- **Dev helpers**: `apply-modes-review-pending.sh`, `live-custom-mode-source-regression.js`, `live-profile-okf-minimax.mjs`, `profile-jd-loop.js`, `pi-replay*.cjs`, `pi-score.py`, `okf-*.js`, `humanized-answers-dataset.mjs`, `spoken-quality-dataset.mjs`.
- **Cleanup**: `uninstall-clean-natively.sh`, `natively-clean-install-models.sh`, `install-mac-fallback-models.sh`, `raw-to-wav.js`, `VectorStoreRebuild.js`.

---

## 27. Version Control & Daily Workflow

### 27.1 Branches
- `main` — production.
- `develop` — current dev branch (this branch you're on).
- Your internal team's remotes: `medscode/natively_ai` (per memory).

### 27.2 Pre-commit
- `.husky/` — husky git hooks.
- Likely runs typecheck on commit.

### 27.3 Daily workflow
1. Pull develop: `git pull origin develop`.
2. Create your branch: `git checkout -b feature/x`.
3. Make changes.
4. `npm run typecheck:electron` — typecheck.
5. `npm run test` — unit tests.
6. `npm run app:dev` — manual smoke.
7. Commit. PR to develop.

### 27.4 Useful aliases
- `npm start` = `npm run app:dev`.
- `npm run typecheck:electron` = check main TS only (no emit).
- `npm run build:electron` = bundle main process JS (use after changing `electron/**`).
- `npm run dev` = just Vite (use for UI-only changes; can be faster than full app:dev).

---

## 28. How To Track Changes AI Makes

When an AI (like this assistant) edits your code, here's how to keep up:

### 28.1 First: understand the layers
For any feature, ask yourself "which layer is this?"
- **UI only** (visual change) → `src/components/**` + `src/index.css` + possibly `src/i18n.*.ts`.
- **UI ↔ backend wiring** → `src/components/X.tsx` calls `window.electronAPI.yyy` → check `src/types/electron.d.ts` for the type → check `electron/preload.ts` for the binding → check `electron/ipcHandlers.ts` for the handler.
- **Backend logic** → `electron/services/X.ts` or `electron/llm/X.ts` or `electron/rag/X.ts`.
- **DB schema** → `electron/db/DatabaseManager.ts` (add a new migration).
- **Native / low-level** → `native-module/`.
- **Build / release** → `package.json` + `electron-builder.signed.cjs` + `scripts/`.

### 28.2 Tools
```bash
git status                    # what changed
git diff                      # exact diff
git diff --stat               # files + line counts
git log --oneline -20         # recent commits
git log --stat                # what each commit touched
git show <sha>                # one commit's full diff
```

### 28.3 Read the diff
Look for:
- `+function name` — new exported function.
- `+import { X } from 'Y'` — new dependency.
- `+await window.electronAPI.X` — new IPC call (also requires preload + handler).
- Schema additions: look for `+db.exec(` blocks in `DatabaseManager.ts`.

### 28.4 When the change breaks
1. **Read the error message** (top of stack trace is the file).
2. **Match against `git diff`**: which file/lines?
3. If it's an IPC call:
   - Did the handler get registered? Search `ipcHandlers.ts` for `ipcMain.handle('channel:here'`.
   - Did the preload expose it? Search `preload.ts` for the same name.
   - Did the types match? Check `electron.d.ts`.
4. If it's a build error:
   - `npm run typecheck:electron` will show all TS errors.
   - `npm run build:electron` re-bundles main.
5. If it's a runtime error:
   - `~/Documents/natively_debug.log` has everything (set by `main.ts`).
   - Open DevTools in the overlay window (View → Toggle Developer Tools in dev mode).

### 28.5 Keep your own notes
Per your saved feedback: write changes to `memory.md` after each turn/session. Format the AI already uses:
```
## [date] session: <one-liner>
- What changed (file:line)
- Why
- How to verify
```

---

## 29. Glossary

| Term | What it means in plain English |
|---|---|
| **Electron** | A way to write desktop apps using web tech. One Node process + one Chromium process per window. |
| **Main process** | The Node part. Owns DB, audio, IPC, native APIs. |
| **Renderer process** | The Chromium part. Each window is one. Renders React. |
| **Preload script** | The bridge file. Runs in renderer but with Node access. Exposes `window.electronAPI`. |
| **IPC** | Inter-Process Communication. JSON messages between main and renderer. |
| **`ipcMain.handle('channel', fn)`** | Registers an RPC on main. Returns a Promise. |
| **`ipcRenderer.invoke('channel', args)`** | Renderer calls the RPC. |
| **`contextBridge.exposeInMainWorld('name', obj)`** | Exposes an object to the renderer's `window`. |
| **Vite** | The bundler. Reads `src/**` and `index.html`, outputs `dist/`. Fast HMR. |
| **esbuild** | Another bundler. Faster than webpack, used here for `electron/**`. |
| **TypeScript (TS)** | JavaScript with types. Catches bugs at compile time. |
| **TSX** | TypeScript + JSX (HTML-in-JS). Used for React files. |
| **React** | A library for building UIs from "components". |
| **Component** | A reusable UI piece (function returning JSX). |
| **JSX** | HTML-looking syntax in JS. `<div>foo</div>`. |
| **Hook** (`useX`) | A React function that gives state, effects, etc. |
| **`useState`** | Component-level state. |
| **`useEffect`** | Run code after render (e.g. fetch data). |
| **`useRef`** | Persistent mutable value across renders. |
| **Tailwind** | CSS-in-classes. `className="bg-black text-white"`. |
| **SQLite** | Embedded SQL database. One file. |
| **better-sqlite3** | A Node library that talks to SQLite. Synchronous (no callbacks). |
| **sqlite-vec** | A SQLite extension for vector search (cosine similarity). |
| **Embedding** | A vector (array of ~384–4096 numbers) that represents meaning of text. |
| **Vector search** | "Find chunks whose embedding is most similar to the query's embedding." |
| **Reranker** | A model that re-scores the top-k vector results for precision. |
| **ONNX** | Open Neural Network Exchange format. Runs models portably. |
| **ONNX Runtime** | Microsoft's runtime for ONNX models. |
| **Whisper** | OpenAI's speech-to-text model. Runs locally via `@huggingface/transformers`. |
| **LLM** | Large Language Model. Gemini, Claude, GPT, etc. |
| **Streaming** | LLM sends tokens as they're generated, not waiting for the full response. |
| **Prompt** | The text you send to an LLM. Includes system + user + context. |
| **System prompt** | The "you are an expert..." part. Set once. |
| **RAG** | Retrieval-Augmented Generation. Look up facts, then ask the LLM. |
| **Tool use / Function calling** | LLM can request that we call a function (e.g. "search the web"). |
| **Worker thread** | A separate Node thread. Used for CPU-heavy tasks (Whisper, ONNX). |
| **NAPI / NAPI-RS** | Native code from Node, written in Rust. |
| **ContextBridge** | Electron's safe way to share objects between main and renderer. |
| **CSP** | Content Security Policy. Whitelists where JS/CSS/fonts can come from. |
| **ASAR** | Electron's app archive (read-only virtual filesystem inside the app). |
| **Code signing** | Apple/Windows requires apps to be signed to install. |
| **Notarization** | Apple's check that the app is from a known developer. |
| **DMG** | macOS installer image. |
| **NSIS** | Windows installer. |
| **AppImage** | Linux single-file executable. |
| **`postinstall`** | Script that runs after `npm install`. |
| **`patch-package`** | Saves a local patch to a node_module and re-applies it on install. |
| **Husky** | Git hooks made easy. |
| **Concurrently** | Run multiple npm scripts in parallel. |
| **`wait-on`** | Wait for a port/file to be ready. |
| **Playwright** | Browser automation. Used for e2e tests. |
| **Vitest / node:test** | Test runners. |
| **TanStack Query** | React-Query. Server-state cache. |
| **Radix** | Accessible UI primitives (Dialog, Toast). |
| **Framer Motion** | Animation library. |
| **liquid-glass-react** | Frosted-glass UI effect (Apple-style). |
| **Sharp** | Fast image processing (libvips bindings). |
| **Tesseract.js** | OCR (read text from images). |
| **Electron-store** | JSON-backed settings. |
| **Electron-updater** | Auto-update via GitHub releases. |
| **Keytar** | OS keychain (store API keys). |
| **Mammoth** | DOCX → text. |
| **PDF-parse** | PDF → text. |
| **Adm-zip** | Read/write zip files. |
| **UUID** | Unique IDs. |
| **Three.js** | 3D in the browser. |
| **jsPDF** | PDF generation in the browser. |
| **marked / react-markdown** | Markdown → HTML / React. |
| **KaTeX** | Math rendering. |
| **Prism** | Syntax highlighting for code. |
| **pdf-parse** | PDF text extraction. |
| **Sharp / libvips** | Image processing C library. |
| **`console.log` in renderer** | Goes to the Browser DevTools. |
| **`console.log` in main** | Goes to terminal / `natively_debug.log`. |
| **Preload bridge** | The "remote control" pattern. |
| **RAG eval / benchmark** | "Did the LLM use the right chunks?" |
| **Context authority** | "Which source wins when they conflict?" (SourceAuthorityKernel). |
| **KB / Knowledge Base** | Per-case (law-firm case) collection of documents + web pages + YouTube. |
| **Suggest mode** | AI auto-fires suggestions based on transcript. |
| **Manual mode** | User explicitly asks; AI answers once. |
| **Sparkles button** | Manual "ask KB now" button in `MeetingChatPanel`. |
| **`kb:suggest`** | IPC channel that returns a KB-grounded suggestion. |
| **`kb:ask`** | IPC channel that falls back to web search if KB is empty. |
| **CitationBadge** | Inline chip showing which KB source a sentence came from. |
| **Hindsight** | Optional Postgres+pgvector long-term-memory backend. |
| **Live session memory** | In-session rolling context of prior assistant responses. |
| **Profile intelligence** | The brain that uses the user's profile (identity, expertise). |
| **Custom mode** | User-configured workflow (own prompt + own context). |
| **WhatToAnswerLLM** | Decides "is this even answerable right now? what should the answer focus on?" |
| **AnswerPlanner** | The orchestrator: which sources, which order, which model, which prompts. |
| **IntelliMetrics** | Latency, quality, cost observability for intelligence flows. |
| **ContextOS** | "Operating system" for context: which source can answer what, and when. |
| **Native arch gate** | Boot-time check that the installed node_modules match the Electron build arch (arm64 vs x64). |
| **Fontations** | Chromium's Rust font backend. Has a crash on macOS 26+; disabled via env var. |
| **WAL** | SQLite Write-Ahead Log. Lets readers + writers not block each other. |
| **Patch-package** | Modify a node_module and save the diff so it re-applies on install. |

---

## Appendix: Recent Sessions (from `memory.md`)

The repo's `memory.md` is the team's running session log. Key entries (as of 2026-07-23):

- **KB extractors**: web page / PPTX / YouTube added; `KnowledgeBaseManager` + KB gate import wired; `ClientCaseSelector` UX.
- **`kb:create-client-case` error**: stale Electron bundle; rebuild via `npm run build:electron`.
- **IPC root cause + PRD phases**: fixed `NATIVELY_E2E` gate that hid KB handlers in prod; added `wrapRegistration`; implemented PRD phases 1–5.
- **FOREIGN KEY error on upload**: added up-front existence check in `addSource` before extraction.
- **CTO demo setup**: settings menu cleanup; KB-aware chat with inline citations; `searchSimilar` instead of non-existent `search()`.
- **CTO demo v2**: `kb:suggest` IPC + Sparkles button; WebSearchProvider (DuckDuckGo+Tavily) with `kb:ask` fallback.
- **Chat UI redesign**: `MeetingChatPanel.tsx` + `SuggestModeCoordinator.ts` for analyst/lawyer use case; Manual/Suggest + Web toggle + LiveKB indicator.
- **Actually-visible changes**: `NativelyInterface.tsx` is the actual chat surface (not `Launcher.tsx`); re-mounted `MeetingChatPanel` there.
- **Schema fix**: self-heal `ALTER TABLE` migration for `knowledge_sources` (broken since v25→v26 used `CREATE IF NOT EXISTS` on existing table).
- **Silent INSERT bug**: `addSource` was swallowing INSERT errors and returning `success: true`; fixed to surface DB errors + immediate refresh.

> Read `memory.md` whenever you start a session — it tells you what was done last and what was learned.

---

## How to use this file

1. **First time?** Read sections 1, 2, 3, 5, 6, 7, 9, 10, 27 in order. That covers the architecture and workflow.
2. **Working on UI?** Jump to §9, §11, §21. Then `git status` + `npm run dev`.
3. **Working on KB / RAG?** §13, §14, §15.
4. **Working on AI / prompts?** §16, §17, §22.
5. **Working on audio / Whisper?** §18.
6. **Debugging?** §28.
7. **Lost in a term?** §29.

If something is missing or you want deeper detail on a section, ask Claude to expand it. This file is meant to be a living document.
