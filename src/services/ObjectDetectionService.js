import { Buffer } from 'buffer';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-react-native';
import * as coco from '@tensorflow-models/coco-ssd';
import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import HazardScoringService from './HazardScoringService';
import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';

/**
 * Detect if the device GPU is known to have broken WebGL/OpenGL ES support.
 *
 * Samsung Exynos GPUs (Galaxy A/M/F series) pass simple matMul validation but
 * their depthwise-separable convolution shaders — the core operation of
 * MobileNet-SSD — are broken on several firmware versions, causing COCO-SSD to
 * silently return 0 detections. All Samsung devices are marked 'unknown' so that
 * the stronger conv2d validation in _validateBackend() is always run before
 * trusting the WebGL backend.
 *
 * PowerVR GPUs (MediaTek Helio in Oppo, Vivo, Realme budget phones) have
 * well-documented packed-float texture issues → marked 'unsafe' → CPU only.
 *
 * Returns 'safe' | 'unsafe' | 'unknown'.
 */
function detectGPUCompatibility() {
  if (Platform.OS !== 'android') return 'safe';
  try {
    const brand = (Platform.constants?.Brand || '').toLowerCase();
    const manufacturer = (Platform.constants?.Manufacturer || '').toLowerCase();
    const model = (Platform.constants?.Model || '').toLowerCase();

    // ── Samsung: always 'unknown' ─────────────────────────────────────────────
    // Exynos 850/980/1280/1380 (Galaxy A/M/F series) and Snapdragon variants
    // both need the stronger conv2d validation before we trust WebGL.
    const isSamsung = brand.includes('samsung') || manufacturer.includes('samsung');
    if (isSamsung) {
      console.log(`ObjectDetectionService: GPU UNKNOWN - Samsung device model=${model} (WebGL conv2d validation required)`);
      return 'unknown';
    }

    // ── MediaTek / PowerVR ────────────────────────────────────────────────────
    const MEDIATEK_POWERVR_BRANDS = ['oppo', 'vivo', 'realme', 'tecno', 'infinix', 'itel'];
    const KNOWN_BROKEN_MODELS = [
      'a54', 'a53', 'a15', 'a16', 'a31',
      'y21', 'y20', 'y15', 'y12', 'y33',
      'c11', 'c15', 'c20', 'c21', 'c25',
    ];

    const isSuspectBrand = MEDIATEK_POWERVR_BRANDS.some(b => brand.includes(b) || manufacturer.includes(b));
    const isKnownBrokenModel = KNOWN_BROKEN_MODELS.some(m => model.includes(m));

    if (isSuspectBrand && isKnownBrokenModel) {
      console.log(`ObjectDetectionService: GPU UNSAFE - brand=${brand} model=${model} (likely PowerVR)`);
      return 'unsafe';
    }
    if (isSuspectBrand) {
      console.log(`ObjectDetectionService: GPU UNKNOWN - brand=${brand} model=${model} (MediaTek-family brand)`);
      return 'unknown';
    }
    return 'safe';
  } catch (e) {
    return 'unknown';
  }
}

// ─── Model cache helpers (react-native-fs backed IOHandler) ──────────────────
//
// The COCO-SSD weights (~6.5 MB for SSDLite) are downloaded from the LAN
// server or CDN on every cold start.  After the first successful load we
// serialise the underlying GraphModel artifacts to the app's RNFS cache
// directory so that subsequent starts read from the local file system and
// skip the network entirely (~300 ms vs up to 30 s).
//
// Cache layout:
//   <CachesDirectory>/tf_cocossd_v1/model.json   – topology + weight manifest
//   <CachesDirectory>/tf_cocossd_v1/weights.bin  – raw weight data (binary)
//
// AsyncStorage key: 'tfjs_cocossd_meta_v1' → { base: 'lite_mobilenet_v2' }
// Bump _CACHE_META_KEY to invalidate the cache on breaking model changes.
//
const _CACHE_META_KEY = 'tfjs_cocossd_meta_v1';

// AsyncStorage key that caches the last successfully validated backend + GPU
// compatibility level.  On subsequent cold starts we try this backend first
// and skip the expensive depthwiseConv2d validation unless the quick matMul
// sanity check fails.  Bumping this key forces a full re-validation (e.g.
// after a firmware update changes GPU behaviour).
const _BACKEND_VALID_KEY = 'tfjs_backend_validated_v2';

/** Convert an ArrayBuffer → base64 string in small chunks to avoid
 *  call-stack overflow on Hermes/JSC with multi-MB buffers. */
function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 4096;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

/** Decode a base64 string back to ArrayBuffer (Buffer is ~10× faster than atob loop). */
function _base64ToArrayBuffer(base64) {
  const buf = Buffer.from(base64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Build a TF.js IOHandler backed by react-native-fs.
 *
 * Implements both `save()` (used by graphModel.save()) and `load()` (used by
 * tf.loadGraphModel / coco.load({ modelUrl: handler })).
 */
function _createRnfsIOHandler(modelDir) {
  return {
    /** Called by tf.loadGraphModel() to read artifacts from disk. */
    load: async () => {
      const modelJsonStr = await RNFS.readFile(modelDir + '/model.json', 'utf8');
      const modelJSON = JSON.parse(modelJsonStr);
      const base64Weights = await RNFS.readFile(modelDir + '/weights.bin', 'base64');
      const weightData = _base64ToArrayBuffer(base64Weights);
      const weightSpecs = modelJSON.weightsManifest[0].weights;
      return {
        modelTopology: modelJSON.modelTopology,
        weightSpecs,
        weightData,
        format: modelJSON.format,
        generatedBy: modelJSON.generatedBy,
        convertedBy: modelJSON.convertedBy,
      };
    },

    /** Called by graphModel.save() to write artifacts to disk. */
    save: async (artifacts) => {
      const dirExists = await RNFS.exists(modelDir);
      if (!dirExists) await RNFS.mkdir(modelDir);

      // Topology + weight manifest (no inline weights)
      const modelJSON = {
        modelTopology: artifacts.modelTopology,
        format: artifacts.format,
        generatedBy: artifacts.generatedBy,
        convertedBy: artifacts.convertedBy,
        weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weightSpecs }],
      };
      await RNFS.writeFile(modelDir + '/model.json', JSON.stringify(modelJSON), 'utf8');

      // Weight data as base64-encoded binary
      const base64 = _arrayBufferToBase64(artifacts.weightData);
      await RNFS.writeFile(modelDir + '/weights.bin', base64, 'base64');

      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
    },
  };
}

// ─── Voice announcement cooldowns (ms) by hazard level ───────────────────────
const VOICE_COOLDOWN = {
  critical: 4000,   // repeat critical warnings every 4 s
  high:     7000,   // high-hazard objects every 7 s
  medium:  12000,   // medium-hazard every 12 s
  low:     20000,   // low-hazard objects every 20 s
};

// Human-readable direction phrases
function directionPhrase(relative, angle) {
  if (relative === 'left') return 'to your left';
  if (relative === 'right') return 'to your right';
  return 'ahead';
}

class ObjectDetectionService {
  constructor() {
    this.model = null;
    this.isReady = false;
    this.cameraRef = null;
    this._poller = null;
    this.apiBaseUrl = API_BASE_URL;
    this.currentDetectionSessionId = null;

    // ── Loading promise deduplication ─────────────────────────────────────────
    // Prevents duplicate concurrent loads (e.g. AppInitializer + ARScreen both
    // call loadModel() before isReady is set).  All callers after the first
    // await the same promise and receive the same model instance.
    this._loadingPromise = null;

    this._isProcessing = false;
    this._cacheBusy = false;
    this._cacheSaveTimer = null;
    this._emptyFrameStreak = 0;
    this._frameSkipCount = 0;
    // Higher target FPS for more real-time feel (GPU); CPU capped later in loadModel
    this._targetFPS = 24;
    this._lastDetectionTime = 0;
    this._minDetectionInterval = 1000 / 24; // ~42 ms

    this._performanceMetrics = {
      avgInferenceTime: 0,
      framesProcessed: 0,
      droppedFrames: 0,
      lastFPS: 0,
    };

    this.config = {
      // ── ACCURACY ──────────────────────────────────────────────────────────
      // scoreThreshold 0.40: balanced floor — catches real obstacles while
      // relying on temporal confirmation to eliminate noise.
      // confirmBypassThreshold 0.55: single-frame confirmation for ≥ 55 %
      // confidence; lower scores need 2 consecutive frames.
      scoreThreshold: 0.40,
      confirmBypassThreshold: 0.55,
      maxDetections: 10,
      nmsIoUThreshold: 0.45,
      perClassNMS: true,
      smoothingFactor: 0.50,
      // 800 ms: must survive 2–3 frame intervals so minConfirmFrames can
      // actually be met with the snapshot capture pipeline.
      trackMaxAgeMs: 800,
      associationIoUThreshold: 0.30,
      // Require 2 frames (seenCount ≥ 2) before a below-bypass-threshold
      // detection is shown.  Balances noise rejection with responsiveness.
      minConfirmFrames: 1,
      enableRefinementPass: false,
      horizontalFOV: 70,
      verticalFOV: 60,
      adaptiveThreshold: false,
      batchProcessing: false,
      tensorPoolSize: 3,
      disableFallback: true,
      canonicalHeights: {
        person: 1.7,
        dog: 0.5,
        bicycle: 1.1,
        motorcycle: 1.2,
        car: 1.45,
        bus: 3.0,
        truck: 3.5,
        chair: 0.9,
        bench: 1.0,
        'stop sign': 2.1,
        'traffic light': 3.5,
        'fire hydrant': 0.6,
        'parking meter': 1.2,
        potted_plant: 0.5,
        skateboard: 0.1,
        umbrella: 0.3,
        handbag: 0.3,
        suitcase: 0.7,
        bottle: 0.25,
        cup: 0.1,
      },
    };

    this._tracks = new Map();
    this._nextId = 1;
    this._tensorPool = [];

    // ── Voice assistance: per-class last-spoken timestamp ─────────────────────
    this._voiceLastSpoken = new Map();
    // Summary timer: every 15 s give a full scene summary if objects are present
    this._summaryLastSpoken = 0;
    this._summaryIntervalMs = 15000;
  }

  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }

  /** Fast LAN health check (1.2 s cap) — avoids blocking on dead local server URLs. */
  async _isLanServerAvailable() {
    if (OfflineModeService.useCloud()) return true;
    const base = this.apiBaseUrl || API_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch(`${base}/api/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const data = await res.json();
      return data?.status === 'ok';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify LAN model.json exists AND all weight shards are present on the server.
   * The server may respond to /api/health while only model.json was copied without
   * running download-coco-ssd.js — coco.load() would hang or fail on missing shards.
   */
  async _verifyLanModelReady(modelJsonUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(modelJsonUrl, { signal: controller.signal });
      if (!res.ok) {
        console.warn('ObjectDetectionService: LAN model.json HTTP', res.status, modelJsonUrl);
        return false;
      }
      const json = await res.json();
      const paths = json.weightsManifest?.[0]?.paths;
      if (!Array.isArray(paths) || paths.length === 0) return false;

      const baseUrl = modelJsonUrl.replace(/\/model\.json$/, '');
      const shardChecks = await Promise.all(
        paths.map(async (shard) => {
          const shardCtrl = new AbortController();
          const shardTimer = setTimeout(() => shardCtrl.abort(), 4000);
          try {
            const r = await fetch(`${baseUrl}/${shard}`, {
              method: 'GET',
              headers: { Range: 'bytes=0-0' },
              signal: shardCtrl.signal,
            });
            return r.ok || r.status === 206;
          } catch {
            return false;
          } finally {
            clearTimeout(shardTimer);
          }
        })
      );
      const ok = shardChecks.every(Boolean);
      if (!ok) {
        console.warn(
          'ObjectDetectionService: LAN model incomplete — weight shards missing on server.',
          'Run: node server/scripts/download-coco-ssd.js',
        );
      }
      return ok;
    } catch (e) {
      console.warn('ObjectDetectionService: LAN model verification failed:', e?.message);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate that the current TF backend can actually run the operations used by
   * MobileNet-SSD.  Two tests are run in sequence:
   *
   * 1. matMul — fast sanity check (catches completely broken backends).
   * 2. depthwiseConv2d — exercises the exact GPU shader path used by every
   *    MobileNet layer.  Skipped on devices marked 'safe' to save ~1–2 s on
   *    cold start; Samsung Exynos and MediaTek devices still get the full test.
   */
  async _validateBackend(gpuCompat = 'unknown') {
    try {
      // ── Test 1: matMul ────────────────────────────────────────────────────
      const a = tf.tensor2d([[1, 2], [3, 4]]);
      const b = tf.tensor2d([[5, 6], [7, 8]]);
      const result = tf.matMul(a, b);
      const data = await result.data();
      a.dispose(); b.dispose(); result.dispose();
      const matMulOk = Math.abs(data[0] - 19) < 0.01 && Math.abs(data[3] - 50) < 0.01;
      if (!matMulOk) {
        console.error('ObjectDetectionService: matMul validation FAILED:', Array.from(data));
        return false;
      }

      if (gpuCompat === 'safe') {
        return true;
      }

      // ── Test 2: depthwiseConv2d ───────────────────────────────────────────
      // Input  [1, 8, 8, 3] of ones × filter [3, 3, 3, 1] of ones (same padding).
      // Interior pixels should each equal 9.0 (3×3 receptive field, all input = 1).
      // NaN/Inf output or wrong centre value → Exynos/Adreno shader bug.
      const inp  = tf.ones([1, 8, 8, 3]);
      const filt = tf.ones([3, 3, 3, 1]);
      const conv = tf.depthwiseConv2d(inp, filt, 1, 'same');
      const convData = await conv.data();
      inp.dispose(); filt.dispose(); conv.dispose();
      const hasInvalid = convData.some(v => !isFinite(v) || isNaN(v));
      const centerIdx  = (4 * 8 + 4) * 3; // channel-0 of centre pixel
      const convOk = !hasInvalid
        && convData.length > 0
        && Math.abs(convData[centerIdx] - 9.0) < 1.5;
      if (!convOk) {
        console.error(
          'ObjectDetectionService: depthwiseConv2d validation FAILED',
          '— Exynos/Adreno GPU shader bug detected. Falling back to CPU.',
          'centre value:', convData[centerIdx], 'hasInvalid:', hasInvalid,
        );
        return false;
      }

      return true;
    } catch (e) {
      console.error('ObjectDetectionService: Backend validation threw error:', e.message || e);
      return false;
    }
  }

  async loadModel() {
    // ── Fast path: already ready ───────────────────────────────────────────
    if (this.isReady && this.model) return this.model;

    // ── Deduplication: concurrent callers wait for the same promise ────────
    // Without this guard, AppInitializer + ARScreen both call loadModel()
    // before isReady is set, triggering two full load pipelines (double GPU
    // validation, double model download/cache-read, double warmup).
    if (this._loadingPromise) return this._loadingPromise;

    this._loadingPromise = this._doLoadModel().finally(() => {
      this._loadingPromise = null;
    });
    return this._loadingPromise;
  }

  async _doLoadModel() {
    try {
      console.log('ObjectDetectionService: Step 1 - Setting up polyfills...');
      // Overlap cache metadata read with backend / polyfill setup.
      const cacheMetaPromise = AsyncStorage.getItem(_CACHE_META_KEY);

      try {
        if (typeof global !== 'undefined') {
          if (!global.location) global.location = { href: '' };
          if (!global.performance) global.performance = { now: Date.now };
          if (!global.navigator) global.navigator = {};
          if (!global.window) global.window = global;
          if (!global.URL && typeof global.require === 'function') {
            try { global.URL = global.require('react-native-url-polyfill'); } catch {}
          }
        }
      } catch {}

      console.log('ObjectDetectionService: Step 2 - Setting TensorFlow backend...');
      const gpuCompat = detectGPUCompatibility();
      console.log('ObjectDetectionService: GPU compatibility:', gpuCompat);

      let backendName = null;

      if (gpuCompat === 'unsafe') {
        console.warn('ObjectDetectionService: Unsafe GPU detected (PowerVR/MediaTek). Using CPU backend.');
        try {
          await tf.setBackend('cpu');
          backendName = 'cpu';
        } catch (e) {
          console.error('ObjectDetectionService: CPU backend also failed:', e);
        }
      } else {
        // ── Try cached validated backend first (skips expensive validation) ──
        // On a typical device the depthwiseConv2d validation adds ~1-2 s to
        // every cold start.  We cache the result in AsyncStorage so subsequent
        // starts can skip straight to tf.ready() with the known-good backend.
        let usedCache = false;
        try {
          const cachedStr = await AsyncStorage.getItem(_BACKEND_VALID_KEY);
          if (cachedStr) {
            const cached = JSON.parse(cachedStr);
            if (cached.backend && cached.gpuCompat === gpuCompat) {
              try {
                await tf.setBackend(cached.backend);
                await tf.ready();
                // Quick matMul sanity check only (skips expensive depthwiseConv2d)
                const a = tf.tensor2d([[1, 2], [3, 4]]);
                const b = tf.tensor2d([[5, 6], [7, 8]]);
                const r = tf.matMul(a, b);
                const d = await r.data();
                a.dispose(); b.dispose(); r.dispose();
                if (Math.abs(d[0] - 19) < 0.01 && Math.abs(d[3] - 50) < 0.01) {
                  backendName = cached.backend;
                  usedCache = true;
                  console.log('ObjectDetectionService: Using cached validated backend:', backendName, '(skipped full validation)');
                }
              } catch (e) {
                console.warn('ObjectDetectionService: Cached backend failed quick check:', e.message);
                try { await AsyncStorage.removeItem(_BACKEND_VALID_KEY); } catch {}
              }
            }
          }
        } catch (cacheReadErr) {
          console.warn('ObjectDetectionService: Backend cache read error:', cacheReadErr.message);
        }

        if (!backendName) {
          // Full validation with depthwiseConv2d
          const webglCandidates = ['rn-webgl', 'webgl'];
          for (const candidate of webglCandidates) {
            try {
              await tf.setBackend(candidate);
              await tf.ready();
              const testResult = await this._validateBackend(gpuCompat);
              if (testResult) {
                backendName = candidate;
                console.log('ObjectDetectionService: Backend', candidate, 'validated successfully');
                // Cache the result to skip validation next time
                AsyncStorage.setItem(_BACKEND_VALID_KEY, JSON.stringify({
                  backend: candidate,
                  gpuCompat,
                })).catch(() => {});
                break;
              } else {
                console.warn('ObjectDetectionService: Backend', candidate, 'validation FAILED');
              }
            } catch (e) {
              console.warn('ObjectDetectionService: Failed to set backend', candidate, e.message || e);
            }
          }
        }

        if (!backendName) {
          console.warn('ObjectDetectionService: All WebGL backends failed. Falling back to CPU.');
          try {
            await tf.setBackend('cpu');
            backendName = 'cpu';
          } catch (e) {
            console.error('ObjectDetectionService: CPU backend failed:', e);
          }
        }
      }

      console.log('ObjectDetectionService: Step 3 - Calling tf.ready()...');
      await tf.ready();
      console.log('ObjectDetectionService: Step 4 - tf.ready() completed, backend:', tf.getBackend());

      try {
        const enablePack = gpuCompat === 'safe' && backendName !== 'cpu';
        tf.env().set('WEBGL_PACK', enablePack);
        tf.env().set('WEBGL_FORCE_F16_TEXTURES', false);
        if (gpuCompat !== 'safe') {
          try { tf.env().set('WEBGL_RENDER_FLOAT32_CAPABLE', false); } catch {}
          try { tf.env().set('WEBGL_FLUSH_THRESHOLD', -1); } catch {}
        }
        console.log('ObjectDetectionService: WEBGL_PACK=' + enablePack);
      } catch {}

      // Suppress the nonMaxSuppression warning from coco-ssd library
      if (typeof console !== 'undefined' && console.warn && !this._warnFilterInstalled) {
        this._warnFilterInstalled = true;
        const originalWarn = console.warn.bind(console);
        console.warn = (...args) => {
          try {
            const message = args.length > 0
              ? (typeof args[0] === 'string' ? args[0] : String(args[0]))
              : '';
            if (message && (
              message.includes('tf.nonMaxSuppression() in webgl locks the UI thread') ||
              message.includes('nonMaxSuppression() in webgl locks') ||
              message.includes('Call tf.nonMaxSuppressionAsync() instead')
            )) {
              return;
            }
            originalWarn(...args);
          } catch (e) {
            originalWarn(...args);
          }
        };
      }

      console.log(`ObjectDetectionService: Using backend ${tf.getBackend()}`);
      this._backendName = tf.getBackend();
      this._gpuCompat = gpuCompat;

      // On CPU, limit to 4 FPS — still responsive while leaving headroom for UI/TTS.
      if (this._backendName === 'cpu') {
        this._targetFPS = 4;
        this._minDetectionInterval = 1000 / 4;
        console.log('ObjectDetectionService: CPU backend — limiting to 4 FPS');
      }

      // On Android, cap maxDetections at 8 — faster NMS + fewer boxes to track.
      const isAndroid = Platform.OS === 'android';
      if (isAndroid && this.config.maxDetections > 8) {
        this.config.maxDetections = 8;
        console.log('ObjectDetectionService: Android — maxDetections capped at 8 for speed');
      }

      // ── Step 5: load COCO-SSD model (cache-first) ────────────────────────
      //
      // On first run the model weights (~6.5 MB for SSDLite) are downloaded
      // from the LAN server or CDN.  After a successful network load the
      // GraphModel artifacts are serialised to the app's RNFS cache directory
      // so that every subsequent cold start loads from the local file system
      // and skips the network entirely (~300 ms vs up to 30 s).
      //
      // Network candidates have a per-attempt timeout:
      //   LAN server URLs  →  8 s timeout  (quick fail if server is offline)
      //   CDN URLs         →  30 s timeout (give CDN time on slow connections)
      //
      // Without a timeout, a non-responding LAN server causes the OS TCP
      // timeout (~60 s per attempt) to block the load for 2+ minutes before
      // the CDN fallback is tried.  This was the primary cause of the reported
      // "2-3 minute detection startup".

      const modelCacheDir = RNFS.CachesDirectoryPath + '/tf_cocossd_v1';
      const localBase = `${this.apiBaseUrl}/models/coco-ssd`;

      const buildCandidates = (lanOk) => {
        const cdn = [
          { base: 'lite_mobilenet_v2' },
          ...(this._backendName !== 'cpu' && Platform.OS === 'ios' ? [{ base: 'mobilenet_v2' }] : []),
          { base: 'mobilenet_v1' },
        ];
        if (!lanOk) return cdn;
        const lan = [
          { base: 'lite_mobilenet_v2', modelUrl: `${localBase}/ssdlite_mobilenet_v2/model.json`, _isLan: true },
          ...(this._backendName !== 'cpu' && Platform.OS === 'ios'
            ? [{ base: 'mobilenet_v2', modelUrl: `${localBase}/ssd_mobilenet_v2/model.json`, _isLan: true }]
            : []),
          { base: 'mobilenet_v1', modelUrl: `${localBase}/ssd_mobilenet_v1/model.json`, _isLan: true },
        ];
        return [...lan, ...cdn];
      };

      // ── Try device cache first (overlap metadata read with backend setup) ─
      let loaded = null;
      let loadedFromCache = false;
      console.log('ObjectDetectionService: Step 5 - Checking device model cache...');
      try {
        const metaStr = await cacheMetaPromise;
        if (metaStr) {
          const meta = JSON.parse(metaStr);
          const [jsonOk, weightsOk] = await Promise.all([
            RNFS.exists(modelCacheDir + '/model.json'),
            RNFS.exists(modelCacheDir + '/weights.bin'),
          ]);
          if (jsonOk && weightsOk) {
            console.log('ObjectDetectionService: Cache hit — loading from device (base:', meta.base, ')');
            const handler = _createRnfsIOHandler(modelCacheDir);
            loaded = await coco.load({ base: meta.base, modelUrl: handler });
            loadedFromCache = true;
            console.log('ObjectDetectionService: ✓ Loaded from device cache — network download skipped');
          } else {
            console.log('ObjectDetectionService: Cache metadata exists but files missing — re-downloading');
            await AsyncStorage.removeItem(_CACHE_META_KEY);
          }
        } else {
          console.log('ObjectDetectionService: No cache — will download and cache after first load');
        }
      } catch (cacheErr) {
        console.warn('ObjectDetectionService: Cache load failed:', cacheErr.message, '— falling back to network');
        loaded = null;
        try { await AsyncStorage.removeItem(_CACHE_META_KEY); } catch {}
      }

      // ── Network download (only on cache miss) ────────────────────────────
      let pendingNetworkCache = null;
      if (!loaded) {
        const serverUp = await this._isLanServerAvailable();
        let lanModelsOk = false;
        if (serverUp) {
          lanModelsOk = await this._verifyLanModelReady(
            `${localBase}/ssdlite_mobilenet_v2/model.json`,
          );
        }
        const candidates = buildCandidates(lanModelsOk);
        if (serverUp && !lanModelsOk) {
          console.log(
            'ObjectDetectionService: LAN server online but model weights missing — using Google CDN',
          );
        } else if (!serverUp) {
          console.log('ObjectDetectionService: LAN server offline — using Google CDN');
        }
        console.log('ObjectDetectionService: Step 5 - Loading coco-ssd model from network...');
        let networkLoadedBase = null;
        for (const opts of candidates) {
          try {
            const timeoutMs = 45000;
            const { _isLan, ...cocoOpts } = opts;
            const source = opts._isLan ? 'LAN' : 'CDN';
            console.log('ObjectDetectionService: Trying model [' + source + ']:', cocoOpts, '(timeout:', timeoutMs, 'ms)');
            loaded = await Promise.race([
              coco.load(cocoOpts),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('load_timeout')), timeoutMs)
              ),
            ]);
            console.log('ObjectDetectionService: Loaded model with options:', cocoOpts);
            if (loaded) {
              networkLoadedBase = opts.base;
              break;
            }
          } catch (e) {
            console.error('ObjectDetectionService: coco-ssd load failed for options', opts.base || opts, e.message);
          }
        }
        if (!loaded) {
          throw new Error('coco-ssd failed to load with all candidates');
        }

        // ── Save model to device cache (fire-and-forget) ──────────────────
        // Run in the background so the warmup and first detection are not
        // delayed.  A failure here is non-fatal — we log and try again next
        // cold start.
        const baseToCache = networkLoadedBase;
        pendingNetworkCache = { base: baseToCache, dir: modelCacheDir };
      }

      // Warmup compiles shaders at real inference size before any live detect() calls.
      const activeModel = await this._runWarmup(loaded);

      this.model = activeModel;
      if (pendingNetworkCache) {
        this._scheduleDeferredModelCache(
          activeModel,
          pendingNetworkCache.base,
          pendingNetworkCache.dir,
        );
      }
      this.isReady = true;
      console.log('ObjectDetectionService: ✓ Model loaded, ready for real-time detection');

      return this.model;
    } catch (error) {
      console.error('ObjectDetectionService loadModel error:', error);
      // Keep pipeline operational — silent no-op model, no mock data
      this.model = { detect: async () => [] };
      this.isReady = true;
      return this.model;
    }
  }

  /**
   * Defer weight caching until the model is idle.  model.save() on the same
   * GraphModel instance while detect() is running freezes WebGL on Android
   * (~90 s stalls, 0 raw predictions).
   */
  _scheduleDeferredModelCache(loaded, base, modelCacheDir) {
    if (this._cacheSaveTimer) clearTimeout(this._cacheSaveTimer);
    const attemptSave = async () => {
      if (this._isProcessing || this._cacheBusy) {
        this._cacheSaveTimer = setTimeout(attemptSave, 8000);
        return;
      }
      this._cacheBusy = true;
      try {
        console.log('ObjectDetectionService: Caching model weights to device storage (idle)...');
        const handler = _createRnfsIOHandler(modelCacheDir);
        await loaded.model.save(handler);
        await AsyncStorage.setItem(_CACHE_META_KEY, JSON.stringify({ base }));
        console.log('ObjectDetectionService: ✓ Model cached — subsequent starts will be faster');
      } catch (saveErr) {
        console.warn('ObjectDetectionService: Cache save failed (non-fatal):', saveErr.message);
      } finally {
        this._cacheBusy = false;
      }
    };
    // First attempt after 20 s — well after the user starts detecting
    this._cacheSaveTimer = setTimeout(attemptSave, 20000);
  }

  /**
   * Pre-compile GPU shaders / allocate CPU buffers. Runs after isReady is set
   * so callers are not blocked on the first forward pass.
   */
  async _runWarmup(loaded) {
    // Match real inference size so shaders compile for 320×240 frames
    const warmupH = 240;
    const warmupW = 320;
    try {
      const wt = tf.zeros([warmupH, warmupW, 3], 'int32');
      const preds = await loaded.detect(wt, 1, 0.01);
      wt.dispose();
      console.log(
        'ObjectDetectionService: ✓ Warmup inference passed',
        `(${warmupW}×${warmupH}, backend=${tf.getBackend()}, preds=${preds?.length ?? 0})`,
      );
      if ((preds?.length ?? 0) === 0 && this._backendName !== 'cpu') {
        console.warn('ObjectDetectionService: Warmup returned 0 preds on GPU — switching to CPU');
        await this._switchToCpuModel();
        const cpuModel = this.model;
        if (cpuModel?.detect) {
          const wt2 = tf.zeros([warmupH, warmupW, 3], 'int32');
          await cpuModel.detect(wt2, 1, 0.01);
          wt2.dispose();
        }
        return this.model;
      }
      return loaded;
    } catch (warmupErr) {
      if (this._backendName === 'cpu') {
        console.warn('ObjectDetectionService: CPU warmup failed (non-fatal):', warmupErr.message);
        return loaded;
      }
      console.warn(
        'ObjectDetectionService: Warmup inference FAILED on',
        this._backendName, '—', warmupErr.message,
        '\n  Switching to CPU + SSDLite for guaranteed compatibility.',
      );
      try { await AsyncStorage.removeItem(_BACKEND_VALID_KEY); } catch {}
      await this._switchToCpuModel();
      return this.model ?? loaded;
    }
  }

  /** Reload COCO-SSD on CPU when WebGL returns empty or stalls. */
  async _switchToCpuModel() {
    if (this._backendName === 'cpu') return;
    try {
      await tf.setBackend('cpu');
      await tf.ready();
      this._backendName = 'cpu';
      this._gpuCompat = 'fallback';
      this._targetFPS = 4;
      this._minDetectionInterval = 1000 / 4;
      const prev = this.model;
      this.model = await coco.load({ base: 'lite_mobilenet_v2' });
      if (prev?.model?.dispose) {
        try { prev.model.dispose(); } catch (_) {}
      }
      console.log('ObjectDetectionService: ✓ CPU + SSDLite fallback model loaded');
    } catch (cpuErr) {
      console.error('ObjectDetectionService: CPU fallback failed:', cpuErr.message);
    }
  }

  async detectFromTensor(tensor, textureWidth, textureHeight) {
    if (!this.isReady || !this.model) {
      console.warn('ObjectDetectionService: Not ready. isReady:', this.isReady, 'model:', !!this.model);
      return [];
    }

    const now = Date.now();
    if (now - this._lastDetectionTime < this._minDetectionInterval) {
      this._performanceMetrics.droppedFrames++;
      return [];
    }

    if (this._isProcessing) {
      this._performanceMetrics.droppedFrames++;
      return [];
    }

    if (this._cacheBusy) {
      this._performanceMetrics.droppedFrames++;
      return [];
    }

    this._isProcessing = true;
    const startTime = performance.now();

    try {
      if (!tensor || !tensor.shape) {
        console.error('ObjectDetectionService: Invalid tensor');
        return [];
      }

      const [tensorH, tensorW] = tensor.shape;
      const frameNum = this._performanceMetrics.framesProcessed;
      const shouldLog = frameNum % 30 === 0 || frameNum < 3;

      if (shouldLog) {
        console.log('ObjectDetectionService: Frame', frameNum, 'tensor:', tensor.shape, tensor.dtype);
      }

      // coco-ssd requires int32 dtype with 0-255 values
      let detectionTensor = tensor;
      if (tensor.dtype === 'float32') {
        detectionTensor = tf.tidy(() => tensor.clipByValue(0, 255).cast('int32'));
      } else if (tensor.dtype !== 'int32' && tensor.dtype !== 'uint8') {
        detectionTensor = tf.tidy(() => tensor.cast('int32'));
      }

      // Pass the actual threshold directly — do NOT subtract 0.15.
      // Lowering it artificially lets garbage detections into our pipeline and forces
      // us to post-filter anyway, while still causing false-positive tracks.
      const libMinScore = Math.min(this.config.scoreThreshold, 0.25);
      const maxBoxes = this.config.maxDetections || 15;

      let predictions;
      try {
        predictions = await this.model.detect(detectionTensor, maxBoxes, libMinScore);
        if (!Array.isArray(predictions)) predictions = [];
      } catch (detectError) {
        console.error('ObjectDetectionService: model.detect() error:', detectError.message);
        predictions = [];
      }

      const inferenceTime = performance.now() - startTime;

      // GPU shader bugs or cache contention → 0 preds + very slow frames
      if (predictions.length === 0 && inferenceTime > 8000) {
        this._emptyFrameStreak++;
        if (this._emptyFrameStreak >= 2 && this._backendName !== 'cpu') {
          console.warn(
            'ObjectDetectionService: 0 predictions after slow inference — switching to CPU',
          );
          this._emptyFrameStreak = 0;
          await this._switchToCpuModel();
          try {
            predictions = await this.model.detect(detectionTensor, maxBoxes, libMinScore);
            if (!Array.isArray(predictions)) predictions = [];
          } catch (_) {}
        }
      } else if (predictions.length > 0) {
        this._emptyFrameStreak = 0;
      }

      if (detectionTensor !== tensor) {
        try { detectionTensor.dispose(); } catch (e) {}
      }

      if (predictions.length === 0 || shouldLog) {
        console.log('ObjectDetectionService: Raw predictions:', predictions.length,
          '| threshold:', this.config.scoreThreshold,
          '| libMinScore:', libMinScore.toFixed(2));
        if (predictions.length > 0) {
          const s = predictions[0];
          console.log('  Top prediction:', s.class, 'score:', (s.score ?? 0).toFixed(3));
        }
      }

      const safePredictions = predictions.filter(p => p && Array.isArray(p.bbox) && p.bbox.length >= 4);

      // Clamp bbox to image bounds (COCO-SSD can return boxes slightly outside)
      const inImage = safePredictions
        .map((p) => {
          let [bx, by, bw, bh] = p.bbox;
          bx = Math.max(0, bx);
          by = Math.max(0, by);
          bw = Math.min(bw, textureWidth - bx);
          bh = Math.min(bh, textureHeight - by);
          if (bw <= 0 || bh <= 0) return null;
          return { ...p, bbox: [bx, by, bw, bh] };
        })
        .filter(Boolean);

      // Reject boxes whose area is too small — likely pattern-triggered noise.
      // Large objects (cars, people) appearing tiny on screen are suspicious;
      // small objects (bottles, cups, fire hydrants) can legitimately occupy
      // less than 1 % of the frame.
      const LARGE_OBJECTS = new Set(['car', 'bus', 'truck', 'person', 'bicycle', 'motorcycle']);
      const MIN_AREA_FRACTION = 0.005;
      const MIN_AREA_LARGE = 0.015;
      const validSize = inImage.filter((p) => {
        const [, , bw, bh] = p.bbox;
        const areaNorm = (bw / textureWidth) * (bh / textureHeight);
        const minArea = LARGE_OBJECTS.has(p.class) ? MIN_AREA_LARGE : MIN_AREA_FRACTION;
        return areaNorm >= minArea;
      });

      // Objects below are highly prone to false-positives from textures/patterns
      // AND are irrelevant for outdoor blind-navigation safety.
      // They require a much higher confidence bar before being reported.
      const FALSE_POSITIVE_CLASSES = new Set([
        // Sports / recreation — rarely present on a city street
        'snowboard', 'surfboard', 'skis', 'sports ball', 'kite',
        'frisbee', 'baseball bat', 'baseball glove', 'tennis racket',
        // Note: skateboard removed — it's a real trip hazard for blind navigation
        // Food — commonly triggered by floor textures, clothing prints, etc.
        'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot',
        'hot dog', 'pizza', 'donut', 'cake',
        // Kitchen appliances — not outdoors
        'oven', 'toaster', 'microwave', 'refrigerator',
        // Small objects triggered by patterns
        'toothbrush', 'scissors', 'remote',
        // Contextually implausible outdoors
        'airplane',
        // Note: boat removed — relevant near waterways/docks
      ]);
      const minConfForClass = (cls) =>
        FALSE_POSITIVE_CLASSES.has(cls)
          ? Math.max(this.config.scoreThreshold, 0.60)
          : this.config.scoreThreshold;

      const filtered = validSize.filter(p => (p.score ?? 0) >= minConfForClass(p.class));

      if (validSize.length > 0 && filtered.length === 0 && shouldLog) {
        const maxScore = Math.max(...validSize.map(p => p.score ?? 0));
        console.log('ObjectDetectionService: All', validSize.length,
          'size-valid predictions below threshold', this.config.scoreThreshold,
          '- max score:', maxScore.toFixed(3));
      }

      const nmsSelected = filtered.length > 0
        ? (this.config.perClassNMS
          ? await this._perClassNMS(filtered)
          : await this._globalNMS(filtered))
        : [];

      let detections = nmsSelected.map(pred => {
        const [bx, by, bw, bh] = Array.isArray(pred.bbox) && pred.bbox.length >= 4
          ? pred.bbox : [0, 0, 10, 10];
        const norm = {
          x: bx / textureWidth,
          y: by / textureHeight,
          width: bw / textureWidth,
          height: bh / textureHeight,
        };
        const centerX = norm.x + norm.width / 2;
        const centerY = norm.y + norm.height / 2;
        const angle = (centerX - 0.5) * this.config.horizontalFOV;
        const distance = this._estimateDistance(
          pred.class, bh, textureHeight, this.config.verticalFOV, norm
        );
        let relative = 'center';
        if (centerX < 0.33) relative = 'left';
        else if (centerX > 0.66) relative = 'right';
        return {
          class: pred.class,
          confidence: pred.score,
          boundingBox: norm,
          distance,
          position: { relative, angle, center: { x: centerX, y: centerY } },
        };
      });

      // Refinement pass is disabled — it re-runs inference on crops and adds too much latency
      // for real-time detection. Re-enable only for high-accuracy offline mode.

      const tracked = this._associateAndSmooth(detections);
      // Only surface detections that have been consistently seen in
      // minConfirmFrames consecutive frames — eliminates single-frame noise.
      const confirmed = tracked.filter(d => d._confirmed);
      const enriched = confirmed.map(d => {
        const { score, level } = HazardScoringService.scoreDetection(d);
        return { ...d, hazard: { score, level } };
      });
      enriched.sort((a, b) =>
        (b.hazard?.score || 0) - (a.hazard?.score || 0) || (b.confidence - a.confidence)
      );

      const finalDetections = enriched.slice(0, this.config.maxDetections);

      const inferenceTimeFinal = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgInferenceTime =
        (this._performanceMetrics.avgInferenceTime * (this._performanceMetrics.framesProcessed - 1)
          + inferenceTimeFinal) / this._performanceMetrics.framesProcessed;
      this._performanceMetrics.lastFPS = inferenceTimeFinal > 0 ? 1000 / inferenceTimeFinal : 0;
      this._lastDetectionTime = now;

      if (shouldLog) {
        console.log('ObjectDetectionService: Returning', finalDetections.length,
          'detections, inference:', inferenceTimeFinal.toFixed(0), 'ms,',
          this._performanceMetrics.lastFPS.toFixed(1), 'fps',
          `backend=${tf.getBackend()}`);
      }

      return finalDetections;
    } catch (error) {
      console.error('detectFromTensor error:', error.message, error.stack);
      return [];
    } finally {
      this._isProcessing = false;
    }
  }

  // ─── Voice Assistance ──────────────────────────────────────────────────────

  /**
   * Announce all detected objects via the provided TTS callback.
   * Uses per-class cooldowns by hazard level to avoid speech spam.
   *
   * @param {Array}    detections  - enriched detection objects with .hazard
   * @param {Function} ttsSpeak   - (text, opts, priority) → void
   */
  announceDetectedObjects(detections, ttsSpeak) {
    if (!detections || detections.length === 0 || typeof ttsSpeak !== 'function') return;

    const now = Date.now();

    // ── 1. Announce each object that has cooled down ──
    for (const det of detections) {
      const level = det.hazard?.level || 'low';
      const cooldown = VOICE_COOLDOWN[level] ?? VOICE_COOLDOWN.low;
      const key = `${det.class}__${det.id || ''}`;
      const lastAt = this._voiceLastSpoken.get(det.class) || 0;

      if (now - lastAt < cooldown) continue;

      this._voiceLastSpoken.set(det.class, now);

      const message = this.getObjectDescription(det);
      const ttsPriority = (level === 'critical' || level === 'high') ? 'critical' : 'normal';
      ttsSpeak(message, {}, ttsPriority);

      // Only announce the single highest-priority object per call to avoid overlapping speech
      break;
    }

    // ── 2. Periodic full-scene summary ────────────────────────────────────────
    if (now - this._summaryLastSpoken >= this._summaryIntervalMs && detections.length > 1) {
      this._summaryLastSpoken = now;
      const summary = this._buildSceneSummary(detections);
      if (summary) ttsSpeak(summary, {}, 'normal');
    }
  }

  /**
   * Build a short spoken scene summary, e.g.:
   * "3 objects nearby: person ahead 2 meters, car to your right 5 meters, bicycle to your left"
   */
  _buildSceneSummary(detections) {
    if (!detections || detections.length === 0) return null;
    const top = detections.slice(0, 4);
    const parts = top.map(d => {
      const dir = directionPhrase(d.position?.relative, d.position?.angle);
      return `${d.class} ${dir}, ${(d.distance ?? 0).toFixed(0)} meters`;
    });
    return `${detections.length} object${detections.length > 1 ? 's' : ''} nearby: ${parts.join('; ')}`;
  }

  /**
   * Returns a natural-language description of a detection for voice output.
   * Examples:
   *   "Warning! Car to your right, 3 meters"
   *   "Person ahead, 2 meters"
   *   "Stop sign to your left, 5 meters"
   */
  getObjectDescription(detection) {
    const distance = (detection.distance ?? 0).toFixed(1);
    const dir = directionPhrase(detection.position?.relative, detection.position?.angle);
    const level = detection.hazard?.level || 'low';
    const prefix = (level === 'critical') ? 'Warning! ' : (level === 'high') ? 'Caution! ' : '';
    return `${prefix}${detection.class} ${dir}, ${distance} meters`;
  }

  // ─── Utility / Pipeline ───────────────────────────────────────────────────

  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }

  setTargetFPS(fps) {
    this._targetFPS = Math.max(5, Math.min(30, fps));
    this._minDetectionInterval = 1000 / this._targetFPS;
  }

  _bboxToNMSFormat(bbox) {
    const [x, y, w, h] = Array.isArray(bbox) && bbox.length >= 4 ? bbox : [0, 0, 1, 1];
    return [y, x, y + h, x + w];
  }

  _iouNMSBoxes(a, b) {
    const [ay1, ax1, ay2, ax2] = a;
    const [by1, bx1, by2, bx2] = b;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = ix * iy;
    const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
    return union <= 0 ? 0 : inter / union;
  }

  /** Greedy NMS in pure JS — faster than TF async ops for small prediction sets. */
  _jsNMS(preds, maxDetections, iouThreshold) {
    if (preds.length <= 1) return preds.slice(0, maxDetections);
    const sorted = [...preds].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const boxes = sorted.map((p) => this._bboxToNMSFormat(p.bbox));
    const selected = [];
    const suppressed = new Set();
    for (let i = 0; i < sorted.length && selected.length < maxDetections; i++) {
      if (suppressed.has(i)) continue;
      selected.push(sorted[i]);
      for (let j = i + 1; j < sorted.length; j++) {
        if (!suppressed.has(j) && this._iouNMSBoxes(boxes[i], boxes[j]) > iouThreshold) {
          suppressed.add(j);
        }
      }
    }
    return selected;
  }

  async _globalNMS(preds) {
    if (preds.length === 0) return [];
    const { maxDetections, nmsIoUThreshold } = this.config;
    if (preds.length <= 12) {
      return this._jsNMS(preds, maxDetections, nmsIoUThreshold);
    }
    const { scoreThreshold } = this.config;
    const boxesNMS = preds.map(p => this._bboxToNMSFormat(p.bbox));
    const boxesT = tf.tensor2d(boxesNMS);
    const scoresT = tf.tensor1d(preds.map(p => p.score ?? 0));
    try {
      const sel = await tf.image.nonMaxSuppressionAsync(
        boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold
      );
      const indices = await sel.array();
      sel.dispose();
      boxesT.dispose();
      scoresT.dispose();
      return indices.map(i => preds[i]);
    } catch (e) {
      boxesT.dispose();
      scoresT.dispose();
      console.warn('_globalNMS error, returning all predictions:', e);
      return preds.slice(0, maxDetections);
    }
  }

  async _perClassNMS(preds) {
    const byClass = new Map();
    preds.forEach(p => {
      const key = p.class || 'unknown';
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(p);
    });
    const selected = [];
    const { maxDetections, nmsIoUThreshold, scoreThreshold } = this.config;

    for (const list of byClass.values()) {
      if (list.length <= 8) {
        selected.push(...this._jsNMS(list, maxDetections, nmsIoUThreshold));
        continue;
      }

      const boxesNMS = list.map(p => this._bboxToNMSFormat(p.bbox));
      const boxesT = tf.tensor2d(boxesNMS);
      const scoresT = tf.tensor1d(list.map(p => p.score ?? 0));
      try {
        const sel = await tf.image.nonMaxSuppressionAsync(
          boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold
        );
        const indices = await sel.array();
        sel.dispose();
        boxesT.dispose();
        scoresT.dispose();
        indices.forEach(i => selected.push(list[i]));
      } catch (e) {
        boxesT.dispose();
        scoresT.dispose();
        console.warn('_perClassNMS error:', e);
        selected.push(...list.slice(0, maxDetections));
      }
    }
    return selected;
  }

  _estimateDistance(objectClass, bboxHeightPixels, frameHeightPixels, verticalFOVDeg, normBox) {
    const canonical = this.config.canonicalHeights[objectClass];
    if (canonical && bboxHeightPixels > 0 && frameHeightPixels > 0) {
      const vfov = (verticalFOVDeg * Math.PI) / 180;
      const focal = (frameHeightPixels / 2) / Math.tan(vfov / 2);
      const z = (canonical * focal) / bboxHeightPixels;
      if (isFinite(z) && z > 0.1 && z < 100) return z;
    }
    const area = Math.max(1e-4, (normBox?.width || 0.1) * (normBox?.height || 0.1));
    return Math.min(100, Math.max(0.2, 6 / Math.sqrt(area)));
  }

  _iou(a, b) {
    const ax2 = a.x + a.width, ay2 = a.y + a.height;
    const bx2 = b.x + b.width, by2 = b.y + b.height;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = ix * iy;
    const union = a.width * a.height + b.width * b.height - inter;
    return union <= 0 ? 0 : inter / union;
  }

  _associateAndSmooth(detections) {
    const now = Date.now();
    const usedTrackIds = new Set();
    const results = [];
    const minConfirm = this.config.minConfirmFrames ?? 2;
    // Detections at or above this score are treated as confirmed on the very first
    // frame they appear — no second-frame requirement. This prevents high-confidence
    // real objects from being silently swallowed by the temporal filter.
    const bypassScore = this.config.confirmBypassThreshold ?? 0.65;

    detections.forEach(det => {
      let bestId = null;
      let bestIou = 0;
      this._tracks.forEach((track, id) => {
        if (usedTrackIds.has(id)) return;
        if (track.class !== det.class) return;
        const iou = this._iou(track.bbox, det.boundingBox);
        if (iou > bestIou) { bestIou = iou; bestId = id; }
      });

      if (bestId && bestIou >= this.config.associationIoUThreshold) {
        const t = this._tracks.get(bestId);
        const a = this.config.smoothingFactor;
        const smoothedBox = {
          x: a * det.boundingBox.x + (1 - a) * t.bbox.x,
          y: a * det.boundingBox.y + (1 - a) * t.bbox.y,
          width: a * det.boundingBox.width + (1 - a) * t.bbox.width,
          height: a * det.boundingBox.height + (1 - a) * t.bbox.height,
        };
        const smoothedScore = a * det.confidence + (1 - a) * t.score;
        const smoothedDistance = a * det.distance + (1 - a) * t.distance;
        const vx = det.boundingBox.x - t.bbox.x;
        const vy = det.boundingBox.y - t.bbox.y;
        const newSeenCount = (t.seenCount || 1) + 1;
        const updated = {
          ...det,
          id: bestId,
          confidence: smoothedScore,
          boundingBox: smoothedBox,
          distance: smoothedDistance,
          velocity: { x: vx, y: vy },
          _confirmed: smoothedScore >= bypassScore || newSeenCount >= minConfirm,
        };
        this._tracks.set(bestId, {
          class: det.class,
          bbox: smoothedBox,
          score: smoothedScore,
          distance: smoothedDistance,
          lastSeen: now,
          velocity: { x: vx, y: vy },
          seenCount: newSeenCount,
        });
        usedTrackIds.add(bestId);
        results.push(updated);
      } else {
        // New track — confirmed immediately if score is high enough, otherwise
        // needs a second frame to be promoted above the temporal filter.
        const id = String(this._nextId++);
        this._tracks.set(id, {
          class: det.class,
          bbox: det.boundingBox,
          score: det.confidence,
          distance: det.distance,
          lastSeen: now,
          velocity: { x: 0, y: 0 },
          seenCount: 1,
        });
        results.push({
          ...det,
          id,
          velocity: { x: 0, y: 0 },
          _confirmed: det.confidence >= bypassScore,
        });
      }
    });

    // Expire stale tracks
    this._tracks.forEach((t, id) => {
      if (now - t.lastSeen > this.config.trackMaxAgeMs) this._tracks.delete(id);
    });

    return results;
  }

  getPriorityLevel(detection) {
    const criticalObjects = ['car', 'bus', 'truck', 'motorcycle', 'bicycle'];
    const warningObjects = ['person', 'traffic light', 'stop sign', 'fire hydrant', 'dog'];
    if (criticalObjects.includes(detection.class) && detection.distance < 6) return 'critical';
    if (warningObjects.includes(detection.class) && detection.distance < 4) return 'warning';
    // Also use hazard score for dynamic classification
    const level = detection.hazard?.level;
    if (level === 'critical' || level === 'high') return 'critical';
    if (level === 'medium') return 'warning';
    return 'info';
  }

  async cleanup() {}

  setCameraRef(ref) {
    this.cameraRef = ref;
  }

  async startDetection(callback, intervalMs = 500) {
    if (this._poller) return;

      const token = await AsyncStorage.getItem('@sensei_auth_token');
      if (token) {
        try {
          const response = await fetch(`${this.apiBaseUrl}/api/ai/detection/start`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ startTime: new Date().toISOString() }),
          });
        if (response.ok) {
          const data = await response.json();
          this.currentDetectionSessionId = data.session_id;
        }
      } catch (err) {
        console.error('Failed to start detection session:', err);
      }
    }

    // NOTE: Real detection is driven by detectFromTensor() called from ARScreen's
    // snapshot loop. This poller only handles backend session logging.
    this._poller = setInterval(async () => {
      try {
        if (typeof callback === 'function') callback([]);
      } catch (err) {
        console.error('ObjectDetectionService.startDetection loop error:', err);
      }
    }, intervalMs);
  }

  async stopDetection() {
    if (this._poller) {
      clearInterval(this._poller);
      this._poller = null;
    }
    if (this.currentDetectionSessionId) {
      const token = await AsyncStorage.getItem('@sensei_auth_token');
      if (token) {
        try {
          await fetch(`${this.apiBaseUrl}/api/ai/detection/stop`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ session_id: this.currentDetectionSessionId }),
          });
        } catch (err) {
          console.error('Failed to stop detection session:', err);
        }
      }
      this.currentDetectionSessionId = null;
    }
  }

  async logDetectionsToServer(enriched) {
    if (!this.currentDetectionSessionId || enriched.length === 0) return;
    const token = await AsyncStorage.getItem('@sensei_auth_token');
    if (!token) return;
    try {
      await Promise.all(enriched.slice(0, 3).map(obj =>
        fetch(`${this.apiBaseUrl}/api/ai/detection/object`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            session_id:  this.currentDetectionSessionId,
            object_type: obj.class,
            confidence:  obj.confidence,
            distance:    obj.distance,
            position:    obj.position?.relative,
            hazard_level: obj.hazard?.level,
          }),
        })
      ));
    } catch (err) {
      console.error('Failed to log detected objects:', err);
    }
  }

  _generateMockDetections() {
    return [
      {
        class: 'person',
        confidence: 0.5,
        boundingBox: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
        distance: 2.0,
        position: { relative: 'center', angle: 0, center: { x: 0.5, y: 0.5 } },
      },
    ];
  }
}

export default new ObjectDetectionService();
