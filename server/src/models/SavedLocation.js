import mongoose from 'mongoose';
const savedLocationSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  location_name: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    type: String,
    trim: true
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
  category: {
    type: String,
    enum: ['home', 'work', 'favorite', 'restaurant', 'medical', 'other'],
    default: 'other'
  },
  notes: {
    type: String
  },
  visit_count: {
    type: Number,
    default: 0
  },
  last_visited_at: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
savedLocationSchema.index({ user_id: 1, category: 1 });
savedLocationSchema.index({ user_id: 1, visit_count: -1 });
export default mongoose.model('SavedLocation', savedLocationSchema);
