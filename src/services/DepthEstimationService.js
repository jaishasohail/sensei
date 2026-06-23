import { API_BASE_URL } from '../constants/config';

// ─── Grid constants (must match FootPlacementService.js) ─────────────────────
const GRID_COLS = 7;
const GRID_ROWS = 5;

// ─── Ground-plane perspective model ───────────────────────────────────────────
// Camera at ~1 m above ground.  HORIZON_Y = normalised Y of the visual horizon.
// Objects touching the bottom edge (normY → 1) are ~GROUND_K / (1 - HORIZON_Y)
// metres away; GROUND_K is chosen so that value ≈ 0.55 m.
const GROUND_K  = 0.55;   // camera-height / frame-height scaling constant
const HORIZON_Y = 0.42;   // upper 42 % of frame is sky / background

// ─── Zone thresholds (metres) ─────────────────────────────────────────────────
const ZONE_CRITICAL = 0.5;
const ZONE_NEAR     = 1.2;
const ZONE_MID      = 3.0;

// ─── Ground analysis thresholds ───────────────────────────────────────────────
const DROP_THRESHOLD = 0.45;   // depth Δ (m) → drop-off (ground falls away)
const STEP_THRESHOLD = 0.25;   // depth Δ (m) → step-up (obstacle sticking up)

// ─── Canonical real-world heights for COCO classes (metres) ──────────────────
const CANONICAL_HEIGHTS = {
  person: 1.7, bicycle: 1.1, motorcycle: 1.2, car: 1.45,
  bus: 3.0, truck: 3.5, chair: 0.9, bench: 1.0,
  'stop sign': 2.1, 'traffic light': 3.5, 'fire hydrant': 0.6,
  'parking meter': 1.2, dog: 0.5, cat: 0.3, bottle: 0.25, cup: 0.1,
  suitcase: 0.7, umbrella: 1.5, skateboard: 0.1,
};

class DepthEstimationService {
  constructor() {
    this.initialized  = false;
    this.apiBaseUrl   = API_BASE_URL;

    this._isProcessing     = false;
    this._lastProcessTime  = 0;
    this._minProcessInterval = 50;   // ms — self-throttle

    this._performanceMetrics = {
      avgProcessTime:      0,
      framesProcessed:     0,
      successfulEstimates: 0,
    };

    this._lastDepthMap   = null;
    this._depthMapAge    = 0;
    this._maxDepthMapAge = 500;   // ms — cached result is still valid for 500 ms

    this._realtimeCallback = null;
    this._realtimeActive   = false;

    // Focal-length calibration — running weighted average across frames
    this._focalEst    = null;
    this._focalWeight = 0;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    console.log('DepthEstimationService: Initialized (on-device 7×5 grid mode)');
    return true;
  }

  startRealtimeDepth(callback, options = {}) {
    const { intervalMs = 50 } = options;
    this._minProcessInterval = intervalMs;
    this._realtimeCallback   = callback;
    this._realtimeActive     = true;
    console.log('DepthEstimationService: Real-time depth started');
    return true;
  }

  stopRealtimeDepth() {
    this._realtimeActive   = false;
    this._realtimeCallback = null;
    this._lastDepthMap     = null;
    console.log('DepthEstimationService: Real-time depth stopped');
  }

  /**
   * Process one frame and return a depth map + 7×5 grid.
   *
   * @param {{ rowMeans: number[], H: number, W: number } | null} edgeSignal
   *   Per-row brightness means for the bottom 60 % of the frame, extracted by
   *   ARScreen using tf.tidy() before the tensor is disposed.  Pass null when
   *   unavailable (backward compat).
   * @param {Array} detections  Enriched COCO-SSD detections from ObjectDetectionService.
   * @returns {object|null}  depth result: { grid, groundData, zones, nearest, mean,
   *                                         objectDepths, isEstimated }
   */
  async processFrame(edgeSignal, detections = []) {
    const now = Date.now();

    // Self-throttle: return the last map if it is still fresh
    if (now - this._lastProcessTime < this._minProcessInterval) {
      if (this._lastDepthMap && (now - this._depthMapAge) < this._maxDepthMapAge) {
        return this._lastDepthMap;
      }
      return null;
    }

    // Don't stack up concurrent invocations
    if (this._isProcessing) return this._lastDepthMap;

    this._isProcessing = true;
    const startTime = performance.now();

    try {
      // 0. Image-based edge analysis for stair/drop detection.
      //    This runs even when detections is empty — stairs are not COCO classes
      //    so object detection alone cannot see them.
      let imageStairSignal = null;
      if (edgeSignal) {
        imageStairSignal = this._detectStairsFromEdgeSignal(edgeSignal);
      }

      // 1. Update focal-length calibration from known-size objects
      this._calibrateFocalLength(detections);

      // 2. Add a blended depth estimate to each detection
      const enriched = this._enrichObjectDepths(detections);

      // 3. Build the 7×5 depth grid (ground-plane baseline, detections overwrite)
      const grid = this._buildDepthGrid(enriched);

      // 4. Analyse the walking zone for drop-offs / step-ups / variance
      const groundData = this._analyzeGround(grid);

      // 5. Augment groundData with image-based stair / edge signals.
      //    Each brightness edge → synthetic step-up signal that FootPlacementService
      //    can use to trigger a stair warning even with zero COCO detections.
      // Only augment when edges show a repeating stair pattern (not floor texture).
      const strongStairSignal =
        imageStairSignal?.isStairLike
        && imageStairSignal.isPeriodic
        && imageStairSignal.edgeCount >= 3;

      if (strongStairSignal) {
        const syntheticStepUps = imageStairSignal.edgeRows.map(edge => ({
          row:       GRID_ROWS - 2,
          col:       3,
          delta:     Math.max(0.25, Math.abs(edge.delta) / 15),
          side:      'center',
          fromImage: true,
        }));
        groundData.stepUps = [...groundData.stepUps, ...syntheticStepUps];

        // Downward brightness edges → synthetic drop-off signals
        const dropEdges = imageStairSignal.edgeRows.filter(e => e.type === 'dropoff');
        if (dropEdges.length > 0) {
          const syntheticDropOffs = dropEdges.map(() => ({
            row:       GRID_ROWS - 1,
            col:       3,
            delta:     0.6,
            side:      'center',
            fromImage: true,
          }));
          groundData.dropOffs = [...groundData.dropOffs, ...syntheticDropOffs];
        }

        // Distance estimate: use the ground-plane depth at the lowest (nearest)
        // detected edge row so warnStairs gives a plausible distance.
        const bottomEdge = imageStairSignal.edgeRows.reduce(
          (best, e) => {
            const score = e.normY ?? 0;
            return score > (best?.normY ?? 0) ? e : best;
          },
          null,
        );
        if (bottomEdge) {
          groundData.imageStairDetected = true;
          groundData.imageStairDistance = this._groundPlaneDepth(bottomEdge.normY ?? 0.65);
          groundData.imageStairAxis = imageStairSignal.detectionAxis ?? 'row';
        }
      }

      // 6. Zone summaries (critical / near / mid / far)
      const zones = this._analyzeZones(enriched);

      // 6. Summary stats
      const depths = enriched.map(o => o.depth).filter(d => isFinite(d) && d > 0);
      const nearest = depths.length > 0
        ? (() => {
            const minD = Math.min(...depths);
            const obj  = enriched.find(o => o.depth === minD);
            return {
              distance: minD,
              x: obj ? (obj.boundingBox.x + obj.boundingBox.width  / 2) : 0.5,
              y: obj ? (obj.boundingBox.y + obj.boundingBox.height / 2) : 0.5,
              object: obj?.class ?? null,
            };
          })()
        : { distance: Infinity, x: 0.5, y: 0.5, object: null };

      const mean = depths.length > 0
        ? depths.reduce((s, d) => s + d, 0) / depths.length
        : Infinity;

      const result = {
        grid,
        groundData,
        zones,
        nearest,
        mean,
        objectDepths: enriched,
        isEstimated: true,
      };

      // Performance tracking
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime =
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1)
          + processTime) / this._performanceMetrics.framesProcessed;
      if (nearest.distance < Infinity) this._performanceMetrics.successfulEstimates++;

      this._lastDepthMap  = result;
      this._depthMapAge   = now;
      this._lastProcessTime = now;

      if (this._realtimeActive && this._realtimeCallback) {
        this._realtimeCallback(result);
      }

      return result;
    } catch (err) {
      console.error('DepthEstimationService processFrame error:', err);
      return this._lastDepthMap || this._emptyResult();
    } finally {
      this._isProcessing = false;
    }
  }

  /** Return the most recent depth map if it is still within maxDepthMapAge. */
  getCachedDepthMap() {
    const now = Date.now();
    if (this._lastDepthMap && (now - this._depthMapAge) < this._maxDepthMapAge) {
      return this._lastDepthMap;
    }
    return null;
  }

  isRealtimeActive()    { return this._realtimeActive; }
  getPerformanceMetrics() { return { ...this._performanceMetrics }; }

  setProcessInterval(intervalMs) {
    this._minProcessInterval = Math.max(50, Math.min(1000, intervalMs));
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Ground-plane perspective model.
   * Returns estimated distance (m) for a point at normalised Y in the frame.
   *
   *   depth = GROUND_K / max(ε, normY - HORIZON_Y)
   *
   * At normY = 1 (bottom of frame) → ~0.55 m.
   * At normY = HORIZON_Y (horizon)  → clamped to 30 m.
   */
  _groundPlaneDepth(normY) {
    const dy = normY - HORIZON_Y;
    if (dy <= 0.001) return 30;
    return Math.min(30, Math.max(0.2, GROUND_K / dy));
  }

  /**
   * Build a full GRID_ROWS × GRID_COLS ground-plane depth grid.
   * Row 0 = top of frame (far), Row GRID_ROWS-1 = bottom (near).
   */
  _groundPlaneGrid() {
    const grid = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const row = [];
      const normY = (r + 0.5) / GRID_ROWS;
      for (let c = 0; c < GRID_COLS; c++) {
        row.push(this._groundPlaneDepth(normY));
      }
      grid.push(row);
    }
    return grid;
  }

  /**
   * Update the running focal-length calibration using detections with known
   * canonical heights.
   *
   * Formula: focal = (bboxH_normalised × ground_depth) / canonicalHeight
   * New frame weight = 0.3, old accumulated weight = 0.7.
   */
  _calibrateFocalLength(detections) {
    if (!detections || detections.length === 0) return;
    for (const det of detections) {
      const canonH = CANONICAL_HEIGHTS[det.class];
      if (!canonH || !det.boundingBox) continue;
      const bboxH = det.boundingBox.height;
      if (bboxH <= 0.02) continue;    // bbox too small for reliable measurement

      const footY  = det.boundingBox.y + bboxH;
      const gDepth = this._groundPlaneDepth(footY);
      const fEst   = (bboxH * gDepth) / canonH;

      if (fEst < 0.1 || fEst > 6.0) continue;

      if (this._focalEst === null) {
        this._focalEst    = fEst;
        this._focalWeight = 1;
      } else {
        this._focalEst    = this._focalEst * 0.7 + fEst * 0.3;
        this._focalWeight = Math.min(20, this._focalWeight + 1);
      }
    }
  }

  /**
   * Add a `.depth` property to each detection using a 65 / 35 blend of:
   *   - Ground-plane model   (65 %) — always available, rotation-robust
   *   - Focal-length model   (35 %) — available after ≥2 calibration frames
   *
   * Returns a new array (detections are not mutated).
   */
  _enrichObjectDepths(detections) {
    if (!detections || detections.length === 0) return [];
    return detections.map(det => {
      const footY  = det.boundingBox
        ? det.boundingBox.y + det.boundingBox.height
        : 0.8;
      const gDepth = this._groundPlaneDepth(footY);

      let blendedDepth = gDepth;

      if (this._focalEst && this._focalWeight >= 2 && det.boundingBox) {
        const canonH = CANONICAL_HEIGHTS[det.class];
        if (canonH) {
          const bboxH = det.boundingBox.height;
          if (bboxH > 0.02) {
            const fDepth = (canonH * this._focalEst) / bboxH;
            if (isFinite(fDepth) && fDepth > 0.1 && fDepth < 50) {
              blendedDepth = gDepth * 0.65 + fDepth * 0.35;
            }
          }
        }
      }

      return { ...det, depth: blendedDepth };
    });
  }

  /**
   * Build the 7×5 depth grid.
   *
   * Cells start with their ground-plane depth.  Detections overwrite any cell
   * they touch (nearest-wins when multiple detections overlap a cell) because
   * an object closer than the ground plane is the relevant depth for navigation.
   */
  _buildDepthGrid(enrichedDetections) {
    const grid = this._groundPlaneGrid();

    for (const det of enrichedDetections) {
      if (!det.boundingBox) continue;
      const { x, y, width, height } = det.boundingBox;
      const depth = det.depth;
      if (!isFinite(depth) || depth <= 0) continue;

      const colStart = Math.max(0, Math.floor(x * GRID_COLS));
      const colEnd   = Math.min(GRID_COLS - 1, Math.floor((x + width)  * GRID_COLS));
      const rowStart = Math.max(0, Math.floor(y * GRID_ROWS));
      const rowEnd   = Math.min(GRID_ROWS - 1, Math.floor((y + height) * GRID_ROWS));

      for (let r = rowStart; r <= rowEnd; r++) {
        for (let c = colStart; c <= colEnd; c++) {
          if (depth < grid[r][c]) grid[r][c] = depth;   // nearest-wins
        }
      }
    }

    return grid;
  }

  /**
   * Analyse the bottom two rows of the grid (immediate walking zone) for:
   *   • drop-offs  — depth increases by >DROP_THRESHOLD  (ground falls away)
   *   • step-ups   — depth decreases by >STEP_THRESHOLD  (obstacle sticking up)
   *   • variance   — spread of depths indicates uneven surface
   *
   * Both horizontal (left↔right) and vertical (near↔far row) transitions are
   * checked so kerb edges and raised steps are caught regardless of orientation.
   */
  _analyzeGround(grid) {
    const walkingRows = [GRID_ROWS - 2, GRID_ROWS - 1];
    const dropOffs = [];
    const stepUps  = [];
    const allDepths = [];

    for (const r of walkingRows) {
      const row = grid[r];
      if (!row) continue;

      for (let c = 0; c < GRID_COLS; c++) {
        allDepths.push(row[c]);

        // ── Horizontal transitions ───────────────────────────────────────────
        if (c + 1 < GRID_COLS) {
          const Δ = row[c + 1] - row[c];   // positive → right cell is farther
          const side = c < GRID_COLS / 2 ? 'left' : 'right';
          if ( Δ >  DROP_THRESHOLD) dropOffs.push({ row: r, col: c, delta:  Δ, side });
          if (-Δ >  STEP_THRESHOLD) stepUps .push({ row: r, col: c, delta: -Δ, side });
        }

        // ── Vertical transitions (current row vs. row above = farther away) ──
        if (r - 1 >= 0 && grid[r - 1]) {
          const Δ = grid[r - 1][c] - row[c];  // positive → cell above is farther
          const side = c < GRID_COLS / 2 ? 'left' : 'right';
          if ( Δ >  DROP_THRESHOLD) dropOffs.push({ row: r, col: c, delta:  Δ, side });
          if (-Δ >  STEP_THRESHOLD) stepUps .push({ row: r, col: c, delta: -Δ, side });
        }
      }
    }

    // Variance of all walking-zone depths
    let variance = 0;
    if (allDepths.length > 0) {
      const mean = allDepths.reduce((s, d) => s + d, 0) / allDepths.length;
      variance   = allDepths.reduce((s, d) => s + Math.pow(d - mean, 2), 0) / allDepths.length;
    }

    return { dropOffs, stepUps, variance };
  }

  /**
   * Canonical physical dimensions of a detection class.
   * Returns { widthM, heightM } — widthM ≈ 60 % of height as a generic heuristic.
   */
  _estimateObjectDimensions(det) {
    const h = CANONICAL_HEIGHTS[det.class];
    if (h) return { widthM: h * 0.6, heightM: h };
    return { widthM: 0.3, heightM: 0.5 };
  }

  _analyzeZones(enriched) {
    const zones = {
      critical: { hasObjects: false, objects: [], minDistance: Infinity },
      near:     { hasObjects: false, objects: [], minDistance: Infinity },
      mid:      { hasObjects: false, objects: [], minDistance: Infinity },
      far:      { hasObjects: false, objects: [], minDistance: Infinity },
    };
    for (const obj of enriched) {
      const d = obj.depth ?? obj.distance ?? Infinity;
      let zone;
      if      (d < ZONE_CRITICAL) zone = 'critical';
      else if (d < ZONE_NEAR)     zone = 'near';
      else if (d < ZONE_MID)      zone = 'mid';
      else                        zone = 'far';
      zones[zone].hasObjects = true;
      zones[zone].objects.push(obj);
      if (d < zones[zone].minDistance) zones[zone].minDistance = d;
    }
    return zones;
  }

  /**
   * Multi-axis stair detection — row, column, and gradient profiles so stairs
   * are found whether the camera looks ahead, down at feet, or along the run.
   */
  _detectStairsFromEdgeSignal(edgeSignal) {
    if (!edgeSignal?.H) {
      return { isStairLike: false, edgeRows: [], edgeCount: 0 };
    }

    const H = edgeSignal.H;
    const analyses = [];

    // Forward / downward view: horizontal edges across rows
    if (edgeSignal.rowMeans?.length >= 6) {
      analyses.push(this._analyzeStairProfile({
        means: edgeSignal.rowMeans,
        edgeEnergy: edgeSignal.rowEdgeEnergy,
        size: H,
        axis: 'row',
        offset: 0,
      }));
    }

    // Bottom crop — original forward-walking path
    if (edgeSignal.bottomRowMeans?.length >= 6) {
      analyses.push(this._analyzeStairProfile({
        means: edgeSignal.bottomRowMeans,
        edgeEnergy: null,
        size: edgeSignal.bottomRowMeans.length,
        axis: 'row',
        offset: edgeSignal.bottomStartRow ?? Math.floor(H * 0.40),
        normDivisor: H,
      }));
    }

    // Parallel / side-on view: vertical edges across columns
    if (edgeSignal.colMeans?.length >= 6) {
      analyses.push(this._analyzeStairProfile({
        means: edgeSignal.colMeans,
        edgeEnergy: edgeSignal.colEdgeEnergy,
        size: edgeSignal.W ?? edgeSignal.colMeans.length,
        axis: 'col',
        offset: 0,
        normDivisor: edgeSignal.W ?? edgeSignal.colMeans.length,
      }));
    }

    const best = analyses
      .filter((a) => a.isStairLike)
      .sort((a, b) => b.edgeCount - a.edgeCount)[0]
      ?? analyses.sort((a, b) => b.edgeCount - a.edgeCount)[0];

    if (!best) {
      return { isStairLike: false, edgeRows: [], edgeCount: 0 };
    }

    return {
      isStairLike: best.isStairLike,
      edgeRows: best.edges,
      edgeCount: best.edgeCount,
      detectionAxis: best.axis,
      isPeriodic: best.isPeriodic,
    };
  }

  /**
   * Find repeating edge patterns in a 1-D brightness or gradient profile.
   */
  _analyzeStairProfile({ means, edgeEnergy, size, axis, offset = 0, normDivisor }) {
    const EDGE_THRESHOLD = 18;
    const MIN_EDGES = 3;
    const MIN_SPACING = 3;
    const normBase = normDivisor ?? size;

    const rawEdges = [];

    // Adjacent mean deltas
    for (let i = 1; i < means.length; i++) {
      const delta = means[i] - means[i - 1];
      if (Math.abs(delta) > EDGE_THRESHOLD) {
        rawEdges.push({
          idx: i,
          normY: axis === 'row' ? (offset + i) / normBase : 0.55,
          normX: axis === 'col' ? (offset + i) / normBase : 0.5,
          delta,
          strength: Math.abs(delta),
          type: delta > 0 ? 'riser' : 'dropoff',
          source: 'mean',
        });
      }
    }

    // Gradient peaks (stronger for parallel/downward angles)
    if (edgeEnergy?.length >= 3) {
      const energies = edgeEnergy;
      let maxE = 0;
      for (const e of energies) maxE = Math.max(maxE, e);
      const peakThreshold = Math.max(EDGE_THRESHOLD * 0.5, maxE * 0.35);
      for (let i = 1; i < energies.length - 1; i++) {
        if (
          energies[i] > peakThreshold
          && energies[i] >= energies[i - 1]
          && energies[i] >= energies[i + 1]
        ) {
          rawEdges.push({
            idx: i,
            normY: axis === 'row' ? (offset + i) / normBase : 0.5 + (i / energies.length) * 0.4,
            normX: axis === 'col' ? (offset + i) / normBase : 0.5,
            delta: energies[i],
            strength: energies[i],
            type: 'riser',
            source: 'gradient',
          });
        }
      }
    }

    // Deduplicate within MIN_SPACING
    rawEdges.sort((a, b) => a.idx - b.idx);
    const edges = [];
    for (const e of rawEdges) {
      const last = edges[edges.length - 1];
      if (!last || e.idx - last.idx >= MIN_SPACING) {
        edges.push(e);
      } else if (e.strength > last.strength) {
        edges[edges.length - 1] = e;
      }
    }

    const isPeriodic = this._hasPeriodicSpacing(edges);
    const requiredEdges = isPeriodic ? MIN_EDGES : 4;

    return {
      isStairLike: edges.length >= requiredEdges,
      edges,
      edgeCount: edges.length,
      axis,
      isPeriodic,
    };
  }

  /** Regularly spaced edges ≈ repeating treads/risers (stair signature). */
  _hasPeriodicSpacing(edges) {
    if (edges.length < 2) return false;
    const sorted = [...edges].sort((a, b) => a.idx - b.idx);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i].idx - sorted[i - 1].idx);
    }
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avg < 3 || avg > 90) return false;
    const variance = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / gaps.length;
    return Math.sqrt(variance) < avg * 0.65;
  }

  /** @deprecated — use _detectStairsFromEdgeSignal */
  _detectStairsFromBrightness(rowMeans, H) {
    return this._detectStairsFromEdgeSignal({
      bottomRowMeans: rowMeans,
      H,
      bottomStartRow: Math.floor(H * 0.40),
    });
  }

  _emptyResult() {
    return {
      grid: this._groundPlaneGrid(),
      groundData: { dropOffs: [], stepUps: [], variance: 0 },
      zones: {
        critical: { hasObjects: false, objects: [], minDistance: Infinity },
        near:     { hasObjects: false, objects: [], minDistance: Infinity },
        mid:      { hasObjects: false, objects: [], minDistance: Infinity },
        far:      { hasObjects: false, objects: [], minDistance: Infinity },
      },
      nearest:     { distance: Infinity, x: 0.5, y: 0.5, object: null },
      mean:        Infinity,
      objectDepths: [],
      isEstimated: true,
    };
  }
}

export default new DepthEstimationService();
