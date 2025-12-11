import mongoose from 'mongoose';
const offlineMapSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  region_name: {
    type: String,
    required: true,
    trim: true
  },
  min_lat: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  min_lng: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  max_lat: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  max_lng: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  map_data_path: {
    type: String,
    required: true,
    trim: true
  },
  file_size_mb: {
    type: Number,
    default: 0
  },
  downloaded_at: {
    type: Date,
    default: Date.now
  },
  last_updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});
offlineMapSchema.index({ user_id: 1, region_name: 1 });
export default mongoose.model('OfflineMap', offlineMapSchema);
