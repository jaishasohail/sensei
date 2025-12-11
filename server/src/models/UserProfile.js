import mongoose from 'mongoose';
const userProfileSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  name: {
    type: String,
    trim: true
  },
  age: {
    type: Number,
    min: 0,
    max: 150
  },
  visual_impairment_type: {
    type: String,
    enum: ['blind', 'low_vision', 'color_blind', 'other'],
    trim: true
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});
export default mongoose.model('UserProfile', userProfileSchema);
