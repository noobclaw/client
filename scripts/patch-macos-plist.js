#!/usr/bin/env node
/**
 * Post-build Info.plist patch for the macOS .app bundle.
 *
 * Tauri v2 writes a minimal Info.plist that lacks several keys NoobClaw
 * needs to run cleanly under modern macOS:
 *
 *   1. NSAppTransportSecurity — the sidecar OAuth flow hits
 *      http://127.0.0.1:<ephemeral> for the authorization callback.
 *      Hardened-runtime macOS will block plain-HTTP connections unless
 *      we explicitly whitelist localhost / 127.0.0.1 via exception
 *      domains. Without this, MCP OAuth (src/main/libs/mcpOAuth.ts)
 *      silently drops the callback on signed/notarized builds.
 *
 *   2. Usage descriptions — NoobClaw's desktopControlMcp performs
 *      screenshot, keyboard, mouse, clipboard, and active-window
 *      operations. macOS triggers TCC prompts the first time each is
 *      called, and if the corresponding NS*UsageDescription key is
 *      missing the prompt either (a) is never shown (silent deny)
 *      or (b) shows a generic "this app wants to access X" dialog with
 *      no explanation string, which is a scary UX. We set a friendly
 *      line for each so the user knows why the prompt appeared.
 *
 *   3. LSApplicationCategoryType — routes the app into the right
 *      Launchpad category ("Productivity") and improves discovery.
 *
 *   4. LSUIElement — defaults to false (visible in Dock). The env var
 *      NOOBCLAW_MENU_BAR_ONLY=1 flips this to true for users who want
 *      the command bar / tray as the *only* UI entry point and never
 *      want a Dock icon. We ship with LSUIElement=false.
 *
 *   5. NSHumanReadableCopyright — required by App Store review and
 *      shown in About → "Get Info" in Finder.
 *
 * Execution: runs AFTER `tauri build` produces the .app but BEFORE
 * notarization. Re-signs the .app afterwards since changing Info.plist
 * invalidates the existing signature. CI already has the signing
 * identity loaded in build.keychain by the earlier "Import code signing
 * certificate" step, so we can call `codesign --force --deep --options
 * runtime --timestamp` without new credentials.
 *
 * Invocation in CI (after `npx tauri build`):
 *   node scripts/patch-macos-plist.js --target x86_64-apple-darwin
 *
 * Skips silently on non-macOS platforms so the same script can sit
 * inside a cross-platform npm run hook without needing a host check.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function log(msg) {
  console.log(`[patch-macos-plist] ${msg}`);
}

function findAppBundle(targetTriple) {
  // Tauri v2 bundle output is usually:
  //   src-tauri/target/<triple>/release/bundle/macos/<ProductName>.app
  // but the directory layout has varied across versions (we've seen
  // bundle/dmg/<ProductName>.app too after the dmg step). Walk the
  // bundle dir recursively to be safe — same strategy the CI "Verify
  // codesign" step uses with `find ... -name "*.app"`.
  const root = path.resolve(__dirname, '..', 'src-tauri', 'target');

  const rootsToScan = [];
  if (targetTriple) {
    rootsToScan.push(path.join(root, targetTriple, 'release', 'bundle'));
  }
  // When --target matches the host, cargo sometimes skips the triple
  // subdir and writes straight to target/release/bundle. Scan that too.
  rootsToScan.push(path.join(root, 'release', 'bundle'));
  // Also scan every triple dir so the script still works without --target.
  try {
    for (const entry of fs.readdirSync(root)) {
      rootsToScan.push(path.join(root, entry, 'release', 'bundle'));
    }
  } catch { /* target dir may not exist yet */ }

  const visited = new Set();
  const walk = (dir) => {
    if (visited.has(dir)) return null;
    visited.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.app')) return full;
      // Recurse one level into sub-bundle folders (macos/, dmg/, etc.).
      const nested = walk(full);
      if (nested) return nested;
    }
    return null;
  };

  for (const dir of rootsToScan) {
    if (!fs.existsSync(dir)) continue;
    const found = walk(dir);
    if (found) return found;
  }
  return null;
}

function runPlutil(args) {
  // plutil is bundled with macOS; no install needed.
  return execSync(`plutil ${args}`, { stdio: 'inherit' });
}

function main() {
  if (process.platform !== 'darwin') {
    log('Not macOS, skipping plist patch');
    return;
  }

  const targetArg = process.argv.find((a) => a.startsWith('--target='));
  const targetTriple = targetArg ? targetArg.split('=')[1] : undefined;

  const appPath = findAppBundle(targetTriple);
  if (!appPath) {
    log('ERROR: Could not locate .app bundle. Did `tauri build` succeed?');
    // Diagnostic dump — list everything under target/<triple>/release/bundle
    // so the CI log tells us exactly where to look next time.
    const root = path.resolve(__dirname, '..', 'src-tauri', 'target');
    log(`Diagnostic listing of ${root}:`);
    try {
      execSync(`find "${root}" -maxdepth 6 -name "*.app" -o -name "bundle" -type d 2>&1 | head -50`, { stdio: 'inherit' });
    } catch { /* ignore */ }
    process.exit(1);
  }
  log(`Patching: ${appPath}`);

  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    log(`ERROR: Info.plist not found at ${plistPath}`);
    process.exit(1);
  }

  // ── 1. Insert or replace keys ───────────────────────────────────────
  //
  // plutil -replace creates the key if missing, and replaces it if
  // present — exactly the idempotent upsert we want. We wrap each call
  // so a single failure doesn't abort the whole patch.
  const replaceXml = (key, xml) => {
    try {
      runPlutil(`-replace ${key} -xml '${xml}' "${plistPath}"`);
      log(`  set ${key}`);
    } catch (e) {
      log(`  WARN: failed to set ${key}: ${e.message}`);
    }
  };
  const replaceString = (key, value) => {
    try {
      runPlutil(`-replace ${key} -string "${value}" "${plistPath}"`);
      log(`  set ${key}=${value}`);
    } catch (e) {
      log(`  WARN: failed to set ${key}: ${e.message}`);
    }
  };
  const replaceBool = (key, value) => {
    try {
      runPlutil(`-replace ${key} -bool ${value ? 'true' : 'false'} "${plistPath}"`);
      log(`  set ${key}=${value}`);
    } catch (e) {
      log(`  WARN: failed to set ${key}: ${e.message}`);
    }
  };

  // 1a. NSAppTransportSecurity — allow loopback HTTP for OAuth callbacks
  // and for the sidecar at 127.0.0.1:18800. The exception is scoped to
  // localhost / 127.0.0.1 so arbitrary http:// loads are still denied.
  const atsXml = [
    '<dict>',
    '  <key>NSAllowsLocalNetworking</key><true/>',
    '  <key>NSExceptionDomains</key>',
    '  <dict>',
    '    <key>localhost</key>',
    '    <dict>',
    '      <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>',
    '      <key>NSIncludesSubdomains</key><true/>',
    '    </dict>',
    '    <key>127.0.0.1</key>',
    '    <dict>',
    '      <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>',
    '    </dict>',
    '  </dict>',
    '</dict>',
  ].join('');
  replaceXml('NSAppTransportSecurity', atsXml);

  // 1b. TCC usage descriptions. These strings are what macOS shows in
  // the "NoobClaw wants to access ..." dialog. Clear, honest, short.
  replaceString(
    'NSAppleEventsUsageDescription',
    'NoobClaw automates other apps via AppleScript when you ask it to.'
  );
  replaceString(
    'NSScreenCaptureUsageDescription',
    'NoobClaw reads your screen so AI agents can see what you are working on.'
  );
  replaceString(
    'NSMicrophoneUsageDescription',
    'NoobClaw captures audio when you use voice input.'
  );
  replaceString(
    'NSCameraUsageDescription',
    'NoobClaw uses the camera only when you explicitly share a video stream.'
  );
  replaceString(
    'NSSystemAdministrationUsageDescription',
    'NoobClaw may request administrator privileges to install or update helper tools.'
  );

  // 1c. LSApplicationCategoryType for Launchpad routing.
  replaceString('LSApplicationCategoryType', 'public.app-category.productivity');

  // 1d. Copyright string. Year is hard-coded to 2026 to match the
  // current project.
  replaceString('NSHumanReadableCopyright', 'Copyright © 2026 NoobClaw. All rights reserved.');

  // 1e. LSUIElement — dock icon behavior. Default false. Set to true
  // only if the env var is set, which CI does not set by default.
  const menuBarOnly = process.env.NOOBCLAW_MENU_BAR_ONLY === '1';
  replaceBool('LSUIElement', menuBarOnly);

  // 1f. NSSupportsSuddenTermination=false — we manage a sidecar child
  // process that needs a graceful SIGTERM. Without this, macOS may kill
  // the parent on shutdown before Drop on SidecarState runs, orphaning
  // the sidecar.
  replaceBool('NSSupportsSuddenTermination', false);

  // ── 2. Re-sign the bundle ────────────────────────────────────────────
  //
  // Changing Info.plist invalidates the signature. CI passes
  // APPLE_SIGNING_IDENTITY from the earlier "Import code signing
  // certificate" step. If the env var is absent (local dev build),
  // we skip re-sign — the resulting .app just won't be notarizable but
  // will still run ad-hoc on the local machine for testing.
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity) {
    log('No APPLE_SIGNING_IDENTITY — skipping re-sign (local dev build)');
    return;
  }
  try {
    const entitlements = path.resolve(__dirname, '..', 'src-tauri', 'entitlements.plist');
    execSync(
      `codesign --force --deep --timestamp --options runtime ` +
        `--entitlements "${entitlements}" --sign "${identity}" "${appPath}"`,
      { stdio: 'inherit' }
    );
    log('Re-signed bundle successfully');
  } catch (e) {
    log(`ERROR: re-sign failed: ${e.message}`);
    process.exit(1);
  }
}

main();
