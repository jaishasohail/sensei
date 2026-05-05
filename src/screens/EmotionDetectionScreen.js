/**
 * EmotionDetectionScreen
 *
 * Opened by the "detect emotion" voice command or the Settings test button.
 * Uses the FRONT camera — shows live feed and overlays the detected emotion.
 *
 * Flow:
 *  1. Opens → requests camera permission → initialises face-api models.
 *  2. Auto-captures first frame after 1.5 s; repeats every 3 s.
 *  3. For each capture: calls EmotionDetectionService → TTS announces result.
 *  4. "Scan Again" button for manual re-scan.
 *  5. Back navigation (header back arrow or voice "go home").
 *
 * Accessibility:
 *  - All results are spoken via TTS (primary output for blind users).
 *  - Large text and high-contrast colour coding for sighted helpers.
 *  - Camera uses front-facing lens (pointing at the user's face / subject).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { CameraView, Camera } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import EmotionDetectionService from '../services/EmotionDetectionService';
import TextToSpeechService from '../services/TextToSpeechService';
import { COLORS } from '../constants/theme';

const { width } = Dimensions.get('window');

// ── Visual theme per emotion ───────────────────────────────────────────────────
const EMOTION_META = {
  happy:            { color: '#27ae60', label: 'Happy',             icon: 'happy-outline' },
  sad:              { color: '#2980b9', label: 'Sad',               icon: 'sad-outline' },
  angry:            { color: '#e74c3c', label: 'Angry',             icon: 'flame-outline' },
  fearful:          { color: '#8e44ad', label: 'Fearful',           icon: 'alert-circle-outline' },
  disgusted:        { color: '#795548', label: 'Disgusted',         icon: 'close-circle-outline' },
  surprised:        { color: '#f39c12', label: 'Surprised',         icon: 'star-outline' },
  neutral:          { color: '#95a5a6', label: 'Neutral',           icon: 'remove-circle-outline' },
  no_face_detected: { color: '#7f8c8d', label: 'No face detected',  icon: 'person-outline' },
  error:            { color: '#e74c3c', label: 'Error',             icon: 'warning-outline' },
};

const DEFAULT_EMOTION_META = { color: COLORS.primary, label: 'Scanning…', icon: 'scan-outline' };

export default function EmotionDetectionScreen() {
  const isFocused = useIsFocused();

  const [hasPermission, setHasPermission]   = useState(null);
  const [modelsReady,   setModelsReady]     = useState(false);
  const [initStatus,    setInitStatus]      = useState('Requesting camera permission…');
  const [detecting,     setDetecting]       = useState(false);
  const [emotion,       setEmotion]         = useState(null);   // string | null
  const [confidence,    setConfidence]      = useState(null);   // 0–1 | null

  const cameraRef    = useRef(null);
  const intervalRef  = useRef(null);
  const isMountedRef = useRef(true);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true;
    requestPermissionsAndInit();

    return () => {
      isMountedRef.current = false;
      _stopAutoScan();
    };
  }, []);

  // Pause auto-scan when screen loses focus; resume when regained.
  useEffect(() => {
    if (isFocused && modelsReady) {
      _startAutoScan();
    } else {
      _stopAutoScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, modelsReady]);

  // ── Permission + model init ─────────────────────────────────────────────────

  const requestPermissionsAndInit = async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      if (!isMountedRef.current) return;

      setHasPermission(status === 'granted');
      if (status !== 'granted') {
        await TextToSpeechService.speak('Camera permission is required for emotion detection');
        return;
      }

      setInitStatus('Loading emotion models from server…');
      await EmotionDetectionService.initialize();
      if (!isMountedRef.current) return;

      setModelsReady(true);
      setInitStatus('Ready');
      await TextToSpeechService.speak('Emotion detection ready. Scanning now.');
    } catch (err) {
      console.error('[EmotionDetectionScreen] init error:', err);
      if (!isMountedRef.current) return;
      setInitStatus('Failed to load models. Is the server running?');
      await TextToSpeechService.speak('Failed to load emotion models. Please ensure the server is running.');
    }
  };

  // ── Auto-scan loop ──────────────────────────────────────────────────────────

  const _startAutoScan = useCallback(() => {
    _stopAutoScan();
    // First scan 1.5 s after ready, then every 3 s.
    const firstTimer = setTimeout(() => {
      if (isMountedRef.current) captureAndDetect();
    }, 1500);
    intervalRef.current = setInterval(() => {
      if (isMountedRef.current) captureAndDetect();
    }, 3000);
    // Store both so _stopAutoScan clears properly.
    intervalRef._firstTimer = firstTimer;
  }, []);

  const _stopAutoScan = useCallback(() => {
    if (intervalRef._firstTimer) {
      clearTimeout(intervalRef._firstTimer);
      intervalRef._firstTimer = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── Capture + infer ─────────────────────────────────────────────────────────

  const captureAndDetect = useCallback(async () => {
    if (detecting || !cameraRef.current || !modelsReady) return;
    if (!isMountedRef.current) return;

    setDetecting(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64:   true,
        quality:  0.6,
        // NOTE: do NOT set skipProcessing:true — that returns the raw landscape
        // sensor frame without EXIF orientation correction.  On a portrait device
        // the face would be rotated 90° and TinyFaceDetector would miss it.
      });

      if (!photo?.base64 || !isMountedRef.current) return;

      const result = await EmotionDetectionService.detectEmotionFromCamera(photo.base64);
      if (!isMountedRef.current) return;

      setEmotion(result.emotion);
      setConfidence(result.confidence);
    } catch (err) {
      console.warn('[EmotionDetectionScreen] captureAndDetect error:', err?.message ?? err);
    } finally {
      if (isMountedRef.current) setDetecting(false);
    }
  }, [detecting, modelsReady]);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const emotionMeta  = EMOTION_META[emotion] ?? DEFAULT_EMOTION_META;
  const emotionColor = emotionMeta.color;
  const emotionLabel = emotion
    ? emotionMeta.label
    : (modelsReady ? 'Scanning…' : initStatus);

  // ── Loading / permission states ─────────────────────────────────────────────

  if (hasPermission === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.statusText}>{initStatus}</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={styles.center}>
        <Ionicons name="camera-off-outline" size={52} color={COLORS.danger} />
        <Text style={styles.statusText}>Camera permission denied</Text>
        <Text style={styles.subText}>
          Grant camera access in your device Settings to use emotion detection.
        </Text>
      </View>
    );
  }

  // ── Main camera + overlay UI ────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Live camera feed — front-facing for face capture */}
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="front"
        accessibilityLabel="Front camera for emotion detection"
      />

      {/* Model-loading overlay (shown while models download) */}
      {!modelsReady && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.overlayText}>{initStatus}</Text>
          <Text style={styles.overlaySubText}>
            Downloading face detection models (~500 KB)…
          </Text>
        </View>
      )}

      {/* Emotion result card — centred at bottom of camera feed */}
      <View style={[styles.resultCard, { borderColor: emotionColor }]}>
        <Ionicons
          name={emotionMeta.icon}
          size={44}
          color={emotionColor}
          accessibilityLabel={`Emotion icon: ${emotionLabel}`}
        />
        <Text
          style={[styles.emotionText, { color: emotionColor }]}
          accessibilityRole="text"
          accessibilityLabel={`Detected emotion: ${emotionLabel}`}
        >
          {emotionLabel}
        </Text>

        {/* Confidence bar (only for real detections) */}
        {confidence !== null &&
         confidence > 0 &&
         emotion !== 'no_face_detected' &&
         emotion !== 'error' && (
          <View style={styles.confBar}>
            <View
              style={[
                styles.confFill,
                { width: `${Math.round(confidence * 100)}%`, backgroundColor: emotionColor },
              ]}
            />
            <Text style={styles.confLabel}>
              {Math.round(confidence * 100)}% confidence
            </Text>
          </View>
        )}

        {/* Spinner while actively capturing */}
        {detecting && (
          <ActivityIndicator
            size="small"
            color={emotionColor}
            style={{ marginTop: 8 }}
          />
        )}
      </View>

      {/* Manual scan button */}
      {modelsReady && (
        <TouchableOpacity
          style={[styles.scanBtn, detecting && styles.scanBtnDisabled]}
          onPress={captureAndDetect}
          disabled={detecting}
          accessibilityLabel={detecting ? 'Scanning in progress' : 'Scan again'}
          accessibilityRole="button"
          accessibilityHint="Captures the current camera frame and detects the emotion"
        >
          <Ionicons
            name={detecting ? 'hourglass-outline' : 'scan-outline'}
            size={26}
            color="#fff"
          />
          <Text style={styles.scanBtnText}>
            {detecting ? 'Scanning…' : 'Scan Again'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },

  // ── Loading / permission ─────────────────────────────
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems:     'center',
    backgroundColor: COLORS.background,
    padding: 24,
    gap: 16,
  },
  statusText: {
    color:     COLORS.text,
    fontSize:  16,
    textAlign: 'center',
  },
  subText: {
    color:     COLORS.gray,
    fontSize:  13,
    textAlign: 'center',
  },

  // ── Model-loading overlay ──────────────────────────────
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor:  'rgba(0,0,0,0.8)',
    justifyContent:   'center',
    alignItems:       'center',
    gap: 14,
  },
  overlayText: {
    color:      '#fff',
    fontSize:   18,
    fontWeight: '600',
    textAlign:  'center',
  },
  overlaySubText: {
    color:     '#aaa',
    fontSize:  13,
    textAlign: 'center',
    paddingHorizontal: 32,
  },

  // ── Emotion result card ────────────────────────────────
  resultCard: {
    position:        'absolute',
    bottom:          110,
    alignSelf:       'center',
    backgroundColor: 'rgba(0,0,0,0.78)',
    borderRadius:    18,
    borderWidth:     2,
    padding:         20,
    minWidth:        width * 0.72,
    alignItems:      'center',
    gap: 8,
  },
  emotionText: {
    fontSize:   26,
    fontWeight: 'bold',
  },

  // Confidence bar
  confBar: {
    width:           '100%',
    height:          6,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius:    3,
    overflow:        'hidden',
    marginTop:       4,
  },
  confFill: {
    height:       '100%',
    borderRadius: 3,
  },
  confLabel: {
    color:    '#bbb',
    fontSize: 12,
    marginTop: 4,
    alignSelf: 'flex-end',
  },

  // ── Scan button ────────────────────────────────────────
  scanBtn: {
    position:         'absolute',
    bottom:           34,
    alignSelf:        'center',
    flexDirection:    'row',
    alignItems:       'center',
    paddingHorizontal: 36,
    paddingVertical:   14,
    borderRadius:      32,
    backgroundColor:  COLORS.primary,
    gap: 10,
    elevation: 5,
    shadowColor:    '#000',
    shadowOffset:   { width: 0, height: 2 },
    shadowOpacity:  0.3,
    shadowRadius:   4,
  },
  scanBtnDisabled: {
    opacity: 0.55,
  },
  scanBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
});
