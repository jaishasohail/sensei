import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { View, Text, StyleSheet, Dimensions, Alert, Platform } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as ExpoCamera from 'expo-camera';
import { decodeJpeg } from '@tensorflow/tfjs-react-native';
import * as tf from '@tensorflow/tfjs';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
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
/** COCO-SSD sweet spot — 320 px keeps decode + inference fast with good accuracy. */
const DETECTION_INPUT_WIDTH = 320;

/**
 * Extract multi-axis brightness / edge signals for stair detection.
 *
 * Works when the camera looks ahead at stairs OR is tilted down / parallel
 * to the treads (foot-level view).  Row analysis catches forward-facing
 * risers; column + gradient analysis catches side-on and downward views.
 */
function extractImageEdgeSignal(imageTensor) {
  try {
    const [H, W] = imageTensor.shape;
    const packed = tf.tidy(() => {
      // Downsample before edge analysis — enough for stair bands, much less RAM
      const maxW = 160;
      const scale = W > maxW ? maxW / W : 1;
      const sH = Math.max(8, Math.round(H * scale));
      const sW = Math.max(8, Math.round(W * scale));

      let gray = tf.mean(imageTensor.toFloat(), 2);
      if (scale < 1) {
        gray = tf.image
          .resizeBilinear(gray.expandDims(2), [sH, sW])
          .squeeze();
      }

      const rowMeans = tf.mean(gray, 1);
      const colMeans = tf.mean(gray, 0);

      const gH = gray.shape[0];
      const gW = gray.shape[1];
      const rowDiff = tf.abs(
        gray.slice([1, 0], [gH - 1, gW]).sub(gray.slice([0, 0], [gH - 1, gW]))
      );
      const rowEdgeEnergy = tf.mean(rowDiff, 1);

      const colDiff = tf.abs(
        gray.slice([0, 1], [gH, gW - 1]).sub(gray.slice([0, 0], [gH, gW - 1]))
      );
      const colEdgeEnergy = tf.mean(colDiff, 0);

      const startRow = Math.floor(gH * 0.40);
      const numRows = gH - startRow;
      const bottomRowMeans = tf.mean(gray.slice([startRow, 0], [numRows, gW]), 1);

      return {
        rowMeans: Array.from(rowMeans.dataSync()),
        colMeans: Array.from(colMeans.dataSync()),
        rowEdgeEnergy: Array.from(rowEdgeEnergy.dataSync()),
        colEdgeEnergy: Array.from(colEdgeEnergy.dataSync()),
        bottomRowMeans: Array.from(bottomRowMeans.dataSync()),
        H,
        W,
        bottomStartRow: Math.floor(H * 0.40),
      };
    });
    return packed;
  } catch (e) {
    console.warn('ARScreen: extractImageEdgeSignal failed:', e?.message);
    return null;
  }
}

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
      // Do NOT request base64 here — we hand the URI to ImageManipulator which
      // resizes to 300 px natively (C++) BEFORE we ever call decodeJpeg.
      // This makes the TF.js decode step ~15× faster (300 px² vs 1920×1080).
      // EXIF orientation is also applied by ImageManipulator so the manual
      // 90° CW tensor rotation below is no longer needed.
      takePicture({ base64: false, quality: 0.55, exif: false })
        .then((photo) => {
          if (captureRequest <= 2) console.log('ARScreen: [CAPTURE] photo ok uri=' + !!(photo?.uri));
          if (photo?.uri) onCaptureRef.current?.(photo);
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
  // Prefer CameraView (newer API) for preview; CameraViewComponent comes from module scope (line 37)
  const CameraComponent = ExpoCamera?.Camera ?? ExpoCamera?.default ?? ExpoCamera;
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
  // Initialise from the singleton's current state: if the model was already
  // loaded (e.g. by AppInitializer's background preload, or by a previous
  // visit to this screen), we skip the "Loading…" state entirely and the
  // "Start AR" button is immediately enabled when the user returns.
  const [modelReady, setModelReady] = useState(ObjectDetectionService.isReady);
  const isActiveRef = useRef(isActive);
  const arInitializedRef = useRef(false);
  const anchorIdsRef = useRef(new Set());
  const detectionIntervalRef = useRef(null);
  const detectionInFlightRef = useRef(false);
  const detectionLoopTimeoutRef = useRef(null);
  const isFocused = useIsFocused();
  const [cameraSessionKey, setCameraSessionKey] = useState(0);
  const [stairInfo, setStairInfo] = useState(null);
  const [surfaceInfo, setSurfaceInfo] = useState(null);
  const [footGuidance, setFootGuidance] = useState({ message: '', priority: 'low', direction: 'forward' });
  const [dropInfo, setDropInfo] = useState(null);
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
  // Latest frame that arrived while inference was in-flight.
  // The detection loop writes here; processCapturedPhoto drains it in finally.
  const pendingPhotoRef = useRef(null);
  const lastDetectionAspectRef = useRef(DEFAULT_DETECTION_ASPECT);
  const previousFrameDetectionsRef = useRef([]);
  const useRealtimeRef = useRef(false);
  // Per-class TTS cooldown: prevents speaking the same object class more than once every 5 s.
  const ttsLastSpokenRef = useRef(new Map());
  useEffect(() => {
    requestCameraPermission();
    if (ObjectDetectionService.isReady) {
      setModelReady(true);
    }
    (async () => {
      try {
        if (!ObjectDetectionService.isReady) {
          console.log('ARScreen: Initializing object detection model...');
        }
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
        // scoreThreshold 0.40: balanced floor — low enough to catch real
        // obstacles on blurry phone-camera frames, high enough that the
        // temporal confirmation filter handles residual noise.
        scoreThreshold: 0.40,
        // confirmBypassThreshold 0.55: a detection must reach 55 % confidence
        // to be shown on the very first frame.  Scores 0.40–0.55 require the
        // object to appear in 2 consecutive frames before being confirmed.
        // 0.65 was too strict — real objects at 3+ meters often score 0.50–0.60.
        confirmBypassThreshold: 0.55,
        nmsIoUThreshold: 0.45,
        perClassNMS: true,
        // 0.72 gives the new frame 72 % weight so boxes track fast (real-time
        // feel) while still smoothing out single-frame jitter.
        smoothingFactor: 0.72,
        // 800 ms: must survive 2–3 frame intervals (~250–400 ms each) so that
        // the minConfirmFrames requirement can actually be met.  The old 400 ms
        // was shorter than the confirmation window, silently dropping real objects.
        trackMaxAgeMs: 800,
        associationIoUThreshold: 0.30,
        // 1 means seenCount must reach 2 for below-bypass detections.
        // With snapshot capture at ~250 ms/frame, 2 frames = 500 ms which is
        // comfortably within the 800 ms track expiry window.
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
        // Use functional setState to avoid stale closure — React bails out if already true
        setIsOcrActive(true);
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
    if (!photo?.uri && !photo?.base64) {
      setDetectionStatus('No image data in photo');
      return;
    }
    detectionInFlightRef.current = true;
    setDetectionStatus('Running model...');
    try {
      // ImageManipulator resizes full-sensor JPEG to DETECTION_INPUT_WIDTH before
      // decodeJpeg — ~4× faster than decoding at camera resolution.
      let smallBase64 = photo.base64 ?? null;
      if (photo.uri) {
        try {
          const { base64: b64 } = await ImageManipulator.manipulateAsync(
            photo.uri,
            [{ resize: { width: DETECTION_INPUT_WIDTH } }],
            { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          smallBase64 = b64;
        } catch (manipErr) {
          console.warn('ARScreen: ImageManipulator resize failed, using fallback', manipErr?.message);
        }
      }
      if (!smallBase64) {
        setDetectionStatus('Image prep failed');
        return;
      }

      const rawBytes = tf.util.encodeString(smallBase64, 'base64');
      let imageTensor = decodeJpeg(rawBytes, 3);
      let [origH, origW] = imageTensor.shape;

      // ImageManipulator already corrected EXIF orientation and resized to target width.
      const maxSize = DETECTION_INPUT_WIDTH;
      const scale = maxSize / Math.max(origW, origH);
      const targetW = Math.round(origW * scale);
      const targetH = Math.round(origH * scale);
      if (targetW < 1 || targetH < 1) {
        setDetectionStatus('Image too small');
        imageTensor.dispose();
        return;
      }
      const needsResize = Math.abs(origW - targetW) > 2 || Math.abs(origH - targetH) > 2;
      if (needsResize) {
        const resizedTensor = tf.tidy(() =>
          tf.image.resizeBilinear(imageTensor.expandDims(0), [targetH, targetW])
            .squeeze()
            .cast('int32')
        );
        imageTensor.dispose();
        imageTensor = resizedTensor;
      }

      const [imgH, imgW] = imageTensor.shape;
      lastDetectionAspectRef.current = imgW / imgH;
      const detections = await ObjectDetectionService.detectFromTensor(imageTensor, imgW, imgH);

      // Extract per-row brightness BEFORE disposing the tensor so that
      // DepthEstimationService can detect stair/step edges from pixel data
      // even when there are zero COCO-SSD detections (stairs are not COCO classes).
      const edgeSignal = extractImageEdgeSignal(imageTensor);
      imageTensor.dispose();

      // ObjectDetectionService already enforces scoreThreshold + temporal consistency.
      // The only extra guard here is a redundant confidence floor for defence-in-depth.
      const DISPLAY_THRESHOLD = 0.35;
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

      // Depth + foot guidance — always run while monitoring so stair edges
      // are not missed on alternating frames (critical for foot-level views).
      const depthData = FootPlacementService.isMonitoring()
        ? await DepthEstimationService.processFrame(edgeSignal, filteredDetections)
        : null;
      if (FootPlacementService.isMonitoring()) {
        const footResult = await FootPlacementService.processFrame(filteredDetections, depthData);
        if (footResult) {
          if (footResult.warnings?.length > 0) setFootWarnings(footResult.warnings);
          else setFootWarnings([]);

          // Guidance card
          if (footResult.guidance) setFootGuidance(footResult.guidance);
          if (footResult.shouldSpeak && footResult.guidance) {
            FootPlacementService.speakGuidance(footResult.guidance).catch(() => {});
          }

          // Drop-off warning
          if (footResult.drop) {
            setDropInfo(footResult.drop);
            FootPlacementService.warnDropOff(footResult.drop).catch(() => {});
          } else {
            setDropInfo(null);
          }

          // Stairs
          if (footResult.stairs?.detected) {
            setStairInfo(footResult.stairs);
            await FootPlacementService.warnStairs(footResult.stairs);
          } else setStairInfo(null);

          // Uneven surface
          if (footResult.surface?.detected) {
            setSurfaceInfo(footResult.surface);
            await FootPlacementService.warnUnevenSurface(footResult.surface);
          } else setSurfaceInfo(null);
        }
      }

      // ── Voice + spatial audio: only when COCO objects are present ──────────
      if (filteredDetections.length > 0) {
        ObjectDetectionService.announceDetectedObjects(
          filteredDetections,
          (text, opts, priority) => TextToSpeechService.speak(text, opts, priority)
        );
        const topHazard = filteredDetections
          .filter(d => ObjectDetectionService.getPriorityLevel(d) !== 'info')
          .sort((a, b) => a.distance - b.distance)[0];
        if (topHazard) {
          SpatialAudioService.playDirectionalBeep(topHazard.position.angle, topHazard.distance);
        }
        ObjectDetectionService.logDetectionsToServer(filteredDetections).catch(() => {});
      }
    } catch (err) {
      setDetectionStatus('Error: ' + (err.message || 'unknown'));
      console.warn('ARScreen: processCapturedPhoto error:', err?.message, err?.stack);
    } finally {
      detectionInFlightRef.current = false;
      // Drain the most recent pending frame immediately (latest-frame-wins).
      // This is the key to pipelining: if a new frame arrived while inference
      // was running we process it right away instead of waiting for the next
      // capture cycle — keeps the detection rate at hardware capture speed.
      const pending = pendingPhotoRef.current;
      if (pending) {
        pendingPhotoRef.current = null;
        processCapturedPhotoRef.current(pending);
      }
    }
  };

  processCapturedPhotoRef.current = processCapturedPhoto;

  const runFrameDetection = () => {
    // NOTE: we no longer gate on detectionInFlightRef here.
    // Capture and inference are now pipelined: if inference is busy when the
    // next capture arrives, handleCapture stores it in pendingPhotoRef and the
    // finally block drains it the instant inference finishes.
    // Allowing captures to run while inference is in-flight is what makes the
    // detection feel real-time (camera throttles the rate, not the model).
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
    if (!detectionInFlightRef.current) {
      // Inference idle — start processing this frame immediately.
      processCapturedPhotoRef.current(photo);
    } else {
      // Inference busy — store as pending (latest-frame-wins: the older
      // pending frame, if any, is simply overwritten and discarded).
      pendingPhotoRef.current = photo;
    }
    // Always kick off the next capture without waiting for inference to finish.
    // The natural throttle is takePictureAsync itself (~80-150 ms on Android).
    // On GPU devices this lets capture and inference run concurrently (both are
    // native async operations), effectively doubling throughput vs the old
    // serialised approach.
    if (isActiveRef.current && isFocused) {
      detectionLoopTimeoutRef.current = setTimeout(scheduleDetectionLoop, 0);
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
        // Config is set once by the applyConfig effect on mount — no partial
        // overwrite here to avoid creating an inconsistent Frankenstein config.
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
      setFootGuidance({ message: '', priority: 'low', direction: 'forward' });
      setDropInfo(null);
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
      TextToSpeechService.speakImmediate('Capturing text');

      // Capture without base64 first (URI only) — we'll let ImageManipulator
      // produce the final base64 after resizing so we never allocate a huge
      // full-resolution base64 string in JS memory.
      const photo = await cam.captureForOCR({
        base64: false,
        quality: 0.8,
      });

      // Resize to max 1200 px wide at 70 % quality.
      // A 12 MP camera photo decoded by Tesseract at full size takes 30–120 s.
      // At 1200 px Tesseract reads the same text in under 5 s with no quality loss
      // because OCR accuracy peaks well below native camera resolution.
      const resized = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );

      // skipHealthCheck: true — we already verified above; no need to pay for
      // a second round-trip before sending the image payload.
      const result = await OCRService.readTextFromImage(resized.base64, { skipHealthCheck: true });

      if (result.serverDown) {
        // Server went down in the narrow window between health check and OCR
        // call — extremely rare but handled gracefully.
        TextToSpeechService.speak('Server became unavailable. Please try again.');
        Alert.alert('Server unavailable', 'The server stopped responding. Make sure it is still running.');
      } else if (result.isTimeout) {
        TextToSpeechService.speak('Reading text timed out. The server may be starting up. Please try again in a moment.');
      } else if (result.text && result.text.trim()) {
        setOcrText(result.text);
        // Require at least 60% confidence before reading aloud.
        // Server-side filtering already strips low-confidence words, but the
        // aggregate score can still be dragged down by borderline detections.
        // 0.60 is the empirical sweet-spot: real sign text scores 0.70–0.95;
        // background noise that slips through the word filter lands below 0.60.
        if (result.confidence >= 0.60) {
          // Final sanitization pass — remove any stray non-printable or
          // non-ASCII characters that survived the server-side char whitelist
          // (e.g. soft-hyphens, zero-width spaces), then normalize whitespace.
          const cleanText = result.text
            .replace(/[^\x20-\x7E]/g, '')   // keep only printable ASCII
            .replace(/\s+/g, ' ')            // collapse multiple spaces/newlines
            .trim();
          if (cleanText) {
            TextToSpeechService.speakImmediate(cleanText);
          } else {
            TextToSpeechService.speakImmediate('Could not read text clearly. Please move closer or improve lighting.');
          }
        } else {
          TextToSpeechService.speakImmediate('Could not read text clearly. Please move closer or improve lighting.');
        }
      } else {
        TextToSpeechService.speakImmediate('No text detected in image');
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
                  {(obj.distance ?? 0).toFixed(1)}m {obj.position?.relative}
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

          {/* Foot Guidance Card — only shown for medium/high/critical priority */}
          {footGuidance.priority !== 'low' && footGuidance.message ? (
            <View style={[
              styles.guidanceCard,
              footGuidance.priority === 'critical' ? styles.guidanceCardCritical
                : footGuidance.priority === 'high' ? styles.guidanceCardHigh
                : styles.guidanceCardMedium,
            ]}>
              <View style={styles.guidanceHeader}>
                <MaterialCommunityIcons
                  name={getGuidanceIcon(footGuidance.priority)}
                  size={20}
                  color={getGuidanceColor(footGuidance.priority)}
                />
                <Text style={[styles.guidanceTitle, { color: getGuidanceColor(footGuidance.priority) }]}>
                  Foot Guidance
                </Text>
              </View>
              <Text style={styles.guidanceMessage}>{footGuidance.message}</Text>
            </View>
          ) : null}

          {/* Drop-off Warning Card */}
          {dropInfo ? (
            <View style={styles.dropWarning}>
              <View style={styles.dropHeader}>
                <MaterialCommunityIcons name="alert-octagon" size={20} color={COLORS.danger} />
                <Text style={styles.dropTitle}>Drop-off Detected</Text>
              </View>
              <Text style={styles.dropText}>
                {dropInfo.severity.charAt(0).toUpperCase() + dropInfo.severity.slice(1)} drop
                {dropInfo.side !== 'center' ? ` to your ${dropInfo.side}` : ' ahead'}
                {' '}({dropInfo.delta.toFixed(1)}m depth change)
              </Text>
              <Text style={styles.dropGuidance}>Step carefully — do not rush</Text>
            </View>
          ) : null}

          {stairInfo && stairInfo.detected && (
            <View style={styles.stairWarning}>
              <View style={styles.stairHeader}>
                <MaterialCommunityIcons name="stairs" size={20} color={COLORS.warning} />
                <Text style={styles.stairTitle}>Stairs Detected</Text>
              </View>
              <Text style={styles.stairText}>
                {stairInfo.goingDown ? 'Going down' : 'Going up'} — {stairInfo.count} steps, {(stairInfo.distance ?? 0).toFixed(1)}m {stairInfo.direction}
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
                        {(obj.distance ?? 0).toFixed(1)}m {obj.position?.relative}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}
          <View style={styles.controls}>
            <View style={styles.buttonRow}>
              <Button
                title={isActive ? 'Stop AR' : (modelReady ? 'Start AR' : 'Loading...')}
                onPress={handleToggleAR}
                variant={isActive ? 'danger' : 'success'}
                size="medium"
                disabled={!modelReady || !cameraReady}
                icon={<Ionicons name={isActive ? 'stop-circle' : 'play-circle'} size={18} color={COLORS.text} />}
                style={styles.buttonHalf}
              />
              <Button
                title={isOcrActive ? 'Reading...' : 'Read Text'}
                onPress={handleReadText}
                variant="secondary"
                size="medium"
                disabled={isOcrActive || !cameraReady}
                loading={isOcrActive}
                icon={<Ionicons name="text" size={18} color={COLORS.text} />}
                style={styles.buttonHalf}
              />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
};
const getGuidanceIcon = (priority) => {
  if (priority === 'critical') return 'alert-octagon';
  if (priority === 'high')     return 'alert-circle';
  if (priority === 'medium')   return 'information';
  return 'check-circle';
};
const getGuidanceColor = (priority) => {
  if (priority === 'critical') return COLORS.danger;
  if (priority === 'high')     return COLORS.warning;
  if (priority === 'medium')   return COLORS.info;
  return COLORS.success;
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
  buttonRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  buttonHalf: {
    flex: 1,
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
  guidanceCard: {
    marginBottom: SPACING.md,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: 3,
  },
  guidanceCardCritical: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderLeftColor: COLORS.danger,
  },
  guidanceCardHigh: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderLeftColor: COLORS.warning,
  },
  guidanceCardMedium: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    borderLeftColor: COLORS.info,
  },
  guidanceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  guidanceTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    marginLeft: SPACING.sm,
  },
  guidanceMessage: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
  },
  dropWarning: {
    marginBottom: SPACING.md,
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.danger,
  },
  dropHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  dropTitle: {
    fontSize: FONT_SIZES.md,
    fontWeight: '700',
    color: COLORS.danger,
    marginLeft: SPACING.sm,
  },
  dropText: {
    fontSize: FONT_SIZES.sm,
    color: COLORS.text,
    marginBottom: SPACING.xs,
  },
  dropGuidance: {
    fontSize: FONT_SIZES.xs,
    color: COLORS.textSecondary,
    fontStyle: 'italic',
  },
});
export default ARScreen;
