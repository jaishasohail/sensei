import * as Speech from 'expo-speech';

// Maximum number of pending messages in the queue at any time.
const MAX_QUEUE_SIZE = 3;
// Minimum ms between two identical messages (deduplication window).
const DEDUP_WINDOW_MS = 3000;

class TextToSpeechService {
  constructor() {
    this._isSpeaking = false;
    this.queue = [];
    // map: message text -> timestamp of last CONFIRMED start (set in onStart, not before)
    this._lastSpoken = new Map();
    // Periodic health-check: if the OS finished speaking but our flag is stuck, reset it.
    this._healthCheckTimer = null;
    // TTS engine readiness: getAvailableVoicesAsync() warms the engine asynchronously.
    // _engineReady becomes true once the call resolves (or after a 4 s safety timeout).
    this._engineReady = false;
    this._prewarm();
  }

  // Warm up the Android TTS engine and set _engineReady when done.
  // Without this, the first Speech.speak() call is sometimes silently dropped
  // because the engine hasn't finished initialising.
  _prewarm() {
    // Safety fallback: mark engine ready after 4 s regardless of voiceAsync result
    const fallbackTimer = setTimeout(() => {
      if (!this._engineReady) {
        this._engineReady = true;
        console.log('[TTS] engine ready (fallback timer)');
        this._processQueue();
      }
    }, 4000);

    Speech.getAvailableVoicesAsync()
      .then(() => {
        clearTimeout(fallbackTimer);
        if (!this._engineReady) {
          this._engineReady = true;
          console.log('[TTS] engine ready (voices loaded)');
          this._processQueue();
        }
      })
      .catch(() => {
        clearTimeout(fallbackTimer);
        this._engineReady = true;
        console.log('[TTS] engine ready (prewarm error — proceeding anyway)');
        this._processQueue();
      });
  }

  // ---------- public API ----------

  /**
   * Enqueue text to be spoken.  Identical messages within DEDUP_WINDOW_MS are silently dropped.
   * @param {string} text
   * @param {object} options  expo-speech options (pitch, rate, …)
   * @param {'normal'|'critical'} priority  'critical' clears the queue and speaks immediately.
   */
  speak(text, options = {}, priority = 'normal') {
    if (!text || typeof text !== 'string' || !text.trim()) return;

    const now = Date.now();

    // --- deduplication (uses last CONFIRMED start time) ---
    const lastAt = this._lastSpoken.get(text);
    if (lastAt && now - lastAt < DEDUP_WINDOW_MS) return;

    // Engine not ready yet → queue and wait for prewarm to finish
    if (!this._engineReady) {
      if (priority === 'critical') {
        this.queue = [{ text, options }];
      } else if (this.queue.length < MAX_QUEUE_SIZE) {
        this.queue.push({ text, options });
      }
      return;
    }

    if (!this._isSpeaking) {
      this._speakNow(text, options);
      return;
    }

    if (priority === 'critical') {
      this._clearAndSpeak(text, options);
      return;
    }

    if (this.queue.length < MAX_QUEUE_SIZE) {
      this.queue.push({ text, options });
    }
  }

  speakImmediate(text, options = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    this._clearAndSpeak(text, options);
  }

  stop() {
    try { Speech.stop(); } catch (e) {}
    this._isSpeaking = false;
    this.queue = [];
    this._stopHealthCheck();
  }

  async pause() {
    try { await Speech.pause(); } catch (e) {}
  }

  async resume() {
    try { await Speech.resume(); } catch (e) {}
  }

  getAvailableVoices() {
    return Speech.getAvailableVoicesAsync();
  }

  isSpeakingNow() {
    return this._isSpeaking;
  }

  async isSpeakingAsync() {
    try { return await Speech.isSpeakingAsync(); } catch (e) { return this._isSpeaking; }
  }

  // ---------- private helpers ----------

  _speakNow(text, options = {}) {
    // Set the in-flight flag BEFORE Speech.speak() to block concurrent calls.
    this._isSpeaking = true;
    // NOTE: _lastSpoken is set in onStart (not here).  Setting it here would
    // mean a silent-failure (engine not ready) permanently blocks retries of
    // the same message for DEDUP_WINDOW_MS, which is wrong.

    const self = this;
    const merged = {
      // language: 'en' — use generic English, not 'en-US'.
      // • Without ANY language, Android TextToSpeech uses the device's default
      //   locale.  If that locale has no TTS voice data installed (common on
      //   non-English devices or fresh Android installs), Speech.speak() returns
      //   immediately with NO callbacks and NO audio — a completely silent failure.
      // • 'en-US' fails the same way on devices that only have the base 'en' pack.
      // • 'en' (no region) matches any English voice pack and is pre-installed on
      //   virtually every Android device, making it the most reliable choice.
      // • pitch: 1.0 is intentionally omitted — some Android TTS engines behave
      //   incorrectly when pitch is explicitly set to the default value.
      // • volume is not a valid expo-speech parameter on Android.
      rate: 0.9,
      language: 'en',
      ...options,
      onStart: () => {
        self._isSpeaking = true;
        // Only record spoken timestamp once the engine CONFIRMS it started.
        // This allows silent failures to be retried after _isSpeaking resets.
        self._lastSpoken.set(text, Date.now());
        if (options.onStart) options.onStart();
      },
      onDone: () => {
        self._isSpeaking = false;
        self._stopHealthCheck();
        if (options.onDone) options.onDone();
        self._processQueue();
      },
      onStopped: () => {
        self._isSpeaking = false;
        self._stopHealthCheck();
        if (options.onStopped) options.onStopped();
      },
      onError: (error) => {
        console.error('[TTS] error:', error);
        self._isSpeaking = false;
        self._stopHealthCheck();
        // Clear the dedup entry so the message can be retried.
        self._lastSpoken.delete(text);
        if (options.onError) options.onError(error);
        self._processQueue();
      },
    };

    try {
      console.log('[TTS] speak:', JSON.stringify(text.substring(0, 60)));
      Speech.speak(text, merged);
      this._startHealthCheck(text);
    } catch (e) {
      console.error('[TTS] _speakNow threw:', e);
      this._isSpeaking = false;
      this._lastSpoken.delete(text);
      this._processQueue();
    }
  }

  _clearAndSpeak(text, options) {
    try { Speech.stop(); } catch (e) {}
    this._isSpeaking = false;
    this.queue = [];
    this._stopHealthCheck();
    this._speakNow(text, options);
  }

  _processQueue() {
    if (this.queue.length === 0) return;
    const { text, options } = this.queue.shift();
    this._speakNow(text, options);
  }

  /**
   * Watchdog timer: if the TTS engine never fires onDone/onError (Android bug),
   * reset _isSpeaking after the estimated speech duration so the queue unblocks.
   *
   * Estimate: ~70 ms per character at rate 0.9, min 1.5 s, max 10 s.
   */
  _startHealthCheck(text) {
    this._stopHealthCheck();
    const estimatedMs = Math.min(10000, Math.max(1500, text.length * 70));
    this._healthCheckTimer = setTimeout(async () => {
      try {
        const stillSpeaking = await Speech.isSpeakingAsync();
        if (!stillSpeaking && this._isSpeaking) {
          console.warn('[TTS] health-check: isSpeaking stuck, resetting');
          this._isSpeaking = false;
          this._processQueue();
        }
      } catch (e) {
        this._isSpeaking = false;
        this._processQueue();
      }
    }, estimatedMs);
  }

  _stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearTimeout(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }
}
export default new TextToSpeechService();
