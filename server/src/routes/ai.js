import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { 
  OCRSession, 
  DetectionSession, 
  DetectedObject, 
  VoiceCommand,
  SystemLog 
} from '../models/index.js';

const router = express.Router();

router.post('/ocr', async (req, res) => {
  try {
    const { image, save = false } = req.body || {};
    
    if (!image) {
      return res.status(400).json({ error: 'Image data is required' });
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const mockTexts = [
      'STOP',
      'EXIT',
      'ENTRANCE',
      'PARKING',
      'NO ENTRY',
      'CAUTION',
      'SPEED LIMIT 30',
      'OPEN 9AM-5PM',
      'PUSH',
      'PULL',
      'RESTROOM',
      'ELEVATOR',
      ''
    ];
    
    const randomText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
    const confidence = randomText ? (0.7 + Math.random() * 0.25) : 0;
    
    const result = {
      text: randomText,
      confidence: parseFloat(confidence.toFixed(2)),
      length: randomText.length,
      language: 'en',
      regions: randomText ? [
        {
          text: randomText,
          boundingBox: { x: 0.3, y: 0.4, width: 0.4, height: 0.2 },
          confidence: confidence
        }
      ] : []
    };
    
    if (save && req.user && req.user.id) {
      try {
        const session = await OCRSession.create({
          user_id: req.user.id,
          detected_text: result.text,
          confidence: result.confidence,
          language: result.language,
          image_path: image.substring(0, 100)
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
      length: 0
    });
  }
});

router.post('/ocr/translate', requireAuth, async (req, res) => {
  try {
    const { session_id, target_language } = req.body || {};
    
    const session = await OCRSession.findOneAndUpdate(
      { _id: session_id, user_id: req.user.id },
      { 
        translated_text: 'Translated text sample',
        translation_language: target_language 
      },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'OCR session not found' });
    }

    res.json({
      original: session.detected_text,
      translated: session.translated_text,
      target_language: session.translation_language
    });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ error: 'Translation failed' });
  }
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
