import mongoose from 'mongoose';
const detectedObjectSchema = new mongoose.Schema({
  session_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DetectionSession',
    required: true
  },
  object_type: {
    type: String,
    required: true,
    trim: true
  },
  confidence: {
    type: Number,
    required: true,
    min: 0,
    max: 1
  },
  distance: {
    type: Number,
    min: 0
  },
  position: {
    type: String,
    enum: ['front_left', 'front_center', 'front_right', 'left', 'right'],
    trim: true
  },
  hazard_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    trim: true
  },
  bounding_box_json: {
    type: mongoose.Schema.Types.Mixed
  },
  detected_at: {
    type: Date,
    default: Date.now
  },
  user_lat: {
    type: Number,
    min: -90,
    max: 90
  },
  user_lng: {
    type: Number,
    min: -180,
    max: 180
  }
}, {
  timestamps: true
});
detectedObjectSchema.index({ session_id: 1, detected_at: -1 });
detectedObjectSchema.index({ hazard_level: 1, detected_at: -1 });
export default mongoose.model('DetectedObject', detectedObjectSchema);
