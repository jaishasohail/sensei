import * as tf from '@tensorflow/tfjs';
import HazardScoringService from './HazardScoringService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * ObjectDetectionService - Real-time object detection using TensorFlow.js with COCO-SSD
 * 
 * AI Model: COCO-SSD (Common Objects in Context - Single Shot MultiBox Detector)
 * - Pre-trained on 80 object classes from COCO dataset
 * - Optimized for mobile with WebGL backend
 * - Supports real-time detection at ~10-30 FPS on modern devices
 * 
 * Real-time Features:
 * - Frame-by-frame tensor processing from camera stream
 * - Object tracking with temporal smoothing (Exponential Moving Average)
 * - Non-Maximum Suppression (NMS) for duplicate removal
 * - Distance estimation using known object heights
 * - Hazard scoring for priority-based alerts
 */
class ObjectDetectionService {
  constructor() {
    this.model = null;
    this.isReady = false;
    this.cameraRef = null;
    this._poller = null;
    this.apiBaseUrl = API_BASE_URL;
    this.currentDetectionSessionId = null;
    
    // Real-time detection state
    this._isProcessing = false;
    this._frameSkipCount = 0;
    this._targetFPS = 15; // Target frames per second for detection
    this._lastDetectionTime = 0;
    this._minDetectionInterval = 1000 / 15; // ~66ms between detections
    
    // Performance metrics
    this._performanceMetrics = {
      avgInferenceTime: 0,
      framesProcessed: 0,
      droppedFrames: 0,
      lastFPS: 0,
    };
    
    this.config = {
      scoreThreshold: 0.4,
      maxDetections: 20,
      nmsIoUThreshold: 0.45,
      perClassNMS: true,
      smoothingFactor: 0.6, 
      trackMaxAgeMs: 1500,
      associationIoUThreshold: 0.3,
      enableRefinementPass: false, 
      horizontalFOV: 70,
      verticalFOV: 60,
      // Real-time streaming config
      adaptiveThreshold: true, // Auto-adjust threshold based on performance
      batchProcessing: false, // Process frames in batches for efficiency
      tensorPoolSize: 3, // Number of tensors to keep in memory pool
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
        // Extended object classes for better foot placement
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
    
    // Tensor memory pool for real-time processing
    this._tensorPool = [];
  }
  setConfig(partial) {
    this.config = { ...this.config, ...partial };
  }
  
  /**
   * Load the COCO-SSD model for real-time detection
   * Uses TensorFlow.js with WebGL backend for mobile optimization
   */
  async loadModel() {
    if (this.isReady && this.model) return this.model;
    try {
      await import('@tensorflow/tfjs-react-native');
      const coco = await import('@tensorflow-models/coco-ssd');
      await tf.ready();
      
      // Try to use the most performant backend available
      const backends = ['rn-webgl', 'webgl', 'cpu'];
      for (const backend of backends) {
        try {
          await tf.setBackend(backend);
          await tf.ready();
          console.log(`ObjectDetectionService: Using ${backend} backend`);
          break;
        } catch (e) {
          console.warn(`Failed to set ${backend} backend:`, e);
        }
      }
      
      // Load COCO-SSD model with mobile-optimized configuration
      this.model = await coco.load({
        base: 'lite_mobilenet_v2', // Faster model for real-time detection
      });
      
      this.isReady = true;
      console.log('ObjectDetectionService: coco-ssd model loaded with lite_mobilenet_v2');
      return this.model;
    } catch (error) {
      console.error('ObjectDetectionService loadModel error:', error);
      throw error;
    }
  }
  
  /**
   * Real-time detection from camera tensor stream
   * Optimized for frame-by-frame processing with temporal smoothing
   * @param {tf.Tensor} tensor - Input tensor from camera (3D: height x width x channels)
   * @param {number} textureWidth - Width of the camera texture
   * @param {number} textureHeight - Height of the camera texture
   * @returns {Array} Detected objects with tracking, distance, and hazard scoring
   */
  async detectFromTensor(tensor, textureWidth, textureHeight) {
    if (!this.isReady || !this.model) return [];
    
    // Real-time frame rate limiting
    const now = Date.now();
    if (now - this._lastDetectionTime < this._minDetectionInterval) {
      this._performanceMetrics.droppedFrames++;
      return [];
    }
    
    // Prevent concurrent processing
    if (this._isProcessing) {
      this._performanceMetrics.droppedFrames++;
      return [];
    }
    
    this._isProcessing = true;
    const startTime = performance.now();
    
    try {
      const predictions = await this.model.detect(tensor);
      const filtered = predictions.filter(p => (p.score ?? 0) >= this.config.scoreThreshold);
      const nmsSelected = this.config.perClassNMS
        ? this._perClassNMS(filtered)
        : this._globalNMS(filtered);
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
      
      // Update performance metrics
      const inferenceTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgInferenceTime = 
        (this._performanceMetrics.avgInferenceTime * (this._performanceMetrics.framesProcessed - 1) + inferenceTime) 
        / this._performanceMetrics.framesProcessed;
      this._performanceMetrics.lastFPS = 1000 / inferenceTime;
      this._lastDetectionTime = now;
      
      // Adaptive threshold adjustment based on performance
      if (this.config.adaptiveThreshold && inferenceTime > 150) {
        this.config.scoreThreshold = Math.min(0.6, this.config.scoreThreshold + 0.02);
      } else if (this.config.adaptiveThreshold && inferenceTime < 50) {
        this.config.scoreThreshold = Math.max(0.3, this.config.scoreThreshold - 0.01);
      }
      
      return enriched.slice(0, this.config.maxDetections);
    } catch (error) {
      console.error('detectFromTensor error:', error);
      return [];
    } finally {
      this._isProcessing = false;
    }
  }
  
  /**
   * Get current performance metrics for real-time monitoring
   */
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  /**
   * Set target FPS for real-time detection
   */
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
      const selected = this._globalNMS(predsLike).map(p => {
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
  _globalNMS(preds) {
    if (preds.length === 0) return [];
    const { maxDetections, nmsIoUThreshold, scoreThreshold } = this.config;
    const indices = tf.tidy(() => {
      const boxesT = tf.tensor2d(preds.map(p => p.bbox));
      const scoresT = tf.tensor1d(preds.map(p => p.score ?? 0));
      const sel = tf.image.nonMaxSuppression(boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold);
      return sel.arraySync();
    });
    return indices.map(i => preds[i]);
  }
  _perClassNMS(preds) {
    const byClass = new Map();
    preds.forEach(p => {
      const key = p.class || 'unknown';
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(p);
    });
    const selected = [];
    byClass.forEach(list => {
      const { maxDetections, nmsIoUThreshold, scoreThreshold } = this.config;
      const indices = tf.tidy(() => {
        const boxesT = tf.tensor2d(list.map(p => p.bbox));
        const scoresT = tf.tensor1d(list.map(p => p.score ?? 0));
        const sel = tf.image.nonMaxSuppression(boxesT, scoresT, maxDetections, nmsIoUThreshold, scoreThreshold);
        return sel.arraySync();
      });
      indices.forEach(i => selected.push(list[i]));
    });
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
        
        // Note: Direct camera frame capture requires TensorCamera integration
        // For now, detection should be handled via TensorCamera component in ARScreen
        // This polling loop is a fallback that will return empty detections
        // unless the model is properly integrated with live camera frames
        
        if (this.isReady && this.model && this.cameraRef && this.cameraRef.current) {
          // Camera ref exists but takePictureAsync is not compatible with new Expo Camera
          // Detection should be handled by handleCameraStream in ARScreen instead
          console.log('Camera ref available, but detection requires TensorCamera integration');
        }
        
        // Return empty detections - actual detection should use TensorCamera
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
      // For React Native with Expo, we need to use decodeJpeg
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
        confidence: 0.6,
        boundingBox: { x: 0.35, y: 0.25, width: 0.3, height: 0.5 },
        distance: 2.5,
        position: { relative: 'center', angle: 0 },
      },
    ];
  }
}
export default new ObjectDetectionService();
