import mongoose from 'mongoose';
const wearableDeviceSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  device_name: {
    type: String,
    required: true,
    trim: true
  },
  device_type: {
    type: String,
    enum: ['haptic_band', 'smart_watch', 'fitness_tracker', 'other'],
    required: true
  },
  bluetooth_address: {
    type: String,
    trim: true
  },
  battery_level: {
    type: Number,
    min: 0,
    max: 100
  },
  is_connected: {
    type: Boolean,
    default: false
  },
  firmware_version: {
    type: String,
    trim: true
  },
  last_connected_at: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
wearableDeviceSchema.index({ user_id: 1, is_connected: 1 });
export default mongoose.model('WearableDevice', wearableDeviceSchema);
