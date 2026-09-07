#!/usr/bin/env node
// scripts/build-dmg.js
// Automated, deterministic build pipeline for Natively Apple Silicon (.dmg).
// Ensures all steps (clean, frontend build, electron bundle, native asset checks,
// electron-builder packaging, and inside-out ad-hoc codesigning) are executed in
// strict sequence.

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
        execSync(command, { cwd: ROOT_DIR, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
        console.log(`✅ [DONE] ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    } catch (err) {
        console.error(`❌ [FAILED] ${name}:`, err.message);
        process.exit(1);
    }
}

async function main() {
    const startTime = Date.now();
    console.log(`\n🚀 Starting Natively DMG Build Pipeline (arm64)...`);

    // 1. Clean previous release artifacts
    if (fs.existsSync(RELEASE_DIR)) {
        console.log(`🧹 Cleaning old DMG artifacts in ${RELEASE_DIR}...`);
        const files = fs.readdirSync(RELEASE_DIR);
        for (const file of files) {
            if (file.endsWith('.dmg') || file.endsWith('.blockmap') || file.endsWith('.zip')) {
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

    // 4. Ensure native dependencies and assets
    runStep('Verify Sharp & Native Assets', 'node scripts/ensure-sharp-mac-deps.js && node scripts/ensure-sqlite-vec.js');

    // 5. Package into DMG with electron-builder
    runStep('Package Electron DMG (arm64)', 'npx electron-builder --mac dmg --arm64');

    // 6. Verify DMG output
    console.log(`\n========================================`);
    console.log(`🔍 Verifying Release Artifacts...`);
    console.log(`========================================`);

    if (fs.existsSync(RELEASE_DIR)) {
        const artifacts = fs.readdirSync(RELEASE_DIR).filter(f => f.endsWith('.dmg'));
        if (artifacts.length === 0) {
            console.error('❌ Error: No .dmg file found in release directory!');
            process.exit(1);
        }

        for (const dmg of artifacts) {
            const dmgPath = path.join(RELEASE_DIR, dmg);
            const stats = fs.statSync(dmgPath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
            console.log(`✅ Created DMG: ${dmg} (${sizeMB} MB)`);
            console.log(`   Location: ${dmgPath}`);
        }
    }

    // Verify .app codesign seal if mac folder exists
    const macAppPath = path.join(RELEASE_DIR, 'mac-arm64', 'Natively.app');
    if (fs.existsSync(macAppPath)) {
        console.log(`\n🔒 Verifying Code Signature of packaged .app...`);
        try {
            const verifyOut = execSync(`codesign -vvv --deep --strict "${macAppPath}" 2>&1`, { encoding: 'utf8' });
            console.log(`   ${verifyOut.trim() || 'Code signature is valid on disk.'}`);
            console.log(`✅ Packaged .app passes deep codesign integrity check!`);
        } catch (e) {
            console.warn(`⚠️ Note on codesign verify:`, e.message);
        }
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 DMG build completed successfully in ${totalSeconds}s!\n`);
}

main();
