import { Vibration } from 'react-native';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';

class FootPlacementService {
  constructor() {
    this.isActive = false;
    this.detectionInterval = null;
    this.groundObstacles = [];
    this.surfaceTypes = ['concrete', 'grass', 'gravel', 'stairs', 'uneven', 'wet'];
    this.safetyZone = 1.5;
    this.lastWarningTime = 0;
    this.warningCooldown = 2000;
    
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 100;
    
    this._realtimeCallback = null;
    
    this._performanceMetrics = {
      framesProcessed: 0,
      warningsIssued: 0,
      avgProcessTime: 0,
    };
    
    this._pathHistory = [];
    this._maxPathHistory = 10;
    
    this._warningCooldowns = {
      critical: 500,
      high: 1000,
      medium: 2000,
      low: 5000,
    };
    this._lastWarningByLevel = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    
    this._groundLevelThreshold = 0.4;
    this._footpathWidth = 1.2;
    
    this._lastStairWarningTime = 0;
    this._lastSurfaceWarningTime = 0;
  }
  
  async startMonitoring(detectedObjects, callback) {
    try {
      this.isActive = true;
      this._realtimeCallback = callback;
      
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
  
  async processFrame(detectedObjects, depthData = null) {
    if (!this.isActive) return null;
    
    const now = Date.now();
    
    if (now - this._lastProcessTime < this._minProcessInterval) {
      return null;
    }
    
    if (this._isProcessing) {
      return null;
    }
    
    this._isProcessing = true;
    const startTime = performance.now();
    
    try {
      this.analyzeFootPath(detectedObjects);
      
      if (depthData && depthData.zones) {
        this._enhanceWithDepthData(depthData);
      }
      
      const stairInfo = this.detectStairs(detectedObjects);
      
      const surfaceInfo = this.detectUnevenSurface(detectedObjects);
      
      const warnings = this.generateWarnings();
      
      await this._checkAndWarnWithAdaptiveCooldown();
      
      this._updatePathHistory(detectedObjects);
      
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      this._lastProcessTime = now;
      
      const result = {
        status: 'active',
        obstacles: this.groundObstacles,
        warnings,
        stairs: stairInfo,
        surface: surfaceInfo,
        safeDirection: this._getSafeDirection(),
        pathRecommendation: this.getSafePathRecommendation(detectedObjects),
      };
      
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
      .sort((a, b) => a.distance - b.distance);
  }
  
  _isInFootpath(obstacle) {
    const centerX = obstacle.boundingBox.x + obstacle.boundingBox.width / 2;
    return centerX > 0.35 && centerX < 0.65;
  }
  
  _predictCollisionTime(obstacle) {
    if (this._pathHistory.length > 1) {
      const prevFrame = this._pathHistory[this._pathHistory.length - 2];
      const prevObstacle = prevFrame.find(o => o.class === obstacle.class);
      
      if (prevObstacle) {
        const distanceDelta = prevObstacle.distance - obstacle.distance;
        if (distanceDelta > 0) {
          const approachRate = distanceDelta / (this._minProcessInterval / 1000);
          return obstacle.distance / approachRate;
        }
      }
    }
    
    return obstacle.distance / 1.0;
  }
  
  _updatePathHistory(detectedObjects) {
    this._pathHistory.push(
      detectedObjects.map(o => ({ class: o.class, distance: o.distance }))
    );
    
    if (this._pathHistory.length > this._maxPathHistory) {
      this._pathHistory.shift();
    }
  }
  
  _enhanceWithDepthData(depthData) {
    if (depthData.zones?.critical?.hasObjects) {
      this.groundObstacles.forEach(obs => {
        if (obs.distance < depthData.zones.critical.minDistance * 1.2) {
          obs.hazardLevel = 'critical';
        }
      });
    }
  }
  
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
  
  async _checkAndWarnWithAdaptiveCooldown() {
    const now = Date.now();
    
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
    const patterns = {
      critical: [0, 100, 50, 100, 50, 100, 50, 100],
      high: [0, 200, 100, 200, 100, 200],
      medium: [0, 300, 150, 300],
      low: [0, 500],
    };
    
    const pattern = patterns[obstacle.hazardLevel] || patterns.medium;
    Vibration.vibrate(pattern);
    
    const direction = obstacle.position.relative;
    const distance = obstacle.distance.toFixed(1);
    const safeDir = this._getSafeDirection();
    
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
    // Detect stairs by looking for multiple horizontal objects at ground level
    // with varying depths suggesting steps
    const groundLevel = detectedObjects.filter(obj => {
      const bottomY = obj.boundingBox.y + obj.boundingBox.height;
      return bottomY > 0.5 && obj.distance < 5;
    });
    
    // Sort by distance to find stepped pattern
    const byDistance = [...groundLevel].sort((a, b) => a.distance - b.distance);
    
    // Look for step-like pattern: objects at regular depth intervals
    let stepPattern = [];
    for (let i = 1; i < byDistance.length; i++) {
      const depthDiff = byDistance[i].distance - byDistance[i-1].distance;
      if (depthDiff > 0.15 && depthDiff < 0.8) {
        stepPattern.push(byDistance[i]);
      }
    }
    
    // Also check for narrow horizontal bands (stair-like)
    const narrowBands = detectedObjects.filter(obj => {
      return obj.boundingBox.height < 0.15 && 
             obj.boundingBox.width > 0.15 && 
             obj.boundingBox.y > 0.4;
    });
    
    const potentialSteps = Math.max(stepPattern.length, narrowBands.length);
    
    if (potentialSteps >= 2) {
      const nearestDistance = byDistance.length > 0 ? byDistance[0].distance : 3;
      const direction = byDistance.length > 0 ? byDistance[0].position.relative : 'center';
      
      // Estimate step depth based on detected pattern
      let estimatedStepHeight = 0.18; // default step height in meters
      if (stepPattern.length >= 2) {
        const avgInterval = stepPattern.reduce((sum, s, i) => {
          if (i > 0) return sum + (s.distance - stepPattern[i-1].distance);
          return sum;
        }, 0) / Math.max(1, stepPattern.length - 1);
        estimatedStepHeight = Math.min(0.3, Math.max(0.1, avgInterval));
      }
      
      return {
        detected: true,
        direction,
        distance: nearestDistance,
        count: potentialSteps,
        estimatedStepHeight,
        goingUp: narrowBands.length > 0 && narrowBands[0].boundingBox.y < 0.7,
        goingDown: narrowBands.length > 0 && narrowBands[0].boundingBox.y > 0.7,
      };
    }
    return { detected: false };
  }
  
  detectUnevenSurface(detectedObjects) {
    const groundObjects = detectedObjects.filter(obj => 
      obj.boundingBox.y > 0.5 && obj.distance < 3
    );
    if (groundObjects.length >= 2) {
      const heights = groundObjects.map(obj => obj.boundingBox.y);
      const distances = groundObjects.map(obj => obj.distance);
      const heightVariance = this.calculateVariance(heights);
      const distVariance = this.calculateVariance(distances);
      
      // Combined variance indicates surface unevenness
      const combinedVariance = heightVariance + distVariance * 0.5;
      
      if (combinedVariance > 0.05) {
        return {
          detected: true,
          severity: combinedVariance > 0.2 ? 'high' : combinedVariance > 0.1 ? 'medium' : 'low',
          variance: combinedVariance,
          nearestDistance: Math.min(...distances),
        };
      }
    }
    return { detected: false };
  }
  
  async warnStairs(stairInfo) {
    if (!stairInfo || !stairInfo.detected) return;
    
    const now = Date.now();
    if (now - (this._lastStairWarningTime || 0) < 3000) return; // 3s cooldown for stair warnings
    this._lastStairWarningTime = now;
    
    const directionText = stairInfo.direction === 'center' ? 'ahead' : `to your ${stairInfo.direction}`;
    const distText = stairInfo.distance.toFixed(1);
    const stepText = stairInfo.count > 1 ? `${stairInfo.count} steps` : 'steps';
    
    let guidance;
    if (stairInfo.distance < 1.0) {
      // Very close - give step-by-step guidance
      if (stairInfo.goingDown) {
        guidance = `Stairs going down ${directionText}, ${distText} meters. Careful. Step down slowly, feel each step with your foot before shifting weight.`;
      } else {
        guidance = `Stairs going up ${directionText}, ${distText} meters. Lift your feet higher. About ${stepText} detected.`;
      }
      Vibration.vibrate([0, 100, 50, 100, 50, 100]);
    } else if (stairInfo.distance < 2.5) {
      // Approaching
      if (stairInfo.goingDown) {
        guidance = `Stairs going down ${directionText} in ${distText} meters. Approach carefully and use handrail if available.`;
      } else {
        guidance = `Stairs ahead ${directionText} in ${distText} meters. ${stepText} detected. Prepare to step up.`;
      }
      Vibration.vibrate([0, 200, 100, 200]);
    } else {
      guidance = `Stairs detected ${directionText}, ${distText} meters away.`;
      Vibration.vibrate([0, 300]);
    }
    
    await TextToSpeechService.speak(guidance);
    await SpatialAudioService.playDirectionalBeep(
      stairInfo.direction === 'left' ? -30 : stairInfo.direction === 'right' ? 30 : 0,
      stairInfo.distance
    );
  }
  
  async warnUnevenSurface(surfaceInfo) {
    if (!surfaceInfo || !surfaceInfo.detected) return;
    
    const now = Date.now();
    if (now - (this._lastSurfaceWarningTime || 0) < 4000) return; // 4s cooldown
    this._lastSurfaceWarningTime = now;
    
    let guidance;
    if (surfaceInfo.severity === 'high') {
      guidance = `Caution. Very uneven surface ahead at ${surfaceInfo.nearestDistance?.toFixed(1) || '?'} meters. Walk slowly and place feet carefully on flat spots.`;
      Vibration.vibrate([0, 150, 50, 150, 50, 150]);
    } else if (surfaceInfo.severity === 'medium') {
      guidance = `Uneven surface ahead. Watch your footing and step carefully.`;
      Vibration.vibrate([0, 200, 100, 200]);
    } else {
      guidance = `Slightly uneven ground ahead. Be careful.`;
      Vibration.vibrate([0, 300]);
    }
    
    await TextToSpeechService.speak(guidance);
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
  
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  setSafetyZone(meters) {
    this.safetyZone = Math.max(0.5, Math.min(5.0, meters));
  }
}
export default new FootPlacementService();
