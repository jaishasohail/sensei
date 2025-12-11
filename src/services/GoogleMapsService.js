import * as Location from 'expo-location';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';
class GoogleMapsService {
  constructor() {
    this.apiKey = null; 
    this.baseUrl = 'https://maps.googleapis.com/maps/api';
    this.isNavigating = false;
    this.currentRoute = null;
    this.watchId = null;
    this.trafficEnabled = true;
    this.avoidTolls = false;
    this.avoidHighways = false;
    this.travelMode = 'walking'; 
  }
  setApiKey(key) {
    this.apiKey = key;
  }
  async searchPlace(query, location = null) {
    try {
      if (!this.apiKey) {
        console.warn('Google Maps API key not set. Using mock results.');
        return this.getMockSearchResults(query);
      }
      const params = new URLSearchParams({
        query,
        key: this.apiKey,
        fields: 'name,formatted_address,geometry,place_id,types'
      });
      if (location) {
        params.append('location', `${location.latitude},${location.longitude}`);
        params.append('radius', '5000'); 
      }
      const response = await fetch(`${this.baseUrl}/place/textsearch/json?${params}`);
      const data = await response.json();
      if (data.status === 'OK') {
        return data.results.map(result => ({
          name: result.name,
          formatted_address: result.formatted_address,
          geometry: result.geometry,
          place_id: result.place_id,
          types: result.types,
          latitude: result.geometry.location.lat,
          longitude: result.geometry.location.lng
        }));
      } else {
        console.warn('Place search error:', data.status);
        return this.getMockSearchResults(query);
      }
    } catch (error) {
      console.error('Search place error:', error);
      return this.getMockSearchResults(query);
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
  getMockSearchResults(query) {
    return [
      {
        name: `${query} - Result 1`,
        formatted_address: '123 Main Street, City, Country',
        geometry: {
          location: { lat: 0, lng: 0 }
        },
        latitude: 0.005,
        longitude: 0.005,
        place_id: 'mock_1'
      },
      {
        name: `${query} - Result 2`,
        formatted_address: '456 Oak Avenue, City, Country',
        geometry: {
          location: { lat: 0, lng: 0 }
        },
        latitude: 0.010,
        longitude: 0.010,
        place_id: 'mock_2'
      }
    ];
  }
  async getDirections(origin, destination, options = {}) {
    try {
      if (!this.apiKey) {
        console.warn('Google Maps API key not set. Using fallback navigation.');
        return this.getFallbackDirections(origin, destination);
      }
      const params = new URLSearchParams({
        origin: `${origin.latitude},${origin.longitude}`,
        destination: typeof destination === 'string' ? destination : `${destination.latitude},${destination.longitude}`,
        mode: options.mode || this.travelMode,
        key: this.apiKey,
        alternatives: true,
        departure_time: 'now',
        traffic_model: 'best_guess'
      });
      if (this.avoidTolls) params.append('avoid', 'tolls');
      if (this.avoidHighways) params.append('avoid', 'highways');
      const response = await fetch(`${this.baseUrl}/directions/json?${params}`);
      const data = await response.json();
      if (data.status === 'OK' && data.routes.length > 0) {
        return this.parseGoogleRoute(data.routes[0]);
      } else {
        console.error('Google Maps API error:', data.status);
        return this.getFallbackDirections(origin, destination);
      }
    } catch (error) {
      console.error('Get directions error:', error);
      return this.getFallbackDirections(origin, destination);
    }
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
      const origin = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High
      });
      const originCoords = {
        latitude: origin.coords.latitude,
        longitude: origin.coords.longitude
      };
      this.currentRoute = await this.getDirections(originCoords, destination);
      if (!this.currentRoute) {
        throw new Error('Could not get directions');
      }
      this.isNavigating = true;
      let currentStepIndex = 0;
      this.watchId = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 5000, 
          distanceInterval: 10 
        },
        async (location) => {
          if (!this.isNavigating) return;
          const currentPosition = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude
          };
          if (currentStepIndex < this.currentRoute.steps.length) {
            const currentStep = this.currentRoute.steps[currentStepIndex];
            const distanceToStepEnd = this.calculateDistance(
              currentPosition.latitude,
              currentPosition.longitude,
              currentStep.endLocation.lat,
              currentStep.endLocation.lng
            );
            if (distanceToStepEnd < 20) {
              currentStepIndex++;
              if (currentStepIndex < this.currentRoute.steps.length) {
                const nextStep = this.currentRoute.steps[currentStepIndex];
                await TextToSpeechService.speak(nextStep.instruction);
                const bearing = this.calculateBearing(
                  currentPosition.latitude,
                  currentPosition.longitude,
                  nextStep.endLocation.lat,
                  nextStep.endLocation.lng
                );
                await SpatialAudioService.playDirectionalBeep(bearing, distanceToStepEnd);
              } else {
                await TextToSpeechService.speak('You have arrived at your destination');
                this.stopNavigation();
              }
            }
            const isOffRoute = await this.checkIfOffRoute(currentPosition, currentStepIndex);
            if (isOffRoute) {
              await TextToSpeechService.speak('Recalculating route');
              this.currentRoute = await this.getDirections(currentPosition, destination);
              currentStepIndex = 0;
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
                direction: this.getCardinalDirection(
                  this.calculateBearing(
                    currentPosition.latitude,
                    currentPosition.longitude,
                    this.currentRoute.steps[currentStepIndex]?.endLocation.lat,
                    this.currentRoute.steps[currentStepIndex]?.endLocation.lng
                  )
                )
              });
            }
          }
        }
      );
      if (this.currentRoute.steps.length > 0) {
        await TextToSpeechService.speak(this.currentRoute.steps[0].instruction);
      }
      return this.currentRoute;
    } catch (error) {
      console.error('Start navigation error:', error);
      this.isNavigating = false;
      throw error;
    }
  }
  async stopNavigation() {
    this.isNavigating = false;
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
        instruction: `Head ${this.getCardinalDirection(bearing)} for ${distance.toFixed(0)} meters`,
        distance,
        duration: distance / 1.4, 
        startLocation: origin,
        endLocation: destination,
        maneuver: 'straight',
        stepNumber: 1
      }],
      totalDistance: distance,
      totalDuration: distance / 1.4,
      startAddress: 'Current Location',
      endAddress: 'Destination'
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
