import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-react-native';
import * as coco from '@tensorflow-models/coco-ssd';
import 'react-native-url-polyfill/auto';
import { Platform } from 'react-native';
import HazardScoringService from './HazardScoringService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Detect if the device GPU is known to have broken WebGL/OpenGL ES support.
 * PowerVR GPUs (common in MediaTek Helio chipsets used by Oppo, Vivo, Realme budget phones)
 * have well-documented issues with WebGL shader compilation and packed float textures
 * that cause TensorFlow.js inference to silently fail or produce empty results.
 *
 * Returns 'safe' | 'unsafe' | 'unknown'.
 */
function detectGPUCompatibility() {
  if (Platform.OS !== 'android') return 'safe';
  try {
    const brand = (Platform.constants?.Brand || '').toLowerCase();
    const manufacturer = (Platform.constants?.Manufacturer || '').toLowerCase();
    const model = (Platform.constants?.Model || '').toLowerCase();

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

    this._isProcessing = false;
    this._frameSkipCount = 0;
    // Higher target FPS for more real-time feel
    this._targetFPS = 20;
    this._lastDetectionTime = 0;
    this._minDetectionInterval = 1000 / 20; // 50 ms

    this._performanceMetrics = {
      avgInferenceTime: 0,
      framesProcessed: 0,
      droppedFrames: 0,
      lastFPS: 0,
    };

    this.config = {
      // ── ACCURACY ──────────────────────────────────────────────────────────
      // 0.40 is the correct floor for mobilenet_v2 COCO-SSD on real phone-camera
      // frames.  Real-world footage is blurrier and lower-contrast than COCO
      // training images — at 0.55 the model returns 0 raw predictions for most
      // frames, causing the blind user to never be warned about obstacles.
      // For a blind-navigation assistant, false negatives (missed obstacles) are
      // MORE dangerous than false positives.  Noisy classes (food, sports) are
      // still protected by FALSE_POSITIVE_CLASSES which requires ≥0.70 for them.
      //
      // High-confidence bypass: score ≥ 0.55 is confirmed in a single frame.
      // Scores 0.40–0.55 need to appear in 2 frames (minConfirmFrames=1 means the
      // second appearance with IoU match is enough — seenCount 1→2 ≥ 1).
      scoreThreshold: 0.40,
      confirmBypassThreshold: 0.55,
      maxDetections: 15,
      nmsIoUThreshold: 0.45,
      perClassNMS: true,
      smoothingFactor: 0.50,
      trackMaxAgeMs: 600,
      associationIoUThreshold: 0.30,
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

  /**
   * Validate that the current TF backend can actually run computations.
   */
  async _validateBackend() {
    try {
      const a = tf.tensor2d([[1, 2], [3, 4]]);
      const b = tf.tensor2d([[5, 6], [7, 8]]);
      const result = tf.matMul(a, b);
      const data = await result.data();
      a.dispose();
      b.dispose();
      result.dispose();
      const valid = Math.abs(data[0] - 19) < 0.01 && Math.abs(data[3] - 50) < 0.01;
      if (!valid) {
        console.error('ObjectDetectionService: Backend validation FAILED — GPU produced wrong result:', Array.from(data));
      }
      return valid;
    } catch (e) {
      console.error('ObjectDetectionService: Backend validation threw error:', e.message || e);
      return false;
    }
  }

  async loadModel() {
    if (this.isReady && this.model) return this.model;
    try {
      console.log('ObjectDetectionService: Step 1 - Setting up polyfills...');
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
        const webglCandidates = ['rn-webgl', 'webgl'];
        for (const candidate of webglCandidates) {
          try {
            await tf.setBackend(candidate);
            await tf.ready();
            const testResult = await this._validateBackend();
            if (testResult) {
              backendName = candidate;
              console.log('ObjectDetectionService: Backend', candidate, 'validated successfully');
              break;
            } else {
              console.warn('ObjectDetectionService: Backend', candidate, 'validation FAILED');
            }
          } catch (e) {
            console.warn('ObjectDetectionService: Failed to set backend', candidate, e.message || e);
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

      // On CPU, reduce FPS to avoid overloading the device
      if (this._backendName === 'cpu') {
        this._targetFPS = 5;
        this._minDetectionInterval = 1000 / 5;
        console.log('ObjectDetectionService: CPU backend — limiting to 5 FPS');
      }

      console.log('ObjectDetectionService: Step 5 - Loading coco-ssd model...');
      // Full mobilenet_v2 is the most accurate; lite is faster but less accurate
      // On GPU prefer full mobilenet_v2 for best accuracy; CPU needs lite for speed
      //
      // Candidate order:
      //   1. Local LAN server  (fast, works without internet)
      //   2. Google CDN        (requires internet, fallback if server not running)
      //
      // To populate local models run:
      //   node server/scripts/download-coco-ssd.js
      const localBase = `${this.apiBaseUrl}/models/coco-ssd`;
      const candidates = this._backendName === 'cpu'
        ? [
            { base: 'lite_mobilenet_v2', modelUrl: `${localBase}/ssdlite_mobilenet_v2/model.json` },
            { base: 'mobilenet_v1',       modelUrl: `${localBase}/ssd_mobilenet_v1/model.json`      },
            // CDN fallbacks (require internet)
            { base: 'lite_mobilenet_v2' },
            { base: 'mobilenet_v1'       },
          ]
        : [
            { base: 'mobilenet_v2',      modelUrl: `${localBase}/ssd_mobilenet_v2/model.json`      },
            { base: 'lite_mobilenet_v2', modelUrl: `${localBase}/ssdlite_mobilenet_v2/model.json` },
            { base: 'mobilenet_v1',       modelUrl: `${localBase}/ssd_mobilenet_v1/model.json`      },
            // CDN fallbacks (require internet)
            { base: 'mobilenet_v2'       },
            { base: 'lite_mobilenet_v2'  },
            { base: 'mobilenet_v1'        },
          ];

      let loaded = null;
      for (const opts of candidates) {
        try {
          console.log('ObjectDetectionService: Trying model:', opts);
          loaded = await coco.load(opts);
          console.log('ObjectDetectionService: Loaded model with options:', opts);
          if (loaded) break;
        } catch (e) {
          console.error('ObjectDetectionService: coco-ssd load failed for options', opts, e.message);
        }
      }
      if (!loaded) {
        throw new Error('coco-ssd failed to load with all candidates');
      }
      this.model = loaded;
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
      const libMinScore = this.config.scoreThreshold;
      const maxBoxes = this.config.maxDetections || 15;

      let predictions;
      try {
        predictions = await this.model.detect(detectionTensor, maxBoxes, libMinScore);
        if (!Array.isArray(predictions)) predictions = [];
      } catch (detectError) {
        console.error('ObjectDetectionService: model.detect() error:', detectError.message);
        predictions = [];
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

      // Reject boxes whose area is less than 1% of the frame — sub-percent boxes
      // are almost always pattern-triggered noise, not real objects.
      const MIN_AREA_FRACTION = 0.01;
      const validSize = inImage.filter((p) => {
        const [, , bw, bh] = p.bbox;
        const areaNorm = (bw / textureWidth) * (bh / textureHeight);
        return areaNorm >= MIN_AREA_FRACTION;
      });

      // Objects below are highly prone to false-positives from textures/patterns
      // AND are irrelevant for outdoor blind-navigation safety.
      // They require a much higher confidence bar before being reported.
      const FALSE_POSITIVE_CLASSES = new Set([
        // Sports / recreation — rarely present on a city street
        'snowboard', 'surfboard', 'skis', 'sports ball', 'kite',
        'frisbee', 'baseball bat', 'baseball glove', 'tennis racket',
        'skateboard',
        // Food — commonly triggered by floor textures, clothing prints, etc.
        'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot',
        'hot dog', 'pizza', 'donut', 'cake',
        // Kitchen appliances — not outdoors
        'oven', 'toaster', 'microwave', 'refrigerator',
        // Small objects triggered by patterns
        'toothbrush', 'scissors', 'remote',
        // Contextually implausible outdoors
        'airplane', 'boat',
      ]);
      const minConfForClass = (cls) =>
        FALSE_POSITIVE_CLASSES.has(cls)
          ? Math.max(this.config.scoreThreshold, 0.70)
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

      const inferenceTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgInferenceTime =
        (this._performanceMetrics.avgInferenceTime * (this._performanceMetrics.framesProcessed - 1)
          + inferenceTime) / this._performanceMetrics.framesProcessed;
      this._performanceMetrics.lastFPS = 1000 / inferenceTime;
      this._lastDetectionTime = now;

      if (shouldLog) {
        console.log('ObjectDetectionService: Returning', finalDetections.length,
          'detections, inference:', inferenceTime.toFixed(0), 'ms,',
          this._performanceMetrics.lastFPS.toFixed(1), 'fps');
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
      return `${d.class} ${dir}, ${d.distance.toFixed(0)} meters`;
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
    const distance = detection.distance.toFixed(1);
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

  async _globalNMS(preds) {
    if (preds.length === 0) return [];
    const { maxDetections, nmsIoUThreshold, scoreThreshold } = this.config;
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

    const token = await AsyncStorage.getItem('authToken');
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
          this.currentDetectionSessionId = data.session?._id;
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
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          await fetch(`${this.apiBaseUrl}/api/ai/detection/stop`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ sessionId: this.currentDetectionSessionId }),
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
    const token = await AsyncStorage.getItem('authToken');
    if (!token) return;
    try {
      for (const obj of enriched.slice(0, 3)) {
        await fetch(`${this.apiBaseUrl}/api/ai/detection/object`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            sessionId: this.currentDetectionSessionId,
            className: obj.class,
            confidence: obj.confidence,
            distance: obj.distance,
            position: obj.position.relative,
            hazardLevel: obj.hazard.level,
          }),
        });
      }
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
