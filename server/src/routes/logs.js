import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { SystemLog } from '../models/index.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const { log_type, log_level, limit = 100 } = req.query;
    
    const query = { user_id: req.user.id };
    if (log_type) query.log_type = log_type;
    if (log_level) query.log_level = log_level;

    const logs = await SystemLog.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit));
    
    res.json(logs);
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { log_type, log_level, message, metadata } = req.body;

    const log = await SystemLog.create({
      user_id: req.user.id,
      log_type,
      log_level: log_level || 'low',
      message,
      metadata_json: metadata || {}
    });

    res.json(log);
  } catch (error) {
    console.error('Create log error:', error);
    res.status(500).json({ error: 'Failed to create log' });
  }
});

router.delete('/clear', requireAuth, async (req, res) => {
  try {
    const { older_than_days = 30 } = req.body;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - older_than_days);

    const result = await SystemLog.deleteMany({
      user_id: req.user.id,
      created_at: { $lt: cutoffDate }
    });

    res.json({ deleted: result.deletedCount });
  } catch (error) {
    console.error('Clear logs error:', error);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

export default router;
