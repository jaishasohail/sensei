import mongoose from 'mongoose';
const navigationSessionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  route_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route'
  },
  start_lat: {
    type: Number,
    min: -90,
    max: 90
  },
  start_lng: {
    type: Number,
    min: -180,
    max: 180
  },
  dest_lat: {
    type: Number,
    min: -90,
    max: 90
  },
  dest_lng: {
    type: Number,
    min: -180,
    max: 180
  },
  start_time: {
    type: Date
  },
  end_time: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'cancelled'],
    default: 'active'
  },
  distance_traveled: {
    type: Number,
    default: 0
  },
  duration_minutes: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});
navigationSessionSchema.index({ user_id: 1, start_time: -1 });
navigationSessionSchema.index({ status: 1 });
export default mongoose.model('NavigationSession', navigationSessionSchema);
