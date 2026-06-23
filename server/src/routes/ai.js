import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAuth } from '../middleware/auth.js';
import { 
  OCRSession, 
  DetectionSession, 
  DetectedObject, 
  VoiceCommand,
  SystemLog 
} from '../models/index.js';
import Tesseract from 'tesseract.js';

const router = express.Router();

// Cache Tesseract language data on disk so it is only downloaded once.
// Without cachePath, Tesseract re-downloads eng.traineddata.gz (~10 MB) from
// its CDN every time the server restarts, which can take 20–60 s on a slow
// connection and causes the client OCR request to time out.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TESSERACT_CACHE_DIR = path.resolve(__dirname, '..', '..', '.tesseract-cache');
try { fs.mkdirSync(TESSERACT_CACHE_DIR, { recursive: true }); } catch {}

// Reusable Tesseract worker — created once and kept alive so every OCR request
// doesn't pay the full worker-init overhead (~500 ms).
let _tesseractWorker = null;
let _workerInitializing = false;
let _workerInitQueue = [];

async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;

  // If another request is already initializing, queue behind it.
  if (_workerInitializing) {
    return new Promise((resolve, reject) => {
      _workerInitQueue.push({ resolve, reject });
    });
  }

  _workerInitializing = true;
  try {
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: () => {},   // suppress progress noise
      errorHandler: (err) => console.error('Tesseract worker error:', err),
      // cachePath: language data is saved here after first download so
      // subsequent server restarts load from disk (~0.5 s) instead of
      // re-downloading from the CDN (~10–60 s).
      cachePath: TESSERACT_CACHE_DIR,
    });
    // PSM 11 (SPARSE_TEXT): find as much text as possible without imposing a
    // layout constraint.  PSM 6 (SINGLE_BLOCK) forced Tesseract to interpret
    // the *entire* image as one text block, causing background textures and
    // out-of-focus regions to be mis-read as garbled characters.  PSM 11 only
    // picks up high-confidence text "islands", which is exactly what we want
    // when pointing a phone camera at a sign or label in a real environment.
    //
    // tessedit_char_whitelist: restricts the output alphabet to printable ASCII
    // word characters + common punctuation.  Any character outside this set
    // (e.g. ¢ £ € ¥ § ← special Unicode that Tesseract hallucinates from image
    // noise) is silently dropped at the recognition stage before we even see it.
    await worker.setParameters({
      tessedit_pageseg_mode: '11',  // PSM_SPARSE_TEXT — best for real-world sign/label images
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' +
        '0123456789 .,!?-:;/()\'"@#%&+=',
    });
    _tesseractWorker = worker;
    // Drain the queue
    for (const cb of _workerInitQueue) cb.resolve(worker);
    _workerInitQueue = [];
    return worker;
  } catch (err) {
    for (const cb of _workerInitQueue) cb.reject(err);
    _workerInitQueue = [];
    _tesseractWorker = null;
    throw err;
  } finally {
    _workerInitializing = false;
  }
}

router.post('/ocr', async (req, res) => {
  try {
    const { image, save = false } = req.body || {};
    
    if (!image) {
      return res.status(400).json({ error: 'Image data is required' });
    }

    // Decode the base64 image into a Buffer for Tesseract.
    // Do NOT truncate the base64 string — that produces a broken JPEG.
    const imageBuffer = Buffer.from(image, 'base64');

    // Run real OCR with Tesseract.js
    let ocrText = '';
    let ocrConfidence = 0;
    try {
      const worker = await getTesseractWorker();

      // Race the recognition against a 25 s hard timeout.
      // Without this, a corrupted or extremely large image can cause the
      // Tesseract worker to hang indefinitely, blocking the route handler
      // until the client's 120 s AbortController fires — and the user hears
      // nothing at all.  25 s is generous for a 1200 px image; typical
      // recognition after the resize fix takes under 4 s.
      const TESSERACT_TIMEOUT_MS = 25000;
      const { data } = await Promise.race([
        worker.recognize(imageBuffer),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tesseract timed out after ${TESSERACT_TIMEOUT_MS / 1000}s`)),
            TESSERACT_TIMEOUT_MS
          )
        ),
      ]);

      // ── Per-word confidence filtering ─────────────────────────────────────
      // Tesseract returns a confidence score (0–100) for every detected word.
      // Words below MIN_WORD_CONF are almost always noise: background texture,
      // camera glare, or encoding artefacts.  We rebuild the output only from
      // words that:
      //   (a) confidence ≥ MIN_WORD_CONF
      //   (b) contain at least 2 consecutive alphanumeric characters — this
      //       rejects lone symbols like "¢", "a|", "::" that technically pass
      //       a single-char /[a-zA-Z0-9]/ test but are clearly not real words.
      //
      // ── Per-line quality gate ─────────────────────────────────────────────
      // After collecting good words for a line we also check that ≥60 % of the
      // non-space characters in the assembled line text are alphanumeric.  A
      // real word like "sensei" scores 100 %; a garbage line like "|.a-:#" scores
      // ~17 % and is discarded entirely.
      const MIN_WORD_CONF = 60;   // raised from 50 — real sign text is usually 70–95
      const LINE_ALPHA_RATIO = 0.60; // min fraction of non-space chars that must be a-z/A-Z/0-9
      const ocrLines = [];
      let totalConf = 0, wordCount = 0;

      if (data.lines && data.lines.length > 0) {
        for (const line of data.lines) {
          // Filter words: must meet confidence AND have ≥2 clean alphanumeric chars.
          const goodWords = (line.words || []).filter(w => {
            if (w.confidence < MIN_WORD_CONF) return false;
            // Strip everything except letters/digits; require at least 2 remain.
            const alphaOnly = (w.text || '').replace(/[^a-zA-Z0-9]/g, '');
            return alphaOnly.length >= 2;
          });

          if (goodWords.length > 0) {
            const lineText = goodWords.map(w => w.text.trim()).join(' ');
            // Line quality gate: fraction of non-space chars that are alphanumeric.
            const nonSpace  = lineText.replace(/\s/g, '');
            const alphaNum  = nonSpace.replace(/[^a-zA-Z0-9]/g, '');
            const ratio     = nonSpace.length > 0 ? alphaNum.length / nonSpace.length : 0;
            if (ratio >= LINE_ALPHA_RATIO) {
              ocrLines.push(lineText);
              goodWords.forEach(w => { totalConf += w.confidence; wordCount++; });
            }
          }
        }
      }

      // If line-level data was unavailable fall back to raw text (older Tesseract).
      if (ocrLines.length === 0 && data.text) {
        ocrText = data.text.replace(/[^\x20-\x7E\n]/g, '').replace(/\s+/g, ' ').trim();
        ocrConfidence = parseFloat(((data.confidence || 0) / 100).toFixed(2));
      } else {
        ocrText = ocrLines.join('\n').replace(/\s+/g, ' ').trim();
        // Confidence = average of the words we actually kept (more meaningful
        // than the aggregate which includes all the noise we just discarded).
        ocrConfidence = wordCount > 0
          ? parseFloat((totalConf / wordCount / 100).toFixed(2))
          : 0;
      }
    } catch (tessErr) {
      console.error('OCR: Tesseract recognition failed:', tessErr.message || tessErr);
      // Return empty but valid response so the client doesn't crash
      return res.json({ text: '', confidence: 0, length: 0, language: 'en', regions: [] });
    }

    const result = {
      text: ocrText,
      confidence: ocrConfidence,
      length: ocrText.length,
      language: 'en',
      regions: ocrText ? [
        {
          text: ocrText,
          boundingBox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          confidence: ocrConfidence,
        }
      ] : [],
    };

    if (save && req.user && req.user.id) {
      try {
        const session = await OCRSession.create({
          user_id: req.user.id,
          detected_text: result.text,
          confidence: result.confidence,
          language: result.language,
          image_path: image.substring(0, 100),
        });
        result.session_id = session._id;
      } catch (dbError) {
        console.warn('Failed to save OCR session:', dbError);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('OCR error:', error);
    res.status(500).json({ 
      error: 'OCR processing failed',
      text: '',
      confidence: 0,
      length: 0,
    });
  }
});

router.post('/ocr/translate', requireAuth, async (req, res) => {
  // Translation is not yet implemented. A real translation API (e.g. LibreTranslate
  // or Google Translate) must be integrated before this endpoint is usable.
  res.status(501).json({ error: 'Translation not implemented' });
});

router.post('/detection/start', requireAuth, async (req, res) => {
  try {
    const session = await DetectionSession.create({
      user_id: req.user.id,
      start_time: new Date(),
      frames_processed: 0,
      objects_detected_count: 0,
      critical_hazards_count: 0
    });

    res.json({
      session_id: session._id,
      started_at: session.start_time
    });
  } catch (error) {
    console.error('Start detection error:', error);
    res.status(500).json({ error: 'Failed to start detection session' });
  }
});

router.post('/detection/object', requireAuth, async (req, res) => {
  try {
    const { 
      session_id, 
      object_type, 
      confidence, 
      distance, 
      position,
      hazard_level,
      bounding_box,
      user_lat,
      user_lng
    } = req.body || {};

    const detectedObject = await DetectedObject.create({
      session_id,
      object_type,
      confidence,
      distance,
      position,
      hazard_level,
      bounding_box_json: bounding_box,
      user_lat,
      user_lng,
      detected_at: new Date()
    });

    await DetectionSession.findByIdAndUpdate(session_id, {
      $inc: { 
        objects_detected_count: 1,
        critical_hazards_count: hazard_level === 'critical' ? 1 : 0
      }
    });

    res.json({
      object_id: detectedObject._id,
      object_type: detectedObject.object_type,
      hazard_level: detectedObject.hazard_level,
      distance: detectedObject.distance
    });
  } catch (error) {
    console.error('Object detection error:', error);
    res.status(500).json({ error: 'Failed to record detected object' });
  }
});

router.post('/detection/stop', requireAuth, async (req, res) => {
  try {
    const { session_id, frames_processed } = req.body || {};

    const session = await DetectionSession.findOneAndUpdate(
      { _id: session_id, user_id: req.user.id },
      { 
        end_time: new Date(),
        frames_processed: frames_processed || 0
      },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'Detection session not found' });
    }

    const objects = await DetectedObject.countDocuments({ session_id });

    res.json({
      session_id: session._id,
      duration_seconds: Math.floor((session.end_time - session.start_time) / 1000),
      frames_processed: session.frames_processed,
      objects_detected: objects,
      critical_hazards: session.critical_hazards_count
    });
  } catch (error) {
    console.error('Stop detection error:', error);
    res.status(500).json({ error: 'Failed to stop detection session' });
  }
});

router.post('/voice-command', requireAuth, async (req, res) => {
  try {
    const { 
      raw_text, 
      parsed_command, 
      command_type, 
      parameters,
      confidence,
      success,
      execution_time_ms 
    } = req.body || {};

    const command = await VoiceCommand.create({
      user_id: req.user.id,
      raw_text,
      parsed_command,
      command_type,
      parameters_json: parameters,
      confidence,
      success: success !== undefined ? success : true,
      execution_time_ms: execution_time_ms || 0
    });

    res.json({
      command_id: command._id,
      parsed: command.parsed_command,
      type: command.command_type,
      success: command.success
    });
  } catch (error) {
    console.error('Voice command error:', error);
    res.status(500).json({ error: 'Failed to process voice command' });
  }
});

router.get('/detection/history', requireAuth, async (req, res) => {
  try {
    const sessions = await DetectionSession.find({ user_id: req.user.id })
      .sort({ start_time: -1 })
      .limit(50);
    
    res.json(sessions);
  } catch (error) {
    console.error('Get detection history error:', error);
    res.status(500).json({ error: 'Failed to get detection history' });
  }
});

router.get('/detection/objects/:session_id', requireAuth, async (req, res) => {
  try {
    const session = await DetectionSession.findOne({
      _id: req.params.session_id,
      user_id: req.user.id
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const objects = await DetectedObject.find({ session_id: req.params.session_id })
      .sort({ detected_at: -1 });
    
    res.json(objects);
  } catch (error) {
    console.error('Get detected objects error:', error);
    res.status(500).json({ error: 'Failed to get detected objects' });
  }
});

router.get('/voice-commands', requireAuth, async (req, res) => {
  try {
    const commands = await VoiceCommand.find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(100);
    
    res.json(commands);
  } catch (error) {
    console.error('Get voice commands error:', error);
    res.status(500).json({ error: 'Failed to get voice commands' });
  }
});

router.post('/emotion', requireAuth, async (req, res) => {
  try {
    const { emotion, confidence } = req.body || {};
    
    await SystemLog.create({
      user_id: req.user.id,
      log_type: 'info',
      log_level: 'low',
      message: 'Emotion detection performed',
      metadata_json: { emotion, confidence }
    });

    res.json({ emotion: emotion || 'neutral', confidence: confidence || 0.6 });
  } catch (error) {
    console.error('Emotion detection error:', error);
    res.status(500).json({ error: 'Emotion detection failed' });
  }
});

router.post('/depth', async (req, res) => {
  try {
    const { image, nearest_distance, mean_distance } = req.body || {};
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const mockNearestDistance = nearest_distance || (1 + Math.random() * 3);
    const mockMeanDistance = mean_distance || (mockNearestDistance + 1 + Math.random() * 2);
    
    const result = {
      nearest: { 
        distance: parseFloat(mockNearestDistance.toFixed(2)),
        x: Math.random() * 0.6 + 0.2,
        y: Math.random() * 0.6 + 0.2
      },
      mean: parseFloat(mockMeanDistance.toFixed(2)),
      depthMap: null,
      isServerEstimate: true
    };
    
    if (req.user && req.user.id) {
      try {
        await SystemLog.create({
          user_id: req.user.id,
          log_type: 'info',
          log_level: 'low',
          message: 'Depth estimation performed',
          metadata_json: { nearest: result.nearest.distance, mean: result.mean }
        });
      } catch (dbError) {
        console.warn('Failed to log depth estimation:', dbError);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Depth estimation error:', error);
    res.status(500).json({ 
      error: 'Depth estimation failed',
      nearest: { distance: Infinity, x: 0, y: 0 },
      mean: Infinity
    });
  }
});

export default router;

// Pre-warm the Tesseract worker at module load so the first client OCR request
// doesn't have to wait for the full cold-start (worker init + eng.traineddata
// download from CDN can take 20-30 s on first use).
getTesseractWorker()
  .then(() => console.log('Tesseract worker ready'))
  .catch(err => console.warn('Tesseract pre-warm failed (will retry on first request):', err?.message || err));
