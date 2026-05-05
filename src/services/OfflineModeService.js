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
    try {
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) return false;
      const data = await res.json();
      return data?.status === 'ok';
    } catch (e) {
      return false;
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
}

export default new OfflineModeService();
