import mongoose from 'mongoose';
const systemLogSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  log_type: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical', 'debug'],
    required: true
  },
  log_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'low'
  },
  message: {
    type: String,
    required: true
  },
  metadata_json: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
systemLogSchema.index({ log_type: 1, created_at: -1 });
systemLogSchema.index({ user_id: 1, created_at: -1 });
systemLogSchema.index({ created_at: -1 });
export default mongoose.model('SystemLog', systemLogSchema);
