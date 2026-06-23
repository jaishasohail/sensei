/**
 * PinnedLocationService
 *
 * Persistent named-location storage for SENSEI.
 *
 * Pins are named GPS positions (or indoor landmarks) that users create via
 * voice ("pin my location as washroom").  The service provides smart fuzzy
 * matching so natural phrases like "the washroom", "men's bathroom", or
 * "restroom" all resolve to the same pin even if it was saved as "washroom".
 *
 * Storage layout:
 *   AsyncStorage key: '@sensei_pinned_locations'
 *   Value: JSON array of PinEntry objects
 *
 * PinEntry shape:
 * {
 *   id:         string   — unique identifier (timestamp-based)
 *   name:       string   — user-provided name (lowercase normalised)
 *   displayName:string   — original capitalisation for display/TTS
 *   latitude:   number
 *   longitude:  number
 *   floor:      number|null  — floor number for indoor pins
 *   buildingId: string|null  — reference to IndoorNavigationService building
 *   address:    string|null  — optional reverse-geocoded address
 *   savedAt:    string   — ISO date string
 *   useCount:   number   — how many times navigated to this pin
 *   lastUsed:   string|null  — ISO date of last navigation
 *   tags:       string[] — synonym words for fuzzy matching
 * }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@sensei_pinned_locations';

// ─── Synonym groups — words in the same group resolve to each other ──────────
// Allows "washroom", "bathroom", "restroom", "toilet" to all match a pin
// named "washroom".
const SYNONYM_GROUPS = [
  ['washroom', 'bathroom', 'restroom', 'toilet', 'wc', 'lavatory', 'loo'],
  ['kitchen', 'kitchenette', 'cafeteria', 'canteen', 'cafe', 'break room'],
  ['office', 'room', 'workspace'],
  ['entrance', 'entry', 'exit', 'door', 'gate', 'lobby'],
  ['stairs', 'staircase', 'stairway', 'stairwell', 'steps'],
  ['elevator', 'lift', 'escalator'],
  ['parking', 'car park', 'garage'],
  ['hall', 'corridor', 'hallway', 'passage', 'aisle'],
  ['meeting room', 'conference room', 'boardroom'],
  ['reception', 'front desk', 'welcome desk'],
];

function buildSynonymMap() {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      map.set(word, group);
    }
  }
  return map;
}
const SYNONYM_MAP = buildSynonymMap();

/** Get synonym group for a word, or return just the word itself. */
function getSynonyms(word) {
  return SYNONYM_MAP.get(word.toLowerCase()) ?? [word.toLowerCase()];
}

/** Levenshtein distance for fuzzy string matching. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalise a phrase for matching: lowercase, strip punctuation, trim. */
function normalise(text) {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

/**
 * Score how well a query matches a pin name (0 = no match, 1 = perfect).
 * Combines: exact, contains, word-overlap, synonym expansion, Levenshtein.
 */
function matchScore(query, pin) {
  const q = normalise(query);
  const p = normalise(pin.name);

  if (!q || !p) return 0;

  // Exact match
  if (q === p) return 1.0;

  // One contains the other
  if (p.includes(q) || q.includes(p)) return 0.92;

  const qWords = q.split(/\s+/).filter(w => w.length > 1);
  const pWords = p.split(/\s+/).filter(w => w.length > 1);

  // Check synonym expansion: expand each query word to its synonym group
  for (const qw of qWords) {
    const synonyms = getSynonyms(qw);
    for (const syn of synonyms) {
      if (p.includes(syn)) return 0.88;
      for (const pw of pWords) {
        if (syn === pw) return 0.90;
      }
    }
  }

  // Also check pin tags
  if (pin.tags?.length) {
    for (const tag of pin.tags) {
      const t = normalise(tag);
      if (t === q || t.includes(q) || q.includes(t)) return 0.87;
    }
  }

  // Word overlap ratio
  const qSet = new Set(qWords);
  const overlap = pWords.filter(w => qSet.has(w)).length;
  if (overlap > 0) {
    return 0.70 + 0.15 * (overlap / Math.max(qWords.length, pWords.length));
  }

  // Levenshtein similarity for short strings
  if (q.length <= 20 && p.length <= 20) {
    const maxLen = Math.max(q.length, p.length);
    const sim = 1 - levenshtein(q, p) / maxLen;
    if (sim >= 0.65) return sim * 0.80;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────

class PinnedLocationService {
  constructor() {
    /** @type {Array<Object>} */
    this.pins = [];
    this._initialized = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize() {
    if (this._initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      this.pins = raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('PinnedLocationService: init error', e);
      this.pins = [];
    }
    this._initialized = true;
    console.log(`PinnedLocationService: loaded ${this.pins.length} pins`);
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Save a named pin at the given location.
   * If a pin with the same name already exists it is updated in place.
   *
   * @param {string} name      User-provided name, e.g. "Washroom"
   * @param {object} location  { latitude, longitude, floor?, buildingId? }
   * @param {object} [opts]    { address?, tags? }
   * @returns {object}         The saved pin entry
   */
  async savePin(name, location, opts = {}) {
    await this.initialize();

    const displayName = name.trim();
    const normName = normalise(displayName);

    // Upsert: find existing pin with same name
    const existingIdx = this.pins.findIndex(p => normalise(p.name) === normName);

    const pin = {
      id:          existingIdx >= 0 ? this.pins[existingIdx].id : `pin_${Date.now()}`,
      name:        normName,
      displayName,
      latitude:    location.latitude,
      longitude:   location.longitude,
      floor:       location.floor ?? null,
      buildingId:  location.buildingId ?? null,
      address:     opts.address ?? null,
      savedAt:     new Date().toISOString(),
      useCount:    existingIdx >= 0 ? (this.pins[existingIdx].useCount ?? 0) : 0,
      lastUsed:    existingIdx >= 0 ? this.pins[existingIdx].lastUsed : null,
      tags:        opts.tags ?? [],
    };

    if (existingIdx >= 0) {
      this.pins[existingIdx] = pin;
    } else {
      this.pins.unshift(pin);
    }

    await this._persist();
    console.log(`PinnedLocationService: saved pin "${displayName}" at`, location.latitude, location.longitude);
    return pin;
  }

  /**
   * Increment use count for a pin (call when user navigates to it).
   */
  async recordUsage(pinId) {
    await this.initialize();
    const pin = this.pins.find(p => p.id === pinId);
    if (pin) {
      pin.useCount = (pin.useCount ?? 0) + 1;
      pin.lastUsed = new Date().toISOString();
      await this._persist();
    }
  }

  /**
   * Delete a pin by name.
   */
  async deletePin(name) {
    await this.initialize();
    const before = this.pins.length;
    this.pins = this.pins.filter(p => normalise(p.name) !== normalise(name));
    if (this.pins.length < before) {
      await this._persist();
      return true;
    }
    return false;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find the best-matching pin for a natural-language query.
   * Returns the pin object or null if confidence is too low.
   *
   * @param {string}  query       E.g. "the washroom", "men's bathroom", "washroom"
   * @param {number}  [threshold] Minimum score to return a result (default 0.55)
   */
  async findPin(query, threshold = 0.55) {
    await this.initialize();
    if (!query || this.pins.length === 0) return null;

    let best = null;
    let bestScore = 0;

    for (const pin of this.pins) {
      const score = matchScore(query, pin);
      if (score > bestScore) {
        bestScore = score;
        best = pin;
      }
    }

    if (bestScore >= threshold) {
      console.log(`PinnedLocationService: matched "${query}" → "${best.displayName}" (score ${bestScore.toFixed(2)})`);
      return best;
    }
    return null;
  }

  /**
   * Return all pins that score above a threshold for a query.
   * Useful when multiple matches exist and we need to disambiguate.
   */
  async findPins(query, threshold = 0.55) {
    await this.initialize();
    if (!query || this.pins.length === 0) return [];

    return this.pins
      .map(pin => ({ pin, score: matchScore(query, pin) }))
      .filter(({ score }) => score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map(({ pin }) => pin);
  }

  /**
   * Return all saved pins sorted by most recently used.
   */
  async getAllPins() {
    await this.initialize();
    return [...this.pins].sort((a, b) => {
      const aTime = a.lastUsed ?? a.savedAt;
      const bTime = b.lastUsed ?? b.savedAt;
      return bTime > aTime ? 1 : -1;
    });
  }

  /**
   * Return pins belonging to a specific building.
   */
  async getPinsForBuilding(buildingId) {
    await this.initialize();
    return this.pins.filter(p => p.buildingId === buildingId);
  }

  /**
   * Return the nearest pin to a GPS location within a radius (metres).
   */
  async getNearestPin(latitude, longitude, radiusMetres = 200) {
    await this.initialize();
    let nearest = null;
    let nearestDist = Infinity;

    for (const pin of this.pins) {
      const d = haversineMetres(latitude, longitude, pin.latitude, pin.longitude);
      if (d < radiusMetres && d < nearestDist) {
        nearestDist = d;
        nearest = pin;
      }
    }
    return nearest ? { pin: nearest, distance: nearestDist } : null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _persist() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.pins));
    } catch (e) {
      console.error('PinnedLocationService: persist error', e);
    }
  }
}

// ─── Haversine helper (metres between two GPS coords) ─────────────────────────
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default new PinnedLocationService();
