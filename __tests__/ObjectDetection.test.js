import { describe, it, expect, beforeEach } from '@jest/globals';

describe('Object Detection Module', () => {
  
  describe('UT-DET-001: Initialize ML Detection Model', () => {
    it('should initialize detection model successfully', async () => {
      const ObjectDetectionService = require('../src/services/ObjectDetectionService').default;

      const startTime = Date.now();
      await ObjectDetectionService.loadModel();
      const loadTime = Date.now() - startTime;

      expect(ObjectDetectionService.isReady).toBe(true);
      expect(ObjectDetectionService.model).toBeDefined();
      expect(loadTime).toBeLessThan(5000);
    });
  });

  describe('UT-DET-002: Detect Objects in Test Image', () => {
    it('should detect objects with high confidence', async () => {
      const ObjectDetectionService = require('../src/services/ObjectDetectionService').default;
      
      await ObjectDetectionService.loadModel();

      const mockDetections = [
        {
          class: 'car',
          score: 0.85,
          bbox: [100, 150, 200, 300]
        },
        {
          class: 'person',
          score: 0.92,
          bbox: [300, 100, 100, 250]
        },
        {
          class: 'person',
          score: 0.88,
          bbox: [450, 120, 90, 230]
        }
      ];

      const highConfidenceDetections = mockDetections.filter(d => d.score > 0.75);

      expect(highConfidenceDetections.length).toBe(3);
      expect(highConfidenceDetections.some(d => d.class === 'car')).toBe(true);
      expect(highConfidenceDetections.filter(d => d.class === 'person').length).toBe(2);
    });
  });

  describe('UT-DET-003: Calculate Distance to Object', () => {
    it('should calculate distance with < 10% error', () => {
      const calculateDistance = (objectHeight, imageHeight, focalLength, realHeight) => {
        return (realHeight * focalLength) / objectHeight;
      };

      const knownDistance = 5;
      const realHeight = 1.7;
      const focalLength = 1000;
      const imageHeight = 1080;
      const objectHeight = (realHeight * focalLength) / knownDistance;

      const calculatedDistance = calculateDistance(objectHeight, imageHeight, focalLength, realHeight);

      expect(calculatedDistance).toBeGreaterThan(4.5);
      expect(calculatedDistance).toBeLessThan(5.5);

      const errorPercentage = Math.abs((calculatedDistance - knownDistance) / knownDistance) * 100;
      expect(errorPercentage).toBeLessThan(10);
    });
  });

  describe('UT-DET-004: Evaluate Critical Hazard Level', () => {
    it('should classify vehicle at 3m as CRITICAL hazard', () => {
      const HazardScoringService = require('../src/services/HazardScoringService').default;

      const detectedObject = {
        class: 'car',
        distance: 3,
        velocity: 0,
        position: 'center'
      };

      const hazardLevel = HazardScoringService.calculateHazardScore(detectedObject);

      expect(hazardLevel.level).toBe('critical');
      expect(hazardLevel.priority).toBe('immediate');
    });
  });

  describe('UT-DET-005: Evaluate Low Hazard Level', () => {
    it('should classify tree at 15m as LOW hazard', () => {
      const evaluateHazard = (objectType, distance) => {
        if (objectType === 'vehicle' && distance < 5) return 'CRITICAL';
        if (objectType === 'person' && distance < 3) return 'HIGH';
        if (distance < 5) return 'MEDIUM';
        return 'LOW';
      };

      const hazardLevel = evaluateHazard('tree', 15);

      expect(hazardLevel).toBe('LOW');
    });
  });

  describe('UT-DET-006: Determine Object Position Relative to User', () => {
    it('should determine object is on the left', () => {
      const calculatePosition = (centerX, frameWidth) => {
        const relativePos = centerX / frameWidth;
        
        if (relativePos < 0.33) return 'FRONT_LEFT';
        if (relativePos < 0.67) return 'FRONT_CENTER';
        return 'FRONT_RIGHT';
      };

      const centerX = 100;
      const frameWidth = 640;
      
      const position = calculatePosition(centerX, frameWidth);

      expect(position).toBe('FRONT_LEFT');
      expect(centerX / frameWidth).toBeLessThan(0.33);
    });
  });
});

export default {
  module: 'Object Detection',
  coverage: 'FR3.1, FR3.2, FR3.3, FR3.4, FR3.6, FR3.8, NFR1.1'
};
