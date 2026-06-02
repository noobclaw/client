/**
 * fetch-ffmpeg — download static ffmpeg/ffprobe into resources/ for bundling.
 *
 * Runs at BUILD time (CI or local), NOT at runtime. The downloaded binaries
 * land in `client/resources/ffmpeg-<platform>/bin/`; prepare-tauri-resources.js
 * then copies them into `src-tauri/resources/ffmpeg-<platform>/bin/` so Tauri
 * bundles them. At runtime ffmpegRuntime.ts resolves them via getResourcesPath().
 *
 * Platform sources:
 *   - Windows x64: gyan.dev "essentials" static build (bundles libx264).
 *   - macOS arm64 + x64: Martin-Riedl.de static builds. Long-running project
 *     (since 2017), build script is open source (Apache-2.0, hosted at
 *     git.martin-riedl.de/ffmpeg/build-script), and the arm64 binaries ship
 *     already signed + notarized. We still re-sign them in build-tauri.yml
 *     with OUR Developer ID (--timestamp --options runtime) because any Mach-O
 *     embedded under Contents/Resources/ must carry a secure timestamp under
 *     OUR identity or the whole .app fails notarization (same treatment the
 *     .node addon gets).
 *   - Linux: NOT bundled — the step no-ops so the build still succeeds; the
 *     app falls back to system PATH ffmpeg, and if absent surfaces a friendly
 *     "ffmpeg unavailable" error.
 *
 * Idempotent: if the target binaries already exist it skips the download.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// gyan.dev "essentials" static build — much smaller than BtbN's full GPL
// master build (~85MB exe vs ~195MB) while still bundling everything our
// pipeline uses: libx264 (H.264), AAC, image decoders, drawtext/freetype
// (burned-in subtitles), and the zoompan filter (Ken Burns). Stable URL that
// always points at the current release.
const WIN_FFMPEG_URL =
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

// Martin-Riedl.de static macOS builds. Separate zips per binary, per arch.
// `redirect/latest/.../release/` always points at the current stable release
// (e.g. 8.x) so we never have to chase version numbers. arch token is the
// site's own: aarch64 -> "arm64", x86_64 -> "amd64".
const MAC_FFMPEG_BASE = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos';
function macArchToken(triple) {
  if (triple.startsWith('aarch64') || triple.includes('arm64')) return 'arm64';
  return 'amd64'; // x86_64-apple-darwin
}

function targetTriple() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.SIDECAR_TARGET) return process.env.SIDECAR_TARGET;
  try {
    return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim();
  } catch {
    if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    }
    return 'x86_64-unknown-linux-gnu';
  }
}

/** Recursively find the first file named `name` under `dir`. */
function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/** Create a fresh scratch dir under FFMPEG_FETCH_TMP (or os.tmpdir()). */
function makeScratchDir() {
  // Allow overriding the scratch dir (FFMPEG_FETCH_TMP) — useful when the
  // system temp volume is space-constrained; defaults to os.tmpdir().
  const tmpBase = process.env.FFMPEG_FETCH_TMP || os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  return fs.mkdtempSync(path.join(tmpBase, 'noobclaw-ffmpeg-'));
}

function fetchWindows() {
  const destBin = path.join(ROOT, 'resources', 'ffmpeg-win', 'bin');
  const ffmpegOut = path.join(destBin, 'ffmpeg.exe');
  const ffprobeOut = path.join(destBin, 'ffprobe.exe');

  if (fs.existsSync(ffmpegOut) && fs.existsSync(ffprobeOut)) {
    console.log(`[fetch-ffmpeg] Windows binaries already present in ${destBin}, skipping.`);
    return;
  }

  const tmp = makeScratchDir();
  const zipPath = path.join(tmp, 'ffmpeg-win.zip');
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    console.log(`[fetch-ffmpeg] Downloading ${WIN_FFMPEG_URL}`);
    // curl is present on GitHub windows-latest runners and locally with Git.
    execSync(`curl -L --fail --retry 3 -o "${zipPath}" "${WIN_FFMPEG_URL}"`, { stdio: 'inherit' });

    console.log('[fetch-ffmpeg] Extracting…');
    // Expand-Archive is built into Windows PowerShell; reliable for .zip.
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'inherit' },
    );

    const ffmpegSrc = findFile(extractDir, 'ffmpeg.exe');
    const ffprobeSrc = findFile(extractDir, 'ffprobe.exe');
    if (!ffmpegSrc || !ffprobeSrc) {
      throw new Error('ffmpeg.exe / ffprobe.exe not found in the downloaded archive');
    }

    fs.mkdirSync(destBin, { recursive: true });
    fs.copyFileSync(ffmpegSrc, ffmpegOut);
    fs.copyFileSync(ffprobeSrc, ffprobeOut);

    const mb = (p) => Math.round(fs.statSync(p).size / 1024 / 1024);
    console.log(`[fetch-ffmpeg] ✓ ffmpeg.exe (${mb(ffmpegOut)}MB) + ffprobe.exe (${mb(ffprobeOut)}MB) → ${destBin}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function fetchMac(triple) {
  const destBin = path.join(ROOT, 'resources', 'ffmpeg-mac', 'bin');
  const ffmpegOut = path.join(destBin, 'ffmpeg');
  const ffprobeOut = path.join(destBin, 'ffprobe');

  if (fs.existsSync(ffmpegOut) && fs.existsSync(ffprobeOut)) {
    console.log(`[fetch-ffmpeg] macOS binaries already present in ${destBin}, skipping.`);
    return;
  }

  const arch = macArchToken(triple);
  const tmp = makeScratchDir();

  try {
    fs.mkdirSync(destBin, { recursive: true });

    // ffmpeg and ffprobe ship as separate zips on this host.
    for (const name of ['ffmpeg', 'ffprobe']) {
      const url = `${MAC_FFMPEG_BASE}/${arch}/release/${name}.zip`;
      const zipPath = path.join(tmp, `${name}.zip`);
      const extractDir = path.join(tmp, `${name}-extracted`);
      fs.mkdirSync(extractDir, { recursive: true });

      console.log(`[fetch-ffmpeg] Downloading ${url}`);
      // -L follows the redirect/latest -> versioned download URL.
      execSync(`curl -L --fail --retry 3 -o "${zipPath}" "${url}"`, { stdio: 'inherit' });

      console.log(`[fetch-ffmpeg] Extracting ${name}…`);
      // `unzip` is preinstalled on macOS runners (and dev Macs).
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

      const src = findFile(extractDir, name);
      if (!src) {
        throw new Error(`${name} not found in the downloaded archive (${url})`);
      }
      const out = path.join(destBin, name);
      fs.copyFileSync(src, out);
      fs.chmodSync(out, 0o755); // ensure the bundled binary stays executable
    }

    const mb = (p) => Math.round(fs.statSync(p).size / 1024 / 1024);
    console.log(
      `[fetch-ffmpeg] ✓ ffmpeg (${mb(ffmpegOut)}MB) + ffprobe (${mb(ffprobeOut)}MB) → ${destBin} ` +
      `(macos/${arch}). NOTE: build-tauri.yml re-signs these with our Developer ID before bundling.`,
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  const triple = targetTriple();
  console.log(`[fetch-ffmpeg] target: ${triple}`);

  if (triple.includes('windows')) {
    fetchWindows();
    return;
  }

  if (triple.includes('darwin') || triple.includes('apple')) {
    fetchMac(triple);
    return;
  }

  // Linux: deferred (see file header). No-op so the build proceeds.
  console.log(
    `[fetch-ffmpeg] No bundled ffmpeg configured for ${triple} — skipping. ` +
    'The app will fall back to system PATH ffmpeg at runtime.',
  );
}

main();
