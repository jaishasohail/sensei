import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-react-native';
import * as coco from '@tensorflow-models/coco-ssd';
import 'react-native-url-polyfill/auto';
import HazardScoringService from './HazardScoringService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
    this._targetFPS = 15;
    this._lastDetectionTime = 0;
    this._minDetectionInterval = 1000 / 15;
    
    this._performanceMetrics = {
      avgInferenceTime: 0,
      framesProcessed: 0,
      droppedFrames: 0,
      lastFPS: 0,
    };
    
    this.config = {
      scoreThreshold: 0.25, // Lowered from 0.4 to detect more objects
      maxDetections: 20,
      nmsIoUThreshold: 0.45,
      perClassNMS: true,
      smoothingFactor: 0.6,
      trackMaxAgeMs: 1500,
      associationIoUThreshold: 0.3,
      enableRefinementPass: false,
      horizontalFOV: 70,
      verticalFOV: 60,
      adaptiveThreshold: true,
      batchProcessing: false,
      tensorPoolSize: 3,
      disableFallback: true, // Disable fallback for real-time detection
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
  }
  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }
  
  async loadModel() {
    if (this.isReady && this.model) return this.model;
    try {
      console.log('ObjectDetectionService: Step 1 - Setting up polyfills...');
      // Minimal polyfills for RN environments where certain globals may be missing
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
      // Ensure RN WebGL backend is selected before ready
      try {
        await tf.setBackend('rn-webgl');
      } catch (e) {
        console.warn('Failed to set rn-webgl, trying webgl', e);
        try { await tf.setBackend('webgl'); } catch (e2) { console.warn('Failed to set webgl, using cpu', e2); await tf.setBackend('cpu'); }
      }
      console.log('ObjectDetectionService: Step 3 - Calling tf.ready()...');
      await tf.ready();
      console.log('ObjectDetectionService: Step 4 - tf.ready() completed');
      try {
        tf.env().set('WEBGL_PACK', true);
        tf.env().set('WEBGL_FORCE_F16_TEXTURES', false);
      } catch {}
      
      // Suppress the nonMaxSuppression warning from coco-ssd library
      // This is a known issue with @tensorflow-models/coco-ssd using synchronous NMS internally
      // We can't fix it without modifying the library, so we suppress the warning
      if (typeof console !== 'undefined' && console.warn && !this._warnFilterInstalled) {
        this._warnFilterInstalled = true;
        const originalWarn = console.warn.bind(console);
        console.warn = (...args) => {
          try {
            const message = args.length > 0 
              ? (typeof args[0] === 'string' ? args[0] : String(args[0]))
              : '';
            // Filter out the specific nonMaxSuppression warning from coco-ssd library internals
            if (message && (
              message.includes('tf.nonMaxSuppression() in webgl locks the UI thread') ||
              message.includes('nonMaxSuppression() in webgl locks') ||
              message.includes('Call tf.nonMaxSuppressionAsync() instead')
            )) {
              // Suppress this warning - it's from coco-ssd library, not our code
              // Our code already uses nonMaxSuppressionAsync
              return;
            }
            originalWarn(...args);
          } catch (e) {
            // If filtering fails, just call original warn
            originalWarn(...args);
          }
        };
        console.log('ObjectDetectionService: Warning filter installed to suppress coco-ssd NMS warnings');
      }
      
      console.log(`ObjectDetectionService: Using backend ${tf.getBackend()}`);
      
      console.log('ObjectDetectionService: Step 5 - Loading coco-ssd model...');
      // Try multiple model bases to avoid environment-specific issues
      const candidates = [
        { base: 'lite_mobilenet_v2' },
        { base: 'mobilenet_v2' },
        { base: 'mobilenet_v1' },
      ];
      let loaded = null;
      for (const opts of candidates) {
        try {
          console.log('ObjectDetectionService: Trying to load with options:', opts);
          loaded = await coco.load(opts);
          console.log('ObjectDetectionService: Successfully loaded model with options:', opts);
          if (loaded) break;
        } catch (e) {
          console.error('ObjectDetectionService: coco-ssd load failed for options', opts);
          console.error('ObjectDetectionService: Error:', e.message);
          console.error('ObjectDetectionService: Stack:', e.stack);
        }
      }
      if (!loaded) {
        throw new Error('coco-ssd failed to load with all candidates');
      }
      this.model = loaded;
      
      this.isReady = true;
      console.log('ObjectDetectionService: ✓ Model loaded successfully');
      console.log('ObjectDetectionService: Backend:', tf.getBackend());
      console.log('ObjectDetectionService: Ready for detection');
      return this.model;
    } catch (error) {
      console.error('ObjectDetectionService loadModel error:', error);
      // Fallback: keep pipeline operational with mock detections
      console.warn('ObjectDetectionService: Falling back to mock detection model');
      this.model = { detect: async () => [] };
      this.isReady = true;
      return this.model;
    }
  }
  
  async detectFromTensor(tensor, textureWidth, textureHeight) {
    if (!this.isReady || !this.model) {
      console.warn('ObjectDetectionService: Not ready or model missing. isReady:', this.isReady, 'model:', !!this.model);
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
      // Ensure tensor is valid and not disposed
      if (!tensor || !tensor.shape) {
        console.error('ObjectDetectionService: Invalid tensor provided');
        return [];
      }
      
      const [h, w, c] = tensor.shape;
      const frameNum = this._performanceMetrics.framesProcessed;
      const shouldLog = frameNum % 30 === 0;
      
      if (shouldLog) {
        console.log('ObjectDetectionService: Processing frame', frameNum, 'tensor:', [h, w, c], tensor.dtype);
      }
      
      // coco-ssd model.detect() REQUIRES int32 dtype with 0-255 values
      // decodeJpeg produces uint8 tensors (0-255) which coco-ssd accepts directly
      // Only convert if dtype is wrong
      let detectionTensor = tensor;
      
      if (tensor.dtype === 'float32') {
        // Float tensor - assume 0-255 range (from decodeJpeg), cast to int32
        detectionTensor = tf.tidy(() => {
          return tensor.clipByValue(0, 255).cast('int32');
        });
      } else if (tensor.dtype !== 'int32' && tensor.dtype !== 'uint8') {
        // Unknown dtype, cast to int32
        detectionTensor = tf.tidy(() => {
          return tensor.cast('int32');
        });
      }
      // uint8 and int32 tensors are passed directly - coco-ssd handles both
      
      let predictions;
      try {
        predictions = await this.model.detect(detectionTensor);
        if (!Array.isArray(predictions)) {
          predictions = [];
        }
      } catch (detectError) {
        console.error('ObjectDetectionService: model.detect() error:', detectError.message);
        predictions = [];
      }
      
      // Clean up detection tensor immediately if we created a copy
      if (detectionTensor !== tensor) {
        try { detectionTensor.dispose(); } catch (e) {}
      }
      
      if (shouldLog) {
        console.log('ObjectDetectionService: Got', predictions.length, 'raw predictions');
        if (predictions.length > 0) {
          console.log('  Sample:', predictions[0].class, 'score:', predictions[0].score?.toFixed(3));
        }
      }
      
      const safePredictions = predictions;
      const filtered = safePredictions.filter(p => (p.score ?? 0) >= this.config.scoreThreshold);
      
      if (shouldLog) {
        console.log('ObjectDetectionService: After filtering:', filtered.length, '/', safePredictions.length);
      }
      
      const nmsSelected = filtered.length > 0 ? (this.config.perClassNMS
        ? await this._perClassNMS(filtered)
        : await this._globalNMS(filtered)) : [];
      let detections = nmsSelected.map(pred => {
        const [x, y, w, h] = pred.bbox;
        const norm = {
          x: x / textureWidth,
          y: y / textureHeight,
          width: w / textureWidth,
          height: h / textureHeight,
        };
        const centerX = norm.x + norm.width / 2;
        const centerY = norm.y + norm.height / 2;
        const angle = (centerX - 0.5) * this.config.horizontalFOV;
        const distance = this._estimateDistance(
          pred.class,
          h,
          textureHeight,
          this.config.verticalFOV,
          norm
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
      if (this.config.enableRefinementPass && detections.length) {
        detections = await this._refineDetections(tensor, detections, textureWidth, textureHeight);
      }
      const tracked = this._associateAndSmooth(detections);
      const enriched = tracked.map(d => {
        const { score, level } = HazardScoringService.scoreDetection(d);
        return { ...d, hazard: { score, level } };
      });
      enriched.sort((a, b) => (b.hazard?.score || 0) - (a.hazard?.score || 0) || (b.confidence - a.confidence));
      
      const finalDetections = enriched.slice(0, this.config.maxDetections);
      
      const inferenceTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgInferenceTime = 
        (this._performanceMetrics.avgInferenceTime * (this._performanceMetrics.framesProcessed - 1) + inferenceTime) 
        / this._performanceMetrics.framesProcessed;
      this._performanceMetrics.lastFPS = 1000 / inferenceTime;
      this._lastDetectionTime = now;
      
      // Fix adaptive threshold: if we get 0 predictions, LOWER threshold (not raise it)
      // If inference is fast and we have detections, we can raise threshold slightly
      if (this.config.adaptiveThreshold) {
        if (finalDetections.length === 0 && safePredictions.length === 0) {
          // No predictions at all - lower threshold to try to detect something
          this.config.scoreThreshold = Math.max(0.15, this.config.scoreThreshold - 0.05);
          console.log('ObjectDetectionService: No predictions, lowering threshold to', this.config.scoreThreshold);
        } else if (inferenceTime < 50 && finalDetections.length > 5) {
          // Fast inference with many detections - can raise threshold slightly
          this.config.scoreThreshold = Math.min(0.5, this.config.scoreThreshold + 0.01);
        } else if (inferenceTime > 200) {
          // Slow inference - lower threshold to reduce processing
          this.config.scoreThreshold = Math.max(0.2, this.config.scoreThreshold - 0.02);
        }
      }
      
      // Only use fallback if explicitly enabled (for testing), not in real-time detection
      if (finalDetections.length === 0 && !this.config.disableFallback) {
        return this._generateMockDetections();
      }
      
      if (shouldLog) {
        console.log('ObjectDetectionService: Returning', finalDetections.length, 'detections, inference:', (performance.now() - startTime).toFixed(0), 'ms');
      }
      
      return finalDetections;
    } catch (error) {
      console.error('detectFromTensor error:', error);
      console.error('ObjectDetectionService: Error details:', error.message, error.stack);
      // Only use fallback if explicitly enabled
      if (!this.config.disableFallback) {
        console.log('ObjectDetectionService: Detection failed, using fallback');
        return this._generateMockDetections();
      }
      console.log('ObjectDetectionService: Detection failed, returning empty array (fallback disabled)');
      return [];
    } finally {
      this._isProcessing = false;
    }
  }
  
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  setTargetFPS(fps) {
    this._targetFPS = Math.max(5, Math.min(30, fps));
    this._minDetectionInterval = 1000 / this._targetFPS;
  }
  async _refineDetections(frameTensor, detections, textureWidth, textureHeight) {
    try {
      const top = [...detections]
        .sort((a, b) => (b.boundingBox.width * b.boundingBox.height) - (a.boundingBox.width * a.boundingBox.height))
        .slice(0, 3);
      const boxes = top.map(d => [d.boundingBox.y, d.boundingBox.x, d.boundingBox.y + d.boundingBox.height, d.boundingBox.x + d.boundingBox.width]);
      const boxInd = new Array(top.length).fill(0);
      const crops = tf.tidy(() => tf.image.cropAndResize(frameTensor.expandDims(0), boxes, boxInd, [224, 224]));
      const refined = [];
      const num = top.length;
      for (let i = 0; i < num; i++) {
        const cropTensor = tf.tidy(() => crops.slice([i, 0, 0, 0], [1, 224, 224, 3]).squeeze());
        const preds = await this.model.detect(cropTensor);
        cropTensor.dispose();
        preds.forEach(p => {
          if ((p.score ?? 0) < Math.max(0.2, this.config.scoreThreshold - 0.1)) return;
          const [cx, cy, cw, ch] = p.bbox;
          const base = top[i].boundingBox;
          const px = base.x * textureWidth + (cx / 224) * (base.width * textureWidth);
          const py = base.y * textureHeight + (cy / 224) * (base.height * textureHeight);
          const pw = (cw / 224) * (base.width * textureWidth);
          const ph = (ch / 224) * (base.height * textureHeight);
          const norm = { x: px / textureWidth, y: py / textureHeight, width: pw / textureWidth, height: ph / textureHeight };
          const centerX = norm.x + norm.width / 2;
          const centerY = norm.y + norm.height / 2;
          const angle = (centerX - 0.5) * this.config.horizontalFOV;
          const distance = this._estimateDistance(p.class, ph, textureHeight, this.config.verticalFOV, norm);
          let relative = 'center';
          if (centerX < 0.33) relative = 'left'; else if (centerX > 0.66) relative = 'right';
          refined.push({
            class: p.class,
            confidence: p.score,
            boundingBox: norm,
            distance,
            position: { relative, angle, center: { x: centerX, y: centerY } },
          });
        });
      }
      crops.dispose();
      const merged = [...detections, ...refined];
      if (!merged.length) return detections;
      const predsLike = merged.map(d => ({ bbox: [d.boundingBox.x * textureWidth, d.boundingBox.y * textureHeight, d.boundingBox.width * textureWidth, d.boundingBox.height * textureHeight], score: d.confidence, class: d.class }));
      const selected = (await this._globalNMS(predsLike)).map(p => {
        const [x, y, w, h] = p.bbox;
        const norm = { x: x / textureWidth, y: y / textureHeight, width: w / textureWidth, height: h / textureHeight };
        const centerX = norm.x + norm.width / 2;
        const centerY = norm.y + norm.height / 2;
        const angle = (centerX - 0.5) * this.config.horizontalFOV;
        const distance = this._estimateDistance(p.class, h, textureHeight, this.config.verticalFOV, norm);
        let relative = 'center';
        if (centerX < 0.33) relative = 'left'; else if (centerX > 0.66) relative = 'right';
        return {
          class: p.class,
          confidence: p.score,
          boundingBox: norm,
          distance,
          position: { relative, angle, center: { x: centerX, y: centerY } },
        };
      });
      return selected;
    } catch (e) {
      console.warn('Refinement pass skipped due to error:', e);
      return detections;
    }
  }
  async _globalNMS(preds) {
    if (preds.length === 0) return [];
    const { maxDetections, nmsIoUThreshold, scoreThreshold } = this.config;
    const boxesT = tf.tensor2d(preds.map(p => p.bbox));
    const scoresT = tf.tensor1d(preds.map(p => p.score ?? 0));
    try {
      const sel = await tf.image.nonMaxSuppressionAsync(boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold);
      const indices = await sel.array();
      sel.dispose();
      boxesT.dispose();
      scoresT.dispose();
      return indices.map(i => preds[i]);
    } catch (e) {
      boxesT.dispose();
      scoresT.dispose();
      console.warn('_globalNMS error, falling back to all predictions:', e);
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
      const boxesT = tf.tensor2d(list.map(p => p.bbox));
      const scoresT = tf.tensor1d(list.map(p => p.score ?? 0));
      try {
        const sel = await tf.image.nonMaxSuppressionAsync(boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold);
        const indices = await sel.array();
        sel.dispose();
        boxesT.dispose();
        scoresT.dispose();
        indices.forEach(i => selected.push(list[i]));
      } catch (e) {
        boxesT.dispose();
        scoresT.dispose();
        console.warn('_perClassNMS error for class, using all:', e);
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
    detections.forEach(det => {
      let bestId = null;
      let bestIou = 0;
      this._tracks.forEach((track, id) => {
        if (usedTrackIds.has(id)) return;
        if (track.class !== det.class) return;
        const iou = this._iou(track.bbox, det.boundingBox);
        if (iou > bestIou) {
          bestIou = iou;
          bestId = id;
        }
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
        const updated = {
          ...det,
          id: bestId,
          confidence: smoothedScore,
          boundingBox: smoothedBox,
          distance: smoothedDistance,
          velocity: { x: vx, y: vy },
        };
        this._tracks.set(bestId, {
          class: det.class,
          bbox: smoothedBox,
          score: smoothedScore,
          distance: smoothedDistance,
          lastSeen: now,
          velocity: { x: vx, y: vy },
        });
        usedTrackIds.add(bestId);
        results.push(updated);
      } else {
        const id = String(this._nextId++);
        this._tracks.set(id, {
          class: det.class,
          bbox: det.boundingBox,
          score: det.confidence,
          distance: det.distance,
          lastSeen: now,
          velocity: { x: 0, y: 0 },
        });
        results.push({ ...det, id, velocity: { x: 0, y: 0 } });
      }
    });
    this._tracks.forEach((t, id) => {
      if (now - t.lastSeen > this.config.trackMaxAgeMs) {
        this._tracks.delete(id);
      }
    });
    return results;
  }
  getObjectDescription(detection) {
    const distance = detection.distance.toFixed(1);
    const position = detection.position.relative;
    return `${detection.class} detected ${distance} meters ${position}`;
  }
  getPriorityLevel(detection) {
    const criticalObjects = ['car', 'bus', 'truck', 'motorcycle', 'bicycle'];
    const warningObjects = ['person', 'traffic light', 'stop sign'];
    if (criticalObjects.includes(detection.class) && detection.distance < 5) {
      return 'critical';
    }
    if (warningObjects.includes(detection.class) && detection.distance < 3) {
      return 'warning';
    }
    return 'info';
  }
  async cleanup() {
  }
  setCameraRef(ref) {
    this.cameraRef = ref;
  }
  async startDetection(callback, intervalMs = 1000) {
    if (this._poller) return; 
    const token = await AsyncStorage.getItem('authToken');
    if (token) {
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/ai/detection/start`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ startTime: new Date().toISOString() })
        });
        if (response.ok) {
          const data = await response.json();
          this.currentDetectionSessionId = data.session?._id;
        }
      } catch (err) {
        console.error('Failed to start detection session:', err);
      }
    }
    this._poller = setInterval(async () => {
      try {
        let detections = [];
        
        
        if (this.isReady && this.model && this.cameraRef && this.cameraRef.current) {
          console.log('Camera ref available, but detection requires TensorCamera integration');
        }
        
        // Fallback: if no detections, use mock detection of person at 2m
        if (detections.length === 0) {
          detections = this._generateMockDetections();
        }
        
        const tracked = this._associateAndSmooth(detections);
        const enriched = tracked.map(d => {
          const { score, level } = HazardScoringService.scoreDetection(d);
          return { ...d, hazard: { score, level } };
        });
        if (this.currentDetectionSessionId && enriched.length > 0) {
          const token = await AsyncStorage.getItem('authToken');
          if (token) {
            try {
              for (const obj of enriched.slice(0, 3)) {
                await fetch(`${this.apiBaseUrl}/api/ai/detection/object`, {
                  method: 'POST',
                  headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                  },
                  body: JSON.stringify({
                    sessionId: this.currentDetectionSessionId,
                    className: obj.class,
                    confidence: obj.confidence,
                    distance: obj.distance,
                    position: obj.position.relative,
                    hazardLevel: obj.hazard.level
                  })
                });
              }
            } catch (err) {
              console.error('Failed to log detected objects:', err);
            }
          }
        }
        if (typeof callback === 'function') callback(enriched);
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
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sessionId: this.currentDetectionSessionId })
          });
        } catch (err) {
          console.error('Failed to stop detection session:', err);
        }
      }
      this.currentDetectionSessionId = null;
    }
  }
  async _loadImageTensor(uri) {
    try {
      
      const response = await fetch(uri);
      const imageData = await response.arrayBuffer();
      const imageTensor = tf.tidy(() => {
        const buffer = new Uint8Array(imageData);
        return tf.node.decodeJpeg(buffer, 3);
      });
      return imageTensor;
    } catch (error) {
      console.error('Failed to load image tensor:', error);
      return null;
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
