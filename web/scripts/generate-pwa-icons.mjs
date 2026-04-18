#!/usr/bin/env node
/**
 * Rasterises the PWA icon SVG sources at `web/scripts/icons/*.svg` into the
 * PNG set referenced by `src/app/manifest.ts`. Run from the `web/` directory:
 *
 *   npm run pwa:icons
 *
 * Idempotent — safe to rerun any time the SVG source changes. Output files
 * are committed to `public/icons/` so dev/CI don't need sharp on the path
 * at runtime (only at icon-regeneration time).
 */

import sharp from 'sharp';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(__dirname, 'icons');
const OUT = resolve(ROOT, 'public', 'icons');
const FAV_OUT = resolve(ROOT, 'public');

/** @type {{src: string; out: string; size: number; bg?: string}[]} */
const TARGETS = [
  // Installable (any-purpose) — matches manifest.icons entries.
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-384.png', size: 384 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  // Android adaptive-icon — launcher clips, so no rounded corners in source.
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

// Apple touch icon — iOS doesn't accept transparency. 180px is the canonical
// size for home-screen icons (iPhone 6+).
const APPLE = { src: 'apple-icon.svg', out: 'apple-icon-180.png', size: 180 };

// Tiny PNG fallback for browsers that still try /favicon.ico lookups.
const FAVICON_PNG = { src: 'favicon.svg', out: 'favicon-32.png', size: 32 };

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function rasterise({ src, out, size, flatten }) {
  const input = resolve(SRC, src);
  const output = resolve(out.startsWith('favicon') || out.startsWith('apple') ? FAV_OUT : OUT, out);
  let pipeline = sharp(input, { density: Math.max(72, Math.round((size / 512) * 300)) })
    .resize(size, size, { fit: 'cover' });
  if (flatten) {
    // iOS apple-touch-icon must be opaque. Flatten onto brand blue so any
    // transparent pixels (shouldn't be any given our SVG, but belt-and-braces)
    // render as solid colour instead of black on the home screen.
    pipeline = pipeline.flatten({ background: '#0066FF' });
  }
  await pipeline.png({ compressionLevel: 9, quality: 100 }).toFile(output);
  console.log(`  wrote ${output} (${size}×${size})`);
}

async function main() {
  await ensureDir(OUT);
  console.log('Rasterising PWA icons…');
  for (const t of TARGETS) {
    await rasterise(t);
  }
  await rasterise({ ...APPLE, flatten: true });
  await rasterise(FAVICON_PNG);
  // Also publish the SVG favicon verbatim — browsers that support SVG favicons
  // (Chrome, Firefox, Edge) get crisp rendering at any DPR without extra work.
  await copyFile(resolve(SRC, 'favicon.svg'), resolve(FAV_OUT, 'favicon.svg'));
  console.log('  wrote', resolve(FAV_OUT, 'favicon.svg'));
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
