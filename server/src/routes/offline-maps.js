import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { OfflineMap } from '../models/index.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const maps = await OfflineMap.find({ user_id: req.user.id })
      .sort({ downloaded_at: -1 });
    
    res.json(maps);
  } catch (error) {
    console.error('Get offline maps error:', error);
    res.status(500).json({ error: 'Failed to get offline maps' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { 
      region_name, 
      min_lat, 
      min_lng, 
      max_lat, 
      max_lng, 
      map_data_path,
      file_size_mb 
    } = req.body;

    const map = await OfflineMap.create({
      user_id: req.user.id,
      region_name,
      min_lat,
      min_lng,
      max_lat,
      max_lng,
      map_data_path,
      file_size_mb: file_size_mb || 0
    });

    res.json(map);
  } catch (error) {
    console.error('Download offline map error:', error);
    res.status(500).json({ error: 'Failed to save offline map' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const map = await OfflineMap.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.id },
      { last_updated_at: new Date() },
      { new: true }
    );

    if (!map) {
      return res.status(404).json({ error: 'Map not found' });
    }

    res.json(map);
  } catch (error) {
    console.error('Update offline map error:', error);
    res.status(500).json({ error: 'Failed to update offline map' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const map = await OfflineMap.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user.id
    });

    if (!map) {
      return res.status(404).json({ error: 'Map not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete offline map error:', error);
    res.status(500).json({ error: 'Failed to delete offline map' });
  }
});

export default router;
