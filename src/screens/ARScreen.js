import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Dimensions, Alert } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as ExpoCamera from 'expo-camera';
import { decodeJpeg } from '@tensorflow/tfjs-react-native';
import * as tf from '@tensorflow/tfjs';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Button from '../components/Button';
import ObjectDetectionService from '../services/ObjectDetectionService';
import SettingsService from '../services/SettingsService';
import TextToSpeechService from '../services/TextToSpeechService';
import SpatialAudioService from '../services/SpatialAudioService';
import FootPlacementService from '../services/FootPlacementService';
import OCRService from '../services/OCRService';
import DepthEstimationService from '../services/DepthEstimationService';
import ARService from '../services/ARService';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const { width, height } = Dimensions.get('window');
function useCompatCameraPermissions() {
  if (typeof ExpoCamera.useCameraPermissions === 'function') {
    return ExpoCamera.useCameraPermissions();
  }
  const [perm, setPerm] = React.useState(null);
  const request = async () => ({ status: 'denied' });
  return [perm, request];
}
function isValidElementTypeLocal(type) {
  if (typeof type === 'string' || typeof type === 'function') return true;
  if (type && typeof type === 'object') {
    try {
      if ('$$typeof' in type) return true;
    } catch (e) {
    }
  }
  return false;
}
const ARScreen = () => {
  // Prefer CameraView (newer API) for preview
  const CameraComponent = ExpoCamera?.Camera ?? ExpoCamera?.default ?? ExpoCamera;
  const CameraViewComponent = ExpoCamera?.CameraView;
  const ResolvedCameraType = ExpoCamera?.CameraType ?? ExpoCamera?.Type ?? (CameraComponent && CameraComponent.Constants ? CameraComponent.Constants.Type : undefined);
  const ResolvedCamera = isValidElementTypeLocal(CameraViewComponent)
    ? CameraViewComponent
    : (isValidElementTypeLocal(CameraComponent) ? CameraComponent : null);
  const [hasPermission, setHasPermission] = useState(null);
  const [isActive, setIsActive] = useState(false);
  const [detectedObjects, setDetectedObjects] = useState([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [footWarnings, setFootWarnings] = useState([]);
  const [ocrText, setOcrText] = useState(null);
  const [isOcrActive, setIsOcrActive] = useState(false);
  const cameraRef = useRef(null);
  const [modelReady, setModelReady] = useState(false);
  const isActiveRef = useRef(isActive);
  const arInitializedRef = useRef(false);
  const anchorIdsRef = useRef(new Set());
  const detectionIntervalRef = useRef(null);
  const detectionInFlightRef = useRef(false);
  const detectionLoopTimeoutRef = useRef(null);
  const isFocused = useIsFocused();
  const [cameraSessionKey, setCameraSessionKey] = useState(0);
  const TENSOR_WIDTH = 320;
  const TENSOR_HEIGHT = 240;
  const [stairInfo, setStairInfo] = useState(null);
  const [surfaceInfo, setSurfaceInfo] = useState(null);
  const [hookPermission, hookRequestPermission] = useCompatCameraPermissions();
  useEffect(() => {
    requestCameraPermission();
    (async () => {
      try {
        console.log('ARScreen: Initializing object detection model...');
        await ObjectDetectionService.loadModel();
        console.log('ARScreen: Model loaded');
        setModelReady(true);
      } catch (e) {
        console.error('ARScreen: CRITICAL - Model initialization failed:', e);
        try { console.error('ARScreen: Error stack:', e.stack); } catch { }
        console.warn('ARScreen: failed to initialize detection model');
      }
    })();
    const applyConfig = (s) => {
      const precision = !!s.precisionMode;
      const config = {
        scoreThreshold: precision ? 0.35 : 0.2, // Lower threshold for better real-time detection
        nmsIoUThreshold: precision ? 0.5 : 0.45,
        perClassNMS: true,
        smoothingFactor: precision ? 0.6 : 0.5,
        maxDetections: s.maxDetections ?? (precision ? 15 : 20),
        horizontalFOV: s.horizontalFOV ?? 70,
        verticalFOV: s.verticalFOV ?? 60,
        enableRefinementPass: !!s.refinementPass,
        disableFallback: true, // Disable fallback for real-time detection
        adaptiveThreshold: false,
      };
      try { ObjectDetectionService.setConfig(config); } catch { }
    };
    (async () => { applyConfig(await SettingsService.getSettings()); })();
    const unsub = SettingsService.addListener(applyConfig);
    try {
      console.log('ARScreen: ExpoCamera exports', ExpoCamera ? Object.keys(ExpoCamera) : ExpoCamera);
      console.log('ARScreen: CameraComponent type', typeof CameraComponent, CameraComponent && (CameraComponent.name || CameraComponent.displayName || 'component'));
    } catch (err) {
      console.warn('ARScreen: error logging camera exports', err);
    }
    return () => {
      if (isActiveRef.current) {
        stopARDetection();
      }
      if (typeof unsub === 'function') unsub();
    };
  }, []);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  useEffect(() => {
    if (!isFocused) {
      // Stop detection and reset camera state when leaving AR tab
      if (isActiveRef.current) {
        stopARDetection();
      }
      setDetectedObjects([]);
      setCameraReady(false);
    } else {
      // Force remount camera on re-focus to avoid black screen
      setCameraSessionKey((prev) => prev + 1);
    }
  }, [isFocused]);
  const requestCameraPermission = async () => {
    try {
      if (typeof hookRequestPermission === 'function') {
        try {
          const res = await hookRequestPermission();
          const status = res?.status ?? (res?.granted ? (res.granted ? 'granted' : 'denied') : undefined);
          if (status) {
            setHasPermission(status === 'granted');
            if (status !== 'granted') {
              TextToSpeechService.speak('Camera permission is required for AR features');
            }
            return;
          }
        } catch (err) {
          console.warn('Hook-based camera permission request failed:', err);
        }
      }
      const candidates = [
        ExpoCamera?.requestCameraPermissionsAsync,
        ExpoCamera?.requestPermissionsAsync,
        ExpoCamera?.Camera?.requestCameraPermissionsAsync,
        ExpoCamera?.Camera?.requestPermissionsAsync,
        CameraComponent?.requestCameraPermissionsAsync,
        CameraComponent?.requestPermissionsAsync,
      ];
      let status;
      for (const fn of candidates) {
        if (typeof fn === 'function') {
          try {
            const res = await fn();
            status = res?.status ?? (res?.granted ? (res.granted ? 'granted' : 'denied') : undefined);
            if (status) break;
          } catch (err) {
            console.warn('Camera permission candidate failed:', err);
            continue;
          }
        }
      }
      if (status) {
        setHasPermission(status === 'granted');
        if (status !== 'granted') {
          TextToSpeechService.speak('Camera permission is required for AR features');
        }
      } else {
        console.error('Camera permission API not found on expo-camera or Camera component.');
        setHasPermission(false);
        TextToSpeechService.speak('Camera module is not available');
      }
    } catch (error) {
      console.error('Permission error:', error);
      setHasPermission(false);
    }
  };
  const runFrameDetection = async () => {
    if (!cameraRef.current || typeof cameraRef.current.takePictureAsync !== 'function') {
      console.warn('ARScreen: Camera ref not ready or takePictureAsync unavailable');
      return;
    }
    if (detectionInFlightRef.current) {
      return;
    }
    detectionInFlightRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.3,
        skipProcessing: true,
        exif: false,
      });
      // Resume preview immediately after capture
      try {
        if (typeof cameraRef.current.resumePreview === 'function') {
          cameraRef.current.resumePreview();
        }
      } catch { }
      if (!photo?.base64) {
        console.warn('ARScreen: Photo captured but no base64 data');
        return;
      }

      // Decode JPEG to tensor
      const rawBytes = tf.util.encodeString(photo.base64, 'base64');
      let imageTensor = decodeJpeg(rawBytes, 3);
      const [origH, origW] = imageTensor.shape;
      
      // Resize to reasonable dimensions for faster inference
      let resizedTensor;
      if (origW > 640 || origH > 480) {
        resizedTensor = tf.tidy(() => {
          return tf.image.resizeBilinear(imageTensor.expandDims(0), [480, 640])
            .squeeze()
            .cast('int32');
        });
        imageTensor.dispose();
        imageTensor = resizedTensor;
      }
      
      const [imgH, imgW] = imageTensor.shape;
      
      // Run object detection
      const detections = await ObjectDetectionService.detectFromTensor(imageTensor, imgW, imgH);
      imageTensor.dispose();
      
      // Update detected objects state
      setDetectedObjects(detections);
      
      if (detections.length > 0) {
        // Run depth estimation on detected objects
        const depthData = await DepthEstimationService.processFrame(photo.base64, detections);
        
        // Run foot placement analysis with depth data
        if (FootPlacementService.isMonitoring()) {
          const footResult = await FootPlacementService.processFrame(detections, depthData);
          if (footResult) {
            if (footResult.warnings && footResult.warnings.length > 0) {
              setFootWarnings(footResult.warnings);
            }
            
            // Voice guidance for stairs
            if (footResult.stairs && footResult.stairs.detected) {
              setStairInfo(footResult.stairs);
              await FootPlacementService.warnStairs(footResult.stairs);
            } else {
              setStairInfo(null);
            }
            
            // Voice guidance for uneven surfaces
            if (footResult.surface && footResult.surface.detected) {
              setSurfaceInfo(footResult.surface);
              await FootPlacementService.warnUnevenSurface(footResult.surface);
            } else {
              setSurfaceInfo(null);
            }
          }
        }
        
        // Announce critical objects via voice
        const priorityObjects = detections
          .filter(d => ObjectDetectionService.getPriorityLevel(d) === 'critical')
          .sort((a, b) => a.distance - b.distance);
        if (priorityObjects.length > 0) {
          const obj = priorityObjects[0];
          TextToSpeechService.speak(ObjectDetectionService.getObjectDescription(obj));
          SpatialAudioService.playDirectionalBeep(obj.position.angle, obj.distance);
        }
      } else {
        // Clear warnings when no objects detected
        if (FootPlacementService.isMonitoring()) {
          FootPlacementService.processFrame([], null);
        }
        setFootWarnings([]);
        setStairInfo(null);
        setSurfaceInfo(null);
      }
    } catch (err) {
      console.warn('ARScreen: frame detection error:', err.message);
    } finally {
      detectionInFlightRef.current = false;
    }
  };
  const scheduleDetectionLoop = async () => {
    if (!isActiveRef.current || !isFocused) return;
    await runFrameDetection();
    // Run detection every 800ms for near real-time performance
    detectionLoopTimeoutRef.current = setTimeout(scheduleDetectionLoop, 800);
  };
  const startARDetection = async () => {
    try {
      console.log('ARScreen: Starting AR Detection...');
      console.log('ARScreen: modelReady:', modelReady);
      if (!modelReady || !cameraReady) {
        Alert.alert('Please wait', 'Object detection model is still loading. Try again in a moment.');
        TextToSpeechService.speak('Model still loading');
        return;
      }

      await SpatialAudioService.initialize();
      // Initialize depth and OCR services immediately (not deferred)
      await DepthEstimationService.initialize().catch((e) => {
        console.warn('ARScreen: DepthEstimation init failed:', e);
      });
      OCRService.initialize().catch(() => { });

      if (modelReady) {
        ObjectDetectionService.setCameraRef(cameraRef);
        setIsActive(true);
        console.log('ARScreen: ✓ Detection set to ACTIVE');
        console.log('ARScreen: Regular camera will remain visible, detection runs via snapshots');
        if (detectionIntervalRef.current) {
          clearInterval(detectionIntervalRef.current);
          detectionIntervalRef.current = null;
        }
        if (detectionLoopTimeoutRef.current) {
          clearTimeout(detectionLoopTimeoutRef.current);
          detectionLoopTimeoutRef.current = null;
        }
        scheduleDetectionLoop();

        await FootPlacementService.startMonitoring([], (status) => {
          if (status.warnings) {
            setFootWarnings(status.warnings);
          }
        });

        console.log('ARScreen: Real-time services initialized');
        console.log('  - ObjectDetection: COCO-SSD with TensorFlow.js');
        console.log('  - OCR: Server-based with text buffering');
        console.log('  - Depth: MiDaS-style with object fallback');
        console.log('  - FootPlacement: Adaptive warnings enabled');

        TextToSpeechService.speak('AR detection started with real-time monitoring');
      } else {
        Alert.alert('Unavailable', 'AR components not ready');
        TextToSpeechService.speak('AR components not ready');
      }
    } catch (error) {
      console.error('AR detection error:', error);
      Alert.alert('Error', 'Failed to start AR detection');
      TextToSpeechService.speak('Failed to start AR detection');
    }
  };
  const handleCameraStream = (images, updatePreview, gl) => {
    console.log('ARScreen: handleCameraStream started', {
      hasImages: !!images,
      hasUpdatePreview: !!updatePreview,
      hasGL: !!gl
    });
    if (!updatePreview) {
      console.warn('ARScreen: updatePreview function not provided - camera preview may not render!');
    }
    if (!images) {
      console.error('ARScreen: images iterator not provided');
      return;
    }
    let isLooping = true;
    let frameCount = 0;
    const loop = async () => {
      if (!isLooping) return;

      let imageTensor;
      try {
        imageTensor = images.next().value;
        if (!imageTensor) {
          requestAnimationFrame(loop);
          return;
        }

        frameCount++;

        // Advance frames for snapshot-based detection.
        if (typeof updatePreview === 'function') {
          try {
            updatePreview();
          } catch (e) {
            console.warn('ARScreen: updatePreview error', e);
          }
        }

        // If not active, just update preview and dispose tensor
        if (!isActiveRef.current) {
          try {
            if (imageTensor && typeof imageTensor.dispose === 'function') {
              imageTensor.dispose();
            }
          } catch (e) {
            console.warn('ARScreen: Error disposing tensor when inactive', e);
          }
          requestAnimationFrame(loop);
          return;
        }
      } catch (err) {
        console.error('ARScreen: Error getting image tensor', err);
        requestAnimationFrame(loop);
        return;
      }

      // Initialize AR service if needed (but don't interfere with camera preview)
      // Note: ARService uses the same GL context, so we need to be careful
      // For now, we'll skip ARService initialization to avoid conflicts with camera preview
      // AR overlays can be added later via React Native views instead of WebGL
      if (gl && !arInitializedRef.current && isActiveRef.current) {
        try {
          // Temporarily disable ARService to prevent GL context conflicts
          // await ARService.initialize(gl, { width, height, pixelRatio: 1 });
          // ARService.start();
          arInitializedRef.current = true;
          anchorIdsRef.current.forEach(id => ARService.removeAnchor(id));
          anchorIdsRef.current.clear();
          console.log('ARScreen: ARService initialization skipped to preserve camera preview');
        } catch (e) {
          console.warn('ARScreen: ARService init failed', e);
        }
      }

      // Process detection only when active and model is ready
      if (isActiveRef.current && modelReady && imageTensor) {
        try {
          if (frameCount % 30 === 0) {
            console.log(`ARScreen: Processing frame ${frameCount} for detection...`);
          }
          const detections = await ObjectDetectionService.detectFromTensor(imageTensor, TENSOR_WIDTH, TENSOR_HEIGHT);
          if (detections.length > 0 || frameCount % 30 === 0) {
            console.log(`ARScreen: Frame ${frameCount} - detected ${detections.length} objects`);
          }

          if (detections.length > 0 || ObjectDetectionService.getPerformanceMetrics().framesProcessed > 0) {
            setDetectedObjects(detections);
          }

          if (FootPlacementService.isMonitoring() && detections.length > 0) {
            const footResult = await FootPlacementService.processFrame(detections, null);
            if (footResult && footResult.warnings) {
              setFootWarnings(footResult.warnings);
            }
          }

          if (detections.length > 0) {
            // AR anchors are disabled to prevent GL context conflicts with camera preview
            // Visual overlays are handled via React Native views (objectMarker styles)
            // ARService 3D rendering can be re-enabled later with a separate GL context

            const priorityObjects = detections
              .filter(d => ObjectDetectionService.getPriorityLevel(d) === 'critical')
              .sort((a, b) => a.distance - b.distance);
            if (priorityObjects.length > 0) {
              const obj = priorityObjects[0];
              TextToSpeechService.speak(ObjectDetectionService.getObjectDescription(obj));
              SpatialAudioService.playDirectionalBeep(obj.position.angle, obj.distance);
            }
          }
        } catch (err) {
          console.warn('handleCameraStream detect error', err);
          console.error('Error details:', err.message, err.stack);
        } finally {
          // Dispose tensor after a delay to ensure detection completes
          // The model.detect() is async and might need the tensor
          setTimeout(() => {
            try {
              if (imageTensor && typeof imageTensor.dispose === 'function') {
                imageTensor.dispose();
              }
            } catch (e) {
              // Tensor might already be disposed, ignore
            }
          }, 200);
        }
      } else {
        // Dispose tensor even if not processing
        try {
          if (imageTensor && typeof imageTensor.dispose === 'function') {
            imageTensor.dispose();
          }
        } catch (e) {
          console.warn('ARScreen: Error disposing tensor when inactive', e);
        }
      }
      requestAnimationFrame(loop);
    };
    loop();

    // Return cleanup function
    return () => {
      isLooping = false;
    };
  };
  const stopARDetection = async () => {
    try {
      ObjectDetectionService.stopDetection();
      FootPlacementService.stopMonitoring();
      OCRService.stopRealtimeOCR();
      DepthEstimationService.stopRealtimeDepth();
      try { ARService.cleanup(); } catch (e) { /* ignore */ }
      arInitializedRef.current = false;
      anchorIdsRef.current.forEach(id => { try { ARService.removeAnchor(id); } catch { } });
      anchorIdsRef.current.clear();
      await SpatialAudioService.stopAllSounds();

      setIsActive(false);
      setDetectedObjects([]);
      setFootWarnings([]);
      setOcrText(null);
      setIsOcrActive(false);
      setStairInfo(null);
      setSurfaceInfo(null);
      // Clear detection interval if using polling
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
        detectionIntervalRef.current = null;
      }
      if (detectionLoopTimeoutRef.current) {
        clearTimeout(detectionLoopTimeoutRef.current);
        detectionLoopTimeoutRef.current = null;
      }

      console.log('ARScreen: AR detection stopped, regular camera remains visible');

      const objMetrics = ObjectDetectionService.getPerformanceMetrics();
      const footMetrics = FootPlacementService.getPerformanceMetrics();
      console.log('ARScreen: Session metrics');
      console.log(`  - Object Detection: ${objMetrics.framesProcessed} frames, avg ${objMetrics.avgInferenceTime.toFixed(1)}ms`);
      console.log(`  - Foot Placement: ${footMetrics.warningsIssued} warnings issued`);

      TextToSpeechService.speak('AR detection stopped');
    } catch (error) {
      console.error('Stop detection error:', error);
    }
  };
  const handleToggleAR = () => {
    if (isActive) {
      stopARDetection();
    } else {
      startARDetection();
    }
  };

  const handleReadText = async () => {
    try {
      const cam = cameraRef.current;
      if (!cam || typeof cam.takePictureAsync !== 'function') {
        Alert.alert('Camera unavailable', 'Camera reference not available');
        return;
      }

      setIsOcrActive(true);
      TextToSpeechService.speak('Capturing text');

      const photo = await cam.takePictureAsync({
        base64: true,
        quality: 0.8,
      });
      try {
        if (typeof cam.resumePreview === 'function') {
          await cam.resumePreview();
        }
      } catch { }

      const result = await OCRService.readTextFromImage(photo.base64);

      if (result.text && result.text.trim()) {
        setOcrText(result.text);
        await TextToSpeechService.speak(`Text detected: ${result.text}`);
      } else {
        await TextToSpeechService.speak('No text detected in image');
      }

      setIsOcrActive(false);
    } catch (error) {
      console.error('OCR error:', error);
      setIsOcrActive(false);
      Alert.alert('Error', 'Failed to read text from camera');
      TextToSpeechService.speak('Failed to read text');
    }
  };
  if (hasPermission === null) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Requesting camera permission...</Text>
      </View>
    );
  }
  if (hasPermission === false) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Camera permission denied</Text>
        <Button
          title="Request Permission"
          onPress={requestCameraPermission}
          variant="primary"
          size="medium"
        />
      </View>
    );
  }
  if (!ResolvedCamera) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Camera module is not available on this platform.</Text>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      {/* Always show regular camera for preview to avoid black screen */}
      <ResolvedCamera
        key={`regular-camera-${cameraSessionKey}`}
        ref={cameraRef}
        style={styles.camera}
        {...(CameraViewComponent ? { facing: 'back' } : { type: ResolvedCameraType?.back ?? (CameraComponent && CameraComponent.Constants ? CameraComponent.Constants.Type.back : 'back') })}
        onCameraReady={() => {
          setCameraReady(true);
          console.log('ARScreen: Regular camera ready');
        }}
      />
      <View style={styles.overlay}>
        <View style={styles.topBar}>
          <View style={styles.statusContainer}>
            <View style={[styles.statusDot, isActive && styles.statusDotActive]} />
            <Text style={styles.statusText}>
              {isActive ? 'AR Detection Active' : 'AR Detection Inactive'}
            </Text>
          </View>
          {isActive && detectedObjects.length > 0 && (
            <View style={styles.objectCount}>
              <MaterialCommunityIcons name="radar" size={20} color={COLORS.primary} />
              <Text style={styles.objectCountText}>{detectedObjects.length}</Text>
            </View>
          )}
        </View>
        {detectedObjects.map((obj, index) => {
          const priority = ObjectDetectionService.getPriorityLevel(obj);
          const markerColor = priority === 'critical' ? COLORS.danger :
            priority === 'warning' ? COLORS.warning : COLORS.primary;
          return (
            <View
              key={index}
              style={[
                styles.objectMarker,
                {
                  left: obj.boundingBox.x * width,
                  top: obj.boundingBox.y * height,
                  width: obj.boundingBox.width * width,
                  height: obj.boundingBox.height * height,
                  borderColor: markerColor,
                },
              ]}
            >
              <View style={[styles.objectLabel, { backgroundColor: markerColor }]}>
                <Text style={styles.objectLabelText}>
                  {obj.class}
                </Text>
                <Text style={styles.objectLabelDistance}>
                  {obj.distance.toFixed(1)}m {obj.position.relative}
                </Text>
              </View>
            </View>
          );
        })}
        <View style={styles.bottomBar}>
          {footWarnings.length > 0 && (
            <View style={styles.warningInfo}>
              <View style={styles.warningHeader}>
                <Ionicons name="warning" size={20} color={COLORS.warning} />
                <Text style={styles.warningTitle}>Foot Placement Warnings</Text>
              </View>
              {footWarnings.slice(0, 2).map((warning, index) => (
                <View key={index} style={styles.warningItem}>
                  <MaterialCommunityIcons
                    name="alert-circle"
                    size={16}
                    color={warning.hazardLevel === 'critical' ? COLORS.danger : COLORS.warning}
                  />
                  <Text style={styles.warningText}>{warning.message}</Text>
                </View>
              ))}
            </View>
          )}

          {ocrText && (
            <View style={styles.ocrInfo}>
              <View style={styles.ocrHeader}>
                <Ionicons name="text" size={20} color={COLORS.primary} />
                <Text style={styles.ocrTitle}>Detected Text</Text>
              </View>
              <Text style={styles.ocrText}>{ocrText}</Text>
            </View>
          )}

          {stairInfo && stairInfo.detected && (
            <View style={styles.stairWarning}>
              <View style={styles.stairHeader}>
                <MaterialCommunityIcons name="stairs" size={20} color={COLORS.warning} />
                <Text style={styles.stairTitle}>Stairs Detected</Text>
              </View>
              <Text style={styles.stairText}>
                {stairInfo.goingDown ? 'Going down' : 'Going up'} — {stairInfo.count} steps, {stairInfo.distance.toFixed(1)}m {stairInfo.direction}
              </Text>
              <Text style={styles.stairGuidance}>
                {stairInfo.distance < 1.0
                  ? (stairInfo.goingDown ? 'Step down slowly, feel each step' : 'Lift feet higher for each step')
                  : 'Approaching stairs — use handrail if available'}
              </Text>
            </View>
          )}

          {surfaceInfo && surfaceInfo.detected && (
            <View style={styles.surfaceWarning}>
              <View style={styles.surfaceHeader}>
                <MaterialCommunityIcons name="terrain" size={20} color={surfaceInfo.severity === 'high' ? COLORS.danger : COLORS.warning} />
                <Text style={styles.surfaceTitle}>Uneven Surface</Text>
              </View>
              <Text style={styles.surfaceText}>
                Severity: {surfaceInfo.severity} — Place feet carefully on flat spots
              </Text>
            </View>
          )}

          {detectedObjects.length > 0 && (
            <View style={styles.detectionInfo}>
              <View style={styles.detectionHeader}>
                <Ionicons name="eye" size={20} color={COLORS.primary} />
                <Text style={styles.detectionCount}>
                  Detected Objects ({detectedObjects.length})
                </Text>
              </View>
              <View style={styles.detectionList}>
                {detectedObjects.slice(0, 3).map((obj, index) => {
                  const priority = ObjectDetectionService.getPriorityLevel(obj);
                  const iconColor = priority === 'critical' ? COLORS.danger :
                    priority === 'warning' ? COLORS.warning : COLORS.success;
                  return (
                    <View key={index} style={styles.detectionItem}>
                      <View style={styles.detectionItemLeft}>
                        <MaterialCommunityIcons
                          name={getObjectIcon(obj.class)}
                          size={16}
                          color={iconColor}
                        />
                        <Text style={styles.detectionItemText}>{obj.class}</Text>
                      </View>
                      <Text style={styles.detectionItemDistance}>
                        {obj.distance.toFixed(1)}m {obj.position.relative}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}
          <View style={styles.controls}>
            <Button
              title={isActive ? 'Stop AR Detection' : (modelReady ? 'Start AR Detection' : 'Model loading...')}
              onPress={handleToggleAR}
              variant={isActive ? 'danger' : 'success'}
              size="medium"
              fullWidth
              disabled={!modelReady || !cameraReady}
              icon={<Ionicons name={isActive ? 'stop-circle' : 'play-circle'} size={18} color={COLORS.text} />}
            />
            {isActive && (
              <Button
                title={isOcrActive ? 'Reading...' : 'Read Text'}
                onPress={handleReadText}
                variant="secondary"
                size="medium"
                fullWidth
                disabled={isOcrActive}
                loading={isOcrActive}
                icon={<Ionicons name="text" size={18} color={COLORS.text} />}
                style={{ marginTop: SPACING.sm }}
              />
            )}
          </View>
        </View>
      </View>
    </View>
  );
};
const getObjectIcon = (objectClass) => {
  const iconMap = {
    'person': 'account',
    'car': 'car',
    'bus': 'bus',
    'truck': 'truck',
    'bicycle': 'bike',
    'motorcycle': 'motorbike',
    'traffic light': 'traffic-light',
    'stop sign': 'stop-circle',
    'door': 'door',
    'chair': 'seat',
    'table': 'table-furniture',
    'laptop': 'laptop',
    'bottle': 'bottle-tonic',
    'cup': 'cup',
  };
  return iconMap[objectClass] || 'shape';
};
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  message: {
    fontSize: FONT_SIZES.lg,
    color: COLORS.text,
    textAlign: 'center',
    marginBottom: SPACING.xl,
    paddingHorizontal: SPACING.xl,
  },
  camera: {
    flex: 1,
    width: width,
    height: height,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
  },
  topBar: {
    paddingTop: 50,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.gray,
    marginRight: SPACING.sm,
  },
  statusDotActive: {
    backgroundColor: COLORS.success,
  },
  statusText: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.text,
  },
  objectCount: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cardBackground,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
  },
  objectCountText: {
    fontSize: FONT_SIZES.md,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginLeft: SPACING.xs,
  },
  objectMarker: {
    position: 'absolute',
    borderWidth: 3,
    borderRadius: BORDER_RADIUS.sm,
  },
  objectLabel: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  objectLabelText: {
    fontSize: FONT_SIZES.xs,
    fontWeight: '700',
    color: COLORS.dark,
    textTransform: 'capitalize',
  },
  objectLabelDistance: {
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.dark,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    padding: SPACING.lg,
    borderTopLeftRadius: BORDER_RADIUS.lg,
    borderTopRightRadius: BORDER_RADIUS.lg,
  },
  detectionInfo: {
    marginBottom: SPACING.lg,
    minHeight: 60,
  },
  detectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  detectionCount: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.text,
    marginLeft: SPACING.sm,
  },
  detectionList: {
    gap: SPACING.sm,
  },
  detectionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.cardBackground,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.sm,
    marginBottom: SPACING.xs,
  },
  detectionItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detectionItemText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    marginLeft: SPACING.sm,
    textTransform: 'capitalize',
    fontWeight: '600',
  },
  detectionItemDistance: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  controls: {
    width: '100%',
  },
  stairWarning: {
    marginBottom: SPACING.md,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.warning,
  },
  stairHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  stairTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.warning,
    marginLeft: SPACING.sm,
  },
  stairText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  stairGuidance: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
  surfaceWarning: {
    marginBottom: SPACING.md,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.danger,
  },
  surfaceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  surfaceTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.danger,
    marginLeft: SPACING.sm,
  },
  surfaceText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
  },
});
export default ARScreen;
