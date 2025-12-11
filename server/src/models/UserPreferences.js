import mongoose from 'mongoose';
const userPreferencesSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  speech_speed: {
    type: Number,
    default: 1.0,
    min: 0.5,
    max: 2.0
  },
  audio_volume: {
    type: Number,
    default: 80,
    min: 0,
    max: 100
  },
  haptic_enabled: {
    type: Boolean,
    default: true
  },
  spatial_audio_enabled: {
    type: Boolean,
    default: true
  },
  voice_language: {
    type: String,
    default: 'en-US',
    trim: true
  },
  screen_reader_verbosity: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  audio_cues_style: {
    type: String,
    enum: ['minimal', 'standard', 'detailed'],
    default: 'standard'
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});
export default mongoose.model('UserPreferences', userPreferencesSchema);
