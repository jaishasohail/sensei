import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';
class EmotionDetectionService {
  constructor() {
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
  }
  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    return true;
  }
  async detectEmotion(faceImageBase64) {
    try {
      if (OfflineModeService.useCloud() && (await OfflineModeService.pingServer())) {
        const res = await fetch(`${this.apiBaseUrl}/api/ai/emotion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ faceImage: faceImageBase64 })
        });
        if (res.ok) return res.json();
      }
      return { emotion: 'unknown', confidence: 0.0 };
    } catch (e) {
      return { emotion: 'error', confidence: 0.0 };
    }
  }
}
export default new EmotionDetectionService();
