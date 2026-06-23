/**
 * IndoorNavigationService
 *
 * Graph-based indoor navigation for SENSEI.
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 *
 * A building is modelled as a GRAPH, not a pixel grid.
 * Nodes  = physical landmarks (rooms, doors, staircases, corridors)
 * Edges  = walkable connections between nodes (stored with distance + heading)
 *
 * This is deliberately simpler than a grid map because:
 *  1. Users define it entirely by voice — they can't draw a grid map by talking.
 *  2. A phone's GPS (±5 m indoors) is too coarse for grid navigation.
 *  3. Graph edges naturally express "walk 10 m then turn right at the door".
 *
 * ── BUILDING DATA STRUCTURE ───────────────────────────────────────────────────
 *
 * Building {
 *   id, name, entrance:{lat,lng}, createdAt
 *   floors: {
 *     [floorNum]: {
 *       name,
 *       nodes: { [nodeId]: Node },
 *       edges: Edge[]
 *     }
 *   }
 * }
 *
 * Node {
 *   id, name, type, latitude, longitude, floor, description,
 *   connectsFloors?   — for staircases/elevators: array of floor numbers
 * }
 *
 * Edge {
 *   from, to,          — node IDs
 *   distanceM,         — metres
 *   heading,           — degrees 0–360 (direction to walk FROM→TO)
 *   instruction        — pre-built "Walk north for 8 m past the blue door"
 * }
 *
 * ── SELF-LOCALISATION ────────────────────────────────────────────────────────
 *
 * GPS is used to match the user to the nearest node in the active building.
 * The user can also say "I am at [node name]" for precise localisation when
 * GPS accuracy is poor.
 *
 * ── PATHFINDING ──────────────────────────────────────────────────────────────
 *
 * Dijkstra on the building graph (sufficient for small indoor graphs).
 * Multi-floor routes pass through staircase/elevator nodes.
 *
 * Storage key: '@sensei_indoor_buildings'
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@sensei_indoor_buildings';
const ACTIVE_KEY  = '@sensei_indoor_active';

// ─── Landmark types ───────────────────────────────────────────────────────────
export const NODE_TYPES = {
  ROOM:       'room',
  DOOR:       'door',
  STAIRCASE:  'staircase',
  ELEVATOR:   'elevator',
  CORRIDOR:   'corridor',
  ENTRANCE:   'entrance',
  TOILET:     'toilet',
  KITCHEN:    'kitchen',
  OFFICE:     'office',
  EMERGENCY_EXIT: 'emergency_exit',
  CUSTOM:     'custom',
};

// ─── Haversine (metres) ───────────────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing in degrees from point A to point B (0 = North, clockwise). */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** Convert a bearing to a spoken direction phrase. */
function bearingToPhrase(deg) {
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return dirs[Math.round(deg / 45) % 8];
}

/** Turn instruction between two consecutive headings. */
function turnInstruction(prevHeading, nextHeading) {
  if (prevHeading === null) return null;
  let diff = ((nextHeading - prevHeading) + 360) % 360;
  if (diff < 30 || diff > 330) return null;          // straight ahead
  if (diff >= 30  && diff < 75)  return 'bear right';
  if (diff >= 75  && diff < 120) return 'turn right';
  if (diff >= 120 && diff < 180) return 'turn sharp right';
  if (diff >= 180 && diff < 240) return 'turn sharp left';
  if (diff >= 240 && diff < 285) return 'turn left';
  if (diff >= 285 && diff < 330) return 'bear left';
  return 'turn around';
}

/** Normalise a string for fuzzy comparison. */
function norm(s) { return (s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); }

// ─────────────────────────────────────────────────────────────────────────────

class IndoorNavigationService {
  constructor() {
    /** @type {Map<string, object>} buildingId → building */
    this.buildings = new Map();
    this._initialized = false;

    // ── Active navigation session ─────────────────────────────────────────
    this.activeBuilding   = null;   // building object
    this.activeFloor      = 0;
    this.currentNodeId    = null;   // user's best-known position
    this.navigationSteps  = [];     // [{instruction, nodeId, distanceM, heading}]
    this.currentStepIndex = 0;
    this.isNavigating     = false;
    this.destination      = null;   // target node

    // ── Mapping mode ──────────────────────────────────────────────────────
    this.isMappingMode    = false;
    this.mappingBuilding  = null;   // building being mapped
    this.lastMappedNodeId = null;   // for auto-connecting consecutive marks

    // ── Callbacks ─────────────────────────────────────────────────────────
    this._onStep    = null;   // (stepInfo) → void
    this._onArrival = null;   // (dest) → void
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize() {
    if (this._initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        for (const b of arr) this.buildings.set(b.id, b);
      }
      // Restore active building reference (id only) across restarts
      const activeId = await AsyncStorage.getItem(ACTIVE_KEY);
      if (activeId && this.buildings.has(activeId)) {
        this.activeBuilding = this.buildings.get(activeId);
      }
    } catch (e) {
      console.error('IndoorNavigationService: init error', e);
    }
    this._initialized = true;
    console.log(`IndoorNavigationService: loaded ${this.buildings.size} buildings`);
  }

  // ── Callback registration ──────────────────────────────────────────────────
  onStep(fn)    { this._onStep    = fn; }
  onArrival(fn) { this._onArrival = fn; }

  // ────────────────────────────────────────────────────────────────────────────
  // BUILDING CREATION & MAPPING
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Start mapping a new building.
   * Call this when the user is standing at the building entrance.
   *
   * @param {string} name      Building name
   * @param {object} location  { latitude, longitude }
   * @returns {object}         The new building object
   */
  async startMapping(name, location) {
    await this.initialize();

    const building = {
      id:        `bld_${Date.now()}`,
      name:      name.trim(),
      entrance:  { latitude: location.latitude, longitude: location.longitude },
      createdAt: new Date().toISOString(),
      floors: {
        0: {
          name:  'Ground Floor',
          nodes: {},
          edges: [],
        },
      },
    };

    // Auto-create the entrance node at the current position
    const entranceNode = this._createNode({
      building,
      floor:    0,
      name:     'Entrance',
      type:     NODE_TYPES.ENTRANCE,
      location,
    });
    building.floors[0].nodes[entranceNode.id] = entranceNode;
    this.lastMappedNodeId = entranceNode.id;

    this.buildings.set(building.id, building);
    this.mappingBuilding = building;
    this.isMappingMode   = true;

    await this._persist();
    console.log(`IndoorNavigationService: mapping started for "${name}" (${building.id})`);
    return { building, entranceNode };
  }

  /**
   * Add a named landmark at the user's current GPS position.
   * Automatically connects it to the last-mapped node with a straight-line edge.
   *
   * @param {string} name      Landmark name
   * @param {string} type      One of NODE_TYPES values
   * @param {object} location  { latitude, longitude }
   * @param {object} [opts]    { floor?, connectsFloors?, description? }
   */
  async markLandmark(name, type, location, opts = {}) {
    await this.initialize();

    const building = this.mappingBuilding ?? this.activeBuilding;
    if (!building) throw new Error('No active or mapping building');

    const floor = opts.floor ?? this.activeFloor ?? 0;
    if (!building.floors[floor]) {
      building.floors[floor] = {
        name:  floor === 0 ? 'Ground Floor' : `Floor ${floor}`,
        nodes: {},
        edges: [],
      };
    }

    const node = this._createNode({ building, floor, name, type, location, opts });
    building.floors[floor].nodes[node.id] = node;

    // Auto-connect to previous landmark on the same floor
    if (this.lastMappedNodeId) {
      const prevNode = this._findNodeById(building, this.lastMappedNodeId);
      if (prevNode && prevNode.floor === floor) {
        this._addEdge(building, floor, prevNode, node);
      }
    }
    this.lastMappedNodeId = node.id;

    await this._persist();
    console.log(`IndoorNavigationService: marked ${type} "${name}" at floor ${floor}`);
    return node;
  }

  /**
   * Manually connect two landmarks by name.
   * Creates bidirectional edges.
   */
  async connectLandmarks(nameA, nameB, floor) {
    await this.initialize();
    const building = this.mappingBuilding ?? this.activeBuilding;
    if (!building) throw new Error('No active building');

    const floorNum = floor ?? this.activeFloor ?? 0;
    const nodeA = this._findNodeByName(building, nameA, floorNum);
    const nodeB = this._findNodeByName(building, nameB, floorNum);
    if (!nodeA || !nodeB) return null;

    this._addEdge(building, floorNum, nodeA, nodeB);
    await this._persist();
    return { nodeA, nodeB };
  }

  /**
   * Finish mapping mode and save the building.
   */
  async finishMapping() {
    if (!this.mappingBuilding) return null;
    const building = this.mappingBuilding;
    this.mappingBuilding  = null;
    this.isMappingMode    = false;
    this.lastMappedNodeId = null;
    await this._persist();
    console.log(`IndoorNavigationService: mapping finished for "${building.name}"`);
    return building;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ACTIVE BUILDING SELECTION & SELF-LOCALISATION
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Detect if the user is near a known building entrance (within radiusM).
   * Returns the closest building or null.
   */
  async detectNearbyBuilding(latitude, longitude, radiusM = 80) {
    await this.initialize();
    let closest = null, closestDist = Infinity;
    for (const [, b] of this.buildings) {
      const d = haversineM(latitude, longitude, b.entrance.latitude, b.entrance.longitude);
      if (d < radiusM && d < closestDist) {
        closestDist = d;
        closest = b;
      }
    }
    return closest ? { building: closest, distanceM: closestDist } : null;
  }

  /**
   * Set the active building (auto-called when user enters a building).
   */
  async setActiveBuilding(buildingId, floor = 0) {
    await this.initialize();
    const building = this.buildings.get(buildingId);
    if (!building) return false;
    this.activeBuilding = building;
    this.activeFloor    = floor;
    await AsyncStorage.setItem(ACTIVE_KEY, buildingId);
    console.log(`IndoorNavigationService: active building → "${building.name}" floor ${floor}`);
    return true;
  }

  exitBuilding() {
    this.activeBuilding  = null;
    this.currentNodeId   = null;
    this.isNavigating    = false;
    AsyncStorage.removeItem(ACTIVE_KEY).catch(() => {});
  }

  /**
   * Self-localise: find nearest node to GPS position in the active building.
   * Returns { node, distanceM } or null.
   */
  getNearestNode(latitude, longitude, floor) {
    const building = this.activeBuilding;
    if (!building) return null;
    const floorNum = floor ?? this.activeFloor ?? 0;
    const floorData = building.floors[floorNum];
    if (!floorData) return null;

    let nearest = null, nearestDist = Infinity;
    for (const node of Object.values(floorData.nodes)) {
      const d = haversineM(latitude, longitude, node.latitude, node.longitude);
      if (d < nearestDist) { nearestDist = d; nearest = node; }
    }
    if (nearest) {
      this.currentNodeId = nearest.id;
      return { node: nearest, distanceM: nearestDist };
    }
    return null;
  }

  /**
   * Explicit self-localisation: user says "I am at [name]".
   */
  setCurrentNode(nodeName) {
    const building = this.activeBuilding;
    if (!building) return null;
    const node = this._findNodeByName(building, nodeName, this.activeFloor);
    if (node) {
      this.currentNodeId = node.id;
      this.activeFloor   = node.floor;
      console.log(`IndoorNavigationService: user self-localised → "${node.name}"`);
    }
    return node;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PATHFINDING & NAVIGATION
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Start indoor navigation to a named destination.
   *
   * Runs Dijkstra on the building graph.  Multi-floor routes automatically
   * route through staircase / elevator nodes.
   *
   * @param {string} destinationName
   * @param {object} [fromLocation]  GPS coords to auto-localise from (optional)
   * @returns {{ steps, destination, totalDistanceM } | null}
   */
  async navigateTo(destinationName, fromLocation = null) {
    await this.initialize();
    const building = this.activeBuilding;
    if (!building) return null;

    // Self-localise from GPS if provided
    if (fromLocation && !this.currentNodeId) {
      this.getNearestNode(fromLocation.latitude, fromLocation.longitude, this.activeFloor);
    }

    // Find destination node across all floors
    const destNode = this._findNodeByName(building, destinationName);
    if (!destNode) {
      console.warn(`IndoorNavigationService: destination "${destinationName}" not found`);
      return null;
    }

    // Find start node
    let startNode = this.currentNodeId
      ? this._findNodeById(building, this.currentNodeId)
      : null;

    // Fallback: nearest node to building entrance
    if (!startNode) {
      const entranceFloor = building.floors[0];
      const entranceNode  = Object.values(entranceFloor?.nodes ?? {})
        .find(n => n.type === NODE_TYPES.ENTRANCE);
      startNode = entranceNode ?? Object.values(entranceFloor?.nodes ?? {})[0] ?? null;
    }

    if (!startNode || startNode.id === destNode.id) {
      return startNode ? { steps: [], destination: destNode, totalDistanceM: 0 } : null;
    }

    // ── Dijkstra ────────────────────────────────────────────────────────────
    const path = this._dijkstra(building, startNode, destNode);
    if (!path) {
      console.warn(`IndoorNavigationService: no path from "${startNode.name}" to "${destNode.name}"`);
      return null;
    }

    // ── Build spoken step instructions ──────────────────────────────────────
    const steps = this._buildSteps(building, path);

    this.navigationSteps  = steps;
    this.currentStepIndex = 0;
    this.isNavigating     = true;
    this.destination      = destNode;

    const totalDistanceM = steps.reduce((s, st) => s + (st.distanceM ?? 0), 0);

    console.log(`IndoorNavigationService: route to "${destNode.name}" — ${steps.length} steps, ${totalDistanceM.toFixed(0)} m`);
    return { steps, destination: destNode, totalDistanceM };
  }

  /** Return the current step. */
  getCurrentStep() {
    return this.navigationSteps[this.currentStepIndex] ?? null;
  }

  /**
   * Advance to the next step (call when GPS shows user reached the current node).
   * Calls _onStep callback with the new step.
   * Calls _onArrival when the last step is reached.
   */
  advanceStep() {
    if (!this.isNavigating) return null;

    this.currentStepIndex++;
    if (this.currentStepIndex >= this.navigationSteps.length) {
      this.isNavigating = false;
      if (this._onArrival) this._onArrival(this.destination);
      return null;
    }

    const step = this.navigationSteps[this.currentStepIndex];
    if (this._onStep) this._onStep(step);
    return step;
  }

  /**
   * Check if the user has reached the current step's node.
   * Call this on every GPS update.
   */
  checkProgress(latitude, longitude) {
    if (!this.isNavigating) return null;
    const step = this.getCurrentStep();
    if (!step?.node) return null;

    const dist = haversineM(latitude, longitude, step.node.latitude, step.node.longitude);
    if (dist < 8) {   // within 8 m = reached the node
      this.currentNodeId = step.node.id;
      this.activeFloor   = step.node.floor;
      return this.advanceStep();
    }
    return null;
  }

  stopNavigation() {
    this.isNavigating    = false;
    this.navigationSteps = [];
    this.currentStepIndex = 0;
    this.destination     = null;
  }

  // ── Read-only accessors ────────────────────────────────────────────────────

  async getAllBuildings() {
    await this.initialize();
    return Array.from(this.buildings.values());
  }

  async getBuilding(id) {
    await this.initialize();
    return this.buildings.get(id) ?? null;
  }

  async getBuildingNodes(buildingId, floor = null) {
    await this.initialize();
    const b = this.buildings.get(buildingId);
    if (!b) return [];
    if (floor !== null) {
      return Object.values(b.floors[floor]?.nodes ?? {});
    }
    return Object.values(b.floors).flatMap(f => Object.values(f.nodes));
  }

  async deleteBuilding(id) {
    await this.initialize();
    this.buildings.delete(id);
    if (this.activeBuilding?.id === id) this.exitBuilding();
    await this._persist();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ────────────────────────────────────────────────────────────────────────────

  _createNode({ building, floor, name, type, location, opts = {} }) {
    return {
      id:           `nd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name:         name.trim(),
      type:         type ?? NODE_TYPES.CUSTOM,
      latitude:     location.latitude,
      longitude:    location.longitude,
      floor,
      description:  opts.description ?? null,
      connectsFloors: type === NODE_TYPES.STAIRCASE || type === NODE_TYPES.ELEVATOR
        ? (opts.connectsFloors ?? [floor])
        : null,
    };
  }

  _addEdge(building, floor, nodeA, nodeB) {
    const distanceM = haversineM(nodeA.latitude, nodeA.longitude, nodeB.latitude, nodeB.longitude);
    const headingAB = bearingDeg(nodeA.latitude, nodeA.longitude, nodeB.latitude, nodeB.longitude);
    const headingBA = bearingDeg(nodeB.latitude, nodeB.longitude, nodeA.latitude, nodeA.longitude);

    const floorData = building.floors[floor];
    // Bidirectional edges
    floorData.edges.push({
      from:        nodeA.id,
      to:          nodeB.id,
      distanceM,
      heading:     headingAB,
      instruction: `Walk ${bearingToPhrase(headingAB)} for ${Math.round(distanceM)} metres`,
    });
    floorData.edges.push({
      from:        nodeB.id,
      to:          nodeA.id,
      distanceM,
      heading:     headingBA,
      instruction: `Walk ${bearingToPhrase(headingBA)} for ${Math.round(distanceM)} metres`,
    });
  }

  _findNodeById(building, nodeId) {
    for (const floor of Object.values(building.floors)) {
      if (floor.nodes[nodeId]) return floor.nodes[nodeId];
    }
    return null;
  }

  _findNodeByName(building, name, preferFloor = null) {
    const q = norm(name);
    let best = null, bestScore = 0;

    for (const floor of Object.values(building.floors)) {
      for (const node of Object.values(floor.nodes)) {
        const p = norm(node.name);
        let score = 0;
        if (p === q) score = 1.0;
        else if (p.includes(q) || q.includes(p)) score = 0.9;
        else {
          const qw = new Set(q.split(/\s+/));
          const pw = p.split(/\s+/);
          const overlap = pw.filter(w => qw.has(w)).length;
          if (overlap > 0) score = 0.7 + 0.2 * (overlap / Math.max(qw.size, pw.length));
        }
        // Prefer current floor
        if (preferFloor !== null && node.floor === preferFloor) score += 0.05;
        if (score > bestScore) { bestScore = score; best = node; }
      }
    }
    return bestScore > 0.4 ? best : null;
  }

  /**
   * Dijkstra's algorithm on the building graph.
   * Returns ordered array of nodes from start to dest, or null if unreachable.
   */
  _dijkstra(building, startNode, destNode) {
    // Build adjacency list across all floors (staircase nodes bridge floors)
    const adj = new Map();
    for (const floor of Object.values(building.floors)) {
      for (const edge of floor.edges) {
        if (!adj.has(edge.from)) adj.set(edge.from, []);
        adj.get(edge.from).push(edge);
      }
    }
    // Cross-floor connections via staircase/elevator nodes
    for (const floor of Object.values(building.floors)) {
      for (const node of Object.values(floor.nodes)) {
        if (node.connectsFloors && node.connectsFloors.length > 1) {
          for (const otherFloor of node.connectsFloors) {
            if (otherFloor === node.floor) continue;
            const floorData = building.floors[otherFloor];
            if (!floorData) continue;
            // Find the matching staircase node on the other floor
            const partner = Object.values(floorData.nodes).find(n =>
              (n.type === NODE_TYPES.STAIRCASE || n.type === NODE_TYPES.ELEVATOR) &&
              norm(n.name) === norm(node.name)
            );
            if (partner) {
              const floorDiff = Math.abs(otherFloor - node.floor);
              if (!adj.has(node.id)) adj.set(node.id, []);
              adj.get(node.id).push({
                from:        node.id,
                to:          partner.id,
                distanceM:   floorDiff * 4,   // ~4 m per floor on stairs
                heading:     null,
                instruction: otherFloor > node.floor
                  ? `Take the ${node.type} up to floor ${otherFloor}`
                  : `Take the ${node.type} down to floor ${otherFloor}`,
                crossFloor:  true,
                toFloor:     otherFloor,
              });
            }
          }
        }
      }
    }

    // Dijkstra
    const dist   = new Map([[startNode.id, 0]]);
    const prev   = new Map();
    const prevEdge = new Map();
    const visited = new Set();
    const queue  = [{ id: startNode.id, cost: 0 }];

    while (queue.length > 0) {
      queue.sort((a, b) => a.cost - b.cost);
      const { id: u } = queue.shift();
      if (visited.has(u)) continue;
      visited.add(u);

      if (u === destNode.id) break;

      for (const edge of (adj.get(u) ?? [])) {
        const alt = (dist.get(u) ?? Infinity) + edge.distanceM;
        if (alt < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, alt);
          prev.set(edge.to, u);
          prevEdge.set(edge.to, edge);
          queue.push({ id: edge.to, cost: alt });
        }
      }
    }

    if (!dist.has(destNode.id)) return null;

    // Reconstruct path
    const path = [];
    let cur = destNode.id;
    while (cur !== undefined) {
      const node = this._findNodeById(building, cur);
      const edge = prevEdge.get(cur) ?? null;
      path.unshift({ node, edge });
      cur = prev.get(cur);
    }
    return path;
  }

  /**
   * Convert a Dijkstra path to human-readable spoken steps.
   */
  _buildSteps(building, path) {
    const steps = [];
    let prevHeading = null;

    for (let i = 0; i < path.length; i++) {
      const { node, edge } = path[i];
      if (!edge) continue;   // first node has no incoming edge

      const turn = turnInstruction(prevHeading, edge.heading);
      let instruction = '';

      if (edge.crossFloor) {
        // Floor transition
        instruction = edge.instruction;
      } else {
        // Same-floor movement
        const distStr = edge.distanceM < 3
          ? `a few steps`
          : `${Math.round(edge.distanceM)} metres`;
        const dirStr = edge.heading !== null ? ` heading ${bearingToPhrase(edge.heading)}` : '';
        instruction = turn
          ? `${turn}, then walk ${distStr}${dirStr}`
          : `Walk ${distStr}${dirStr}`;
      }

      // Landmark mention
      const landmarkSuffix = this._landmarkSuffix(node);
      if (landmarkSuffix) instruction += landmarkSuffix;

      steps.push({
        instruction,
        node,
        distanceM: edge.distanceM,
        heading:   edge.heading,
        isFinal:   i === path.length - 1,
      });

      if (edge.heading !== null) prevHeading = edge.heading;
    }

    // Final arrival step
    const dest = path[path.length - 1]?.node;
    if (dest) {
      steps.push({
        instruction: `You have arrived at ${dest.name}`,
        node:        dest,
        distanceM:   0,
        isFinal:     true,
        isArrival:   true,
      });
    }

    return steps;
  }

  _landmarkSuffix(node) {
    switch (node.type) {
      case NODE_TYPES.DOOR:       return `. Pass through the ${node.name}.`;
      case NODE_TYPES.STAIRCASE:  return `. Staircase is ahead.`;
      case NODE_TYPES.ELEVATOR:   return `. Elevator is on your left.`;
      case NODE_TYPES.ROOM:       return `. The ${node.name} is on your right.`;
      default: return null;
    }
  }

  async _persist() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(this.buildings.values())));
    } catch (e) {
      console.error('IndoorNavigationService: persist error', e);
    }
  }
}

export default new IndoorNavigationService();
