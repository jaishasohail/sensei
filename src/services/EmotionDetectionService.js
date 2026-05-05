/**
 * EmotionDetectionService — on-device face + expression recognition.
 *
 * Architecture:
 *   1. At first use, loads TinyFaceDetector + FaceExpressionNet model weights
 *      from the LAN server's static asset endpoint (/models/face-api/).
 *   2. All inference runs on-device using @tensorflow/tfjs-react-native backend.
 *   3. Caller passes a base64-encoded JPEG (from expo-camera takePictureAsync).
 *   4. Returns { emotion, confidence } or { emotion: 'no_face_detected', ... }.
 *
 * Why client-side:
 *   - @tensorflow/tfjs-node cannot install on this machine (native binary 404).
 *   - LAN round-trip is avoided; works fully offline once models are cached.
 *   - @vladmandic/face-api ESM build resolves to face-api.esm.js via Metro's
 *     "browser" field — no Node.js APIs are touched at runtime.
 *
 * Model loading note:
 *   Models are fetched once from the server (~500 KB total) and cached by the
 *   face-api library in memory for the app session.  A server restart is only
 *   needed if the device restarts (cold app start).
 */

// MUST be first — polyfills window/document for @vladmandic/face-api and
// suppresses duplicate TF.js kernel registration WARNs.  See file for details.
import '../utils/faceApiPolyfill';

import { Buffer } from 'buffer';
import * as tf from '@tensorflow/tfjs';
import { decodeJpeg } from '@tensorflow/tfjs-react-native';
import * as faceapi from '@vladmandic/face-api';
import TextToSpeechService from './TextToSpeechService';
import { API_BASE_URL } from '../constants/config';

/** Base URL for model manifest + weight files served by express.static */
const MODEL_BASE_URL = `${API_BASE_URL}/models/face-api`;

class EmotionDetectionService {
  constructor() {
    this.initialized    = false;
    this._initializing  = false;
    this._initQueue     = [];  // pending initialize() callers
  }

  // ── Model initialisation (lazy, once per app session) ──────────────────────

  /**
   * Ensure the TF.js RN backend is ready and both face-api models are loaded.
   * Safe to call multiple times — subsequent calls return immediately.
   */
  async initialize() {
    if (this.initialized) return true;

    // If another caller already started init, queue behind it.
    if (this._initializing) {
      return new Promise((res, rej) => this._initQueue.push({ res, rej }));
    }

    this._initializing = true;
    try {
      // 1. Wait for TF.js React Native backend to be ready.
      await tf.ready();

      // 2. Explicitly set face-api's runtime environment for React Native.
      //
      //    face-api.esm.js calls kk() (initialize) at module-eval time:
      //      if (isBrowser()) setEnv(createBrowserEnv());
      //      else if (isNodejs()) setEnv(createNodejsEnv());
      //    In Hermes/React Native neither path triggers reliably, so we call
      //    faceapi.env.setEnv() directly here — before any loadFromUri call.
      //
      //    The env only needs `fetch` (for model downloading) and stub classes
      //    for Canvas/Image/Video; inference uses tf.Tensor3D input so the DOM
      //    paths inside face-api are never reached.
      try {
        faceapi.env.getEnv(); // no-op if already set; throws if not
      } catch (_) {
        faceapi.env.setEnv({
          Canvas:                  global.HTMLCanvasElement             || class {},
          CanvasRenderingContext2D: global.CanvasRenderingContext2D      || class {},
          Image:                   global.HTMLImageElement              || class {},
          ImageData:               global.ImageData                     || class {},
          Video:                   global.HTMLVideoElement              || class {},
          createCanvasElement:     () => ({ getContext: () => null, width: 0, height: 0 }),
          createImageElement:      () => ({}),
          createVideoElement:      () => ({}),
          fetch:                   global.fetch,
          readFile:                () => { throw new Error('readFile not available in React Native'); },
        });
        console.log('[EmotionDetection] face-api env set manually for React Native');
      }

      // 3. Load face detection model (~190 KB).
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL);

      // 4. Load expression classification model (~310 KB).
      await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_BASE_URL);

      this.initialized = true;
      console.log('[EmotionDetection] models loaded from', MODEL_BASE_URL);

      this._initQueue.forEach(cb => cb.res(true));
      return true;
    } catch (err) {
      console.error('[EmotionDetection] initialize error:', err?.message ?? err);
      this._initQueue.forEach(cb => cb.rej(err));
      // Reset so the caller can retry after fixing the issue (e.g. server down).
      this.initialized = false;
      throw err;
    } finally {
      this._initializing = false;
      this._initQueue    = [];
    }
  }

  // ── Core inference ──────────────────────────────────────────────────────────

  /**
   * Detect the dominant emotion in a base64-encoded JPEG image.
   *
   * @param {string} base64Image  - Pure base64 string (no data-URI prefix).
   * @returns {Promise<{emotion: string, confidence: number}>}
   */
  async detectEmotion(base64Image) {
    try {
      await this.initialize();

      // Strip data-URI prefix if present
      const base64 = base64Image.replace(/^data:image\/[a-z]+;base64,/, '');

      // Decode base64 → JPEG bytes.
      // Use Buffer.from instead of atob: Hermes's atob can silently corrupt
      // bytes > 0x7F (common in JPEG data), producing a garbage tensor.
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));

      // decodeJpeg from @tensorflow/tfjs-react-native returns uint8 Tensor3D
      // with shape [H, W, 3], values 0–255.
      let tensor = decodeJpeg(bytes, 3);

      const [h, w] = tensor.shape;
      console.log(`[EmotionDetection] tensor shape: ${h}x${w}x3`);

      // ── Orientation fix ────────────────────────────────────────────────────
      // expo-camera with skipProcessing:true returns the raw sensor frame,
      // which is LANDSCAPE on portrait Android devices (width > height).
      // TinyFaceDetector is trained on upright faces — a sideways face scores
      // below threshold and is missed entirely.
      //
      // If the tensor is landscape AND the device screen is portrait, rotate
      // 90° CW:  transpose [H,W,C] → [W,H,C]  then  reverse columns (axis-1).
      // (Same logic as ARScreen.js uses for the live camera feed.)
      if (w > h) {
        const rotated = tf.tidy(() => {
          const transposed = tf.transpose(tensor, [1, 0, 2]);
          return tf.reverse(transposed, 1);
        });
        tf.dispose(tensor);
        tensor = rotated;
        console.log(`[EmotionDetection] rotated tensor to ${tensor.shape[0]}x${tensor.shape[1]}x3`);
      }

      // Run: face bounding-box detection + per-face expression classification.
      // Passing a Tensor3D bypasses tf.browser.fromPixels (unavailable in RN).
      // scoreThreshold 0.10 — generous to handle CPU-backend precision variance.
      // inputSize 416      — TinyFaceDetector's native resolution (must be ×32).
      const detections = await faceapi
        .detectAllFaces(
          tensor,
          new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.10, inputSize: 416 }),
        )
        .withFaceExpressions();

      tf.dispose(tensor);

      console.log(`[EmotionDetection] detections: ${detections?.length ?? 0}`);

      if (!detections || detections.length === 0) {
        return { emotion: 'no_face_detected', confidence: 1.0 };
      }

      // Use the face with the highest detection score.
      const best = detections.reduce((a, b) =>
        (a.detection.score > b.detection.score ? a : b)
      );

      // expressions object: { happy: 0.95, neutral: 0.03, sad: 0.01, … }
      const [topEmotion, topConf] = Object.entries(best.expressions)
        .sort(([, a], [, b]) => b - a)[0];

      return {
        emotion:    topEmotion,
        confidence: parseFloat(topConf.toFixed(3)),
      };
    } catch (err) {
      console.error('[EmotionDetection] detectEmotion error:', err?.message ?? err);
      return { emotion: 'error', confidence: 0.0, error: err?.message };
    }
  }

  // ── Convenience: detect + speak result ─────────────────────────────────────

  /**
   * Detect emotion from a camera frame and announce the result via TTS.
   *
   * @param {string} base64Image  - base64 JPEG string from takePictureAsync.
   * @returns {Promise<{emotion: string, confidence: number}>}
   */
  async detectEmotionFromCamera(base64Image) {
    try {
      const result = await this.detectEmotion(base64Image);
      const { emotion, confidence } = result;

      if (emotion === 'no_face_detected') {
        await TextToSpeechService.speak('No face detected in frame');
      } else if (emotion === 'error') {
        await TextToSpeechService.speak('Emotion detection failed');
      } else {
        const pct = Math.round((confidence || 0) * 100);
        await TextToSpeechService.speak(
          `Detected emotion: ${emotion}, ${pct} percent confidence`
        );
      }

      return result;
    } catch (err) {
      console.error('[EmotionDetection] detectEmotionFromCamera error:', err);
      return { emotion: 'error', confidence: 0.0 };
    }
  }
}

export default new EmotionDetectionService();
