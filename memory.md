# Memory for the Next Agent

## 📋 Context & Fixed Issues
We resolved two critical bugs that were blocking onboarding and basic RAG settings usage:
1. **Onboarding Orchestrator Infinite Loop**: 
   - **File**: `src/lib/onboarding/stageCatalog.ts` (lines 187-197)
   - **Issue**: The `quiet_window` stage (a gate-only step) was triggering a rendering loop where the app completed and re-evaluated the stage on every tick, causing a major memory leak and crashing the launcher window.
   - **Fix**: Added `onceEver: true` to the stage configuration to ensure it only completes once and breaks the evaluation loop.
   
2. **ReferenceError: KnowledgeBaseManager is not defined**:
   - **Files**: `electron/ipcHandlers.ts` and `electron/main.ts`
   - **Issue**: Dynamic imports using `require('./rag/KnowledgeBaseManager')` inside dynamic SafeHandlers got bundled by `esbuild` into deferred `__esm` initializers. When invoked from the event loop, destructuring happened before the variables were initialized, causing runtime ReferenceErrors.
   - **Fix**: Converted all dynamic imports of `KnowledgeBaseManager` and `KnowledgeBaseGate` in `ipcHandlers.ts` and `main.ts` into top-level static ES module imports.

---

## 🎯 Current Task: Complete the Knowledge Base UI & Ingestion Pipeline
The user has requested that the Knowledge Base settings page should:
1. **Compel Name Input**: When creating a client case, typing the name must be compulsory/mandatory (with validation and clear UI warnings).
2. **Accept Multiple Formats**: The ingestion area must support adding:
   - **Files**: PDFs, PPTX, Docx, Text, Markdown (already supported by backend `kb:add-source`).
   - **Web Links / URLs**: Scraping pages.
   - **YouTube Links**: Transcribing or indexing YouTube audio/captions.
3. **GROUNDING IN CHATBOT**: Make sure the context retrieved from the selected client case is available to the chatbot when answering questions.

---

## 🔍 In-Depth Code Analysis

### Backend RAG Implementation
1. **Database Schema**:
   Located in `electron/db/DatabaseManager.ts`. In migration v26, it sets up two main tables:
   ```sql
   CREATE TABLE IF NOT EXISTS client_cases (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     company TEXT,
     notes TEXT,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   );
   
   CREATE TABLE IF NOT EXISTS knowledge_sources (
     id TEXT PRIMARY KEY,
     client_case_id TEXT NOT NULL,
     type TEXT NOT NULL, -- 'file', 'url', etc.
     name TEXT NOT NULL,
     content_path TEXT,
     url TEXT,
     status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     FOREIGN KEY(client_case_id) REFERENCES client_cases(id) ON DELETE CASCADE
   );
   ```

2. **KnowledgeBaseManager**:
   Located in `electron/rag/KnowledgeBaseManager.ts`.
   - `createClientCase(name, company, notes)` inserts a case.
   - `addSource(clientCaseId, filePath)` runs text extraction via `extractSafeDocumentText`, chunks it semantically, generates vector embeddings using Gemini, and saves them in the vector DB using `sqlite-vec`.

3. **LLM Context Injection**:
   Located in `electron/llm/WhatToAnswerLLM.ts`. The backend checks the active client case:
   ```typescript
   // Retrieves top semantic chunks matches for query and injects into prompt
   const context = await injectKBContext(promptContext, query);
   ```

### Frontend Settings Page
Located in `src/components/settings/KnowledgeBaseSettings.tsx` and `src/components/ClientCaseSelector.tsx`.
- Currently, the user selects a client case.
- There is a "Create Client Case" modal or block, but name validation might be loose (or not strictly enforced/visualized).
- There needs to be a unified UI showing tabs/inputs for:
  1. **Upload File**: Triggering `window.electronAPI.kbAddSource()` (which prompts for file).
  2. **Add URL / Web Link**: An input to submit a URL.
  3. **Add YouTube Link**: An input to submit a YouTube URL.

---

## 🛠️ Step-by-Step Implementation Roadmap

### Phase 1: Compulsory Case Name Validation
1. Open `src/components/ClientCaseSelector.tsx` or the creation modal in `src/components/settings/KnowledgeBaseSettings.tsx`.
2. Ensure the "Save/Create" button is disabled if `name.trim() === ''`.
3. Add a red visual asterisk `*` and validation helper text to indicate that "Client Name" is required.

### Phase 2: Expand Ingestion Forms (Files, URLs, YouTube Links)
1. In `KnowledgeBaseSettings.tsx`, underneath the selected Client Case details, create a clean, segmented tab controller or button group for:
   - **📄 Upload File** (triggers file picker via IPC).
   - **🔗 Add Web Page** (text input for URL + submit button).
   - **🎥 Add YouTube Video** (text input for YT URL + submit button).
2. **Create New IPC Handlers**:
   In `electron/ipcHandlers.ts`:
   - Register `kb:add-url-source` to fetch webpage text, chunk it, embed it, and insert it as a source.
   - Register `kb:add-youtube-source` to parse the video ID, fetch the transcript/metadata, chunk it, embed it, and save it.
3. Update the frontend preload in `electron/preload.js` (or similar file) to expose these new functions to `window.electronAPI`.
4. Handle the different source types ('file', 'url', 'youtube') in `KnowledgeBaseSettings.tsx` when rendering the table of indexed documents/sources.
