/**
 * Real-time object detection using Vision Camera + ML Kit (vision-camera-object-detector).
 * Requires: npx expo prebuild && npx expo run:android (or run:ios). Does not work in Expo Go.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { runOnJS } from 'react-native-reanimated';
import { COLORS } from '../constants/theme';

const { width: WINDOW_WIDTH, height: WINDOW_HEIGHT } = Dimensions.get('window');

// Lazy-load Vision Camera and plugin to avoid crashes when not available (e.g. Expo Go)
let Camera = null;
let useCameraDevice = null;
let useFrameProcessor = null;
let detectObjects = null;
let VisionCameraAvailable = false;

try {
  const vision = require('react-native-vision-camera');
  Camera = vision.Camera;
  useCameraDevice = vision.useCameraDevice;
  useFrameProcessor = vision.useFrameProcessor;
  const detector = require('vision-camera-object-detector');
  detectObjects = detector.detectObjects ?? detector.default?.detectObjects;
  VisionCameraAvailable = !!Camera && !!detectObjects;
} catch (e) {
  VisionCameraAvailable = false;
}

/**
 * Map plugin DetectedObject to app format { class, confidence, boundingBox, position, distance }.
 */
function mapToAppDetection(obj) {
  const label = obj?.labels?.[0];
  const bounds = obj?.bounds ?? {};
  const origin = bounds?.relativeOrigin ?? { left: 0, top: 0 };
  const size = bounds?.relativeSize ?? { width: 0.1, height: 0.1 };
  const left = typeof origin.left === 'number' ? origin.left : 0;
  const top = typeof origin.top === 'number' ? origin.top : 0;
  const w = typeof size.width === 'number' ? size.width : 0.1;
  const h = typeof size.height === 'number' ? size.height : 0.1;
  const centerX = left + w / 2;
  const centerY = top + h / 2;
  let relative = 'center';
  if (centerX < 0.33) relative = 'left';
  else if (centerX > 0.66) relative = 'right';
  return {
    class: label?.text ?? 'object',
    confidence: typeof label?.confidence === 'number' ? label.confidence : 0.5,
    boundingBox: { x: left, y: top, width: w, height: h },
    position: { relative, angle: (centerX - 0.5) * 70, center: { x: centerX, y: centerY } },
    distance: 2.0,
  };
}

export function isRealTimeCameraAvailable() {
  return VisionCameraAvailable;
}

export default function RealTimeCameraView({ onDetections, isActive, style }) {
  const [hasPermission, setHasPermission] = useState(false);
  const [detections, setDetections] = useState([]);
  const device = useCameraDevice ? useCameraDevice('back') : null;

  const setDetectionsOnJS = useCallback((list) => {
    const mapped = (list ?? []).map(mapToAppDetection);
    setDetections(mapped);
    onDetections?.(mapped);
  }, [onDetections]);

  useEffect(() => {
    if (!Camera?.requestCameraPermission) return;
    Camera.requestCameraPermission().then((status) => {
      setHasPermission(status === 'authorized');
    });
  }, []);

  const frameProcessor = useFrameProcessor
    ? useFrameProcessor(
        (frame) => {
          'worklet';
          try {
            const result = detectObjects(frame, {
              enableClassification: true,
              enableMultipleObjects: true,
            });
            runOnJS(setDetectionsOnJS)(result ?? []);
          } catch (e) {
            runOnJS(setDetectionsOnJS)([]);
          }
        },
        [setDetectionsOnJS]
      )
    : null;

  if (!VisionCameraAvailable || !device || !hasPermission) {
    return (
      <View style={[styles.placeholder, style]}>
        <Text style={styles.placeholderText}>
          {!VisionCameraAvailable
            ? 'Real-time camera requires a development build (npx expo prebuild && npx expo run:android)'
            : !device
              ? 'No camera device'
              : 'Camera permission required'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        frameProcessor={frameProcessor}
        frameProcessorFps={10}
      />
      {isActive && detections.map((d, i) => (
        <View
          key={i}
          style={[
            styles.box,
            {
              left: d.boundingBox.x * WINDOW_WIDTH,
              top: d.boundingBox.y * WINDOW_HEIGHT,
              width: d.boundingBox.width * WINDOW_WIDTH,
              height: d.boundingBox.height * WINDOW_HEIGHT,
            },
          ]}
        >
          <Text style={styles.label}>
            {d.class} {Math.round((d.confidence ?? 0) * 100)}%
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    padding: 24,
  },
  placeholderText: {
    color: COLORS.text,
    textAlign: 'center',
    fontSize: 14,
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  label: {
    backgroundColor: COLORS.primary,
    color: '#fff',
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 12,
  },
});
