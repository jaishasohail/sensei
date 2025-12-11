import mongoose from 'mongoose';
const emergencyAlertSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  trigger_type: {
    type: String,
    enum: ['fall_detected', 'manual_trigger', 'voice_command', 'panic_button'],
    required: true
  },
  latitude: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  longitude: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  status: {
    type: String,
    enum: ['triggered', 'notifying', 'resolved', 'cancelled'],
    default: 'triggered'
  },
  message: {
    type: String
  },
  contacts_notified: {
    type: Number,
    default: 0
  },
  call_911_made: {
    type: Boolean,
    default: false
  },
  resolved_at: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
emergencyAlertSchema.index({ user_id: 1, created_at: -1 });
emergencyAlertSchema.index({ status: 1, created_at: -1 });
export default mongoose.model('EmergencyAlert', emergencyAlertSchema);
