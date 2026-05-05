/**
 * Downloads coco-ssd model weights from Google's CDN to server/models/coco-ssd/
 * so the Android app can fetch them from the local LAN server instead of hitting
 * the internet on every cold start.
 *
 * Usage (from the repo root):
 *   node server/scripts/download-coco-ssd.js
 *
 * Models downloaded:
 *   ssdlite_mobilenet_v2  – ~18 MB  (fastest, used on CPU backend)
 *   ssd_mobilenet_v1      –  ~28 MB  (fallback)
 *
 * After running once, restart the Express server.  The app will automatically
 * prefer http://<LAN-IP>:3001/models/coco-ssd/<model>/model.json over the CDN.
 */

import https from 'https';
import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_CDN   = 'https://storage.googleapis.com/tfjs-models/savedmodel/';
const MODEL_NAMES = ['ssdlite_mobilenet_v2', 'ssd_mobilenet_v1'];
const OUT_DIR    = path.resolve(__dirname, '..', 'models', 'coco-ssd');

// ── HTTP(S) download helper with redirect support ────────────────────────────
function download(url, dest, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const proto  = url.startsWith('https') ? https : http;
    const tmpDest = dest + '.tmp';
    const file   = fs.createWriteStream(tmpDest);

    proto.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        file.destroy();
        fs.unlink(tmpDest, () => {});
        download(res.headers.location, dest, depth + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.destroy();
        fs.unlink(tmpDest, () => {});
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmpDest, dest, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
    }).on('error', (err) => {
      file.destroy();
      fs.unlink(tmpDest, () => {});
      reject(err);
    });

    file.on('error', (err) => {
      file.destroy();
      fs.unlink(tmpDest, () => {});
      reject(err);
    });
  });
}

// ── Download one model (model.json + all weight shards) ──────────────────────
async function downloadModel(modelName) {
  const modelDir = path.join(OUT_DIR, modelName);
  fs.mkdirSync(modelDir, { recursive: true });

  // 1. model.json
  const modelJsonUrl  = `${BASE_CDN}${modelName}/model.json`;
  const modelJsonPath = path.join(modelDir, 'model.json');

  if (fs.existsSync(modelJsonPath)) {
    console.log(`  model.json already exists – skipping download`);
  } else {
    process.stdout.write(`  Downloading model.json ... `);
    await download(modelJsonUrl, modelJsonPath);
    console.log('done');
  }

  // 2. Weight shards referenced in weightsManifest
  const manifest    = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
  const weightPaths = (manifest.weightsManifest ?? []).flatMap(m => m.paths ?? []);

  for (const weightFile of weightPaths) {
    const weightPath = path.join(modelDir, weightFile);
    if (fs.existsSync(weightPath)) {
      console.log(`  ${weightFile} already exists – skipping`);
      continue;
    }
    const weightUrl = `${BASE_CDN}${modelName}/${weightFile}`;
    process.stdout.write(`  Downloading ${weightFile} ... `);
    await download(weightUrl, weightPath);
    console.log('done');
  }

  console.log(`✓ ${modelName} ready\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`Saving models to: ${OUT_DIR}\n`);

for (const name of MODEL_NAMES) {
  console.log(`── ${name}`);
  try {
    await downloadModel(name);
  } catch (err) {
    console.error(`✗ ${name} failed: ${err.message}\n`);
  }
}

console.log('All done.  Restart the Express server to serve the new model files.');
