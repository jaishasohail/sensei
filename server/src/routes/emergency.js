import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { EmergencyAlert, EmergencyContact } from '../models/index.js';

const router = express.Router();

router.post('/alert', requireAuth, async (req, res) => {
  try {
    const { latitude, longitude, message, trigger_type } = req.body || {};
    
    const alert = await EmergencyAlert.create({
      user_id: req.user.id,
      trigger_type: trigger_type || 'manual_trigger',
      latitude,
      longitude,
      message,
      status: 'triggered',
      contacts_notified: 0
    });

    const contacts = await EmergencyContact.find({ user_id: req.user.id });
    
    const io = req.app.get('io');
    io.emit('emergency', {
      alert_id: alert._id,
      user_id: req.user.id,
      location: { latitude, longitude },
      message,
      contacts: contacts.length,
      time: alert.created_at
    });

    alert.status = 'notifying';
    alert.contacts_notified = contacts.length;
    await alert.save();

    res.json({ 
      success: true, 
      alert_id: alert._id,
      contacts_notified: contacts.length 
    });
  } catch (error) {
    console.error('Emergency alert error:', error);
    res.status(500).json({ error: 'Failed to send emergency alert' });
  }
});

router.get('/alerts', requireAuth, async (req, res) => {
  try {
    const alerts = await EmergencyAlert.find({ user_id: req.user.id })
      .sort({ created_at: -1 })
      .limit(50);
    
    res.json(alerts);
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to get alerts' });
  }
});

router.put('/alerts/:id/resolve', requireAuth, async (req, res) => {
  try {
    const alert = await EmergencyAlert.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.id },
      { status: 'resolved', resolved_at: new Date() },
      { new: true }
    );

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json(alert);
  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({ error: 'Failed to resolve alert' });
  }
});

export default router;
