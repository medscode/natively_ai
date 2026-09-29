# DevOps & Infrastructure Guide for Natively

> **CRITICAL ARCHITECTURAL NOTE FOR DEVOPS / INFRASTRUCTURE ENGINEERS:**
> **Natively is a Client-Side Desktop Application (Electron + React + Native Rust + SQLite), NOT a hosted web application or microservice.**
> It **CANNOT** be containerized in Docker or deployed to AWS ECS, Kubernetes, Vercel, or EC2 as an HTTP web service. Attempting to run it on a headless Linux server will immediately crash due to missing X11/Wayland display servers and native OS audio device hooks (macOS CoreAudio / Windows WASAPI).

---

## 1. What DevOps Actually Manages

Instead of hosting the app itself, the DevOps role for Natively consists of:
1. **CI/CD Build Pipelines (GitHub Actions)**: Automating the compilation of macOS (`.dmg`) and Windows (`.exe`) installers.
2. **Release Distribution & Auto-Updates**: Publishing installer artifacts and update manifests (`latest-mac.yml`, `latest.yml`) to GitHub Releases.
3. **Cloud Knowledge Base (PostgreSQL + pgvector)**: Hosting the optional shared legal database and vector store that client apps connect to for RAG retrieval.
4. **API Key Secrets & Proxy Configuration**: Managing cloud LLM credentials (OpenAI, Gemini, Anthropic, Groq, Sarvam STT).

---

## 2. Infrastructure & Cloud Backend Setup

If your organization uses the **Shared Legal Knowledge Base**:

### A. Database (PostgreSQL 16 + pgvector)
* **Provider**: Any PostgreSQL 16+ instance with `pgvector` enabled (AWS RDS, Supabase, Neon, or self-hosted).
* **Connection String**: Set in `.env`:
  ```bash
  POSTGRES_KB_URL=postgresql://user:password@host:5432/natively_legal_kb?sslmode=require
  ```
* **Schema**: Run migration script once to initialize tables:
  ```bash
  node scripts/migrate-kb-to-cloud.mjs
  ```

### B. Document Storage (AWS S3)
* **Bucket**: S3 bucket for storing uploaded legal source files (PDFs, docs).
* **Environment Variables**:
  ```bash
  AWS_S3_KB_BUCKET=natively-shared-legal-kb
  AWS_S3_KB_REGION=ap-south-1
  AWS_ACCESS_KEY_ID=AKIA...
  AWS_SECRET_ACCESS_KEY=...
  ```

---

## 3. CI/CD Build Pipelines (GitHub Actions)

Pre-configured workflows are located in `.github/workflows/`:

| Workflow File | Target Platform | Runner OS | Artifacts Produced |
| :--- | :--- | :--- | :--- |
| `release-windows.yml` | Windows x64 | `windows-latest` | NSIS Setup `.exe`, Portable `.exe`, `latest.yml` |
| `release-macos.yml` | macOS (Apple Silicon + Intel) | `macos-14` | Signed & Notarized `.dmg`, `.zip`, `latest-mac.yml` |

### Triggering Builds:
1. **Automated Release**: Push a version tag matching `v*` (e.g. `git tag v2.8.5 && git push origin v2.8.5`). Both runners will build and attach artifacts to GitHub Releases automatically.
2. **Manual Dispatch**: Go to GitHub Actions UI &rarr; Select the workflow &rarr; Click **Run workflow** &rarr; Select the target branch.

### Required GitHub Secrets for CI/CD:
* `GITHUB_TOKEN`: Built-in GitHub secret for uploading release assets.
* **For macOS Signing & Notarization (Apple Developer ID)**:
  * `MACOS_CERT_P12_BASE64`: Base64-encoded Developer ID Application certificate.
  * `MACOS_CERT_PASSWORD`: Certificate password.
  * `APPLE_API_KEY_P8_BASE64`: App Store Connect API Key (`.p8`).
  * `APPLE_API_KEY_ID`: Key ID (e.g. `T9GPZ92M7K`).
  * `APPLE_API_ISSUER`: Issuer UUID from App Store Connect.

---

## 4. Local Build Prerequisites (For Developers)

If building manually without GitHub Actions:
* **Node.js**: v22 LTS (mandatory).
* **Rust Toolchain**: `rustup default stable` (required to compile Windows audio module `native-module/` via `@napi-rs/cli`).
* **Python**: Required by `node-gyp` for native C++ bindings (`better-sqlite3`, `keytar`).
* **Commands**:
  ```bash
  npm ci --ignore-scripts
  npm run postinstall
  npm run dmg        # Build macOS DMG
  npm run build:win  # Build Windows EXE (on Windows OS)
  ```

---

## 5. Potential Pitfalls / Why It Could Fail

1. **Attempting to Dockerize or "host" on Linux**: Electron is a client GUI app. It will crash on headless machines with `Error: Cannot open display` or audio device initialization errors.
2. **Node Version Mismatches**: Node versions older than v20 or newer than v22 without matching Electron ABI headers will cause native module binding mismatch errors (`better-sqlite3.node`).
3. **Windows Audio Compilation**: The WASAPI speaker loopback capture module requires MSVC C++ Build Tools and Rust toolchain on Windows runners.
