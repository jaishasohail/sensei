/**
 * MicToneService
 * ==============
 * Plays short audio feedback tones to replace Android SpeechRecognizer's
 * built-in system beeps during the always-on STT loop.
 *
 * - playOn()  → 660 Hz (rising, "mic open")
 * - playOff() → 440 Hz (lower, "mic closed / wake-word mode")
 *
 * Tones are generated programmatically as WAV PCM data (no asset files needed),
 * written once to the app cache dir via react-native-fs, then played via
 * expo-audio's createAudioPlayer. Players are created fresh per-play and
 * released after the tone completes, keeping memory usage negligible.
 */

import { createAudioPlayer } from 'expo-audio';
import RNFS from 'react-native-fs';

// ── tone parameters ──────────────────────────────────────────────────────────
const SAMPLE_RATE   = 22050;   // Hz – enough quality for a simple beep
const AMPLITUDE     = 0.55;    // 0..1 – not too loud, not too quiet
const DURATION_ON   = 0.12;    // seconds – short "ding" when mic opens
const DURATION_OFF  = 0.10;    // seconds – shorter "dop" when mic closes
const FREQ_ON       = 660;     // Hz
const FREQ_OFF      = 440;     // Hz

// ── file paths in the app cache directory ───────────────────────────────────
const PATH_ON  = RNFS.CachesDirectoryPath + '/sensei_mic_on.wav';
const PATH_OFF = RNFS.CachesDirectoryPath + '/sensei_mic_off.wav';

// ── WAV generation helpers ──────────────────────────────────────────────────

/**
 * Build a mono 16-bit PCM WAV buffer for the given frequency and duration.
 * Applies a 10 % linear fade-in and fade-out to eliminate clicks.
 */
function _buildWAV(freqHz, durationSec) {
  const numSamples = Math.floor(SAMPLE_RATE * durationSec);
  const dataBytes  = numSamples * 2;           // 16-bit = 2 bytes / sample
  const buf        = new ArrayBuffer(44 + dataBytes);
  const view       = new DataView(buf);
  const fadeLen    = Math.floor(numSamples * 0.10);

  // ── RIFF/WAVE header ──────────────────────────────────────────────────────
  const s = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  s(0,  'RIFF');
  view.setUint32( 4, 36 + dataBytes, true);   // ChunkSize
  s(8,  'WAVE');

  // ── fmt  sub-chunk ────────────────────────────────────────────────────────
  s(12, 'fmt ');
  view.setUint32(16, 16,           true);  // SubChunk1Size  (16 = PCM)
  view.setUint16(20,  1,           true);  // AudioFormat    (1 = PCM)
  view.setUint16(22,  1,           true);  // NumChannels    (mono)
  view.setUint32(24, SAMPLE_RATE,  true);  // SampleRate
  view.setUint32(28, SAMPLE_RATE * 2, true); // ByteRate
  view.setUint16(32,  2,           true);  // BlockAlign
  view.setUint16(34, 16,           true);  // BitsPerSample

  // ── data sub-chunk ────────────────────────────────────────────────────────
  s(36, 'data');
  view.setUint32(40, dataBytes, true);

  // ── PCM samples ───────────────────────────────────────────────────────────
  for (let i = 0; i < numSamples; i++) {
    const t   = i / SAMPLE_RATE;
    let   env = 1.0;
    if (i < fadeLen)                      env = i / fadeLen;
    else if (i > numSamples - fadeLen)    env = (numSamples - i) / fadeLen;

    const raw   = Math.sin(2 * Math.PI * freqHz * t) * AMPLITUDE * env;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(raw * 32767)));
    view.setInt16(44 + i * 2, int16, true);
  }

  return buf;
}

/**
 * Convert an ArrayBuffer to a base-64 string (React Native compatible).
 * Uses chunked String.fromCharCode to avoid call-stack overflow on large buffers.
 */
function _bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

// ── MicToneService ───────────────────────────────────────────────────────────

class MicToneService {
  constructor() {
    this._ready = false;   // true once WAV files have been written
    this._init  = null;    // Promise – prevents double-init races
  }

  /**
   * Generate the two WAV files and write them to cache.
   * Called lazily on first playOn/playOff; safe to call multiple times.
   */
  async _ensureReady() {
    if (this._ready) return;
    if (this._init)  return this._init;

    this._init = (async () => {
      try {
        const b64On  = _bufToBase64(_buildWAV(FREQ_ON,  DURATION_ON));
        const b64Off = _bufToBase64(_buildWAV(FREQ_OFF, DURATION_OFF));

        await RNFS.writeFile(PATH_ON,  b64On,  'base64');
        await RNFS.writeFile(PATH_OFF, b64Off, 'base64');

        this._ready = true;
        console.log('[MicTone] WAV tones written to cache.');
      } catch (err) {
        console.warn('[MicTone] Failed to write WAV tones:', err);
        // _ready stays false; playOn/playOff will silently no-op
      }
    })();

    return this._init;
  }

  /**
   * Play a tone from the given file path.
   * Creates a fresh player, plays it, then removes it after the tone finishes.
   * Non-throwing — audio errors are logged, not propagated.
   */
  async _play(filePath, durationSec) {
    await this._ensureReady();
    if (!this._ready) return;   // WAV generation failed — graceful no-op

    try {
      const player = createAudioPlayer({ uri: 'file://' + filePath });
      player.play();
      // Release the player slightly after the tone should have finished.
      const releaseMs = Math.round(durationSec * 1000) + 200;
      setTimeout(() => {
        try { player.remove(); } catch (_) {}
      }, releaseMs);
    } catch (err) {
      console.warn('[MicTone] Playback error:', err);
    }
  }

  /**
   * Play the "mic ON" tone (660 Hz, 120 ms).
   * Call this when the STT session opens for a command.
   */
  playOn() {
    this._play(PATH_ON, DURATION_ON).catch(() => {});
  }

  /**
   * Play the "mic OFF / wake-word" tone (440 Hz, 100 ms).
   * Call this when returning to passive wake-word mode.
   */
  playOff() {
    this._play(PATH_OFF, DURATION_OFF).catch(() => {});
  }
}

export default new MicToneService();
