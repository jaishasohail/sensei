import * as Speech from 'expo-speech';

// ─── tunables ───────────────────────────────────────────────────────────────
const DEDUP_MS    = 4000;   // ms — same text within this window is silently dropped
const MAX_QUEUE   = 3;      // max pending items (oldest are dropped when full)
const RATE        = 1.0;    // speech rate — 1.0 = normal, no language set (uses system default)
// Watchdog: ~65 ms per character at rate 1.0, clamped 2 s … 15 s.
// Fires if onDone/onError never arrive (known Android TTS callback bug).
const watchdogMs  = (text) => Math.min(15000, Math.max(2000, text.length * 65));
// ────────────────────────────────────────────────────────────────────────────

class TextToSpeechService {
  constructor() {
    this._lastSpoken = new Map();   // text → last spoken timestamp
    this._queue      = [];          // pending { text, options } items
    this._busy       = false;       // true while an utterance is in-flight
    this._stopPending = false;      // true while a stop() is being awaited

    // Pre-warm: accessing getAvailableVoicesAsync() triggers the lazy
    // TextToSpeech initialization on Android so the first real utterance
    // is not delayed by engine startup.
    Speech.getAvailableVoicesAsync().catch(() => {});
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Speak `text`.
   *  - Deduplication: identical text within DEDUP_MS is silently dropped.
   *  - priority 'critical'  →  interrupts current speech, speaks immediately.
   *  - priority 'normal'    →  queued (max MAX_QUEUE items, oldest dropped).
   *
   * @param {string}            text
   * @param {object}            options   expo-speech options (rate, pitch, …)
   * @param {'normal'|'critical'} priority
   */
  speak(text, options = {}, priority = 'normal') {
    if (!text || typeof text !== 'string' || !text.trim()) return;

    const now  = Date.now();
    const last = this._lastSpoken.get(text);
    if (last && now - last < DEDUP_MS) return;
    this._lastSpoken.set(text, now);

    if (priority === 'critical') {
      this._stopThenFire(text, options);
    } else {
      // Drop oldest if queue is full so fresh items always get in.
      if (this._queue.length >= MAX_QUEUE) this._queue.shift();
      this._queue.push({ text, options });
      if (!this._busy && !this._stopPending) this._drain();
    }
  }

  /**
   * Speak `text` immediately, interrupting anything currently playing.
   * Bypasses deduplication so it ALWAYS fires.
   */
  speakImmediate(text, options = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    this._lastSpoken.set(text, Date.now());
    this._stopThenFire(text, options);
  }

  /** Stop all speech and clear the queue. */
  stop() {
    this._queue        = [];
    this._busy         = false;
    this._stopPending  = false;   // prevent any in-flight _stopThenFire from blocking drain
    Speech.stop().catch(() => {});
  }

  isSpeakingNow() { return this._busy; }

  async isSpeakingAsync() {
    try { return await Speech.isSpeakingAsync(); } catch (_) { return this._busy; }
  }

  getAvailableVoices() { return Speech.getAvailableVoicesAsync(); }

  async pause()  { try { await Speech.pause();  } catch (_) {} }
  async resume() { try { await Speech.resume(); } catch (_) {} }

  // ── private helpers ────────────────────────────────────────────────────────

  /**
   * Stop whatever is playing, WAIT for the stop to complete at the native
   * layer, then immediately fire `text`.
   *
   * This avoids the race condition where Speech.speak() executes at native
   * level BEFORE Speech.stop() has flushed the TTS queue, which caused the
   * new utterance to be silently discarded.
   */
  _stopThenFire(text, options) {
    this._queue       = [];
    this._busy        = false;
    this._stopPending = true;

    Speech.stop()
      .catch(() => {})
      .finally(() => {
        this._stopPending = false;
        this._fire(text, options);
      });
  }

  /** Pull the next item off the queue and speak it. */
  _drain() {
    if (this._queue.length === 0) {
      this._busy = false;
      return;
    }
    const { text, options } = this._queue.shift();
    this._fire(text, options);
  }

  /**
   * Call Speech.speak() for one utterance and manage the _busy flag.
   *
   * A "done" callback guards against double-invocation (important because
   * both onDone/onStopped AND the watchdog timer can fire).  Whichever
   * arrives first wins; the second call is a no-op.
   */
  _fire(text, options = {}) {
    this._busy = true;
    console.log('[TTS] speak:', JSON.stringify(text.substring(0, 100)));

    let finished  = false;
    let watchdog  = null;

    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      this._busy = false;
      this._drain();
    };

    // Watchdog fires if Android never calls onDone/onStopped/onError.
    watchdog = setTimeout(done, watchdogMs(text));

    try {
      Speech.speak(text, {
        rate: RATE,
        ...options,
        // Callbacks must come AFTER ...options so callers cannot accidentally
        // override them and break the queue drain.
        onDone:    done,
        onStopped: done,
        onError: (err) => {
          console.error('[TTS] onError:', err);
          done();
        },
      });
    } catch (err) {
      console.error('[TTS] Speech.speak threw:', err);
      done();
    }
  }
}

export default new TextToSpeechService();
