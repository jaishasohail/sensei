import express from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { 
  User, 
  UserProfile, 
  UserPreferences, 
  EmergencyContact,
  SavedLocation,
  WearableDevice 
} from '../models/index.js';

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const profile = await UserProfile.findOne({ user_id: req.user.id });
    const preferences = await UserPreferences.findOne({ user_id: req.user.id });

    res.json({
      id: user._id,
      email: user.email,
      phone_number: user.phone_number,
      profile: profile || {},
      preferences: preferences || {}
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

router.put('/me', requireAuth, async (req, res) => {
  try {
    const { name, age, visual_impairment_type } = req.body;

    const profile = await UserProfile.findOneAndUpdate(
      { user_id: req.user.id },
      { name, age, visual_impairment_type },
      { new: true, upsert: true }
    );

    res.json(profile);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.get('/preferences', requireAuth, async (req, res) => {
  try {
    const preferences = await UserPreferences.findOne({ user_id: req.user.id });
    res.json(preferences || {});
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

router.put('/preferences', requireAuth, async (req, res) => {
  try {
    const preferences = await UserPreferences.findOneAndUpdate(
      { user_id: req.user.id },
      req.body,
      { new: true, upsert: true }
    );

    res.json(preferences);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

router.get('/emergency-contacts', requireAuth, async (req, res) => {
  try {
    // Explicitly cast req.user.id to ObjectId.  jwt.sign({ id: user._id })
    // serialises the Mongoose ObjectId as a hex string; jwt.verify returns that
    // string in payload.id.  Mongoose 8 auto-casts valid hex strings, but an
    // explicit cast gives a clear 400 instead of an opaque 500 when the token
    // carries a malformed id (e.g. old token signed before the id field was set).
    let userId;
    try {
      userId = new mongoose.Types.ObjectId(String(req.user.id));
    } catch (castErr) {
      console.error('GET /emergency-contacts — invalid user id in token:',
        JSON.stringify(req.user.id), castErr.message);
      return res.status(400).json({ error: 'Invalid user ID in token' });
    }
    const contacts = await EmergencyContact.find({ user_id: userId });
    res.json(contacts);
  } catch (error) {
    console.error('Get emergency contacts error:',
      error.name, error.message,
      '| user_id type:', typeof req.user?.id,
      '| user_id value:', JSON.stringify(req.user?.id));
    res.status(500).json({ error: 'Failed to get emergency contacts' });
  }
});

router.post('/emergency-contacts', requireAuth, async (req, res) => {
  try {
    const { name, phone_number, relationship, is_primary } = req.body;

    if (is_primary) {
      await EmergencyContact.updateMany(
        { user_id: req.user.id },
        { is_primary: false }
      );
    }

    const contact = await EmergencyContact.create({
      user_id: req.user.id,
      name,
      phone_number,
      relationship,
      is_primary: is_primary || false
    });

    res.json(contact);
  } catch (error) {
    console.error('Add emergency contact error:', error);
    res.status(500).json({ error: 'Failed to add emergency contact' });
  }
});

router.put('/emergency-contacts/:id', requireAuth, async (req, res) => {
  try {
    const contact = await EmergencyContact.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.id },
      req.body,
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(contact);
  } catch (error) {
    console.error('Update emergency contact error:', error);
    res.status(500).json({ error: 'Failed to update emergency contact' });
  }
});

router.delete('/emergency-contacts/:id', requireAuth, async (req, res) => {
  try {
    const contact = await EmergencyContact.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user.id
    });

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete emergency contact error:', error);
    res.status(500).json({ error: 'Failed to delete emergency contact' });
  }
});

router.get('/saved-locations', requireAuth, async (req, res) => {
  try {
    const locations = await SavedLocation.find({ user_id: req.user.id })
      .sort({ visit_count: -1 });
    res.json(locations);
  } catch (error) {
    console.error('Get saved locations error:', error);
    res.status(500).json({ error: 'Failed to get saved locations' });
  }
});

router.post('/saved-locations', requireAuth, async (req, res) => {
  try {
    const location = await SavedLocation.create({
      user_id: req.user.id,
      ...req.body
    });

    res.json(location);
  } catch (error) {
    console.error('Add saved location error:', error);
    res.status(500).json({ error: 'Failed to add saved location' });
  }
});

router.get('/wearable-devices', requireAuth, async (req, res) => {
  try {
    const devices = await WearableDevice.find({ user_id: req.user.id });
    res.json(devices);
  } catch (error) {
    console.error('Get wearable devices error:', error);
    res.status(500).json({ error: 'Failed to get wearable devices' });
  }
});

router.post('/wearable-devices', requireAuth, async (req, res) => {
  try {
    const device = await WearableDevice.create({
      user_id: req.user.id,
      ...req.body
    });

    res.json(device);
  } catch (error) {
    console.error('Add wearable device error:', error);
    res.status(500).json({ error: 'Failed to add wearable device' });
  }
});

export default router;
