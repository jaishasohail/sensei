import express from 'express';
import bcrypt from 'bcryptjs';
import { signToken } from '../middleware/auth.js';
import { User, UserProfile, UserPreferences } from '../models/index.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone_number } = req.body || {};
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    
    const user = await User.create({
      email,
      password_hash,
      phone_number,
      is_active: true,
      account_type: 'standard'
    });

    await UserProfile.create({
      user_id: user._id,
      name: name || email.split('@')[0]
    });

    await UserPreferences.create({
      user_id: user._id,
      speech_speed: 1.0,
      audio_volume: 80,
      haptic_enabled: true,
      spatial_audio_enabled: true,
      voice_language: 'en-US'
    });

    const token = signToken({ id: user._id, email: user.email });
    
    res.json({ 
      token, 
      user: {
        id: user._id,
        email: user.email,
        name: name || email.split('@')[0]
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.last_login_at = new Date();
    await user.save();

    const profile = await UserProfile.findOne({ user_id: user._id });

    const token = signToken({ id: user._id, email: user.email });
    
    res.json({ 
      token, 
      user: {
        id: user._id,
        email: user.email,
        name: profile?.name || email.split('@')[0]
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
