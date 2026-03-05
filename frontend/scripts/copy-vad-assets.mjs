/**
 * Copy Silero VAD ONNX model, worklet, and ONNX Runtime WASM files
 * from node_modules to public/vad/ for static serving.
 *
 * Run automatically via `postinstall` in package.json.
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = resolve(__dirname, '..', 'public', 'vad');

mkdirSync(dest, { recursive: true });

const files = [
  // Silero VAD ONNX models
  ['../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
  ['../node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', 'silero_vad_legacy.onnx'],
  // VAD AudioWorklet
  ['../node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
  // ONNX Runtime Web WASM
  ['../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  ['../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.wasm'],
];

let copied = 0;
for (const [src, name] of files) {
  const srcPath = resolve(__dirname, src);
  if (existsSync(srcPath)) {
    cpSync(srcPath, resolve(dest, name));
    copied++;
  } else {
    console.warn(`[copy-vad-assets] Missing: ${srcPath}`);
  }
}

console.log(`[copy-vad-assets] Copied ${copied}/${files.length} files to public/vad/`);
