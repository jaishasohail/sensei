import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  phone_number: {
    type: String,
    trim: true
  },
  password_hash: {
    type: String,
    required: true
  },
  last_login_at: {
    type: Date
  },
  is_active: {
    type: Boolean,
    default: true
  },
  account_type: {
    type: String,
    enum: ['standard', 'premium', 'admin'],
    default: 'standard'
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});
export default mongoose.model('User', userSchema);
