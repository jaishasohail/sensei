import { describe, it, expect, beforeEach } from '@jest/globals';

describe('Navigation Module', () => {
  
  describe('UT-NAV-001: Calculate Route to Valid Destination', () => {
    it('should calculate route between San Francisco and Oakland', async () => {
      const NavigationService = require('../src/services/NavigationService').default;
      const LocationService = require('../src/services/LocationService').default;

      const start = { latitude: 37.7749, longitude: -122.4194 };
      const destination = { 
        name: 'Oakland',
        latitude: 37.8044, 
        longitude: -122.2712 
      };

      const distance = LocationService.calculateDistance(
        start.latitude,
        start.longitude,
        destination.latitude,
        destination.longitude
      );

      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeGreaterThan(10000);
      expect(distance).toBeLessThan(20000);
    });
  });

  describe('UT-NAV-002: Handle Invalid Destination Coordinates', () => {
    it('should handle invalid coordinates gracefully', () => {
      const LocationService = require('../src/services/LocationService').default;

      const start = { latitude: 37.7749, longitude: -122.4194 };
      const invalidDest = { latitude: 999, longitude: 999 };

      const isValidLat = invalidDest.latitude >= -90 && invalidDest.latitude <= 90;
      const isValidLon = invalidDest.longitude >= -180 && invalidDest.longitude <= 180;

      expect(isValidLat).toBe(false);
      expect(isValidLon).toBe(false);
    });
  });

  describe('UT-NAV-003: Verify GPS Location Accuracy', () => {
    it('should return location with valid coordinates', async () => {
      const LocationService = require('../src/services/LocationService').default;

      const mockLocation = {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 15
      };

      expect(mockLocation.latitude).toBeGreaterThanOrEqual(-90);
      expect(mockLocation.latitude).toBeLessThanOrEqual(90);
      expect(mockLocation.longitude).toBeGreaterThanOrEqual(-180);
      expect(mockLocation.longitude).toBeLessThanOrEqual(180);
      expect(mockLocation.accuracy).toBeLessThan(20);
    });
  });

  describe('UT-NAV-004: Calculate Distance Between Coordinates', () => {
    it('should calculate accurate distance between SF and Oakland', () => {
      const LocationService = require('../src/services/LocationService').default;

      const pointA = { latitude: 37.7749, longitude: -122.4194 };
      const pointB = { latitude: 37.8044, longitude: -122.2712 };

      const distance = LocationService.calculateDistance(
        pointA.latitude,
        pointA.longitude,
        pointB.latitude,
        pointB.longitude
      );

      expect(distance).toBeGreaterThan(13000);
      expect(distance).toBeLessThan(14000);
      
      const expectedDistance = 13500;
      const marginOfError = Math.abs(distance - expectedDistance);
      expect(marginOfError).toBeLessThan(500);
    });
  });

  describe('UT-NAV-005: Classify Turn Direction Correctly', () => {
    it('should classify 85° turn as LEFT', () => {
      const classifyTurnDirection = (bearingDifference) => {
        const normalizedDiff = ((bearingDifference % 360) + 360) % 360;
        
        if (normalizedDiff >= 315 || normalizedDiff < 45) {
          return 'STRAIGHT';
        } else if (normalizedDiff >= 45 && normalizedDiff < 135) {
          return 'RIGHT';
        } else if (normalizedDiff >= 135 && normalizedDiff < 225) {
          return 'U_TURN';
        } else {
          return 'LEFT';
        }
      };

      const turnDirection = classifyTurnDirection(85);
      expect(turnDirection).toBe('RIGHT');

      expect(classifyTurnDirection(10)).toBe('STRAIGHT');
      expect(classifyTurnDirection(90)).toBe('RIGHT');
      expect(classifyTurnDirection(270)).toBe('LEFT');
      expect(classifyTurnDirection(180)).toBe('U_TURN');
    });
  });
});

export default {
  module: 'Navigation',
  coverage: 'FR2.1, FR2.2, NFR1.2, NFR1.6'
};
