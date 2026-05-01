#!/usr/bin/env node
/**
 * Clones the private NoobClaw chrome-extension repo into ./chrome-extension.
 *
 * The bundled browser extension lives in a separate private GitHub repo
 * (noobclaw/chrome-extension) and is no longer checked into this public
 * client repo. This script fetches a shallow snapshot of its `main`
 * branch into the local working tree so that:
 *
 *   - `scripts/prepare-tauri-resources.js` can copy it into
 *     `src-tauri/resources/chrome-extension/` for the Tauri bundle
 *   - Local developers can load it as an unpacked extension when
 *     hacking on the desktop client
 *
 * Auth:
 *   - In CI, set `CHROME_EXTENSION_TOKEN` to a PAT with read access to
 *     noobclaw/chrome-extension (the workflow injects it from the
 *     repository secret of the same name).
 *   - Locally, leave it unset — git uses your existing credential helper
 *     (e.g. `gh auth setup-git`) to authenticate.
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'chrome-extension');
const REPO = 'github.com/noobclaw/chrome-extension.git';

function repoUrl() {
  const tok = process.env.CHROME_EXTENSION_TOKEN || process.env.GITHUB_TOKEN;
  if (tok) return `https://x-access-token:${tok}@${REPO}`;
  return `https://${REPO}`;
}

function run(cmd) {
  console.log(`> ${cmd.replace(/x-access-token:[^@]+@/, 'x-access-token:***@')}`);
  execSync(cmd, { stdio: 'inherit' });
}

if (fs.existsSync(TARGET)) {
  console.log(`Removing existing ${TARGET} for a clean clone`);
  fs.rmSync(TARGET, { recursive: true, force: true });
}

run(`git clone --depth=1 ${repoUrl()} ${JSON.stringify(TARGET)}`);

// Strip the inner .git so the folder isn't a nested repo, and drop the
// private-repo README which isn't part of the extension package.
const innerGit = path.join(TARGET, '.git');
if (fs.existsSync(innerGit)) fs.rmSync(innerGit, { recursive: true, force: true });
const innerReadme = path.join(TARGET, 'README.md');
if (fs.existsSync(innerReadme)) fs.unlinkSync(innerReadme);

console.log(`✔ chrome-extension fetched into ${TARGET}`);
