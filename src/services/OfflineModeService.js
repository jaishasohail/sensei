import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../constants/config';

class OfflineModeService {
  constructor() {
    this._useCloud = false;
    this._apiBaseUrl = API_BASE_URL;
  }
  setApiBaseUrl(url) {
    this._apiBaseUrl = url;
  }
  setUseCloud(enabled) {
    this._useCloud = !!enabled;
  }
  useCloud() {
    return this._useCloud;
  }
  async pingServer() {
    const base = this._apiBaseUrl || API_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${base}/api/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const data = await res.json();
      return data?.status === 'ok';
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Offline route caching ───────────────────────────────────────────────────

  /**
   * Persist a route to AsyncStorage under a stable key derived from routeId.
   */
  async cacheRouteData(routeId, routeData) {
    try {
      const key = `@sensei_offline_route_${routeId}`;
      await AsyncStorage.setItem(key, JSON.stringify(routeData));
      return true;
    } catch (e) {
      console.error('[OfflineMode] cacheRouteData error:', e);
      return false;
    }
  }

  /**
   * Retrieve a previously cached route. Returns null if not found or on error.
   */
  async getCachedRoute(routeId) {
    try {
      const key = `@sensei_offline_route_${routeId}`;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error('[OfflineMode] getCachedRoute error:', e);
      return null;
    }
  }

  // ── Offline map tile caching ────────────────────────────────────────────────

  /**
   * Cache a tile array (array of objects) for a named region.
   */
  async cacheMapTiles(region, tiles) {
    try {
      const key = `@sensei_map_tiles_${region}`;
      await AsyncStorage.setItem(key, JSON.stringify(tiles));
      return true;
    } catch (e) {
      console.error('[OfflineMode] cacheMapTiles error:', e);
      return false;
    }
  }

  /**
   * Retrieve cached map tiles for a region. Returns null if not cached.
   */
  async getCachedMapTiles(region) {
    try {
      const key = `@sensei_map_tiles_${region}`;
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error('[OfflineMode] getCachedMapTiles error:', e);
      return null;
    }
  }

  // ── Sync pending offline data when connectivity returns ─────────────────────

  /**
   * If the server is reachable, POST every locally cached route to the sync
   * endpoint, then delete the local copy on success.
   */
  async syncPendingData() {
    try {
      const online = await this.pingServer();
      if (!online) {
        console.log('[OfflineMode] syncPendingData: server unreachable, skipping.');
        return { synced: 0, failed: 0 };
      }

      const allKeys = await AsyncStorage.getAllKeys();
      const routeKeys = allKeys.filter(k => k.startsWith('@sensei_offline_route_'));

      let synced = 0;
      let failed = 0;

      for (const key of routeKeys) {
        try {
          const raw = await AsyncStorage.getItem(key);
          if (!raw) continue;
          const routeData = JSON.parse(raw);

          const res = await fetch(
            `${this._apiBaseUrl || API_BASE_URL}/api/navigation/sync`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(routeData),
            }
          );

          if (res.ok) {
            await AsyncStorage.removeItem(key);
            synced++;
          } else {
            console.warn('[OfflineMode] Sync failed for key:', key, res.status);
            failed++;
          }
        } catch (itemErr) {
          console.error('[OfflineMode] Error syncing key:', key, itemErr);
          failed++;
        }
      }

      console.log(`[OfflineMode] syncPendingData complete — synced: ${synced}, failed: ${failed}`);
      return { synced, failed };
    } catch (e) {
      console.error('[OfflineMode] syncPendingData error:', e);
      return { synced: 0, failed: 0 };
    }
  }

  /**
   * Convenience method — returns true when the server is reachable.
   */
  async isOnline() {
    return this.pingServer();
  }

  // ── Named destination cache (dedup by coordinates) ──────────────────────────

  /**
   * Build a stable storage key from destination coordinates.
   * Rounds to ~100 m precision so nearby re-searches reuse the same entry.
   */
  _makeDestKey(lat, lng) {
    const rLat = Math.round(lat * 1000);
    const rLng = Math.round(lng * 1000);
    return `@sensei_offline_named_${rLat}_${rLng}`;
  }

  /**
   * Cache a full route (dest info + route polyline/steps) to local storage.
   * Silently skips the write if the destination is already cached (dedup).
   *
   * @param {{ name, address, latitude, longitude }} dest
   * @param {object} routeData  – whatever GoogleMapsService returns
   * @returns {{ key: string, alreadyCached: boolean }}
   */
  async cacheRouteForOffline(dest, routeData) {
    try {
      const key = this._makeDestKey(dest.latitude, dest.longitude);
      const existing = await AsyncStorage.getItem(key);
      if (existing) {
        return { key, alreadyCached: true };
      }
      const payload = {
        dest: {
          name: dest.name,
          address: dest.address || '',
          latitude: dest.latitude,
          longitude: dest.longitude,
        },
        routeData,
        cachedAt: new Date().toISOString(),
      };
      await AsyncStorage.setItem(key, JSON.stringify(payload));
      return { key, alreadyCached: false };
    } catch (e) {
      console.error('[OfflineMode] cacheRouteForOffline error:', e);
      return { key: null, alreadyCached: false };
    }
  }

  /**
   * Returns true if a route to the given coordinates is already cached.
   */
  async isRouteCached(lat, lng) {
    try {
      const key = this._makeDestKey(lat, lng);
      const val = await AsyncStorage.getItem(key);
      return val !== null;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve the cached route for given coordinates.
   * Returns null if not cached.
   */
  async getOfflineRoute(lat, lng) {
    try {
      const key = this._makeDestKey(lat, lng);
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error('[OfflineMode] getOfflineRoute error:', e);
      return null;
    }
  }

  /**
   * List all destinations cached for offline use, newest first.
   */
  async listOfflineRoutes() {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const namedKeys = allKeys.filter(k => k.startsWith('@sensei_offline_named_'));
      if (namedKeys.length === 0) return [];
      const pairs = await AsyncStorage.multiGet(namedKeys);
      const result = pairs
        .map(([, raw]) => {
          if (!raw) return null;
          try {
            const data = JSON.parse(raw);
            return { dest: data.dest, cachedAt: data.cachedAt };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.cachedAt) - new Date(a.cachedAt));
      return result;
    } catch (e) {
      console.error('[OfflineMode] listOfflineRoutes error:', e);
      return [];
    }
  }

  /**
   * Remove a cached offline route by destination coordinates.
   */
  async removeOfflineRoute(lat, lng) {
    try {
      const key = this._makeDestKey(lat, lng);
      await AsyncStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error('[OfflineMode] removeOfflineRoute error:', e);
      return false;
    }
  }
}

export default new OfflineModeService();
