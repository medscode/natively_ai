#!/usr/bin/env node
// scripts/build-win.js
// Automated, deterministic build pipeline for Natively Windows (x64 NSIS + Portable).
// Ensures all steps (clean, frontend build, electron bundle, native asset checks,
// electron-builder packaging) are executed in strict sequence.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');

function runStep(name, command) {
    const start = Date.now();
    console.log(`\n========================================`);
    console.log(`▶ [STEP] ${name}`);
    console.log(`  $ ${command}`);
    console.log(`========================================`);
    try {
        execSync(command, { cwd: ROOT_DIR, stdio: 'inherit', env: { ...process.env } });
        console.log(`✅ [DONE] ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    } catch (err) {
        console.error(`❌ [FAILED] ${name}:`, err.message);
        process.exit(1);
    }
}

async function main() {
    const startTime = Date.now();
    console.log(`\n🚀 Starting Natively Windows Build Pipeline (x64)...`);

    // 1. Clean previous release artifacts (.exe, .blockmap)
    if (fs.existsSync(RELEASE_DIR)) {
        console.log(`🧹 Cleaning old Windows release artifacts in ${RELEASE_DIR}...`);
        const files = fs.readdirSync(RELEASE_DIR);
        for (const file of files) {
            if (file.endsWith('.exe') || file.endsWith('.blockmap')) {
                const target = path.join(RELEASE_DIR, file);
                try {
                    fs.unlinkSync(target);
                    console.log(`   Deleted ${file}`);
                } catch { /* ignore */ }
            }
        }
    }

    // 2. Build renderer (Vite + React)
    runStep('Build Frontend (Vite & React)', 'npm run build');

    // 3. Build electron main & preload
    runStep('Build Electron TypeScript Bundle', 'npm run build:electron');

    // 4. Ensure sqlite-vec native assets
    runStep('Verify sqlite-vec native binaries', 'node scripts/ensure-sqlite-vec.js');

    // 5. Ensure native audio module on Windows
    const nativeWinBinary = path.join(ROOT_DIR, 'native-module', 'index.win32-x64-msvc.node');
    if (!fs.existsSync(nativeWinBinary)) {
        if (process.platform === 'win32') {
            runStep('Build Rust Native Audio Module (win32-x64)', 'npm run build:native');
        } else {
            console.warn(`⚠️ Warning: ${nativeWinBinary} not found. Rust compilation requires Windows environment or CI runner.`);
        }
    } else {
        console.log(`✅ Native module verified: ${nativeWinBinary}`);
    }

    // 6. Pre-packaging asset check
    runStep('Verify Pre-packaged Assets', 'node scripts/verify-packaged-local-assets.mjs');

    // 7. Package Windows executables (NSIS installer + Portable)
    runStep('Package Electron Windows Executables (x64)', 'npx electron-builder --win nsis portable --x64 --publish never');

    // 8. Verify generated outputs
    if (fs.existsSync(RELEASE_DIR)) {
        const files = fs.readdirSync(RELEASE_DIR).filter(f => f.endsWith('.exe'));
        if (files.length > 0) {
            console.log(`\n========================================`);
            console.log(`✅ Successfully Created Windows Packages:`);
            for (const file of files) {
                const stats = fs.statSync(path.join(RELEASE_DIR, file));
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                console.log(`   - ${file} (${sizeMB} MB)`);
            }
            console.log(`========================================`);
        } else {
            console.warn(`⚠️ Warning: No .exe files found in ${RELEASE_DIR}`);
        }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Windows build completed successfully in ${totalSeconds}s!\n`);
}

main();
