import * as Location from 'expo-location';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';
import { GOOGLE_MAPS_API_KEY } from '../constants/config';
class GoogleMapsService {
  constructor() {
    this.apiKey = GOOGLE_MAPS_API_KEY && GOOGLE_MAPS_API_KEY !== 'YOUR_GOOGLE_MAPS_API_KEY_HERE'
      ? GOOGLE_MAPS_API_KEY
      : null;
    this.baseUrl = 'https://maps.googleapis.com/maps/api';
    this.isNavigating = false;
    this.currentRoute = null;
    this.watchId = null;
    this.trafficEnabled = true;
    this.avoidTolls = false;
    this.avoidHighways = false;
    this.travelMode = 'walking';
    // Navigation session state — prevents false "arrived" on stale/cached GPS
    this._navOrigin = null;
    this._navDestination = null;
    this._navStartedAt = 0;
    this._maxDistanceFromStart = 0;
  }
  setApiKey(key) {
    this.apiKey = key;
  }
  // ── Nominatim (OpenStreetMap) free geocoder ─────────────────────────────────
  // No API key required.  Supports both place-name search ("Starbucks") and
  // address search ("123 Main St").  Rate limit: 1 req/s — fine for a single user.
  // When a GPS location is provided the search is biased toward nearby results
  // via a viewbox (but not strictly bounded so far-away matches are still returned).
  async _searchNominatim(query, location = null) {
    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        limit: '5',
        addressdetails: '1',
      });
      if (location) {
        // 0.1° ≈ 11 km — wide enough to catch nearby results without excluding city-level searches
        const d = 0.1;
        params.append('viewbox', [
          location.longitude - d,
          location.latitude  + d,
          location.longitude + d,
          location.latitude  - d,
        ].join(','));
        params.append('bounded', '0'); // prefer viewbox but don't exclude outside results
      }
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { 'User-Agent': 'SenseiBlindAssistantApp/1.0 (accessibility tool)' } }
      );
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return data.map(item => ({
          name: item.namedetails?.name || item.display_name.split(',')[0].trim(),
          formatted_address: item.display_name,
          geometry: { location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) } },
          latitude:  parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          place_id:  String(item.place_id),
        }));
      }
      return [];
    } catch (error) {
      console.warn('Nominatim search error:', error.message);
      return [];
    }
  }

  async searchPlace(query, location = null) {
    try {
      // ── 1. Nominatim (OSM) — free, no API key, works for place names & addresses
      const nominatimResults = await this._searchNominatim(query, location);
      if (nominatimResults.length > 0) {
        console.log('[Maps] Nominatim returned', nominatimResults.length, 'result(s)');
        return nominatimResults;
      }
      console.log('[Maps] Nominatim returned 0 results, trying Google APIs');

      // ── 2. Google Places Text Search — better for business names/chains
      if (this.apiKey) {
        // NOTE: the `fields` parameter is NOT supported by the Text Search
        // endpoint; omit it so the API returns the full default response.
        const params = new URLSearchParams({ query, key: this.apiKey });
        if (location) {
          params.append('location', `${location.latitude},${location.longitude}`);
          params.append('radius', '5000');
        }
        try {
          const response = await fetch(`${this.baseUrl}/place/textsearch/json?${params}`);
          const data = await response.json();
          if (data.status === 'OK') {
            console.log('[Maps] Google Places returned', data.results.length, 'result(s)');
            return data.results.map(result => ({
              name: result.name,
              formatted_address: result.formatted_address,
              geometry: result.geometry,
              place_id: result.place_id,
              types: result.types,
              latitude: result.geometry.location.lat,
              longitude: result.geometry.location.lng,
            }));
          }
          console.warn(
            '[Maps] Places API error:',
            data.status || '(no status)',
            data.error_message ? '— ' + data.error_message : ''
          );
        } catch (placesErr) {
          console.warn('[Maps] Places API fetch failed:', placesErr.message);
        }

        // ── 3. Google Geocoding — reliable for exact addresses, less useful for place names
        const geocodeResult = await this.geocodeAddress(query);
        if (geocodeResult) {
          console.log('[Maps] Geocoding fallback succeeded');
          return [{
            name: query,
            formatted_address: geocodeResult.formattedAddress,
            geometry: { location: { lat: geocodeResult.latitude, lng: geocodeResult.longitude } },
            latitude:  geocodeResult.latitude,
            longitude: geocodeResult.longitude,
            place_id:  null,
          }];
        }
      }

      // All sources failed
      console.warn('[Maps] All search sources returned 0 results for:', query);
      return [];
    } catch (error) {
      console.error('[Maps] searchPlace unexpected error:', error);
      return [];
    }
  }
  async getNearbyPlaces(location, type = 'restaurant', radius = 1000) {
    try {
      if (!this.apiKey) {
        console.warn('Google Maps API key not set. Using mock results.');
        return [];
      }
      const params = new URLSearchParams({
        location: `${location.latitude},${location.longitude}`,
        radius,
        type,
        key: this.apiKey
      });
      const response = await fetch(`${this.baseUrl}/place/nearbysearch/json?${params}`);
      const data = await response.json();
      if (data.status === 'OK') {
        return data.results.map(result => ({
          name: result.name,
          vicinity: result.vicinity,
          geometry: result.geometry,
          place_id: result.place_id,
          types: result.types,
          rating: result.rating,
          latitude: result.geometry.location.lat,
          longitude: result.geometry.location.lng
        }));
      } else {
        console.warn('Nearby places error:', data.status);
        return [];
      }
    } catch (error) {
      console.error('Get nearby places error:', error);
      return [];
    }
  }

  // ── OSRM (Open Source Routing Machine) ──────────────────────────────────────
  // Free, no API key, no billing required.  Uses OpenStreetMap data.
  // Public demo server — fine for single-user personal apps.
  // Docs: https://project-osrm.org/

  // Map app travel-mode strings to OSRM profile names
  _osrmProfile(mode) {
    if (mode === 'driving')   return 'car';
    if (mode === 'bicycling') return 'bike';
    return 'foot'; // walking, transit, or any unknown mode
  }

  // Build a human-readable instruction string from an OSRM step
  _osrmInstruction(step) {
    const type     = step.maneuver?.type     || 'continue';
    const modifier = step.maneuver?.modifier || '';
    const street   = step.name
      ? ` onto ${step.name}`
      : (step.ref ? ` onto ${step.ref}` : '');
    const towards  = step.destinations
      ? ` towards ${step.destinations.split(',')[0].trim()}`
      : '';

    switch (type) {
      case 'depart':
        return `Head ${modifier || 'straight'}${step.name ? ` on ${step.name}` : ''}`;
      case 'arrive':
        return 'You have arrived at your destination';
      case 'turn':
        return `Turn ${modifier.replace(/-/g, ' ')}${street}${towards}`;
      case 'continue':
      case 'new name':
        return `Continue${street}${towards}`;
      case 'merge':
        return `Merge${modifier ? ' ' + modifier.replace(/-/g, ' ') : ''}${street}`;
      case 'on ramp':
        return `Take the on-ramp${modifier ? ' to the ' + modifier.replace(/-/g, ' ') : ''}${towards}`;
      case 'off ramp':
        return `Take the off-ramp${modifier ? ' to the ' + modifier.replace(/-/g, ' ') : ''}${towards}`;
      case 'fork':
        return `Keep ${modifier.includes('left') ? 'left' : 'right'} at the fork${street}`;
      case 'end of road':
        return `Turn ${modifier.replace(/-/g, ' ')} at the end of the road${street}`;
      case 'roundabout':
      case 'rotary':
        return `Enter the roundabout${street}`;
      case 'use lane':
        return `Use the correct lane${street}`;
      default:
        return step.name ? `Continue on ${step.name}` : 'Continue straight';
    }
  }

  // Map OSRM maneuver to the icon key used by NavigationScreen.maneuverIcon()
  _osrmManeuver(type = '', modifier = '') {
    if (type === 'arrive')                          return 'arrive';
    if (type === 'roundabout' || type === 'rotary') return 'roundabout';
    if (type === 'merge')                           return 'merge';
    if (type === 'turn' || type === 'end of road') {
      if (modifier.includes('left'))  return 'turn-left';
      if (modifier.includes('right')) return 'turn-right';
      if (modifier === 'uturn')       return 'uturn-left';
    }
    return 'straight';
  }

  // Parse OSRM route response into the same shape as parseGoogleRoute()
  // Returns coordinates[] instead of polyline string (no encoding/decoding needed)
  _parseOSRMRoute(data, destination) {
    const route = data.routes[0];
    const leg   = route.legs[0];

    const steps = leg.steps.map((step, index) => {
      const [sLon, sLat] = step.maneuver.location;
      // endLocation = last coordinate of this step's own geometry
      const geomCoords = step.geometry?.coordinates ?? [];
      const [eLon, eLat] = geomCoords.length > 0
        ? geomCoords[geomCoords.length - 1]
        : step.maneuver.location;
      return {
        instruction:   this._osrmInstruction(step),
        distance:      step.distance,
        duration:      step.duration,
        startLocation: { lat: sLat, lng: sLon },
        endLocation:   { lat: eLat, lng: eLon },
        maneuver:      this._osrmManeuver(step.maneuver?.type, step.maneuver?.modifier),
        stepNumber:    index + 1,
      };
    });

    // GeoJSON standard is [longitude, latitude] — swap to {latitude, longitude}
    const coordinates = (route.geometry?.coordinates ?? []).map(([lon, lat]) => ({
      latitude:  lat,
      longitude: lon,
    }));

    return {
      steps,
      totalDistance:   route.distance,
      totalDuration:   route.duration,
      startAddress:    data.waypoints?.[0]?.name || 'Current Location',
      endAddress:      data.waypoints?.[1]?.name || destination?.name || 'Destination',
      coordinates,     // ready-to-use array for MapView Polyline
      polyline:        null,
      bounds:          null,
      trafficDuration: route.duration,
    };
  }

  async _getDirectionsOSRM(origin, destination, mode) {
    try {
      if (typeof destination === 'string') return null; // can't use raw string with OSRM

      const profile = this._osrmProfile(mode);
      const url = [
        `https://router.project-osrm.org/route/v1/${profile}/`,
        `${origin.longitude},${origin.latitude}`,
        `;`,
        `${destination.longitude},${destination.latitude}`,
        `?steps=true&geometries=geojson&overview=full&annotations=false`,
      ].join('');

      console.log(`[Maps] OSRM ${profile}: ${origin.latitude.toFixed(4)},${origin.longitude.toFixed(4)} → ${destination.latitude.toFixed(4)},${destination.longitude.toFixed(4)}`);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SenseiBlindAssistantApp/1.0 (accessibility tool)' },
      });
      const data = await response.json();

      if (data.code === 'Ok' && data.routes?.length > 0) {
        const r = data.routes[0];
        console.log(`[Maps] OSRM OK — ${r.legs[0].steps.length} steps, ${(r.distance / 1000).toFixed(1)} km, ${Math.round(r.duration / 60)} min`);
        return this._parseOSRMRoute(data, destination);
      }

      console.warn('[Maps] OSRM returned:', data.code, data.message || '');
      return null;
    } catch (err) {
      console.warn('[Maps] OSRM request failed:', err.message);
      return null;
    }
  }

  async getDirections(origin, destination, options = {}) {
    const travelMode = options.mode || this.travelMode;

    // ── 1. OSRM — free, no API key, no billing, works everywhere ────────────
    const osrmRoute = await this._getDirectionsOSRM(origin, destination, travelMode);
    if (osrmRoute) return osrmRoute;
    console.log('[Maps] OSRM failed, trying Google Directions API');

    // ── 2. Google Directions API — requires billing (fallback only) ──────────
    if (this.apiKey) {
      try {
        const destParam = typeof destination === 'string'
          ? destination
          : `${destination.latitude},${destination.longitude}`;

        const params = new URLSearchParams({
          origin:      `${origin.latitude},${origin.longitude}`,
          destination: destParam,
          mode:        travelMode,
          language:    'en',
          key:         this.apiKey,
        });
        // departure_time / traffic_model are driving-only; omit for other modes
        if (travelMode === 'driving') {
          params.append('departure_time', 'now');
          params.append('traffic_model',  'best_guess');
        }
        if (this.avoidTolls)    params.append('avoid', 'tolls');
        if (this.avoidHighways) params.append('avoid', 'highways');

        const response = await fetch(`${this.baseUrl}/directions/json?${params}`);
        const data     = await response.json();

        if (data.status === 'OK' && data.routes.length > 0) {
          console.log(`[Maps] Google Directions OK — ${data.routes[0].legs[0].steps.length} steps`);
          return this.parseGoogleRoute(data.routes[0]);
        }
        console.error('[Maps] Google Directions error:', data.status, data.error_message || '');
      } catch (err) {
        console.error('[Maps] Google Directions threw:', err.message);
      }
    }

    // ── 3. Straight-line last resort ─────────────────────────────────────────
    console.warn('[Maps] All direction sources failed — using straight-line fallback');
    return this.getFallbackDirections(origin, destination);
  }
  parseGoogleRoute(route) {
    const leg = route.legs[0];
    const steps = leg.steps.map((step, index) => ({
      instruction: step.html_instructions.replace(/<[^>]*>/g, ''), 
      distance: step.distance.value, 
      duration: step.duration.value, 
      startLocation: step.start_location,
      endLocation: step.end_location,
      maneuver: step.maneuver || 'straight',
      stepNumber: index + 1
    }));
    return {
      steps,
      totalDistance: leg.distance.value,
      totalDuration: leg.duration.value,
      startAddress: leg.start_address,
      endAddress: leg.end_address,
      polyline: route.overview_polyline.points,
      bounds: route.bounds,
      trafficDuration: leg.duration_in_traffic?.value || leg.duration.value
    };
  }
  async startNavigation(destination, callback) {
    try {
      // Always request a fresh fix — cached coords cause false arrival when the
      // user has moved (e.g. bedroom pin → living room) but GPS cache is stale.
      const origin = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
        maximumAge: 0,
        mayShowUserSettingsDialog: true,
      });
      const originCoords = {
        latitude: origin.coords.latitude,
        longitude: origin.coords.longitude,
      };

      const destLat = destination.latitude ?? destination.lat;
      const destLng = destination.longitude ?? destination.lng;
      if (destLat == null || destLng == null) {
        throw new Error('Destination coordinates missing');
      }

      const distToDest = this.calculateDistance(
        originCoords.latitude, originCoords.longitude, destLat, destLng,
      );

      // Pinned / short indoor routes: GPS often cannot distinguish rooms in the
      // same home — do not start a fake route that instantly says "arrived".
      const MIN_NAV_DISTANCE_M = 25;
      if (distToDest < MIN_NAV_DISTANCE_M) {
        const msg = distToDest < 5
          ? `Your GPS shows you are already at ${destination.name || 'that location'}. Phone GPS usually cannot tell rooms apart indoors. Try moving near a window for a better signal, or use indoor landmark mapping for room-to-room guidance.`
          : `You are only ${Math.round(distToDest)} meters from ${destination.name || 'that location'}. GPS may not have updated since you moved. Wait a moment near a window and try again, or use indoor navigation with marked landmarks.`;
        await TextToSpeechService.speak(msg);
        throw new Error('destination_too_close');
      }

      this._navOrigin = { ...originCoords };
      this._navDestination = { lat: destLat, lng: destLng };
      this._navStartedAt = Date.now();
      this._maxDistanceFromStart = 0;

      this.currentRoute = await this.getDirections(originCoords, destination);
      if (!this.currentRoute) {
        throw new Error('Could not get directions');
      }

      // Degenerate zero-length route (same coords) — refuse to navigate
      if ((this.currentRoute.totalDistance ?? 0) < MIN_NAV_DISTANCE_M) {
        await TextToSpeechService.speak(
          `Cannot navigate to ${destination.name || 'that location'}. Your current GPS position is too close to the saved pin. Move to a different area and try again.`,
        );
        throw new Error('route_too_short');
      }

      this.isNavigating = true;
      let currentStepIndex = 0;
      this.watchId = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 3000,
          distanceInterval: 5,
        },
        async (location) => {
          if (!this.isNavigating) return;
          const currentPosition = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          };

          const distFromStart = this.calculateDistance(
            currentPosition.latitude, currentPosition.longitude,
            this._navOrigin.latitude, this._navOrigin.longitude,
          );
          this._maxDistanceFromStart = Math.max(this._maxDistanceFromStart, distFromStart);

          const distToFinal = this.calculateDistance(
            currentPosition.latitude, currentPosition.longitude,
            this._navDestination.lat, this._navDestination.lng,
          );

          // True arrival: near destination AND user has actually moved or enough time passed
          if (this._hasTrulyArrived(currentPosition, distToFinal)) {
            await TextToSpeechService.speak('You have arrived at your destination');
            this.stopNavigation();
            return;
          }

          if (currentStepIndex < this.currentRoute.steps.length) {
            const currentStep = this.currentRoute.steps[currentStepIndex];
            const distanceToStepEnd = this.calculateDistance(
              currentPosition.latitude,
              currentPosition.longitude,
              currentStep.endLocation.lat,
              currentStep.endLocation.lng,
            );
            // Advance steps only after user has moved away from the start point
            const canAdvanceSteps = this._maxDistanceFromStart > 8
              || (Date.now() - this._navStartedAt) > 8000;
            if (canAdvanceSteps && distanceToStepEnd < 20) {
              currentStepIndex++;
              if (currentStepIndex < this.currentRoute.steps.length) {
                const nextStep = this.currentRoute.steps[currentStepIndex];
                if (nextStep.instruction && !nextStep.instruction.toLowerCase().includes('you have arrived')) {
                  await TextToSpeechService.speak(nextStep.instruction);
                }
                const bearing = this.calculateBearing(
                  currentPosition.latitude,
                  currentPosition.longitude,
                  nextStep.endLocation.lat,
                  nextStep.endLocation.lng,
                );
                await SpatialAudioService.playDirectionalBeep(bearing, distanceToStepEnd);
              }
            }
            const isOffRoute = await this.checkIfOffRoute(currentPosition, currentStepIndex);
            if (isOffRoute) {
              await TextToSpeechService.speak('Recalculating route');
              this.currentRoute = await this.getDirections(currentPosition, destination);
              currentStepIndex = 0;
              this._navOrigin = { ...currentPosition };
              this._maxDistanceFromStart = 0;
            }
            if (callback) {
              callback({
                currentStep: currentStepIndex + 1,
                totalSteps: this.currentRoute.steps.length,
                instruction: this.currentRoute.steps[currentStepIndex]?.instruction || 'Continue',
                distanceToNextStep: distanceToStepEnd,
                remainingDistance: this.calculateRemainingDistance(currentStepIndex),
                estimatedTimeMinutes: Math.ceil(this.calculateRemainingDuration(currentStepIndex) / 60),
                currentSpeed: location.coords.speed || 0,
                currentPosition,
                direction: this.getCardinalDirection(
                  this.calculateBearing(
                    currentPosition.latitude,
                    currentPosition.longitude,
                    this.currentRoute.steps[currentStepIndex]?.endLocation.lat,
                    this.currentRoute.steps[currentStepIndex]?.endLocation.lng,
                  ),
                ),
              });
            }
          }
        },
      );
      if (this.currentRoute.steps.length > 0) {
        const first = this.currentRoute.steps[0].instruction;
        if (first && !first.toLowerCase().includes('you have arrived')) {
          await TextToSpeechService.speak(first);
        }
      }
      return this.currentRoute;
    } catch (error) {
      console.error('Start navigation error:', error);
      this.isNavigating = false;
      throw error;
    }
  }

  /** Prevent instant false arrival when origin ≈ destination (stale GPS). */
  _hasTrulyArrived(currentPosition, distToFinal) {
    const ARRIVAL_RADIUS_M = 18;
    if (distToFinal > ARRIVAL_RADIUS_M) return false;

    const elapsed = Date.now() - this._navStartedAt;
    const movedFromStart = this._maxDistanceFromStart > 10;
    const routeDist = this.currentRoute?.totalDistance ?? 0;

    // Must have been navigating for at least 5 s OR moved meaningfully
    if (elapsed < 5000 && !movedFromStart) return false;

    // Short routes: require actual movement toward destination
    if (routeDist < 40 && !movedFromStart) return false;

    return true;
  }
  async stopNavigation() {
    this.isNavigating = false;
    this._navOrigin = null;
    this._navDestination = null;
    this._navStartedAt = 0;
    this._maxDistanceFromStart = 0;
    if (this.watchId) {
      this.watchId.remove();
      this.watchId = null;
    }
    this.currentRoute = null;
  }
  async checkIfOffRoute(currentPosition, currentStepIndex) {
    if (!this.currentRoute || currentStepIndex >= this.currentRoute.steps.length) {
      return false;
    }
    const currentStep = this.currentRoute.steps[currentStepIndex];
    const distanceToPath = this.calculateDistance(
      currentPosition.latitude,
      currentPosition.longitude,
      currentStep.endLocation.lat,
      currentStep.endLocation.lng
    );
    return distanceToPath > 50;
  }
  async getTrafficInfo(origin, destination) {
    if (!this.apiKey) {
      return { trafficLevel: 'unknown', delay: 0 };
    }
    try {
      const route = await this.getDirections(origin, destination);
      const delay = route.trafficDuration - route.totalDuration;
      let trafficLevel = 'light';
      if (delay > 600) trafficLevel = 'heavy'; 
      else if (delay > 300) trafficLevel = 'moderate'; 
      return {
        trafficLevel,
        delay,
        normalDuration: route.totalDuration,
        currentDuration: route.trafficDuration
      };
    } catch (error) {
      console.error('Traffic info error:', error);
      return { trafficLevel: 'unknown', delay: 0 };
    }
  }
  async searchNearby(location, query, radius = 1000) {
    if (!this.apiKey) {
      return [];
    }
    try {
      const params = new URLSearchParams({
        location: `${location.latitude},${location.longitude}`,
        radius,
        keyword: query,
        key: this.apiKey
      });
      const response = await fetch(`${this.baseUrl}/place/nearbysearch/json?${params}`);
      const data = await response.json();
      if (data.status === 'OK') {
        return data.results.map(place => ({
          name: place.name,
          address: place.vicinity,
          location: place.geometry.location,
          rating: place.rating,
          types: place.types
        }));
      }
      return [];
    } catch (error) {
      console.error('Search nearby error:', error);
      return [];
    }
  }
  async geocodeAddress(address) {
    if (!this.apiKey) {
      return null;
    }
    try {
      const params = new URLSearchParams({
        address,
        key: this.apiKey
      });
      const response = await fetch(`${this.baseUrl}/geocode/json?${params}`);
      const data = await response.json();
      if (data.status === 'OK' && data.results.length > 0) {
        return {
          latitude: data.results[0].geometry.location.lat,
          longitude: data.results[0].geometry.location.lng,
          formattedAddress: data.results[0].formatted_address
        };
      }
      return null;
    } catch (error) {
      console.error('Geocode error:', error);
      return null;
    }
  }
  getFallbackDirections(origin, destination) {
    const distance = this.calculateDistance(
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude
    );
    const bearing = this.calculateBearing(
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude
    );
    return {
      steps: [{
        instruction: `Head ${this.getCardinalDirection(bearing)} for ${Math.round(distance)} meters`,
        distance,
        duration: distance / 1.4,
        startLocation: { lat: origin.latitude,      lng: origin.longitude },
        // Use { lat, lng } — same format as parseGoogleRoute — so step-tracking
        // math (calculateDistance using .lat / .lng) never receives undefined.
        endLocation:   { lat: destination.latitude, lng: destination.longitude },
        maneuver: 'straight',
        stepNumber: 1
      }],
      totalDistance: distance,
      totalDuration: distance / 1.4,
      startAddress: 'Current Location',
      endAddress: destination.name || destination.address || 'Destination'
    };
  }
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
  }
  getCardinalDirection(bearing) {
    const directions = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
  }
  calculateRemainingDistance(currentStepIndex) {
    if (!this.currentRoute) return 0;
    return this.currentRoute.steps
      .slice(currentStepIndex)
      .reduce((sum, step) => sum + step.distance, 0);
  }
  calculateRemainingDuration(currentStepIndex) {
    if (!this.currentRoute) return 0;
    return this.currentRoute.steps
      .slice(currentStepIndex)
      .reduce((sum, step) => sum + step.duration, 0);
  }
  setTravelMode(mode) {
    this.travelMode = mode; 
  }
  setTrafficEnabled(enabled) {
    this.trafficEnabled = enabled;
  }
}
export default new GoogleMapsService();
