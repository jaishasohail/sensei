import AsyncStorage from '@react-native-async-storage/async-storage';
import LocationService from './LocationService';
import TextToSpeechService from './TextToSpeechService';
class RouteMemoryService {
  constructor() {
    this.savedRoutes = [];
    this.currentRecording = null;
    this.routeHistory = [];
    this.frequentDestinations = [];
    // Named recent searches — stores { name, address, latitude, longitude, searchedAt }
    // so the navigation screen can display real place names (not just coordinates).
    this.recentSearches = [];
    this.storageKey = '@sensei_route_memory';
    this.initialized = false;
  }
  async initialize() {
    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        this.savedRoutes = data.routes || [];
        this.routeHistory = data.history || [];
        this.frequentDestinations = data.destinations || [];
        this.recentSearches = data.recentSearches || [];
      }
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('Route memory initialization error:', error);
      return false;
    }
  }
  async startRecording(routeName) {
    try {
      const startLocation = await LocationService.getCurrentLocation();
      this.currentRecording = {
        id: Date.now() + Math.random(),
        name: routeName || `Route ${new Date().toLocaleDateString()}`,
        startLocation,
        waypoints: [startLocation],
        startTime: new Date(),
        distance: 0,
        landmarks: []
      };
      await TextToSpeechService.speak(`Recording route: ${this.currentRecording.name}`);
      return this.currentRecording;
    } catch (error) {
      console.error('Route recording error:', error);
      return null;
    }
  }
  async addWaypoint(location, landmark = null) {
    if (!this.currentRecording) {
      return null;
    }
    const waypoint = location || await LocationService.getCurrentLocation();
    const lastWaypoint = this.currentRecording.waypoints[this.currentRecording.waypoints.length - 1];
    const segmentDistance = LocationService.calculateDistance(
      lastWaypoint.latitude,
      lastWaypoint.longitude,
      waypoint.latitude,
      waypoint.longitude
    );
    this.currentRecording.waypoints.push(waypoint);
    this.currentRecording.distance += segmentDistance;
    if (landmark) {
      this.currentRecording.landmarks.push({
        location: waypoint,
        description: landmark,
        timestamp: new Date()
      });
    }
    return waypoint;
  }
  async stopRecording() {
    if (!this.currentRecording) {
      return null;
    }
    const endLocation = await LocationService.getCurrentLocation();
    this.currentRecording.endLocation = endLocation;
    this.currentRecording.endTime = new Date();
    this.currentRecording.duration = 
      (this.currentRecording.endTime - this.currentRecording.startTime) / 1000; 
    await this.saveRoute(this.currentRecording);
    await TextToSpeechService.speak(
      `Route saved: ${this.currentRecording.name}. Distance: ${(this.currentRecording.distance || 0).toFixed(0)} meters`
    );
    const savedRoute = this.currentRecording;
    this.currentRecording = null;
    return savedRoute;
  }
  async saveRoute(route) {
    try {
      route.savedAt = new Date();
      route.useCount = 0;
      route.lastUsed = null;
      this.savedRoutes.push(route);
      this.updateFrequentDestinations(route.endLocation);
      await this.persist();
      return route;
    } catch (error) {
      console.error('Save route error:', error);
      return null;
    }
  }
  getSavedRoutes() {
    return this.savedRoutes.sort((a, b) => 
      new Date(b.savedAt) - new Date(a.savedAt)
    );
  }
  getRoute(routeId) {
    return this.savedRoutes.find(r => r.id === routeId);
  }
  getRouteByName(name) {
    return this.savedRoutes.find(r => 
      r.name.toLowerCase().includes(name.toLowerCase())
    );
  }
  async findSimilarRoutes(currentLocation, radiusMeters = 50) {
    const location = currentLocation || await LocationService.getCurrentLocation();
    return this.savedRoutes.filter(route => {
      const distanceToStart = LocationService.calculateDistance(
        location.latitude,
        location.longitude,
        route.startLocation.latitude,
        route.startLocation.longitude
      );
      return distanceToStart <= radiusMeters;
    }).sort((a, b) => b.useCount - a.useCount);
  }
  getFrequentRoutes(limit = 5) {
    return this.savedRoutes
      .filter(r => r.useCount > 0)
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, limit);
  }
  getRecentRoutes(limit = 5) {
    return this.savedRoutes
      .filter(r => r.lastUsed)
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed))
      .slice(0, limit);
  }
  async useRoute(routeId) {
    const route = this.savedRoutes.find(r => r.id === routeId);
    if (route) {
      route.useCount = (route.useCount || 0) + 1;
      route.lastUsed = new Date();
      await this.persist();
    }
  }
  async deleteRoute(routeId) {
    this.savedRoutes = this.savedRoutes.filter(r => r.id !== routeId);
    await this.persist();
  }
  updateFrequentDestinations(location) {
    const existing = this.frequentDestinations.find(dest => {
      const distance = LocationService.calculateDistance(
        location.latitude,
        location.longitude,
        dest.location.latitude,
        dest.location.longitude
      );
      return distance < 50;
    });
    if (existing) {
      existing.count += 1;
      existing.lastVisit = new Date();
    } else {
      this.frequentDestinations.push({
        location,
        count: 1,
        firstVisit: new Date(),
        lastVisit: new Date()
      });
    }
    this.frequentDestinations = this.frequentDestinations
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }
  getFrequentDestinations(limit = 10) {
    return this.frequentDestinations
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
  getRecentDestinations(limit = 10) {
    return this.frequentDestinations
      .sort((a, b) => new Date(b.lastVisit) - new Date(a.lastVisit))
      .slice(0, limit);
  }

  /**
   * Record a named destination the user actively navigated to.
   * Deduplicates: if a place with the same name and similar coordinates
   * (within ~100 m) already exists it is moved to the top instead of
   * creating a duplicate entry.
   *
   * @param {{ name: string, address?: string, latitude: number, longitude: number }} dest
   */
  addRecentSearch(dest) {
    if (!dest?.name || dest.latitude == null || dest.longitude == null) return;
    // Remove any existing entry for the same place
    this.recentSearches = this.recentSearches.filter(r => {
      const sameName = r.name?.toLowerCase() === dest.name.toLowerCase();
      const distLat = Math.abs((r.latitude || 0) - dest.latitude);
      const distLng = Math.abs((r.longitude || 0) - dest.longitude);
      const nearby = distLat < 0.001 && distLng < 0.001; // ~100 m
      return !(sameName || nearby);
    });
    // Prepend (most recent first)
    this.recentSearches.unshift({
      name:       dest.name,
      address:    dest.address || '',
      latitude:   dest.latitude,
      longitude:  dest.longitude,
      searchedAt: new Date().toISOString(),
    });
    // Keep a rolling window of 20
    this.recentSearches = this.recentSearches.slice(0, 20);
    this.persist(); // fire-and-forget — don't block the caller
  }

  /**
   * Returns recent searches sorted newest-first.
   */
  getRecentSearches(limit = 8) {
    return this.recentSearches.slice(0, limit);
  }
  async suggestRoute() {
    const currentLocation = await LocationService.getCurrentLocation();
    const currentHour = new Date().getHours();
    const timeBasedRoutes = this.savedRoutes.filter(route => {
      if (!route.lastUsed) return false;
      const routeHour = new Date(route.lastUsed).getHours();
      return Math.abs(currentHour - routeHour) <= 2; 
    });
    const nearbyRoutes = await this.findSimilarRoutes(currentLocation, 100);
    const suggestions = [...new Set([...timeBasedRoutes, ...nearbyRoutes])]
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, 3);
    return suggestions;
  }
  getStatistics() {
    const totalRoutes = this.savedRoutes.length;
    const totalDistance = this.savedRoutes.reduce((sum, r) => sum + (r.distance || 0), 0);
    const mostUsed = [...this.savedRoutes].sort((a, b) => b.useCount - a.useCount)[0];
    const longestRoute = [...this.savedRoutes].sort((a, b) => b.distance - a.distance)[0];
    return {
      totalRoutes,
      totalDistance: totalDistance.toFixed(0),
      averageDistance: totalRoutes > 0 ? (totalDistance / totalRoutes).toFixed(0) : 0,
      mostUsedRoute: mostUsed?.name,
      longestRoute: longestRoute?.name,
      longestDistance: longestRoute?.distance?.toFixed(0)
    };
  }
  async exportRoutes() {
    return {
      routes:         this.savedRoutes,
      history:        this.routeHistory,
      destinations:   this.frequentDestinations,
      recentSearches: this.recentSearches,
      exportDate:     new Date()
    };
  }
  async importRoutes(data) {
    try {
      if (data.routes)         this.savedRoutes          = data.routes;
      if (data.history)        this.routeHistory          = data.history;
      if (data.destinations)   this.frequentDestinations  = data.destinations;
      if (data.recentSearches) this.recentSearches        = data.recentSearches;
      await this.persist();
      return true;
    } catch (error) {
      console.error('Import routes error:', error);
      return false;
    }
  }
  async persist() {
    try {
      const data = {
        routes: this.savedRoutes,
        history: this.routeHistory,
        destinations: this.frequentDestinations,
        recentSearches: this.recentSearches,
      };
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error('Persist error:', error);
    }
  }
  async clearAll() {
    this.savedRoutes = [];
    this.routeHistory = [];
    this.frequentDestinations = [];
    this.recentSearches = [];
    await AsyncStorage.removeItem(this.storageKey);
  }
}
export default new RouteMemoryService();
