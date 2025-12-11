import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';

/**
 * DepthEstimationService - Real-time Monocular Depth Estimation
 * 
 * AI Model Strategy:
 * - Primary: MiDaS-style depth estimation via server API
 * - Fallback: Object-size based depth estimation (offline)
 * 
 * Real-time Features:
 * - Frame-rate controlled depth processing
 * - Depth map caching for performance
 * - Zone-based hazard detection (near/mid/far)
 * - Integration with ObjectDetection for enhanced accuracy
 */
class DepthEstimationService {
  constructor() {
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
    
    // Real-time state
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 200; // 5 FPS for depth estimation
    
    // Performance metrics
    this._performanceMetrics = {
      avgProcessTime: 0,
      framesProcessed: 0,
      successfulEstimates: 0,
    };
    
    // Depth map caching
    this._lastDepthMap = null;
    this._depthMapAge = 0;
    this._maxDepthMapAge = 500; // ms before requiring new depth map
    
    // Zone configuration
    this._zones = {
      critical: 0.5,  // 0-0.5m - immediate danger
      near: 1.5,      // 0.5-1.5m - close proximity
      mid: 3.0,       // 1.5-3m - walking distance
      far: 10.0,      // 3-10m - visible range
    };
    
    // Real-time callback
    this._realtimeCallback = null;
    this._realtimeActive = false;
    
    // Object-based depth calibration
    this._knownObjectDepths = new Map();
  }
  
  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    console.log('DepthEstimationService: Initialized with real-time capabilities');
    return true;
  }
  
  /**
   * Start real-time depth estimation
   * @param {Function} callback - Called with depth results
   * @param {Object} options - Configuration options
   */
  startRealtimeDepth(callback, options = {}) {
    const { intervalMs = 200 } = options;
    this._minProcessInterval = intervalMs;
    this._realtimeCallback = callback;
    this._realtimeActive = true;
    console.log('DepthEstimationService: Real-time depth estimation started');
    return true;
  }
  
  /**
   * Stop real-time depth estimation
   */
  stopRealtimeDepth() {
    this._realtimeActive = false;
    this._realtimeCallback = null;
    this._lastDepthMap = null;
    console.log('DepthEstimationService: Real-time depth estimation stopped');
  }
  
  /**
   * Process a frame for real-time depth estimation
   * @param {string} imageBase64 - Base64 encoded image from camera
   * @param {Array} detectedObjects - Optional detected objects for enhanced depth
   * @returns {Object} Depth estimation result
   */
  async processFrame(imageBase64, detectedObjects = []) {
    const now = Date.now();
    
    // Rate limiting
    if (now - this._lastProcessTime < this._minProcessInterval) {
      // Return cached depth map if still valid
      if (this._lastDepthMap && (now - this._depthMapAge) < this._maxDepthMapAge) {
        return this._lastDepthMap;
      }
      return null;
    }
    
    if (this._isProcessing) {
      return this._lastDepthMap;
    }
    
    this._isProcessing = true;
    const startTime = performance.now();
    
    try {
      let result;
      
      // Try server-based depth estimation first
      if (OfflineModeService.useCloud() && (await OfflineModeService.pingServer())) {
        result = await this.estimateDepthFromImage(imageBase64);
      } else {
        // Fallback to object-based depth estimation
        result = this._estimateDepthFromObjects(detectedObjects);
      }
      
      // Update performance metrics
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      if (result.nearest && result.nearest.distance < Infinity) {
        this._performanceMetrics.successfulEstimates++;
      }
      
      // Analyze zones
      result.zones = this._analyzeZones(result, detectedObjects);
      
      // Cache the result
      this._lastDepthMap = result;
      this._depthMapAge = now;
      this._lastProcessTime = now;
      
      // Trigger callback if active
      if (this._realtimeActive && this._realtimeCallback) {
        this._realtimeCallback(result);
      }
      
      return result;
    } catch (error) {
      console.error('DepthEstimationService processFrame error:', error);
      return this._lastDepthMap || { nearest: { distance: Infinity, x: 0, y: 0 }, mean: Infinity };
    } finally {
      this._isProcessing = false;
    }
  }
  
  /**
   * Estimate depth using object detection results (offline fallback)
   */
  _estimateDepthFromObjects(detectedObjects) {
    if (!detectedObjects || detectedObjects.length === 0) {
      return { nearest: { distance: 5.0, x: 0.5, y: 0.5 }, mean: 5.0, isEstimated: true };
    }
    
    // Find nearest object
    let nearestObj = detectedObjects[0];
    for (const obj of detectedObjects) {
      if (obj.distance < nearestObj.distance) {
        nearestObj = obj;
      }
    }
    
    // Calculate mean distance
    const totalDistance = detectedObjects.reduce((sum, obj) => sum + obj.distance, 0);
    const meanDistance = totalDistance / detectedObjects.length;
    
    return {
      nearest: {
        distance: nearestObj.distance,
        x: nearestObj.boundingBox.x + nearestObj.boundingBox.width / 2,
        y: nearestObj.boundingBox.y + nearestObj.boundingBox.height / 2,
        object: nearestObj.class,
      },
      mean: meanDistance,
      isEstimated: true,
      objectCount: detectedObjects.length,
    };
  }
  
  /**
   * Analyze depth zones for hazard detection
   */
  _analyzeZones(depthResult, detectedObjects) {
    const zones = {
      critical: { hasObjects: false, objects: [], minDistance: Infinity },
      near: { hasObjects: false, objects: [], minDistance: Infinity },
      mid: { hasObjects: false, objects: [], minDistance: Infinity },
      far: { hasObjects: false, objects: [], minDistance: Infinity },
    };
    
    // Categorize objects by zone
    for (const obj of detectedObjects) {
      const distance = obj.distance;
      let zone;
      
      if (distance < this._zones.critical) {
        zone = 'critical';
      } else if (distance < this._zones.near) {
        zone = 'near';
      } else if (distance < this._zones.mid) {
        zone = 'mid';
      } else {
        zone = 'far';
      }
      
      zones[zone].hasObjects = true;
      zones[zone].objects.push(obj);
      if (distance < zones[zone].minDistance) {
        zones[zone].minDistance = distance;
      }
    }
    
    return zones;
  }

  async estimateDepthFromImage(imageBase64) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const res = await fetch(`${this.apiBaseUrl}/api/ai/depth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageBase64 }),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (res.ok) {
        const data = await res.json();
        return {
          nearest: data.nearest || { distance: 2.0, x: 0.0, y: 0.0 },
          mean: data.mean || 3.5,
          depthMap: data.depthMap || null,
          isServerEstimate: true,
        };
      }
      
      return { nearest: { distance: 2.0, x: 0.0, y: 0.0 }, mean: 3.5, isEstimated: true };
    } catch (e) {
      console.warn('DepthEstimationService: API failed, using fallback', e);
      return { nearest: { distance: Infinity, x: 0, y: 0 }, mean: Infinity, isEstimated: true };
    }
  }
  
  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  /**
   * Set processing interval
   */
  setProcessInterval(intervalMs) {
    this._minProcessInterval = Math.max(100, Math.min(1000, intervalMs));
  }
  
  /**
   * Configure depth zones
   */
  setZones(zones) {
    this._zones = { ...this._zones, ...zones };
  }
  
  /**
   * Get the cached depth map if available
   */
  getCachedDepthMap() {
    const now = Date.now();
    if (this._lastDepthMap && (now - this._depthMapAge) < this._maxDepthMapAge) {
      return this._lastDepthMap;
    }
    return null;
  }
  
  /**
   * Check if real-time depth estimation is active
   */
  isRealtimeActive() {
    return this._realtimeActive;
  }
}
export default new DepthEstimationService();
