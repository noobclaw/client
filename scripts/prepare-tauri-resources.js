/**
 * Prepare resources for Tauri bundling.
 * Copies SKILLs, chrome-extension, tray icons, system prompt, and WASM
 * into src-tauri/resources/ so Tauri can bundle them without ../  paths
 * (which create _up_ directories in NSIS installers).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT, 'src-tauri', 'resources');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules in skills to reduce size
      if (entry.name === 'node_modules') {
        // Only copy node_modules for skills that need them (web-search, pptx, etc)
        copyDirRecursive(srcPath, destPath);
      } else {
        count += copyDirRecursive(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function main() {
  console.log('Preparing Tauri resources...');

  // Clean previous resources
  if (fs.existsSync(RESOURCES_DIR)) {
    fs.rmSync(RESOURCES_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });

  // 1. SKILLs
  const skillsSrc = path.join(ROOT, 'SKILLs');
  const skillsDest = path.join(RESOURCES_DIR, 'SKILLs');
  const skillCount = copyDirRecursive(skillsSrc, skillsDest);
  console.log(`  SKILLs: ${skillCount} files`);

  // 2. Chrome extension
  const chromeSrc = path.join(ROOT, 'chrome-extension');
  const chromeDest = path.join(RESOURCES_DIR, 'chrome-extension');
  const chromeCount = copyDirRecursive(chromeSrc, chromeDest);
  console.log(`  chrome-extension: ${chromeCount} files`);

  // 3. Tray icons
  const traySrc = path.join(ROOT, 'resources', 'tray');
  const trayDest = path.join(RESOURCES_DIR, 'tray');
  const trayCount = copyDirRecursive(traySrc, trayDest);
  console.log(`  tray: ${trayCount} files`);

  // 4. System prompt
  const promptSrc = path.join(ROOT, 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md');
  if (fs.existsSync(promptSrc)) {
    const promptDest = path.join(RESOURCES_DIR, 'AGENT_SYSTEM_PROMPT.md');
    fs.copyFileSync(promptSrc, promptDest);
    console.log('  AGENT_SYSTEM_PROMPT.md: copied');
  }

  // 5. sql-wasm.wasm (from sidecar build)
  const wasmSrc = path.join(ROOT, 'src-tauri', 'binaries', 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(RESOURCES_DIR, 'sql-wasm.wasm'));
    console.log('  sql-wasm.wasm: copied');
  }

  // 6. Native messaging host script
  const nmhSrc = path.join(ROOT, 'resources', 'native-messaging-host.js');
  if (fs.existsSync(nmhSrc)) {
    fs.copyFileSync(nmhSrc, path.join(RESOURCES_DIR, 'native-messaging-host.js'));
    console.log('  native-messaging-host.js: copied');
  }
  const nmhBatSrc = path.join(ROOT, 'resources', 'native-messaging-host.bat');
  if (fs.existsSync(nmhBatSrc)) {
    fs.copyFileSync(nmhBatSrc, path.join(RESOURCES_DIR, 'native-messaging-host.bat'));
    console.log('  native-messaging-host.bat: copied');
  }

  console.log(`Done. Resources prepared in ${RESOURCES_DIR}`);
}

main();
