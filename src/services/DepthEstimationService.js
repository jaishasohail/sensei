import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';

class DepthEstimationService {
  constructor() {
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
    
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 200;
    
    this._performanceMetrics = {
      avgProcessTime: 0,
      framesProcessed: 0,
      successfulEstimates: 0,
    };
    
    this._lastDepthMap = null;
    this._depthMapAge = 0;
    this._maxDepthMapAge = 500;
    
    this._zones = {
      critical: 0.5,
      near: 1.5,
      mid: 3.0,
      far: 10.0,
    };
    
    this._realtimeCallback = null;
    this._realtimeActive = false;
    
    this._knownObjectDepths = new Map();
  }
  
  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    console.log('DepthEstimationService: Initialized with real-time capabilities');
    return true;
  }
  
  startRealtimeDepth(callback, options = {}) {
    const { intervalMs = 200 } = options;
    this._minProcessInterval = intervalMs;
    this._realtimeCallback = callback;
    this._realtimeActive = true;
    console.log('DepthEstimationService: Real-time depth estimation started');
    return true;
  }
  
  stopRealtimeDepth() {
    this._realtimeActive = false;
    this._realtimeCallback = null;
    this._lastDepthMap = null;
    console.log('DepthEstimationService: Real-time depth estimation stopped');
  }
  
  async processFrame(imageBase64, detectedObjects = []) {
    const now = Date.now();
    
    if (now - this._lastProcessTime < this._minProcessInterval) {
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
      
      if (OfflineModeService.useCloud() && (await OfflineModeService.pingServer())) {
        result = await this.estimateDepthFromImage(imageBase64);
      } else {
        result = this._estimateDepthFromObjects(detectedObjects);
      }
      
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      if (result.nearest && result.nearest.distance < Infinity) {
        this._performanceMetrics.successfulEstimates++;
      }
      
      result.zones = this._analyzeZones(result, detectedObjects);
      
      this._lastDepthMap = result;
      this._depthMapAge = now;
      this._lastProcessTime = now;
      
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
  
  _estimateDepthFromObjects(detectedObjects) {
    if (!detectedObjects || detectedObjects.length === 0) {
      return { nearest: { distance: 5.0, x: 0.5, y: 0.5 }, mean: 5.0, isEstimated: true };
    }
    
    let nearestObj = detectedObjects[0];
    for (const obj of detectedObjects) {
      if (obj.distance < nearestObj.distance) {
        nearestObj = obj;
      }
    }
    
    const totalDistance = detectedObjects.reduce((sum, obj) => sum + obj.distance, 0);
    const meanDistance = totalDistance / detectedObjects.length;
    
    // Analyze surface characteristics from detection positions
    const surfaceAnalysis = this._analyzeSurface(detectedObjects);
    
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
      surface: surfaceAnalysis,
    };
  }
  
  _analyzeSurface(detectedObjects) {
    // Analyze ground-level objects for surface type hints
    const groundObjects = detectedObjects.filter(obj => 
      (obj.boundingBox.y + obj.boundingBox.height) > 0.6
    );
    
    // Check for stair-like patterns: multiple small horizontal objects at varying depths
    const potentialSteps = groundObjects.filter(obj => 
      obj.boundingBox.height < 0.15 && obj.boundingBox.width > 0.2
    );
    
    // Check depth variance among ground objects for uneven surface detection
    const groundDistances = groundObjects.map(obj => obj.distance);
    let depthVariance = 0;
    if (groundDistances.length > 1) {
      const mean = groundDistances.reduce((a, b) => a + b, 0) / groundDistances.length;
      depthVariance = groundDistances.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / groundDistances.length;
    }
    
    const hasStairPattern = potentialSteps.length >= 2;
    const hasUnevenSurface = depthVariance > 0.3;
    
    return {
      hasStairPattern,
      stepCount: potentialSteps.length,
      hasUnevenSurface,
      depthVariance,
      groundObjectCount: groundObjects.length,
      nearestGroundDistance: groundDistances.length > 0 ? Math.min(...groundDistances) : Infinity,
    };
  }
  
  _analyzeZones(depthResult, detectedObjects) {
    const zones = {
      critical: { hasObjects: false, objects: [], minDistance: Infinity },
      near: { hasObjects: false, objects: [], minDistance: Infinity },
      mid: { hasObjects: false, objects: [], minDistance: Infinity },
      far: { hasObjects: false, objects: [], minDistance: Infinity },
    };
    
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
  
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  setProcessInterval(intervalMs) {
    this._minProcessInterval = Math.max(100, Math.min(1000, intervalMs));
  }
  
  setZones(zones) {
    this._zones = { ...this._zones, ...zones };
  }
  
  getCachedDepthMap() {
    const now = Date.now();
    if (this._lastDepthMap && (now - this._depthMapAge) < this._maxDepthMapAge) {
      return this._lastDepthMap;
    }
    return null;
  }
  
  isRealtimeActive() {
    return this._realtimeActive;
  }
}
export default new DepthEstimationService();
