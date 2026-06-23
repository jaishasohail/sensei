import { Vibration } from 'react-native';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';

// ─── Grid constants (must match DepthEstimationService.js) ───────────────────
const GRID_COLS    = 7;
const GRID_ROWS    = 5;
const LEFT_COLS    = [0, 1];
const CENTER_COLS  = [2, 3, 4];
const RIGHT_COLS   = [5, 6];

// ─── TTS cooldowns ────────────────────────────────────────────────────────────
const GUIDANCE_COOLDOWN = 2500;   // ms — speakGuidance dedup window
const DROP_COOLDOWN     = 2500;   // ms — warnDropOff dedup window
const STAIR_COOLDOWN    = 3000;   // ms
const SURFACE_COOLDOWN  = 4000;   // ms

class FootPlacementService {
  constructor() {
    this.isActive       = false;
    this.groundObstacles = [];
    this.safetyZone      = 1.5;

    this._isProcessing     = false;
    this._lastProcessTime  = 0;
    this._minProcessInterval = 50;   // ms

    this._realtimeCallback = null;

    this._performanceMetrics = {
      framesProcessed: 0,
      warningsIssued:  0,
      avgProcessTime:  0,
    };

    this._pathHistory    = [];
    this._maxPathHistory = 10;

    this._warningCooldowns = {
      critical: 500,
      high:    1000,
      medium:  2000,
      low:     5000,
    };
    this._lastWarningByLevel = { critical: 0, high: 0, medium: 0, low: 0 };

    this._groundLevelThreshold = 0.4;
    this._footpathWidth        = 1.2;

    // Guidance dedup
    this._lastGuidanceText = '';
    this._lastGuidanceTime = 0;

    // Drop-off dedup
    this._lastDropTime = 0;

    // Stair / surface dedup
    this._lastStairWarningTime   = 0;
    this._lastSurfaceWarningTime = 0;

    // ── Stair temporal consistency ────────────────────────────────────────────
    // Stairs must be detected in this many consecutive frames before being
    // reported and announced.  A single frame (or even two) can easily be
    // triggered by floor textures, shadows, or a carpet edge.  Requiring 3
    // consecutive frames (~0.3–0.6 s at typical capture rates) eliminates
    // virtually all such false alarms while still catching real stairways well
    // before the user reaches the first step.
    this._stairConsecutiveCount = 0;
    this._minStairFrames        = 3;
    this._lastStairResult       = { detected: false };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async startMonitoring(detectedObjects, callback) {
    try {
      this.isActive          = true;
      this._realtimeCallback = callback;
      this.analyzeFootPath(detectedObjects);
      if (callback) {
        callback({
          status:        'active',
          obstacles:     this.groundObstacles,
          warnings:      this.generateWarnings(),
          safeDirection: this._getSafeDirection(),
        });
      }
      await TextToSpeechService.speak('Foot placement monitoring active');
      return true;
    } catch (err) {
      console.error('FootPlacementService startMonitoring error:', err);
      return false;
    }
  }

  stopMonitoring() {
    this.isActive          = false;
    this.groundObstacles   = [];
    this._realtimeCallback = null;
    this._pathHistory      = [];
  }

  isMonitoring() { return this.isActive; }

  getPerformanceMetrics() { return { ...this._performanceMetrics }; }

  // ── Main per-frame processing ──────────────────────────────────────────────

  /**
   * Process one frame and return guidance.
   *
   * @param {Array}        detections  — from ObjectDetectionService
   * @param {object|null}  depthData   — from DepthEstimationService (may be null)
   *
   * @returns {{
   *   status:       'active',
   *   obstacles:    Array,
   *   warnings:     Array,
   *   guidance:     { message: string, priority: string, direction: string },
   *   drop:         object|null,
   *   shouldSpeak:  boolean,
   *   stairs:       object,
   *   surface:      object,
   *   safeDirection: string,
   * } | null}
   */
  async processFrame(detections, depthData = null) {
    if (!this.isActive) return null;

    const now = Date.now();
    if (now - this._lastProcessTime < this._minProcessInterval) return null;
    if (this._isProcessing) return null;

    this._isProcessing = true;
    const startTime = performance.now();

    try {
      // ── 1. Classic obstacle list ──────────────────────────────────────────
      this.analyzeFootPath(detections);

      // ── 2. Grid-based guidance (primary) / object-based (fallback) ────────
      const grid      = depthData?.grid ?? null;
      const groundData = depthData?.groundData ?? null;

      let guidance;
      if (grid) {
        guidance = this._gridBasedGuidance(grid, groundData, detections);
      } else {
        guidance = this._objectBasedGuidance(detections);
      }
      if (!guidance) {
        guidance = { message: 'Path clear', priority: 'low', direction: 'forward' };
      }

      // ── 3. Drop-off detection ─────────────────────────────────────────────
      const drop = this._buildDropInfo(groundData);

      // ── 4. shouldSpeak: true when guidance is medium/high/critical ────────
      const shouldSpeak = guidance.priority !== 'low';

      // ── 5. Stairs & surface ───────────────────────────────────────────────
      const stairInfo   = this.detectStairs(detections, depthData);
      const surfaceInfo = this.detectUnevenSurface(detections, depthData);

      // ── 6. Obstacle warnings (internal TTS) ───────────────────────────────
      await this._checkAndWarnWithAdaptiveCooldown();

      // ── 7. Path history ───────────────────────────────────────────────────
      this._updatePathHistory(detections);

      // Performance tracking
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime =
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1)
          + processTime) / this._performanceMetrics.framesProcessed;
      this._lastProcessTime = now;

      const result = {
        status:        'active',
        obstacles:     this.groundObstacles,
        warnings:      this.generateWarnings(),
        guidance,
        drop,
        shouldSpeak,
        stairs:        stairInfo,
        surface:       surfaceInfo,
        safeDirection: this._getSafeDirection(),
        pathRecommendation: this.getSafePathRecommendation(detections),
      };

      if (this._realtimeCallback) this._realtimeCallback(result);
      return result;
    } catch (err) {
      console.error('FootPlacementService processFrame error:', err);
      return null;
    } finally {
      this._isProcessing = false;
    }
  }

  // ── Public TTS methods ─────────────────────────────────────────────────────

  /**
   * Speak foot-guidance text.
   * Deduplicated: same text within GUIDANCE_COOLDOWN is silently suppressed.
   * ARScreen calls this explicitly when footResult.shouldSpeak is true.
   */
  async speakGuidance(guidance) {
    if (!guidance?.message) return;
    const now = Date.now();
    if (
      guidance.message === this._lastGuidanceText &&
      now - this._lastGuidanceTime < GUIDANCE_COOLDOWN
    ) return;

    this._lastGuidanceText = guidance.message;
    this._lastGuidanceTime = now;

    const priority = (guidance.priority === 'critical' || guidance.priority === 'high')
      ? 'critical' : 'normal';
    await TextToSpeechService.speak(guidance.message, {}, priority);
  }

  /**
   * Warn the user about a detected drop-off (kerb edge, open manhole, etc.).
   * Vibrates and speaks.  Deduplicated within DROP_COOLDOWN ms.
   * ARScreen calls this when footResult.drop is non-null.
   */
  async warnDropOff(dropInfo) {
    if (!dropInfo) return;
    const now = Date.now();
    if (now - this._lastDropTime < DROP_COOLDOWN) return;
    this._lastDropTime = now;

    // Vibration: three short pulses
    Vibration.vibrate([0, 120, 60, 120, 60, 120]);

    const sideText = dropInfo.side === 'center'
      ? 'ahead'
      : `to your ${dropInfo.side}`;
    const severityText = dropInfo.severity === 'severe'
      ? 'severe'
      : dropInfo.severity === 'moderate' ? 'significant' : 'small';

    const message = `Caution! ${severityText} drop-off ${sideText}. Step carefully.`;
    await TextToSpeechService.speak(message, {}, 'critical');

    // Spatial audio cue (angle in degrees: left=-30, center=0, right=30)
    const angle = dropInfo.side === 'left' ? -30 : dropInfo.side === 'right' ? 30 : 0;
    SpatialAudioService.playDirectionalBeep(angle, 0.5).catch(() => {});
  }

  // ── Grid-based guidance ────────────────────────────────────────────────────

  /**
   * Primary guidance path: uses the 7×5 depth grid from DepthEstimationService.
   *
   * Looks at the bottom two rows (immediate walking zone).
   * Computes minimum depth per zone (left / center / right) and recommends
   * the clearest direction.  Drop-offs in a zone make that zone effectively
   * zero-distance (avoid).
   */
  _gridBasedGuidance(grid, groundData, detections = []) {
    if (!grid || grid.length < GRID_ROWS) return null;

    const hasDetections = Array.isArray(detections) && detections.length > 0;
    const hasStructuralHazard =
      (groundData?.dropOffs?.some(d => !d.fromImage) ?? false)
      || (groundData?.stepUps?.some(s => !s.fromImage) ?? false)
      || groundData?.imageStairDetected === true;

    // Ground-plane baseline alone reads ~1.1 m at the bottom row — not a real obstacle.
    if (!hasDetections && !hasStructuralHazard) {
      return { message: 'Path clear', priority: 'low', direction: 'forward' };
    }

    const walkingRows = [GRID_ROWS - 2, GRID_ROWS - 1];

    const zoneMin = (cols) => {
      let min = Infinity;
      for (const r of walkingRows) {
        if (!grid[r]) continue;
        for (const c of cols) {
          if (grid[r][c] < min) min = grid[r][c];
        }
      }
      return min;
    };

    const leftMin   = zoneMin(LEFT_COLS);
    const centerMin = zoneMin(CENTER_COLS);
    const rightMin  = zoneMin(RIGHT_COLS);

    // A zone with a drop-off is treated as impassable
    const hasDrop = (cols) =>
      groundData?.dropOffs?.some(d => cols.includes(d.col)) ?? false;
    const leftEff   = hasDrop(LEFT_COLS)   ? 0 : leftMin;
    const centerEff = hasDrop(CENTER_COLS) ? 0 : centerMin;
    const rightEff  = hasDrop(RIGHT_COLS)  ? 0 : rightMin;

    // Path clear when center is open beyond 2 m
    if (centerEff > 2.0) {
      return { message: 'Path clear', priority: 'low', direction: 'forward' };
    }

    // Find safest direction by effective distance
    const zones  = { left: leftEff, center: centerEff, right: rightEff };
    const sorted = Object.entries(zones).sort((a, b) => b[1] - a[1]);
    const safest = sorted[0][0];

    const allMin = Math.min(leftMin, centerMin, rightMin);

    let priority, message;

    if (allMin < 0.5) {
      priority = 'critical';
      const moveText = safest === 'center' ? 'step back' : `move ${safest}`;
      message  = `Stop! Obstacle ${allMin.toFixed(1)} meters — ${moveText}`;
    } else if (allMin < 1.2) {
      priority = 'high';
      if (centerMin < 1.2) {
        const altDir = leftEff >= rightEff ? 'left' : 'right';
        message = `Obstacle ahead ${centerMin.toFixed(1)}m — move ${safest === 'center' ? altDir : safest}`;
      } else {
        const blockSide = leftMin < rightMin ? 'left' : 'right';
        message = `Obstacle to your ${blockSide} — continue forward`;
      }
    } else {
      priority = 'medium';
      message  = `Obstacle at ${allMin.toFixed(1)} meters — step carefully`;
    }

    return { message, priority, direction: safest };
  }

  /**
   * Fallback guidance when no depth grid is available.
   * Uses object bounding-box positions and distances.
   */
  _objectBasedGuidance(detections) {
    if (!detections || detections.length === 0) {
      return { message: 'Path clear', priority: 'low', direction: 'forward' };
    }

    const nearby = detections.filter(d => (d.distance ?? d.depth ?? Infinity) < 3.0);
    if (nearby.length === 0) {
      return { message: 'Path clear', priority: 'low', direction: 'forward' };
    }

    const closest = nearby.reduce((a, b) =>
      (a.distance ?? Infinity) < (b.distance ?? Infinity) ? a : b
    );
    const dist    = (closest.distance ?? 2.0).toFixed(1);
    const dirText = closest.position?.relative === 'left'  ? 'to your left'
                  : closest.position?.relative === 'right' ? 'to your right'
                  : 'ahead';

    const allMin = Math.min(...nearby.map(d => d.distance ?? Infinity));
    const priority = allMin < 0.5 ? 'critical' : allMin < 1.2 ? 'high' : 'medium';

    return {
      message:   `${closest.class} ${dirText}, ${dist} meters`,
      priority,
      direction: closest.position?.relative ?? 'center',
    };
  }

  /**
   * Build a drop-off info object from depth groundData.
   * Returns null when no meaningful drop-off is present.
   */
  _buildDropInfo(groundData) {
    const realDrops = (groundData?.dropOffs ?? []).filter(d => !d.fromImage);
    if (!realDrops.length) return null;

    // Pick the most severe drop-off
    const worst = [...realDrops].sort((a, b) => b.delta - a.delta)[0];

    let side = 'center';
    if (LEFT_COLS.includes(worst.col))   side = 'left';
    if (RIGHT_COLS.includes(worst.col))  side = 'right';

    const severity = worst.delta > 1.0 ? 'severe'
                   : worst.delta > 0.6 ? 'moderate'
                   : 'mild';

    return { delta: worst.delta, side, severity, col: worst.col, row: worst.row };
  }

  // ── Stair & surface detection ──────────────────────────────────────────────

  /**
   * Detect stairs by combining:
   *   a) Object pattern analysis (narrow horizontal bands at ground level)
   *   b) Depth grid step-up signals from depthData.groundData.stepUps
   *
   * Temporal consistency gate: stairs must be detected in _minStairFrames (3)
   * consecutive frames before the result is reported as detected:true.  This
   * prevents floor textures, shadows, and carpet edges from triggering false
   * stair announcements.
   */
  detectStairs(detectedObjects, depthData = null) {
    const gridStepUps = depthData?.groundData?.stepUps ?? [];
    const gridHasStairs = gridStepUps.filter(s => !s.fromImage).length >= 2;
    const imageStairDetected = depthData?.groundData?.imageStairDetected === true;

    const groundLevel = detectedObjects.filter(obj => {
      if (!obj.boundingBox) return false;
      const bottomY = obj.boundingBox.y + obj.boundingBox.height;
      return bottomY > 0.5 && obj.distance < 5;
    });

    const byDistance = [...groundLevel].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

    // Step-like pattern: depth intervals 0.15–0.80 m
    let stepPattern = [];
    for (let i = 1; i < byDistance.length; i++) {
      const Δ = byDistance[i].distance - byDistance[i - 1].distance;
      if (Δ > 0.15 && Δ < 0.80) stepPattern.push(byDistance[i]);
    }

    // Narrow horizontal bands (stair risers)
    const narrowBands = detectedObjects.filter(obj =>
      obj.boundingBox &&
      obj.boundingBox.height < 0.15 &&
      obj.boundingBox.width  > 0.15 &&
      obj.boundingBox.y      > 0.40
    );

    const potentialSteps = Math.max(
      stepPattern.length,
      narrowBands.length,
      gridHasStairs ? 2 : 0,
      imageStairDetected ? 3 : 0,
    );

    const framesRequired = this._minStairFrames;

    if (potentialSteps >= 2) {
      this._stairConsecutiveCount++;

      if (this._stairConsecutiveCount < framesRequired) {
        return { detected: false };
      }

      // Confirmed stair detection
      const imageStairDist = depthData?.groundData?.imageStairDetected
        ? depthData.groundData.imageStairDistance
        : null;
      const nearestDistance = imageStairDist
        ?? (byDistance.length > 0 ? byDistance[0].distance : 1.5);
      const direction       = byDistance.length > 0
        ? (byDistance[0].position?.relative ?? 'center')
        : 'center';

      let estimatedStepHeight = 0.18;
      if (stepPattern.length >= 2) {
        const avgInterval = stepPattern.reduce((sum, s, i) => {
          if (i > 0) return sum + (s.distance - stepPattern[i - 1].distance);
          return sum;
        }, 0) / Math.max(1, stepPattern.length - 1);
        estimatedStepHeight = Math.min(0.3, Math.max(0.1, avgInterval));
      }

      const topBand = narrowBands[0];
      const topY    = topBand ? topBand.boundingBox.y : 0.5;

      const goingDown = imageStairDetected
        ? (imageStairDist != null && imageStairDist < 2.0)
        : topY > 0.70;
      const goingUp = !goingDown;

      const stepCount = imageStairDetected
        ? Math.max(potentialSteps, gridStepUps.filter(s => s.fromImage).length, 2)
        : potentialSteps;

      this._lastStairResult = {
        detected: true,
        direction,
        distance: nearestDistance,
        count: stepCount,
        estimatedStepHeight,
        goingUp,
        goingDown,
        fromImage: imageStairDetected,
      };
      return this._lastStairResult;
    }

    // No evidence in this frame — reset the consecutive counter
    this._stairConsecutiveCount = 0;
    this._lastStairResult = { detected: false };
    return { detected: false };
  }

  /**
   * Detect uneven surface by combining object-position variance with the
   * depth grid variance from depthData.groundData.
   */
  detectUnevenSurface(detectedObjects, depthData = null) {
    const groundObjects = detectedObjects.filter(
      obj => obj.boundingBox && obj.boundingBox.y > 0.5 && obj.distance < 3
    );

    // Baseline ground-plane variance is not uneven terrain — need real objects or stairs.
    if (groundObjects.length < 2 && !depthData?.groundData?.imageStairDetected) {
      return { detected: false };
    }

    const gridVariance = depthData?.groundData?.variance ?? 0;

    let combinedVariance = gridVariance;

    if (groundObjects.length >= 2) {
      const heights   = groundObjects.map(obj => obj.boundingBox.y);
      const distances = groundObjects.map(obj => obj.distance);
      const hVar = this.calculateVariance(heights);
      const dVar = this.calculateVariance(distances);
      combinedVariance = Math.max(gridVariance, hVar + dVar * 0.5);
    }

    if (combinedVariance > 0.05) {
      const nearestDistance = groundObjects.length > 0
        ? Math.min(...groundObjects.map(o => o.distance))
        : Infinity;
      return {
        detected:        true,
        severity:        combinedVariance > 0.2 ? 'high' : combinedVariance > 0.1 ? 'medium' : 'low',
        variance:        combinedVariance,
        nearestDistance,
      };
    }
    return { detected: false };
  }

  // ── Stair / surface TTS warnings ───────────────────────────────────────────

  async warnStairs(stairInfo) {
    if (!stairInfo?.detected) return;
    const now = Date.now();
    if (now - this._lastStairWarningTime < STAIR_COOLDOWN) return;
    this._lastStairWarningTime = now;

    const dirText  = stairInfo.direction === 'center' ? 'ahead' : `to your ${stairInfo.direction}`;
    const distText = (stairInfo.distance ?? 0).toFixed(1);
    const stepText = stairInfo.count > 1 ? `${stairInfo.count} steps` : 'steps';

    let guidance;
    if (stairInfo.distance < 1.0) {
      guidance = stairInfo.goingDown
        ? `Stairs going down ${dirText}, ${distText} meters. Step down slowly, feel each step.`
        : `Stairs going up ${dirText}, ${distText} meters. Lift feet higher. About ${stepText} detected.`;
      Vibration.vibrate([0, 100, 50, 100, 50, 100]);
    } else if (stairInfo.distance < 2.5) {
      guidance = stairInfo.goingDown
        ? `Stairs going down ${dirText} in ${distText} meters. Use handrail if available.`
        : `Stairs ahead ${dirText} in ${distText} meters. ${stepText} detected. Prepare to step up.`;
      Vibration.vibrate([0, 200, 100, 200]);
    } else {
      guidance = `Stairs detected ${dirText}, ${distText} meters away.`;
      Vibration.vibrate([0, 300]);
    }

    await TextToSpeechService.speak(guidance, {}, 'critical');
    SpatialAudioService.playDirectionalBeep(
      stairInfo.direction === 'left' ? -30 : stairInfo.direction === 'right' ? 30 : 0,
      stairInfo.distance
    ).catch(() => {});
  }

  async warnUnevenSurface(surfaceInfo) {
    if (!surfaceInfo?.detected) return;
    const now = Date.now();
    if (now - this._lastSurfaceWarningTime < SURFACE_COOLDOWN) return;
    this._lastSurfaceWarningTime = now;

    let guidance;
    const nearDist = surfaceInfo.nearestDistance;
    if (surfaceInfo.severity === 'high') {
      guidance = `Caution. Very uneven surface ahead${isFinite(nearDist) ? ` at ${nearDist.toFixed(1)} meters` : ''}. Walk slowly.`;
      Vibration.vibrate([0, 150, 50, 150, 50, 150]);
    } else if (surfaceInfo.severity === 'medium') {
      guidance = `Uneven surface ahead. Watch your footing.`;
      Vibration.vibrate([0, 200, 100, 200]);
    } else {
      guidance = `Slightly uneven ground ahead. Be careful.`;
      Vibration.vibrate([0, 300]);
    }

    await TextToSpeechService.speak(guidance);
  }

  // ── Obstacle analysis ──────────────────────────────────────────────────────

  analyzeFootPath(detectedObjects) {
    if (!detectedObjects || detectedObjects.length === 0) {
      this.groundObstacles = [];
      return;
    }
    const OBSTACLE_TYPES = new Set([
      'person', 'bicycle', 'car', 'motorcycle', 'bench', 'chair',
      'suitcase', 'backpack', 'sports ball', 'fire hydrant', 'parking meter',
      'potted plant', 'skateboard', 'umbrella', 'handbag', 'bottle', 'cup',
      'dog', 'cat',
    ]);
    this.groundObstacles = detectedObjects
      .filter(obj => {
        if (!obj.boundingBox) return false;
        const isGroundLevel = obj.boundingBox.y + obj.boundingBox.height > this._groundLevelThreshold;
        const isClose       = obj.distance < this.safetyZone * 2;
        const isObstacle    = Array.from(OBSTACLE_TYPES).some(t =>
          obj.class.toLowerCase().includes(t)
        );
        return isGroundLevel && isClose && isObstacle;
      })
      .map(obj => ({
        ...obj,
        hazardLevel:            this.calculateHazardLevel(obj),
        surfaceType:            this.detectSurfaceType(obj),
        inFootpath:             this._isInFootpath(obj),
        predictedCollisionTime: this._predictCollisionTime(obj),
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  calculateHazardLevel(obstacle) {
    const dist   = obstacle.distance;
    const inPath = this._isInFootpath(obstacle);
    if (dist < (inPath ? 0.7 : 0.5)) return 'critical';
    if (dist < (inPath ? 1.2 : 1.0)) return 'high';
    if (dist < (inPath ? this.safetyZone + 0.5 : this.safetyZone)) return 'medium';
    return 'low';
  }

  detectSurfaceType(obstacle) {
    if (obstacle.class.includes('bench') || obstacle.class.includes('chair')) return 'elevated';
    if (obstacle.class.includes('skateboard')) return 'rolling_hazard';
    if (obstacle.class.includes('bottle') || obstacle.class.includes('cup')) return 'trip_hazard';
    return 'concrete';
  }

  generateWarnings() {
    return this.groundObstacles
      .filter(obj => obj.hazardLevel !== 'low')
      .map(obj => ({
        object:       obj.class,
        distance:     obj.distance,
        direction:    obj.position.relative,
        hazardLevel:  obj.hazardLevel,
        inFootpath:   obj.inFootpath,
        collisionTime: obj.predictedCollisionTime,
        message:      `${obj.class} ${obj.distance.toFixed(1)}m ${obj.position.relative}`,
        priority:     obj.hazardLevel === 'critical' ? 1 : obj.hazardLevel === 'high' ? 2 : 3,
      }))
      .sort((a, b) => a.priority - b.priority);
  }

  getSafePathRecommendation(detectedObjects) {
    this.analyzeFootPath(detectedObjects);
    if (this.groundObstacles.length === 0) {
      return { safe: true, message: 'Path clear', direction: 'forward', confidence: 1.0 };
    }
    const zones = {
      left:   this.groundObstacles.filter(o => o.position.relative === 'left').length,
      center: this.groundObstacles.filter(o => o.position.relative === 'center').length,
      right:  this.groundObstacles.filter(o => o.position.relative === 'right').length,
    };
    const safest     = Object.entries(zones).sort((a, b) => a[1] - b[1])[0][0];
    const confidence = zones[safest] === 0 ? 1.0 : 0.7;
    return {
      safe:          zones[safest] === 0,
      message:       zones[safest] === 0 ? `Move ${safest}` : 'Caution: obstacles ahead',
      direction:     safest,
      obstacleCount: this.groundObstacles.length,
      confidence,
    };
  }

  getGroundObstacles() { return this.groundObstacles; }

  setSafetyZone(meters) {
    this.safetyZone = Math.max(0.5, Math.min(5.0, meters));
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  async _checkAndWarnWithAdaptiveCooldown() {
    const now = Date.now();
    const critical = this.groundObstacles
      .filter(o => o.hazardLevel === 'critical' || o.hazardLevel === 'high')
      .sort((a, b) => a.distance - b.distance);
    if (critical.length === 0) return;

    const obstacle = critical[0];
    const level    = obstacle.hazardLevel;
    const cooldown = this._warningCooldowns[level] || 2000;

    if (now - this._lastWarningByLevel[level] >= cooldown) {
      await this._issueWarning(obstacle);
      this._lastWarningByLevel[level] = now;
      this._performanceMetrics.warningsIssued++;
    }
  }

  async _issueWarning(obstacle) {
    const patterns = {
      critical: [0, 100, 50, 100, 50, 100, 50, 100],
      high:     [0, 200, 100, 200, 100, 200],
      medium:   [0, 300, 150, 300],
      low:      [0, 500],
    };
    Vibration.vibrate(patterns[obstacle.hazardLevel] || patterns.medium);

    const direction = obstacle.position.relative;
    const distance  = obstacle.distance.toFixed(1);
    const safeDir   = this._getSafeDirection();
    let message     = `Warning: ${obstacle.class} ${distance} meters ${direction}`;
    if ((obstacle.hazardLevel === 'critical' || obstacle.hazardLevel === 'high') && safeDir !== direction) {
      message += `. Move ${safeDir}`;
    }

    await TextToSpeechService.speak(message, {}, 'critical');
    SpatialAudioService.playDirectionalBeep(
      obstacle.position.angle,
      obstacle.distance
    ).catch(() => {});
  }

  _getSafeDirection() {
    const zones = {
      left:   { count: 0, minDistance: Infinity },
      center: { count: 0, minDistance: Infinity },
      right:  { count: 0, minDistance: Infinity },
    };
    this.groundObstacles.forEach(obj => {
      const d = obj.position.relative;
      zones[d].count++;
      if (obj.distance < zones[d].minDistance) zones[d].minDistance = obj.distance;
    });
    let safest = 'center', bestScore = -Infinity;
    for (const [dir, data] of Object.entries(zones)) {
      const score = (data.count === 0 ? 10 : 0) + (data.minDistance === Infinity ? 5 : data.minDistance);
      if (score > bestScore) { bestScore = score; safest = dir; }
    }
    return safest;
  }

  _isInFootpath(obstacle) {
    const cx = obstacle.boundingBox.x + obstacle.boundingBox.width / 2;
    return cx > 0.35 && cx < 0.65;
  }

  _predictCollisionTime(obstacle) {
    if (this._pathHistory.length > 1) {
      const prev     = this._pathHistory[this._pathHistory.length - 2];
      const prevObs  = prev.find(o => o.class === obstacle.class);
      if (prevObs) {
        const Δ = prevObs.distance - obstacle.distance;
        if (Δ > 0) return obstacle.distance / (Δ / (this._minProcessInterval / 1000));
      }
    }
    return obstacle.distance / 1.0;
  }

  _updatePathHistory(detectedObjects) {
    this._pathHistory.push(
      detectedObjects.map(o => ({ class: o.class, distance: o.distance }))
    );
    if (this._pathHistory.length > this._maxPathHistory) this._pathHistory.shift();
  }

  calculateVariance(numbers) {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    return numbers.reduce((s, n) => s + Math.pow(n - mean, 2), 0) / numbers.length;
  }
}

export default new FootPlacementService();
