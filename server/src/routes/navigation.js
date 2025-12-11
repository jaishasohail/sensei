import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { NavigationSession, Route, SavedLocation } from '../models/index.js';

const router = express.Router();

router.post('/route', requireAuth, async (req, res) => {
  try {
    const { origin, destination, mode = 'walking', route_name } = req.body || {};
    
    const route = await Route.create({
      user_id: req.user.id,
      route_name: route_name || `Route to ${destination?.name || 'destination'}`,
      start_lat: origin?.latitude,
      start_lng: origin?.longitude,
      end_lat: destination?.latitude,
      end_lng: destination?.longitude,
      waypoints_json: [],
      turns_json: [
        { instruction: `Head towards ${destination?.name || 'destination'}`, distance: 120, bearing: 45 },
        { instruction: 'Turn right at the junction', distance: 80, bearing: 90 },
        { instruction: 'Your destination is ahead', distance: 30, bearing: 0 },
      ],
      total_distance: 230,
      estimated_time: 3
    });

    const session = await NavigationSession.create({
      user_id: req.user.id,
      route_id: route._id,
      start_lat: origin?.latitude,
      start_lng: origin?.longitude,
      dest_lat: destination?.latitude,
      dest_lng: destination?.longitude,
      start_time: new Date(),
      status: 'active',
      distance_traveled: 0,
      duration_minutes: 0
    });

    res.json({
      session_id: session._id,
      route_id: route._id,
      origin,
      destination,
      mode,
      steps: route.turns_json,
      started_at: session.start_time,
      status: session.status
    });
  } catch (error) {
    console.error('Create route error:', error);
    res.status(500).json({ error: 'Failed to create route' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const session = await NavigationSession.findOne({
      user_id: req.user.id,
      status: 'active'
    }).populate('route_id');

    if (!session) {
      return res.status(404).json({ error: 'No active navigation' });
    }

    res.json({
      session_id: session._id,
      route: session.route_id,
      status: session.status,
      distance_traveled: session.distance_traveled,
      duration_minutes: session.duration_minutes,
      started_at: session.start_time
    });
  } catch (error) {
    console.error('Get navigation status error:', error);
    res.status(500).json({ error: 'Failed to get navigation status' });
  }
});

router.post('/stop', requireAuth, async (req, res) => {
  try {
    const session = await NavigationSession.findOneAndUpdate(
      { user_id: req.user.id, status: 'active' },
      { 
        status: 'completed', 
        end_time: new Date(),
        duration_minutes: req.body.duration_minutes || 0,
        distance_traveled: req.body.distance_traveled || 0
      },
      { new: true }
    );

    if (!session) {
      return res.status(404).json({ error: 'No active navigation' });
    }

    if (session.route_id) {
      await Route.findByIdAndUpdate(session.route_id, {
        $inc: { used_count: 1 },
        last_used_at: new Date()
      });
    }

    res.json({ stopped: true, session_id: session._id });
  } catch (error) {
    console.error('Stop navigation error:', error);
    res.status(500).json({ error: 'Failed to stop navigation' });
  }
});

router.get('/routes', requireAuth, async (req, res) => {
  try {
    const routes = await Route.find({ user_id: req.user.id, is_saved: true })
      .sort({ used_count: -1, last_used_at: -1 })
      .limit(20);
    
    res.json(routes);
  } catch (error) {
    console.error('Get routes error:', error);
    res.status(500).json({ error: 'Failed to get routes' });
  }
});

router.post('/routes/:id/save', requireAuth, async (req, res) => {
  try {
    const route = await Route.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.id },
      { is_saved: true, route_name: req.body.route_name },
      { new: true }
    );

    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    res.json(route);
  } catch (error) {
    console.error('Save route error:', error);
    res.status(500).json({ error: 'Failed to save route' });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const sessions = await NavigationSession.find({ user_id: req.user.id })
      .populate('route_id')
      .sort({ start_time: -1 })
      .limit(50);
    
    res.json(sessions);
  } catch (error) {
    console.error('Get navigation history error:', error);
    res.status(500).json({ error: 'Failed to get navigation history' });
  }
});

export default router;
