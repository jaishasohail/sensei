import mongoose from 'mongoose';
const voiceCommandSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  raw_text: {
    type: String,
    required: true
  },
  parsed_command: {
    type: String,
    trim: true
  },
  command_type: {
    type: String,
    enum: ['navigation', 'emergency', 'detection', 'settings', 'ocr', 'other'],
    required: true
  },
  parameters_json: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1
  },
  success: {
    type: Boolean,
    default: false
  },
  execution_time_ms: {
    type: Number,
    default: 0
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
voiceCommandSchema.index({ user_id: 1, created_at: -1 });
voiceCommandSchema.index({ command_type: 1, success: 1 });
export default mongoose.model('VoiceCommand', voiceCommandSchema);
