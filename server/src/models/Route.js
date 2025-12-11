import mongoose from 'mongoose';
const routeSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  route_name: {
    type: String,
    trim: true
  },
  start_lat: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  start_lng: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  end_lat: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  end_lng: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  total_distance: {
    type: Number,
    default: 0
  },
  estimated_time: {
    type: Number,
    default: 0
  },
  waypoints_json: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  turns_json: {
    type: mongoose.Schema.Types.Mixed,
    default: []
  },
  is_saved: {
    type: Boolean,
    default: false
  },
  used_count: {
    type: Number,
    default: 0
  },
  last_used_at: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
routeSchema.index({ user_id: 1, is_saved: 1 });
routeSchema.index({ user_id: 1, used_count: -1 });
export default mongoose.model('Route', routeSchema);
