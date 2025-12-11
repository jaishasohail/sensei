import { API_BASE_URL } from '../constants/config';
class OfflineModeService {
  constructor() {
    this._useCloud = false;
    this._apiBaseUrl = API_BASE_URL;
  }
  setApiBaseUrl(url) {
    this._apiBaseUrl = url;
  }
  setUseCloud(enabled) {
    this._useCloud = !!enabled;
  }
  useCloud() {
    return this._useCloud;
  }
  async pingServer() {
    const base = this._apiBaseUrl || API_BASE_URL;
    try {
      const res = await fetch(`${base}/api/health`);
      if (!res.ok) return false;
      const data = await res.json();
      return data?.status === 'ok';
    } catch (e) {
      return false;
    }
  }
}
export default new OfflineModeService();
