#!/usr/bin/env node
/**
 * Generate the macOS DMG background image with a visible arrow between
 * the app icon slot and the /Applications alias. Without this the DMG
 * just shows two bare icons on a blank window and users do not know they
 * are supposed to drag.
 *
 * Output: src-tauri/icons/dmg-background.png  (660x400, matches the
 * windowSize in tauri.conf.json > bundle.macOS.dmg).
 *
 * Re-run this whenever you change the DMG dimensions or icon slot
 * positions. It is idempotent and safe to run from any platform since
 * `sharp` handles the raster conversion.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const WIDTH = 660;
const HEIGHT = 400;

// Icon slot centres — these must stay in sync with tauri.conf.json.
// Tauri's DMG coordinates are icon CENTRES (Finder .DS_Store convention),
// so (180, 220) means the icon is drawn centred on that point.
const APP_ICON_CENTER = { x: 180, y: 220 };
const APPS_ICON_CENTER = { x: 480, y: 220 };
const ARROW_Y = APP_ICON_CENTER.y;                     // same row as icons
const ARROW_START_X = APP_ICON_CENTER.x + 80;          // clear of left icon
const ARROW_END_X = APPS_ICON_CENTER.x - 80;           // clear of right icon

const OUTPUT_PATH = path.join(
  __dirname,
  '..',
  'src-tauri',
  'icons',
  'dmg-background.png'
);

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e1e22"/>
      <stop offset="100%" stop-color="#0f0f12"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

  <!-- Title -->
  <text x="${WIDTH / 2}" y="60" text-anchor="middle"
        font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
        font-size="22" font-weight="600" fill="#ffffff">
    Install NoobClaw
  </text>
  <text x="${WIDTH / 2}" y="90" text-anchor="middle"
        font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
        font-size="14" fill="#9ca3af">
    Drag the NoobClaw icon into the Applications folder
  </text>

  <!-- Arrow: from just right of app icon slot to just left of Apps slot -->
  <g filter="url(#glow)">
    <line x1="${ARROW_START_X}" y1="${ARROW_Y}"
          x2="${ARROW_END_X}" y2="${ARROW_Y}"
          stroke="#f97316" stroke-width="6" stroke-linecap="round"/>
    <polygon points="${ARROW_END_X},${ARROW_Y - 14} ${ARROW_END_X + 18},${ARROW_Y} ${ARROW_END_X},${ARROW_Y + 14}"
             fill="#f97316"/>
  </g>

  <!-- No icon labels here — Finder overlays the real "NoobClaw" and
       "Applications" names under each icon automatically. Drawing our
       own would double them up. -->
</svg>
`;

(async () => {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(OUTPUT_PATH);
  const stat = fs.statSync(OUTPUT_PATH);
  console.log(`DMG background written: ${OUTPUT_PATH} (${stat.size} bytes)`);
})().catch((err) => {
  console.error('Failed to generate DMG background:', err);
  process.exit(1);
});
