import mongoose from 'mongoose';
const ocrSessionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  detected_text: {
    type: String
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1
  },
  language: {
    type: String,
    default: 'en',
    trim: true
  },
  translated_text: {
    type: String
  },
  translation_language: {
    type: String,
    trim: true
  },
  image_path: {
    type: String,
    trim: true
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false }
});
ocrSessionSchema.index({ user_id: 1, created_at: -1 });
export default mongoose.model('OCRSession', ocrSessionSchema);
