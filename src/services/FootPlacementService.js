import { Vibration } from 'react-native';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';

/**
 * FootPlacementService - Real-time Foot Placement Guidance
 * 
 * AI Integration:
 * - Uses ObjectDetectionService detections for ground obstacle awareness
 * - Integrates with DepthEstimationService for surface depth analysis
 * - Provides haptic and audio feedback for safe foot placement
 * 
 * Real-time Features:
 * - Continuous ground obstacle monitoring
 * - Path zone analysis (left/center/right)
 * - Stair and uneven surface detection
 * - Adaptive warning frequency based on hazard proximity
 * - Haptic feedback patterns for direction guidance
 */
class FootPlacementService {
  constructor() {
    this.isActive = false;
    this.detectionInterval = null;
    this.groundObstacles = [];
    this.surfaceTypes = ['concrete', 'grass', 'gravel', 'stairs', 'uneven', 'wet'];
    this.safetyZone = 1.5; 
    this.lastWarningTime = 0;
    this.warningCooldown = 2000;
    
    // Real-time processing state
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 100; // 10 FPS for foot placement
    
    // Real-time callback
    this._realtimeCallback = null;
    
    // Performance metrics
    this._performanceMetrics = {
      framesProcessed: 0,
      warningsIssued: 0,
      avgProcessTime: 0,
    };
    
    // Path history for trajectory prediction
    this._pathHistory = [];
    this._maxPathHistory = 10;
    
    // Adaptive warning system
    this._warningCooldowns = {
      critical: 500,   // 0.5s between critical warnings
      high: 1000,      // 1s between high warnings
      medium: 2000,    // 2s between medium warnings
      low: 5000,       // 5s between low warnings
    };
    this._lastWarningByLevel = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    
    // Ground level detection config
    this._groundLevelThreshold = 0.4; // Objects below this Y position are at ground level
    this._footpathWidth = 1.2; // Estimated width of user's walking path in meters
  }
  
  /**
   * Start real-time foot placement monitoring
   * @param {Array} detectedObjects - Initial detected objects
   * @param {Function} callback - Real-time status callback
   */
  async startMonitoring(detectedObjects, callback) {
    try {
      this.isActive = true;
      this._realtimeCallback = callback;
      
      // Initial analysis
      this.analyzeFootPath(detectedObjects);
      
      if (callback) {
        callback({ 
          status: 'active', 
          obstacles: this.groundObstacles,
          warnings: this.generateWarnings(),
          safeDirection: this._getSafeDirection(),
        });
      }
      
      await TextToSpeechService.speak('Foot placement monitoring active');
      return true;
    } catch (error) {
      console.error('Foot placement monitoring error:', error);
      return false;
    }
  }
  
  /**
   * Process a frame for real-time foot placement analysis
   * @param {Array} detectedObjects - Detected objects from ObjectDetectionService
   * @param {Object} depthData - Optional depth data from DepthEstimationService
   * @returns {Object} Foot placement analysis result
   */
  async processFrame(detectedObjects, depthData = null) {
    if (!this.isActive) return null;
    
    const now = Date.now();
    
    // Rate limiting
    if (now - this._lastProcessTime < this._minProcessInterval) {
      return null;
    }
    
    if (this._isProcessing) {
      return null;
    }
    
    this._isProcessing = true;
    const startTime = performance.now();
    
    try {
      // Analyze foot path with detected objects
      this.analyzeFootPath(detectedObjects);
      
      // Enhance with depth data if available
      if (depthData && depthData.zones) {
        this._enhanceWithDepthData(depthData);
      }
      
      // Check for stairs
      const stairInfo = this.detectStairs(detectedObjects);
      
      // Check for uneven surface
      const surfaceInfo = this.detectUnevenSurface(detectedObjects);
      
      // Generate warnings
      const warnings = this.generateWarnings();
      
      // Check and issue warnings with adaptive cooldown
      await this._checkAndWarnWithAdaptiveCooldown();
      
      // Update path history for trajectory prediction
      this._updatePathHistory(detectedObjects);
      
      // Update performance metrics
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      this._lastProcessTime = now;
      
      // Build result
      const result = {
        status: 'active',
        obstacles: this.groundObstacles,
        warnings,
        stairs: stairInfo,
        surface: surfaceInfo,
        safeDirection: this._getSafeDirection(),
        pathRecommendation: this.getSafePathRecommendation(detectedObjects),
      };
      
      // Trigger callback if set
      if (this._realtimeCallback) {
        this._realtimeCallback(result);
      }
      
      return result;
    } catch (error) {
      console.error('FootPlacementService processFrame error:', error);
      return null;
    } finally {
      this._isProcessing = false;
    }
  }
  
  stopMonitoring() {
    this.isActive = false;
    this.groundObstacles = [];
    this._realtimeCallback = null;
    this._pathHistory = [];
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
  }
  
  analyzeFootPath(detectedObjects) {
    if (!detectedObjects || detectedObjects.length === 0) {
      this.groundObstacles = [];
      return;
    }
    this.groundObstacles = detectedObjects
      .filter(obj => {
        // Enhanced ground level detection
        const isGroundLevel = obj.boundingBox.y + obj.boundingBox.height > this._groundLevelThreshold;
        const isCloseEnough = obj.distance < this.safetyZone * 2;
        const obstacleTypes = [
          'person', 'bicycle', 'car', 'motorcycle', 'bench', 
          'chair', 'suitcase', 'backpack', 'sports ball',
          'fire hydrant', 'parking meter', 'potted plant', 'skateboard',
          'umbrella', 'handbag', 'bottle', 'cup', 'dog', 'cat'
        ];
        const isObstacle = obstacleTypes.some(type => 
          obj.class.toLowerCase().includes(type)
        );
        return isGroundLevel && isCloseEnough && isObstacle;
      })
      .map(obj => ({
        ...obj,
        hazardLevel: this.calculateHazardLevel(obj),
        surfaceType: this.detectSurfaceType(obj),
        inFootpath: this._isInFootpath(obj),
        predictedCollisionTime: this._predictCollisionTime(obj),
      }))
      .sort((a, b) => a.distance - b.distance); // Sort by distance
  }
  
  /**
   * Check if an obstacle is in the user's walking path
   */
  _isInFootpath(obstacle) {
    const centerX = obstacle.boundingBox.x + obstacle.boundingBox.width / 2;
    // Center of screen (0.35 - 0.65) is considered the footpath
    return centerX > 0.35 && centerX < 0.65;
  }
  
  /**
   * Predict time to collision based on approach rate
   */
  _predictCollisionTime(obstacle) {
    // If we have history, calculate approach rate
    if (this._pathHistory.length > 1) {
      const prevFrame = this._pathHistory[this._pathHistory.length - 2];
      const prevObstacle = prevFrame.find(o => o.class === obstacle.class);
      
      if (prevObstacle) {
        const distanceDelta = prevObstacle.distance - obstacle.distance;
        if (distanceDelta > 0) {
          // Approaching - estimate time to collision
          const approachRate = distanceDelta / (this._minProcessInterval / 1000);
          return obstacle.distance / approachRate;
        }
      }
    }
    
    // Default: assume 1 m/s walking speed
    return obstacle.distance / 1.0;
  }
  
  /**
   * Update path history for trajectory prediction
   */
  _updatePathHistory(detectedObjects) {
    this._pathHistory.push(
      detectedObjects.map(o => ({ class: o.class, distance: o.distance }))
    );
    
    if (this._pathHistory.length > this._maxPathHistory) {
      this._pathHistory.shift();
    }
  }
  
  /**
   * Enhance analysis with depth data
   */
  _enhanceWithDepthData(depthData) {
    if (depthData.zones?.critical?.hasObjects) {
      // Mark all obstacles as critical if depth shows objects very close
      this.groundObstacles.forEach(obs => {
        if (obs.distance < depthData.zones.critical.minDistance * 1.2) {
          obs.hazardLevel = 'critical';
        }
      });
    }
  }
  
  /**
   * Get the safest direction to move
   */
  _getSafeDirection() {
    const zones = {
      left: { count: 0, minDistance: Infinity },
      center: { count: 0, minDistance: Infinity },
      right: { count: 0, minDistance: Infinity },
    };
    
    this.groundObstacles.forEach(obj => {
      const direction = obj.position.relative;
      zones[direction].count++;
      if (obj.distance < zones[direction].minDistance) {
        zones[direction].minDistance = obj.distance;
      }
    });
    
    // Find safest zone (fewest obstacles, furthest minimum distance)
    let safest = 'center';
    let bestScore = -Infinity;
    
    for (const [dir, data] of Object.entries(zones)) {
      const score = (data.count === 0 ? 10 : 0) + (data.minDistance === Infinity ? 5 : data.minDistance);
      if (score > bestScore) {
        bestScore = score;
        safest = dir;
      }
    }
    
    return safest;
  }
  
  calculateHazardLevel(obstacle) {
    const distance = obstacle.distance;
    const inPath = this._isInFootpath(obstacle);
    
    // Adjust thresholds if obstacle is directly in path
    const criticalThreshold = inPath ? 0.7 : 0.5;
    const highThreshold = inPath ? 1.2 : 1.0;
    const mediumThreshold = inPath ? this.safetyZone + 0.5 : this.safetyZone;
    
    if (distance < criticalThreshold) return 'critical';
    if (distance < highThreshold) return 'high';
    if (distance < mediumThreshold) return 'medium';
    return 'low';
  }
  
  detectSurfaceType(obstacle) {
    if (obstacle.class.includes('bench') || obstacle.class.includes('chair')) {
      return 'elevated';
    }
    if (obstacle.class.includes('skateboard')) {
      return 'rolling_hazard';
    }
    if (obstacle.class.includes('bottle') || obstacle.class.includes('cup')) {
      return 'trip_hazard';
    }
    return 'concrete';
  }
  
  /**
   * Adaptive warning system with per-level cooldowns
   */
  async _checkAndWarnWithAdaptiveCooldown() {
    const now = Date.now();
    
    // Get highest priority obstacle
    const criticalObstacles = this.groundObstacles
      .filter(obj => obj.hazardLevel === 'critical' || obj.hazardLevel === 'high')
      .sort((a, b) => a.distance - b.distance);
    
    if (criticalObstacles.length === 0) return;
    
    const obstacle = criticalObstacles[0];
    const level = obstacle.hazardLevel;
    const cooldown = this._warningCooldowns[level] || 2000;
    
    if (now - this._lastWarningByLevel[level] >= cooldown) {
      await this.issueWarning(obstacle);
      this._lastWarningByLevel[level] = now;
      this._performanceMetrics.warningsIssued++;
    }
  }
  
  async checkAndWarnObstacles() {
    const now = Date.now();
    if (now - this.lastWarningTime < this.warningCooldown) {
      return;
    }
    const criticalObstacles = this.groundObstacles
      .filter(obj => obj.hazardLevel === 'critical' || obj.hazardLevel === 'high')
      .sort((a, b) => a.distance - b.distance);
    if (criticalObstacles.length > 0) {
      const obstacle = criticalObstacles[0];
      await this.issueWarning(obstacle);
      this.lastWarningTime = now;
    }
  }
  
  async issueWarning(obstacle) {
    // Enhanced haptic patterns based on hazard level
    const patterns = {
      critical: [0, 100, 50, 100, 50, 100, 50, 100], // Rapid pulses
      high: [0, 200, 100, 200, 100, 200],            // Fast pattern
      medium: [0, 300, 150, 300],                     // Medium pattern
      low: [0, 500],                                  // Single long pulse
    };
    
    const pattern = patterns[obstacle.hazardLevel] || patterns.medium;
    Vibration.vibrate(pattern);
    
    const direction = obstacle.position.relative;
    const distance = obstacle.distance.toFixed(1);
    const safeDir = this._getSafeDirection();
    
    // Include safe direction advice for critical/high hazards
    let message = `Warning: ${obstacle.class} ${distance} meters ${direction}`;
    if ((obstacle.hazardLevel === 'critical' || obstacle.hazardLevel === 'high') && safeDir !== direction) {
      message += `. Move ${safeDir}`;
    }
    
    await TextToSpeechService.speak(message);
    await SpatialAudioService.playDirectionalBeep(
      obstacle.position.angle,
      obstacle.distance
    );
  }
  
  generateWarnings() {
    return this.groundObstacles
      .filter(obj => obj.hazardLevel !== 'low')
      .map(obj => ({
        object: obj.class,
        distance: obj.distance,
        direction: obj.position.relative,
        hazardLevel: obj.hazardLevel,
        inFootpath: obj.inFootpath,
        collisionTime: obj.predictedCollisionTime,
        message: `${obj.class} ${obj.distance.toFixed(1)}m ${obj.position.relative}`,
        priority: obj.hazardLevel === 'critical' ? 1 : obj.hazardLevel === 'high' ? 2 : 3,
      }))
      .sort((a, b) => a.priority - b.priority);
  }
  
  detectStairs(detectedObjects) {
    const potentialStairs = detectedObjects.filter(obj => {
      return obj.boundingBox.height < 0.2 && obj.boundingBox.y > 0.6;
    });
    if (potentialStairs.length > 2) {
      return {
        detected: true,
        direction: potentialStairs[0].position.relative,
        distance: Math.min(...potentialStairs.map(s => s.distance)),
        count: potentialStairs.length,
      };
    }
    return { detected: false };
  }
  
  detectUnevenSurface(detectedObjects) {
    const groundObjects = detectedObjects.filter(obj => 
      obj.boundingBox.y > 0.5 && obj.distance < 3
    );
    if (groundObjects.length > 3) {
      const heights = groundObjects.map(obj => obj.boundingBox.y);
      const variance = this.calculateVariance(heights);
      if (variance > 0.1) {
        return {
          detected: true,
          severity: variance > 0.2 ? 'high' : 'medium',
          variance,
        };
      }
    }
    return { detected: false };
  }
  
  calculateVariance(numbers) {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    const squaredDiffs = numbers.map(n => Math.pow(n - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / numbers.length;
  }
  
  getSafePathRecommendation(detectedObjects) {
    this.analyzeFootPath(detectedObjects);
    if (this.groundObstacles.length === 0) {
      return {
        safe: true,
        message: 'Path clear',
        direction: 'forward',
        confidence: 1.0,
      };
    }
    const zones = {
      left: this.groundObstacles.filter(obj => obj.position.relative === 'left').length,
      center: this.groundObstacles.filter(obj => obj.position.relative === 'center').length,
      right: this.groundObstacles.filter(obj => obj.position.relative === 'right').length
    };
    const safest = Object.entries(zones)
      .sort((a, b) => a[1] - b[1])[0][0];
    
    const confidence = zones[safest] === 0 ? 1.0 : 0.7;
    
    return {
      safe: zones[safest] === 0,
      message: zones[safest] === 0 
        ? `Move ${safest}` 
        : `Caution: obstacles ahead`,
      direction: safest,
      obstacleCount: this.groundObstacles.length,
      confidence,
    };
  }
  
  getGroundObstacles() {
    return this.groundObstacles;
  }
  
  isMonitoring() {
    return this.isActive;
  }
  
  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  /**
   * Set the safety zone distance
   */
  setSafetyZone(meters) {
    this.safetyZone = Math.max(0.5, Math.min(5.0, meters));
  }
}
export default new FootPlacementService();
