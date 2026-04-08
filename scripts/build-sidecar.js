/**
 * Build the Node.js sidecar binary for Tauri.
 *
 * Steps:
 * 1. Compile TypeScript (electron main process code)
 * 2. Bundle into a single JS file with esbuild
 * 3. Package with @yao-pkg/pkg into a native binary
 * 4. Copy to src-tauri/binaries/ with correct target triple name
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

// Detect target triple
function getTargetTriple() {
  try {
    return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim();
  } catch {
    // Fallback based on platform
    if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin';
    }
    return 'x86_64-unknown-linux-gnu';
  }
}

function main() {
  const triple = getTargetTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const outName = `noobclaw-server-${triple}${ext}`;
  const outPath = path.join(BINARIES_DIR, outName);

  console.log(`Building sidecar for target: ${triple}`);
  console.log(`Output: ${outPath}`);

  // Step 1: Compile TypeScript
  console.log('Step 1: Compiling TypeScript...');
  execSync('npx tsc --project electron-tsconfig.json', { cwd: ROOT, stdio: 'inherit' });

  // Step 2: Bundle with esbuild into single file
  console.log('Step 2: Bundling with esbuild...');
  const entryPoint = path.join(ROOT, 'dist-electron', 'sidecar-server.js');
  const bundlePath = path.join(ROOT, 'dist-electron', 'sidecar-bundle.cjs');

  if (!fs.existsSync(entryPoint)) {
    console.error(`Entry point not found: ${entryPoint}`);
    console.log('Available files in dist-electron:');
    try {
      const files = fs.readdirSync(path.join(ROOT, 'dist-electron'));
      files.slice(0, 20).forEach(f => console.log(`  ${f}`));
    } catch {}
    process.exit(1);
  }

  execSync(`npx esbuild "${entryPoint}" --bundle --platform=node --target=node20 --outfile="${bundlePath}" --external:better-sqlite3 --external:@anthropic-ai/sdk --external:@modelcontextprotocol/sdk`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  // Step 3: Package with pkg
  console.log('Step 3: Packaging with pkg...');
  const pkgTarget = process.platform === 'win32' ? 'node20-win-x64'
    : process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'node20-macos-arm64' : 'node20-macos-x64')
      : 'node20-linux-x64';

  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  execSync(`npx @yao-pkg/pkg "${bundlePath}" --target ${pkgTarget} --output "${outPath}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (fs.existsSync(outPath)) {
    const size = fs.statSync(outPath).size;
    console.log(`✓ Sidecar built: ${outPath} (${Math.round(size / 1024 / 1024)}MB)`);
  } else {
    console.error('✗ Sidecar build failed - output not found');
    process.exit(1);
  }
}

main();
