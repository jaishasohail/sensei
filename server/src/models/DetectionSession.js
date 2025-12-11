import mongoose from 'mongoose';
const detectionSessionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  start_time: {
    type: Date,
    required: true
  },
  end_time: {
    type: Date
  },
  frames_processed: {
    type: Number,
    default: 0
  },
  objects_detected_count: {
    type: Number,
    default: 0
  },
  critical_hazards_count: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});
detectionSessionSchema.index({ user_id: 1, start_time: -1 });
export default mongoose.model('DetectionSession', detectionSessionSchema);
