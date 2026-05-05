import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
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
import VoiceCommandService from '../services/VoiceCommandService';
import RealTimeCameraView, { isRealTimeCameraAvailable } from '../components/RealTimeCameraView';
import { COLORS, SPACING, FONT_SIZES, BORDER_RADIUS } from '../constants/theme';
const { width, height } = Dimensions.get('window');
const DEFAULT_DETECTION_ASPECT = 640 / 480;

function getDetectionContentRect(viewWidth, viewHeight, aspectRatio) {
  const aspect = aspectRatio ?? DEFAULT_DETECTION_ASPECT;
  const viewAspect = viewWidth / viewHeight;
  if (viewAspect > aspect) {
    const contentHeight = viewHeight;
    const contentWidth = viewHeight * aspect;
    return { x: (viewWidth - contentWidth) / 2, y: 0, width: contentWidth, height: contentHeight };
  }
  const contentWidth = viewWidth;
  const contentHeight = viewWidth / aspect;
  return { x: 0, y: (viewHeight - contentHeight) / 2, width: contentWidth, height: contentHeight };
}

const CameraViewComponent = ExpoCamera?.CameraView;

// CameraWithCaptureRequest is a forwardRef component so that the parent can
// call takePictureAsync on it (needed for OCR / "Read Text" button).
const CameraWithCaptureRequest = forwardRef(function CameraWithCaptureRequest(
  { captureRequest, onCapture, onReady, ...props },
  externalRef
) {
  const innerRef = useRef(null);
  const capturingRef = useRef(false);
  const lastRequestRef = useRef(0);
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  // Expose takePictureAsync, captureForOCR, and resumePreview to the parent.
  useImperativeHandle(externalRef, () => ({
    takePictureAsync: (opts) => {
      const cam = innerRef.current;
      if (!cam || typeof cam.takePictureAsync !== 'function') {
        return Promise.reject(new Error('Camera not ready'));
      }
      return cam.takePictureAsync(opts);
    },

    // Safe OCR capture: waits for any in-flight detection snapshot to finish,
    // then acquires the capturingRef lock so the detection loop cannot start a
    // new snapshot while OCR is taking its photo.
    //
    // Using takePictureAsync directly from handleReadText (without this lock)
    // races with the detection-loop effect: if captureRequest was already
    // incremented before ocrCapturingRef was set, both captures run at the same
    // time → expo-camera throws "Camera unmounted during taking photo process".
    captureForOCR: async (opts) => {
      // Wait up to 1 s for any detection snapshot that is already in flight.
      let waited = 0;
      while (capturingRef.current && waited < 1000) {
        await new Promise(r => setTimeout(r, 50));
        waited += 50;
      }
      const cam = innerRef.current;
      if (!cam || typeof cam.takePictureAsync !== 'function') {
        throw new Error('Camera not ready');
      }
      // Hold the lock so the detection-loop effect is blocked for the duration.
      capturingRef.current = true;
      try {
        return await cam.takePictureAsync(opts);
      } finally {
        capturingRef.current = false;
      }
    },

    resumePreview: () => {
      const cam = innerRef.current;
      if (cam && typeof cam.resumePreview === 'function') {
        return cam.resumePreview();
      }
    },
  }), []);

  useEffect(() => {
    if (!CameraViewComponent || !captureRequest || captureRequest === lastRequestRef.current) return;
    if (capturingRef.current) return;
    const cam = innerRef.current;
    if (captureRequest <= 3 || captureRequest % 10 === 1) {
      console.log('ARScreen: [CAPTURE] request=' + captureRequest + ' cam=' + !!cam + ' takePictureAsync=' + !!(cam && typeof cam.takePictureAsync === 'function'));
    }
    if (!cam) {
      console.warn('ARScreen: Capture requested but camera ref not ready');
      return;
    }
    const takePicture = typeof cam.takePictureAsync === 'function' ? cam.takePictureAsync.bind(cam) : (typeof cam.takePicture === 'function' ? cam.takePicture.bind(cam) : null);
    if (!takePicture) {
      console.warn('ARScreen: Camera has no takePictureAsync/takePicture');
      return;
    }
    lastRequestRef.current = captureRequest;
    capturingRef.current = true;
    // skipProcessing removed: expo-camera must apply EXIF rotation so decodeJpeg
    // receives a correctly-oriented frame (Android stores JPEGs in sensor-native
    // landscape with an EXIF rotate tag that TensorFlow.js ignores).
    takePicture({ base64: true, quality: 0.8, exif: false })
      .then((photo) => {
        if (captureRequest <= 2) console.log('ARScreen: [CAPTURE] photo ok base64=' + !!(photo?.base64));
        if (photo?.base64) onCaptureRef.current?.(photo);
      })
      .catch((err) => {
        console.warn('ARScreen: Capture failed', err?.message || err);
      })
      .finally(() => {
        capturingRef.current = false;
      });
  }, [captureRequest]);

  return (
    <CameraViewComponent
      {...props}
      ref={innerRef}
      onCameraReady={onReady || props.onCameraReady}
    />
  );
});
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
  const TENSOR_WIDTH = 640;
  const TENSOR_HEIGHT = 480;
  const [stairInfo, setStairInfo] = useState(null);
  const [surfaceInfo, setSurfaceInfo] = useState(null);
  const [hookPermission, hookRequestPermission] = useCompatCameraPermissions();
  const [detectionFrameCount, setDetectionFrameCount] = useState(0);
  const [lastDetectionCount, setLastDetectionCount] = useState(-1);
  const [detectionStatus, setDetectionStatus] = useState('');
  const detectionFrameCountRef = useRef(0);
  const [captureRequest, setCaptureRequest] = useState(0);
  const processCapturedPhotoRef = useRef(() => {});
  // Prevents the detection snapshot loop from firing while OCR is capturing.
  // Simultaneous captures cause "Camera unmounted during taking photo process".
  const ocrCapturingRef = useRef(false);
  const lastDetectionAspectRef = useRef(DEFAULT_DETECTION_ASPECT);
  const previousFrameDetectionsRef = useRef([]);
  const useRealtimeRef = useRef(false);
  // Per-class TTS cooldown: prevents speaking the same object class more than once every 5 s.
  const ttsLastSpokenRef = useRef(new Map());
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
      const config = {
        // 0.40 is the right floor for real phone-camera frames — at 0.55 the model
        // returns 0 raw predictions for most frames (real-world footage is blurrier
        // than COCO training images).  False-positive classes are still protected
        // by FALSE_POSITIVE_CLASSES requiring ≥0.70.
        scoreThreshold: 0.40,
        confirmBypassThreshold: 0.55,  // ≥0.55 → shown immediately; 0.40-0.55 → needs 2 frames
        nmsIoUThreshold: 0.45,
        perClassNMS: true,
        smoothingFactor: 0.50,
        trackMaxAgeMs: 600,
        associationIoUThreshold: 0.30,
        minConfirmFrames: 1,
        maxDetections: s.maxDetections ?? 15,
        horizontalFOV: s.horizontalFOV ?? 70,
        verticalFOV: s.verticalFOV ?? 60,
        enableRefinementPass: false,
        disableFallback: true,
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

  // Register VoiceCommandService callbacks for AR screen control
  useEffect(() => {
    VoiceCommandService.setCallbacks({
      onStartDetection: () => {
        if (!isActiveRef.current && cameraReady) {
          startARDetection();
        }
      },
      onStopDetection: () => {
        if (isActiveRef.current) {
          stopARDetection();
        }
      },
      onReadText: () => {
        // Trigger OCR if available
        if (!isOcrActive) {
          setIsOcrActive(true);
        }
      },
    });
  }, [cameraReady]);

  // Sync detected objects to VoiceCommandService for voice queries
  useEffect(() => {
    VoiceCommandService.setDetectedObjects(detectedObjects);
  }, [detectedObjects]);

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
  const processCapturedPhoto = async (photo) => {
    if (!photo?.base64) {
      setDetectionStatus('No base64 in photo');
      return;
    }
    detectionInFlightRef.current = true;
    setDetectionStatus('Running model...');
    try {
      const rawBytes = tf.util.encodeString(photo.base64, 'base64');
      let imageTensor = decodeJpeg(rawBytes, 3);
      let [origH, origW] = imageTensor.shape;

      // ── ORIENTATION FIX ────────────────────────────────────────────────────
      // On Android, takePictureAsync always returns the raw sensor frame in
      // landscape orientation (W > H) with an EXIF rotation tag that tells the
      // OS how to display it.  tf.decodeJpeg ignores EXIF, so when the device
      // is held in portrait the tensor has objects rotated 90° — detection sees
      // a landscape image and raw predictions drop to 0 for most frames.
      //
      // Fix: when the photo is landscape but the device screen is portrait,
      // apply the implicit EXIF 90° CW rotation manually:
      //   transpose [H,W,C] → [W,H,C]  then  reverse axis-1 (columns)
      // This is equivalent to rotating the pixel grid 90° clockwise.
      if (origW > origH) {
        const screenDims = Dimensions.get('window');
        if (screenDims.height > screenDims.width) {
          // Device is portrait, raw sensor frame is landscape → rotate 90° CW
          const rotated = tf.tidy(() =>
            tf.transpose(imageTensor, [1, 0, 2]).reverse(1)
          );
          imageTensor.dispose();
          imageTensor = rotated;
          [origH, origW] = imageTensor.shape; // update to post-rotation dimensions
          if (detectionFrameCountRef.current <= 2) {
            console.log('ARScreen: Applied 90° CW rotation (was landscape, device is portrait)');
          }
        }
      }

      // Use smaller resolution on CPU backend to keep inference time acceptable.
      // Scale so the LONGER dimension is maxSize — this works for both landscape
      // and portrait frames.  The old maxW/maxH (640×480) squashed a portrait
      // frame to only ~273 px wide, making person detection unreliable.
      const isCpuBackend = tf.getBackend() === 'cpu';
      const maxSize = isCpuBackend ? 416 : 640;
      const scale = maxSize / Math.max(origW, origH);
      const targetW = Math.round(origW * scale);
      const targetH = Math.round(origH * scale);
      if (targetW < 1 || targetH < 1) {
        setDetectionStatus('Image too small');
        return;
      }
      if (origW !== targetW || origH !== targetH) {
        if (detectionFrameCountRef.current <= 2) {
          console.log('ARScreen: Resizing photo from', origW + 'x' + origH, 'to', targetW + 'x' + targetH, '(aspect preserved)');
        }
        const resizedTensor = tf.tidy(() => {
          return tf.image.resizeBilinear(imageTensor.expandDims(0), [targetH, targetW])
            .squeeze()
            .cast('int32');
        });
        imageTensor.dispose();
        imageTensor = resizedTensor;
      }
      const [imgH, imgW] = imageTensor.shape;
      lastDetectionAspectRef.current = imgW / imgH;
      const detections = await ObjectDetectionService.detectFromTensor(imageTensor, imgW, imgH);
      imageTensor.dispose();

      // ObjectDetectionService already enforces scoreThreshold + temporal consistency.
      // The only extra guard here is a redundant confidence floor for defence-in-depth.
      const DISPLAY_THRESHOLD = 0.40;
      const filteredDetections = detections.filter(d => (d.confidence ?? 0) >= DISPLAY_THRESHOLD);

      previousFrameDetectionsRef.current = filteredDetections.map((d) => ({
        class: d.class,
        cx: d.position?.center?.x ?? (d.boundingBox.x + d.boundingBox.width / 2),
        cy: d.position?.center?.y ?? (d.boundingBox.y + d.boundingBox.height / 2),
      }));
      setLastDetectionCount(filteredDetections.length);
      setDetectionStatus(filteredDetections.length > 0 ? `${filteredDetections.length} object(s)` : '0 objects');
      if (detectionFrameCountRef.current <= 5 || filteredDetections.length > 0 || detectionFrameCountRef.current % 20 === 0) {
        console.log('ARScreen: Frame #' + detectionFrameCountRef.current + ' -> ' + filteredDetections.length + ' detected (raw: ' + detections.length + ')');
      }
      setDetectedObjects(filteredDetections);
      const frameNum = detectionFrameCountRef.current;
      const runDepthAndFoot = frameNum % 2 === 0; // every 2nd frame to keep UI responsive
      if (filteredDetections.length > 0) {
        let depthData = null;
        if (runDepthAndFoot) {
          depthData = await DepthEstimationService.processFrame(photo.base64, filteredDetections);
          if (FootPlacementService.isMonitoring()) {
            const footResult = await FootPlacementService.processFrame(filteredDetections, depthData);
            if (footResult) {
              if (footResult.warnings?.length > 0) setFootWarnings(footResult.warnings);
              if (footResult.stairs?.detected) {
                setStairInfo(footResult.stairs);
                await FootPlacementService.warnStairs(footResult.stairs);
              } else setStairInfo(null);
              if (footResult.surface?.detected) {
                setSurfaceInfo(footResult.surface);
                await FootPlacementService.warnUnevenSurface(footResult.surface);
              } else setSurfaceInfo(null);
              }
            }
          }
        // ── Voice assistance: announce ALL detected objects by hazard level ──
        // announceDetectedObjects handles per-class cooldowns internally so TTS
        // never floods the user. Critical objects get 4 s cooldown, others longer.
        ObjectDetectionService.announceDetectedObjects(
          filteredDetections,
          (text, opts, priority) => TextToSpeechService.speak(text, opts, priority)
        );
        // Spatial audio beep for the closest critical/warning object
        const topHazard = filteredDetections
          .filter(d => ObjectDetectionService.getPriorityLevel(d) !== 'info')
          .sort((a, b) => a.distance - b.distance)[0];
        if (topHazard) {
          SpatialAudioService.playDirectionalBeep(topHazard.position.angle, topHazard.distance);
        }
        // Log to server (non-blocking)
        ObjectDetectionService.logDetectionsToServer(filteredDetections).catch(() => {});
      } else {
        if (runDepthAndFoot && FootPlacementService.isMonitoring()) FootPlacementService.processFrame([], null);
        previousFrameDetectionsRef.current = [];
        if (runDepthAndFoot) {
          setFootWarnings([]);
          setStairInfo(null);
          setSurfaceInfo(null);
        }
      }
    } catch (err) {
      setDetectionStatus('Error: ' + (err.message || 'unknown'));
      console.warn('ARScreen: processCapturedPhoto error:', err?.message, err?.stack);
    } finally {
      detectionInFlightRef.current = false;
    }
  };

  processCapturedPhotoRef.current = processCapturedPhoto;

  const runFrameDetection = () => {
    if (detectionInFlightRef.current) return;
    // Don't fire a snapshot capture while OCR is taking its own photo.
    if (ocrCapturingRef.current) return;
    detectionFrameCountRef.current += 1;
    setDetectionFrameCount(detectionFrameCountRef.current);
    setDetectionStatus('Capturing...');
    if (detectionFrameCountRef.current <= 5 || detectionFrameCountRef.current % 15 === 0) {
      console.log('ARScreen: Detection frame #' + detectionFrameCountRef.current + ', requesting capture');
    }
    setCaptureRequest((prev) => prev + 1);
  };

  const handleCapture = (photo) => {
    processCapturedPhotoRef.current(photo);
    if (isActiveRef.current && isFocused) {
      // CPU backend is much slower — give it breathing room; GPU runs tight loop
      const loopDelay = tf.getBackend() === 'cpu' ? 500 : 100;
      detectionLoopTimeoutRef.current = setTimeout(scheduleDetectionLoop, loopDelay);
    }
  };

  // Snapshot-based detection (takePictureAsync every 250ms). True real-time would need
  // cameraWithTensors (expo-camera no longer exports Camera component) or react-native-vision-camera frame processor.
  const scheduleDetectionLoop = () => {
    if (!isActiveRef.current || !isFocused) {
      if (detectionFrameCountRef.current < 3) {
        console.log('ARScreen: [LOOP SKIP] isActiveRef=', isActiveRef.current, 'isFocused=', isFocused);
      }
      return;
    }
    runFrameDetection();
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
        useRealtimeRef.current = isRealTimeCameraAvailable();
        ObjectDetectionService.setCameraRef(cameraRef);
        ObjectDetectionService.setConfig({ scoreThreshold: 0.40, confirmBypassThreshold: 0.55 });
        setIsActive(true);
        isActiveRef.current = true;
        if (useRealtimeRef.current) {
          console.log('ARScreen: Using real-time Vision Camera (frame processor)');
        }
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
        if (!useRealtimeRef.current) {
          console.log('ARScreen: Starting detection loop (snapshot every 250ms), isFocused=', isFocused);
          scheduleDetectionLoop();
        }

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
            // ── Voice assistance for all hazard levels ──
            ObjectDetectionService.announceDetectedObjects(
              detections,
              (text, opts, priority) => TextToSpeechService.speak(text, opts, priority)
            );
            const topHazard = detections
              .filter(d => ObjectDetectionService.getPriorityLevel(d) !== 'info')
              .sort((a, b) => a.distance - b.distance)[0];
            if (topHazard) {
              SpatialAudioService.playDirectionalBeep(topHazard.position.angle, topHazard.distance);
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
      isActiveRef.current = false;
      setDetectedObjects([]);
      previousFrameDetectionsRef.current = [];
      ttsLastSpokenRef.current.clear();
      setFootWarnings([]);
      setOcrText(null);
      setIsOcrActive(false);
      setStairInfo(null);
      setSurfaceInfo(null);
      setDetectionFrameCount(0);
      setLastDetectionCount(-1);
      setDetectionStatus('');
      detectionFrameCountRef.current = 0;
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
    // Don't attempt OCR if the screen is no longer focused — the camera may
    // be in the middle of unmounting, which causes the "Camera unmounted
    // during taking photo process" error.
    if (!isFocused) return;
    try {
      const cam = cameraRef.current;
      if (!cam || typeof cam.captureForOCR !== 'function') {
        Alert.alert('Camera unavailable', 'Camera is not ready yet — please wait a moment and try again.');
        return;
      }

      setIsOcrActive(true);
      // Signal the detection loop not to fire new captures.
      ocrCapturingRef.current = true;

      // ── 1. Health check FIRST ────────────────────────────────────────────────
      // We MUST verify the server is reachable before taking a photo or saying
      // "Capturing text".  Without this check the user would hear "Capturing
      // text" immediately followed by "Server not running" — a confusing and
      // unrecoverable UX sequence that we guarantee can never happen here.
      const serverAlive = await OCRService.checkServerHealth();
      if (!serverAlive) {
        TextToSpeechService.speak('Server not running. Please start the server and try again.');
        Alert.alert(
          'Server unavailable',
          'Could not reach the AI server. Make sure it is running and you are on the same Wi-Fi network.'
        );
        return; // goes to finally block — resets ocrCapturingRef and isOcrActive
      }

      // ── 2. Server confirmed up — now speak and capture ───────────────────────
      TextToSpeechService.speak('Capturing text');

      const photo = await cam.captureForOCR({
        base64: true,
        quality: 0.9,
      });

      // skipHealthCheck: true — we already verified above; no need to pay for
      // a second round-trip before sending the image payload.
      const result = await OCRService.readTextFromImage(photo.base64, { skipHealthCheck: true });

      if (result.serverDown) {
        // Server went down in the narrow window between health check and OCR
        // call — extremely rare but handled gracefully.
        TextToSpeechService.speak('Server became unavailable. Please try again.');
        Alert.alert('Server unavailable', 'The server stopped responding. Make sure it is still running.');
      } else if (result.isTimeout) {
        TextToSpeechService.speak('Reading text timed out. The server may be starting up. Please try again in a moment.');
      } else if (result.text && result.text.trim()) {
        setOcrText(result.text);
        TextToSpeechService.speak(`Text detected: ${result.text}`);
      } else {
        TextToSpeechService.speak('No text detected in image');
      }
    } catch (error) {
      console.error('OCR error:', error);
      Alert.alert('Error', 'Failed to read text from camera');
      TextToSpeechService.speak('Failed to read text');
    } finally {
      // Always resume detection loop and clear OCR state.
      ocrCapturingRef.current = false;
      setIsOcrActive(false);
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
  const cameraKey = `regular-camera-${cameraSessionKey}`;
  const cameraProps = {
    style: styles.camera,
    onReady: () => {
      setCameraReady(true);
      console.log('ARScreen: Regular camera ready');
    },
  };
  if (CameraViewComponent) {
    cameraProps.facing = 'back';
  } else if (CameraComponent?.Constants) {
    cameraProps.type = ResolvedCameraType?.back ?? CameraComponent.Constants.Type?.back ?? 'back';
  }

  const realTimeActive = isActive && useRealtimeRef.current;

  return (
    <View style={styles.container}>
      {realTimeActive ? (
        <RealTimeCameraView
          style={StyleSheet.absoluteFill}
          isActive={isActive}
          onDetections={(list) => {
            setDetectedObjects(list ?? []);
            setLastDetectionCount((list ?? []).length);
          }}
        />
      ) : CameraViewComponent ? (
        <CameraWithCaptureRequest
          key={cameraKey}
          ref={cameraRef}
          {...cameraProps}
          captureRequest={captureRequest}
          onCapture={handleCapture}
        />
      ) : (
        <ResolvedCamera key={cameraKey} {...cameraProps} ref={cameraRef} />
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
        {isActive && (
          <View style={styles.detectionStatusBar}>
            <Text style={styles.detectionStatusText} numberOfLines={2}>
              Frames: {detectionFrameCount} | Last: {lastDetectionCount >= 0 ? lastDetectionCount : '–'} objects
            </Text>
            <Text style={styles.detectionStatusSubtext} numberOfLines={1}>
              {detectionStatus || 'Starting...'}
            </Text>
          </View>
        )}
        {detectedObjects.map((obj, index) => {
          const priority = ObjectDetectionService.getPriorityLevel(obj);
          const markerColor = priority === 'critical' ? COLORS.danger :
            priority === 'warning' ? COLORS.warning : COLORS.primary;
          const content = getDetectionContentRect(width, height, lastDetectionAspectRef.current);
          const box = {
            left: content.x + obj.boundingBox.x * content.width,
            top: content.y + obj.boundingBox.y * content.height,
            width: obj.boundingBox.width * content.width,
            height: obj.boundingBox.height * content.height,
          };
          return (
            <View
              key={index}
              style={[
                styles.objectMarker,
                {
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  borderColor: markerColor,
                },
              ]}
            >
              <View style={[styles.objectLabel, { backgroundColor: markerColor }]}>
                <Text style={styles.objectLabelText}>
                  {obj.class} {Math.round((obj.confidence ?? 0) * 100)}%
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
  detectionStatusBar: {
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  detectionStatusText: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    color: COLORS.text,
  },
  detectionStatusSubtext: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    marginTop: 2,
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
