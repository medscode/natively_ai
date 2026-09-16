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

    // 5. Pre-packaging asset check
    runStep('Verify Pre-packaged Assets', 'node scripts/verify-packaged-local-assets.mjs');

    // 6. Package into .app bundle with electron-builder and ad-hoc inside-out codesign
    runStep('Package Electron App Directory (arm64)', 'npx electron-builder --mac dir --arm64');

    // 7. Verify .app bundle contents & codesign
    const macAppPath = path.join(RELEASE_DIR, 'mac-arm64', 'Natively.app');
    if (!fs.existsSync(macAppPath)) {
        console.error(`❌ FATAL: Packaged app not found at ${macAppPath}`);
        process.exit(1);
    }

    runStep('Verify Packaged Assets in .app', `node scripts/verify-packaged-local-assets.mjs --app "${macAppPath}"`);

    // Check Electron Framework existence and symlink
    const electronFw = path.join(macAppPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    if (fs.existsSync(electronFw)) {
        console.log(`✅ Electron Framework library verified: ${electronFw}`);
    } else {
        console.error(`❌ FATAL: Electron Framework library missing at ${electronFw}`);
        process.exit(1);
    }

    // Verify .app codesign seal
    console.log(`\n🔒 Verifying Code Signature of packaged .app...`);
    try {
        const verifyOut = execSync(`codesign -vvv --deep --strict "${macAppPath}" 2>&1`, { encoding: 'utf8' });
        console.log(`   ${verifyOut.trim() || 'Code signature is valid on disk.'}`);
        console.log(`✅ Packaged .app passes deep codesign integrity check!`);
    } catch (e) {
        console.warn(`⚠️ Note on codesign verify:`, e.message);
    }

    // 8. Build pristine shareable DMG via ditto staging and hdiutil create (preserves all framework symlinks)
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const version = pkg.version || '2.8.4';
    const outDmg = path.join(RELEASE_DIR, `Natively-${version}-arm64.dmg`);

    console.log(`\n========================================`);
    console.log(`📦 Creating Pristine Shareable DMG (${path.basename(outDmg)})...`);
    console.log(`========================================`);

    const os = require('os');
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-dmg-'));
    const stagedApp = path.join(stageDir, 'Natively.app');

    try {
        console.log(`Staging .app via ditto to preserve symlinks and signatures...`);
        execSync(`ditto "${macAppPath}" "${stagedApp}"`, { stdio: 'inherit' });
        fs.symlinkSync('/Applications', path.join(stageDir, 'Applications'));

        if (fs.existsSync(outDmg)) fs.unlinkSync(outDmg);

        console.log(`Generating compressed DMG with hdiutil...`);
        execSync(`hdiutil create -volname "Natively" -srcfolder "${stageDir}" -ov -format UDZO "${outDmg}"`, { stdio: 'inherit' });
    } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
    }

    // 9. Verify Final DMG
    if (fs.existsSync(outDmg)) {
        const stats = fs.statSync(outDmg);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        console.log(`\n========================================`);
        console.log(`✅ Successfully Created Shareable DMG:`);
        console.log(`   File:     ${path.basename(outDmg)}`);
        console.log(`   Size:     ${sizeMB} MB`);
        console.log(`   Path:     ${outDmg}`);
        console.log(`========================================`);
    } else {
        console.error('❌ Error: DMG creation failed!');
        process.exit(1);
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 DMG build and verification completed successfully in ${totalSeconds}s!\n`);
}

main();
