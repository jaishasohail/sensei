import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Dimensions, Alert } from 'react-native';
import * as ExpoCamera from 'expo-camera';
import { cameraWithTensors } from '@tensorflow/tfjs-react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import Button from '../components/Button';
import ObjectDetectionService from '../services/ObjectDetectionService';
import SettingsService from '../services/SettingsService';
import TextToSpeechService from '../services/TextToSpeechService';
import SpatialAudioService from '../services/SpatialAudioService';
import FootPlacementService from '../services/FootPlacementService';
import OCRService from '../services/OCRService';
import DepthEstimationService from '../services/DepthEstimationService';
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
  const CameraComponent = ExpoCamera?.Camera ?? ExpoCamera?.default ?? ExpoCamera;
  const ResolvedCameraType = ExpoCamera?.CameraType ?? ExpoCamera?.Type ?? (CameraComponent && CameraComponent.Constants ? CameraComponent.Constants.Type : undefined);
  const ResolvedCamera = isValidElementTypeLocal(CameraComponent)
    ? CameraComponent
    : (isValidElementTypeLocal(ExpoCamera?.CameraView) ? ExpoCamera.CameraView : null);
  const [hasPermission, setHasPermission] = useState(null);
  const [isActive, setIsActive] = useState(false);
  const [detectedObjects, setDetectedObjects] = useState([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [footWarnings, setFootWarnings] = useState([]);
  const [ocrText, setOcrText] = useState(null);
  const [isOcrActive, setIsOcrActive] = useState(false);
  const cameraRef = useRef(null);
  const [modelReady, setModelReady] = useState(false);
  const [TensorCameraComp, setTensorCameraComp] = useState(null);
  const TensorCameraRef = useRef(null);
  const isActiveRef = useRef(isActive);
  const TENSOR_WIDTH = 320; 
  const TENSOR_HEIGHT = 240; 
  const [hookPermission, hookRequestPermission] = useCompatCameraPermissions();
  useEffect(() => {
    requestCameraPermission();
    (async () => {
      try {
        await ObjectDetectionService.loadModel();
        const baseCamera = ResolvedCamera || CameraComponent || ExpoCamera.Camera;
        if (!isValidElementTypeLocal(baseCamera)) {
          console.warn('ARScreen: baseCamera is not a valid element type for cameraWithTensors', baseCamera);
        } else {
          const Comp = cameraWithTensors(baseCamera);
          setTensorCameraComp(() => Comp);
        }
        setModelReady(true);
      } catch (e) {
        console.warn('ARScreen: failed to load detection model', e);
      }
    })();
    const applyConfig = (s) => {
      const precision = !!s.precisionMode;
      const config = {
        scoreThreshold: precision ? 0.5 : 0.35,
        nmsIoUThreshold: precision ? 0.5 : 0.45,
        perClassNMS: true,
        smoothingFactor: precision ? 0.6 : 0.5,
        maxDetections: s.maxDetections ?? (precision ? 15 : 20),
        horizontalFOV: s.horizontalFOV ?? 70,
        verticalFOV: s.verticalFOV ?? 60,
        enableRefinementPass: !!s.refinementPass,
      };
      try { ObjectDetectionService.setConfig(config); } catch {}
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
      if (isActive) {
        stopARDetection();
      }
      if (typeof unsub === 'function') unsub();
    };
  }, []);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
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
  const startARDetection = async () => {
    try {
      // Initialize all real-time services
      await SpatialAudioService.initialize();
      await OCRService.initialize();
      await DepthEstimationService.initialize();
      
      if (modelReady && TensorCameraComp) {
        ObjectDetectionService.setCameraRef(cameraRef);
        setIsActive(true);
        
        // Start real-time foot placement monitoring with callback
        await FootPlacementService.startMonitoring([], (status) => {
          if (status.warnings) {
            setFootWarnings(status.warnings);
          }
        });
        
        // Log performance info
        console.log('ARScreen: Real-time services initialized');
        console.log('  - ObjectDetection: COCO-SSD with TensorFlow.js');
        console.log('  - OCR: Server-based with text buffering');
        console.log('  - Depth: MiDaS-style with object fallback');
        console.log('  - FootPlacement: Adaptive warnings enabled');
        
        TextToSpeechService.speak('AR detection started with real-time monitoring');
      } else {
        // Try to initialize TensorCamera again using base camera
        try {
          const baseCamera = ResolvedCamera || CameraComponent || ExpoCamera.Camera;
          if (isValidElementTypeLocal(baseCamera)) {
            const Comp = cameraWithTensors(baseCamera);
            setTensorCameraComp(() => Comp);
            setIsActive(true);
            TextToSpeechService.speak('AR detection started');
            return;
          }
        } catch (err) {
          console.warn('ARScreen: re-init TensorCamera failed', err);
        }
        Alert.alert('Camera unavailable', 'TensorCamera could not be initialized on this device.');
        TextToSpeechService.speak('Tensor camera unavailable');
      }
    } catch (error) {
      console.error('AR detection error:', error);
      Alert.alert('Error', 'Failed to start AR detection');
      TextToSpeechService.speak('Failed to start AR detection');
    }
  };
  const handleCameraStream = (images, updatePreview, gl) => {
    const loop = async () => {
      const imageTensor = images.next().value;
      if (isActiveRef.current && modelReady && imageTensor) {
        try {
          // Real-time object detection
          const detections = await ObjectDetectionService.detectFromTensor(imageTensor, TENSOR_WIDTH, TENSOR_HEIGHT);
          
          // Only update if we got valid detections (not rate-limited empty array)
          if (detections.length > 0 || ObjectDetectionService.getPerformanceMetrics().framesProcessed > 0) {
            setDetectedObjects(detections);
          }
          
          // Real-time foot placement analysis using processFrame
          if (FootPlacementService.isMonitoring() && detections.length > 0) {
            const footResult = await FootPlacementService.processFrame(detections, null);
            if (footResult && footResult.warnings) {
              setFootWarnings(footResult.warnings);
            }
          }
          
          // Speak about critical objects (rate limited internally by TTS)
          if (detections.length > 0) {
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
        } finally {
          try { if (imageTensor && typeof imageTensor.dispose === 'function') imageTensor.dispose(); } catch (e) {  }
        }
      }
      requestAnimationFrame(loop);
    };
    loop();
  };
  const stopARDetection = async () => {
    try {
      // Stop all real-time services
      ObjectDetectionService.stopDetection();
      FootPlacementService.stopMonitoring();
      OCRService.stopRealtimeOCR();
      DepthEstimationService.stopRealtimeDepth();
      await SpatialAudioService.stopAllSounds();
      
      // Clear state
      setIsActive(false);
      setDetectedObjects([]);
      setFootWarnings([]);
      setOcrText(null);
      setIsOcrActive(false);
      
      // Log final performance metrics
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
      if (!cameraRef.current) {
        Alert.alert('Camera unavailable', 'Camera reference not available');
        return;
      }
      
      setIsOcrActive(true);
      TextToSpeechService.speak('Capturing text');
      
      // Take photo for OCR
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.8,
      });
      
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
      {modelReady && TensorCameraComp ? (
        <TensorCameraComp
          ref={TensorCameraRef}
          style={styles.camera}
          type={ResolvedCameraType?.back ?? (CameraComponent && CameraComponent.Constants ? CameraComponent.Constants.Type.back : 'back')}
          cameraTextureWidth={TENSOR_WIDTH}
          cameraTextureHeight={TENSOR_HEIGHT}
          resizeWidth={TENSOR_WIDTH}
          resizeHeight={TENSOR_HEIGHT}
          onReady={handleCameraStream}
          autorender={true}
        />
      ) : (
        <ResolvedCamera
          ref={cameraRef}
          style={styles.camera}
          type={ResolvedCameraType?.back ?? (CameraComponent && CameraComponent.Constants ? CameraComponent.Constants.Type.back : 'back')}
          onCameraReady={() => setCameraReady(true)}
        />
      )}
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
                title={isActive ? 'Stop AR Detection' : 'Start AR Detection'}
                onPress={handleToggleAR}
                variant={isActive ? 'danger' : 'success'}
                size="medium"
                fullWidth
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
    flex: 1,
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
});
export default ARScreen;
