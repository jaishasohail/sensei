import LocationService from './LocationService';
import TextToSpeechService from './TextToSpeechService';
import SpatialAudioService from './SpatialAudioService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
class NavigationService {
  constructor() {
    this.isNavigating = false;
    this.destination = null;
    this.route = [];
    this.currentStepIndex = 0;
    this.navigationUpdateInterval = null;
    this.currentLocation = null;
    this.apiBaseUrl = API_BASE_URL;
    this.currentSessionId = null;
  }
  async startNavigation(destination, onUpdate) {
    try {
      this.destination = destination;
      this.isNavigating = true;
      this.currentStepIndex = 0;
      const currentLocation = await LocationService.getCurrentLocation();
      this.currentLocation = currentLocation;
      this.route = await this.generateRealTimeRoute(currentLocation, destination);
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          const response = await fetch(`${this.apiBaseUrl}/api/navigation/route`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              start: { latitude: currentLocation.latitude, longitude: currentLocation.longitude },
              end: { latitude: destination.latitude, longitude: destination.longitude },
              waypoints: this.route.map(s => ({ latitude: s.latitude, longitude: s.longitude })),
              distance: this.route[0]?.distance || 0,
              estimatedDuration: Math.round((this.route[0]?.distance || 0) / 80)
            })
          });
          if (response.ok) {
            const data = await response.json();
            this.currentSessionId = data.session?._id;
          }
        } catch (err) {
          console.error('Failed to create navigation session:', err);
        }
      }
      TextToSpeechService.speak(`Navigation started to ${destination.name}`);
      await LocationService.startWatchingLocation(async (location) => {
        if (this.isNavigating) {
          this.currentLocation = location;
          await this.updateNavigation(location, onUpdate);
        }
      });
      this.navigationUpdateInterval = setInterval(() => {
        if (this.isNavigating && this.route[this.currentStepIndex]) {
          this.provideNavigationGuidance();
        }
      }, 10000); 
    } catch (error) {
      console.error('Navigation start error:', error);
      throw error;
    }
  }
  async generateRealTimeRoute(start, end) {
    const steps = [];
    const totalDistance = LocationService.calculateDistance(
      start.latitude,
      start.longitude,
      end.latitude,
      end.longitude
    );
    const initialBearing = LocationService.calculateBearing(
      start.latitude,
      start.longitude,
      end.latitude,
      end.longitude
    );
    const direction = LocationService.getCardinalDirection(initialBearing);
    steps.push({
      instruction: `Head ${direction} for ${Math.round(totalDistance)} meters to reach ${end.name}`,
      latitude: start.latitude,
      longitude: start.longitude,
      distance: totalDistance,
      bearing: initialBearing,
      type: 'start',
    });
    const numIntermediateSteps = Math.floor(totalDistance / 50);
    for (let i = 1; i <= numIntermediateSteps; i++) {
      const fraction = i / (numIntermediateSteps + 1);
      const lat = start.latitude + (end.latitude - start.latitude) * fraction;
      const lon = start.longitude + (end.longitude - start.longitude) * fraction;
      const remainingDistance = totalDistance * (1 - fraction);
      const stepBearing = LocationService.calculateBearing(lat, lon, end.latitude, end.longitude);
      const stepDirection = LocationService.getCardinalDirection(stepBearing);
      let instruction = `Continue ${stepDirection}`;
      const bearingChange = Math.abs(stepBearing - initialBearing);
      if (bearingChange > 30 && bearingChange < 330) {
        if (bearingChange > 180) {
          instruction = `Turn left and continue ${stepDirection}`;
        } else if (bearingChange < 180 && bearingChange > 30) {
          instruction = `Turn right and continue ${stepDirection}`;
        }
      }
      if (remainingDistance < 100) {
        instruction = `${end.name} is ${Math.round(remainingDistance)} meters ahead`;
      }
      steps.push({
        instruction: instruction,
        latitude: lat,
        longitude: lon,
        distance: remainingDistance,
        bearing: stepBearing,
        type: 'continue',
      });
    }
    steps.push({
      instruction: `You have arrived at ${end.name}`,
      latitude: end.latitude,
      longitude: end.longitude,
      distance: 0,
      bearing: initialBearing,
      type: 'end',
    });
    return steps;
  }
  async updateNavigation(currentLocation, onUpdate) {
    if (!this.isNavigating || !this.route[this.currentStepIndex]) {
      return;
    }
    const currentStep = this.route[this.currentStepIndex];
    const distanceToStep = LocationService.calculateDistance(
      currentLocation.latitude,
      currentLocation.longitude,
      currentStep.latitude,
      currentStep.longitude
    );
    const bearing = LocationService.calculateBearing(
      currentLocation.latitude,
      currentLocation.longitude,
      currentStep.latitude,
      currentStep.longitude
    );
    const direction = LocationService.getCardinalDirection(bearing);
    const remainingDistance = this.calculateRemainingDistance(currentLocation);
    const navigationData = {
      currentStep: this.currentStepIndex + 1,
      totalSteps: this.route.length,
      instruction: currentStep.instruction,
      distanceToNextStep: Math.round(distanceToStep),
      bearing: bearing,
      direction: direction,
      remainingDistance: remainingDistance,
      estimatedTimeMinutes: Math.round(remainingDistance / 80), 
      currentSpeed: currentLocation.speed || 0,
    };
    if (onUpdate) {
      onUpdate(navigationData);
    }
    if (distanceToStep < 15) {
      this.currentStepIndex++;
      if (this.currentStepIndex < this.route.length) {
        const nextStep = this.route[this.currentStepIndex];
        TextToSpeechService.speak(nextStep.instruction);
        await SpatialAudioService.playNavigationCue('forward');
      } else {
        this.stopNavigation();
        TextToSpeechService.speak('You have arrived at your destination');
      }
    } else if (distanceToStep < 50) {
      if (Math.round(distanceToStep) % 10 === 0) {
        TextToSpeechService.speak(`${Math.round(distanceToStep)} meters to next turn`);
      }
    }
    if (distanceToStep > 25 && this.currentStepIndex > 0) {
      await this.recalculateRoute(currentLocation);
    }
  }
  async recalculateRoute(currentLocation) {
    try {
      TextToSpeechService.speak('Recalculating route');
      this.route = await this.generateRealTimeRoute(currentLocation, this.destination);
      this.currentStepIndex = 0;
    } catch (error) {
      console.error('Recalculation error:', error);
    }
  }
  calculateRemainingDistance(currentLocation) {
    let totalDistance = 0;
    if (this.currentStepIndex < this.route.length) {
      const currentStep = this.route[this.currentStepIndex];
      totalDistance += LocationService.calculateDistance(
        currentLocation.latitude,
        currentLocation.longitude,
        currentStep.latitude,
        currentStep.longitude
      );
    }
    for (let i = this.currentStepIndex; i < this.route.length - 1; i++) {
      const step = this.route[i];
      const nextStep = this.route[i + 1];
      totalDistance += LocationService.calculateDistance(
        step.latitude,
        step.longitude,
        nextStep.latitude,
        nextStep.longitude
      );
    }
    return Math.round(totalDistance);
  }
  provideNavigationGuidance() {
    if (!this.isNavigating || !this.route[this.currentStepIndex]) {
      return;
    }
    const step = this.route[this.currentStepIndex];
    if (this.currentLocation) {
      const distanceToStep = LocationService.calculateDistance(
        this.currentLocation.latitude,
        this.currentLocation.longitude,
        step.latitude,
        step.longitude
      );
      if (distanceToStep > 20) {
        TextToSpeechService.speak(`Continue ${LocationService.getCardinalDirection(step.bearing)}. ${Math.round(distanceToStep)} meters to next waypoint`);
      }
    }
  }
  async stopNavigation() {
    if (this.currentSessionId) {
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          await fetch(`${this.apiBaseUrl}/api/navigation/stop`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ sessionId: this.currentSessionId })
          });
        } catch (err) {
          console.error('Failed to stop navigation session:', err);
        }
      }
      this.currentSessionId = null;
    }
    this.isNavigating = false;
    this.destination = null;
    this.route = [];
    this.currentStepIndex = 0;
    this.currentLocation = null;
    if (this.navigationUpdateInterval) {
      clearInterval(this.navigationUpdateInterval);
      this.navigationUpdateInterval = null;
    }
    LocationService.stopWatchingLocation();
    TextToSpeechService.speak('Navigation stopped');
  }
  getNavigationStatus() {
    return {
      isNavigating: this.isNavigating,
      destination: this.destination,
      currentStep: this.currentStepIndex,
      totalSteps: this.route.length,
      currentLocation: this.currentLocation,
    };
  }
}
export default new NavigationService();
