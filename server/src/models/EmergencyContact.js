import mongoose from 'mongoose';
const emergencyContactSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  phone_number: {
    type: String,
    required: true,
    trim: true
  },
  relationship: {
    type: String,
    trim: true
  },
  is_primary: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});
emergencyContactSchema.index({ user_id: 1 });
emergencyContactSchema.index({ user_id: 1, is_primary: 1 });
export default mongoose.model('EmergencyContact', emergencyContactSchema);
