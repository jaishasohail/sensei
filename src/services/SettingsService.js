import AsyncStorage from '@react-native-async-storage/async-storage';
const STORAGE_KEY = '@sensei_settings_v1';
const DEFAULTS = {
  precisionMode: true,
  refinementPass: false,
  horizontalFOV: 70,
  verticalFOV: 60,
  maxDetections: 15,
};
class SettingsService {
  constructor() {
    this._listeners = new Set();
    this._cache = null;
  }
  async getSettings() {
    if (this._cache) return this._cache;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      this._cache = { ...DEFAULTS, ...parsed };
      return this._cache;
    } catch (e) {
      this._cache = { ...DEFAULTS };
      return this._cache;
    }
  }
  async saveSettings(partial) {
    const current = await this.getSettings();
    const merged = { ...current, ...partial };
    this._cache = merged;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    this._emit(merged);
    return merged;
  }
  async set(key, value) {
    return this.saveSettings({ [key]: value });
  }
  async get(key) {
    const s = await this.getSettings();
    return s[key];
  }
  addListener(cb) {
    if (typeof cb === 'function') this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  _emit(settings) {
    this._listeners.forEach((cb) => {
      try { cb(settings); } catch {}
    });
  }
}
export default new SettingsService();
