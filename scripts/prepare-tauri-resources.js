/**
 * Prepare resources for Tauri bundling.
 * Copies SKILLs, tray icons, system prompt, and WASM
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

  // 2. Tray icons (chrome-extension is no longer bundled — users install
  //    the NoobClaw Browser Assistant from Chrome / Firefox / Edge stores)
  const traySrc = path.join(ROOT, 'resources', 'tray');
  const trayDest = path.join(RESOURCES_DIR, 'tray');
  const trayCount = copyDirRecursive(traySrc, trayDest);
  console.log(`  tray: ${trayCount} files`);

  // 3. System prompt
  const promptSrc = path.join(ROOT, 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md');
  if (fs.existsSync(promptSrc)) {
    const promptDest = path.join(RESOURCES_DIR, 'AGENT_SYSTEM_PROMPT.md');
    fs.copyFileSync(promptSrc, promptDest);
    console.log('  AGENT_SYSTEM_PROMPT.md: copied');
  }

  // 4. sql-wasm.wasm (from sidecar build)
  const wasmSrc = path.join(ROOT, 'src-tauri', 'binaries', 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(RESOURCES_DIR, 'sql-wasm.wasm'));
    console.log('  sql-wasm.wasm: copied');
  }

  // 4b. macOS native desktop addon (compiled by node-gyp before this step
  //     runs; see .github/workflows/build-tauri.yml). The .node file is
  //     only built on macOS — Windows and Linux skip silently. The
  //     sidecar loader in src/main/libs/nativeDesktopMac.ts looks for
  //     this file at <resources>/native/noobclaw_desktop.node at runtime.
  if (process.platform === 'darwin') {
    const nodeAddonSrc = path.join(
      ROOT,
      'native',
      'macos-desktop',
      'build',
      'Release',
      'noobclaw_desktop.node'
    );
    if (fs.existsSync(nodeAddonSrc)) {
      const nativeDestDir = path.join(RESOURCES_DIR, 'native');
      fs.mkdirSync(nativeDestDir, { recursive: true });
      const nodeAddonDest = path.join(nativeDestDir, 'noobclaw_desktop.node');
      fs.copyFileSync(nodeAddonSrc, nodeAddonDest);
      const sizeKb = Math.round(fs.statSync(nodeAddonDest).size / 1024);
      console.log(`  native/noobclaw_desktop.node: copied (${sizeKb} KB)`);
    } else {
      console.warn(
        '  native/noobclaw_desktop.node: NOT FOUND — sidecar will fall back to osascript. ' +
          'Build it first with: cd native/macos-desktop && npm install && npm run build'
      );
    }
  }

  // 4c. Windows native desktop addon — same pattern as 4b but for the
  //     C++ BitBlt/SendInput addon built from native/win-desktop/. The
  //     sidecar loader at src/main/libs/nativeDesktopWin.ts looks for
  //     the .node file in the same <resources>/native/ directory.
  if (process.platform === 'win32') {
    const winAddonSrc = path.join(
      ROOT,
      'native',
      'win-desktop',
      'build',
      'Release',
      'noobclaw_desktop_win.node'
    );
    if (fs.existsSync(winAddonSrc)) {
      const nativeDestDir = path.join(RESOURCES_DIR, 'native');
      fs.mkdirSync(nativeDestDir, { recursive: true });
      const winAddonDest = path.join(nativeDestDir, 'noobclaw_desktop_win.node');
      fs.copyFileSync(winAddonSrc, winAddonDest);
      const sizeKb = Math.round(fs.statSync(winAddonDest).size / 1024);
      console.log(`  native/noobclaw_desktop_win.node: copied (${sizeKb} KB)`);
    } else {
      console.warn(
        '  native/noobclaw_desktop_win.node: NOT FOUND — sidecar will fall back to PowerShell. ' +
          'Build it first with: cd native/win-desktop && npm install && npm run build'
      );
    }
  }

  // 5. Native messaging host JS source only. The .bat / .sh wrappers are
  //    generated at runtime by registerNativeMessagingHost() using absolute
  //    paths derived from the actual install location, and in Tauri mode
  //    the wrapper just calls `noobclaw-server.exe --native-messaging-host`
  //    so it does not even need the .js file to exist on disk. We still
  //    ship the .js for Electron builds that may share this resource dir.
  {
    const name = 'native-messaging-host.js';
    const candidates = [
      path.join(ROOT, 'resources', name),
      path.join(ROOT, name),
    ];
    for (const src of candidates) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(RESOURCES_DIR, name));
        console.log(`  ${name}: copied from ${src}`);
        break;
      }
    }
  }

  console.log(`Done. Resources prepared in ${RESOURCES_DIR}`);
}

main();
