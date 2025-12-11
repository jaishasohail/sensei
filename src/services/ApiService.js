import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../constants/config';

class ApiService {
  constructor() {
    this.baseUrl = API_BASE_URL;
    this.token = null;
  }

  async initialize() {
    try {
      const token = await AsyncStorage.getItem('@sensei_auth_token');
      if (token) {
        this.token = token;
      }
    } catch (error) {
      console.error('Failed to load auth token:', error);
    }
  }

  async setToken(token) {
    this.token = token;
    try {
      await AsyncStorage.setItem('@sensei_auth_token', token);
    } catch (error) {
      console.error('Failed to save auth token:', error);
    }
  }

  async clearToken() {
    this.token = null;
    try {
      await AsyncStorage.removeItem('@sensei_auth_token');
    } catch (error) {
      console.error('Failed to clear auth token:', error);
    }
  }

  getHeaders(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (includeAuth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const config = {
      ...options,
      headers: this.getHeaders(options.auth !== false),
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error(`API request failed: ${endpoint}`, error);
      throw error;
    }
  }

  // Authentication
  async register(email, password, name, phone_number) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, password, name, phone_number }),
    });
    if (data.token) {
      await this.setToken(data.token);
    }
    return data;
  }

  async login(email, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, password }),
    });
    if (data.token) {
      await this.setToken(data.token);
    }
    return data;
  }

  async logout() {
    await this.clearToken();
  }

  // User Profile CRUD
  async getUserProfile(userId) {
    return this.request('/api/users/me');
  }

  async updateUserProfile(profileData) {
    return this.request('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(profileData),
    });
  }

  async getUserPreferences() {
    return this.request('/api/users/preferences');
  }

  async updateUserPreferences(preferences) {
    return this.request('/api/users/preferences', {
      method: 'PUT',
      body: JSON.stringify(preferences),
    });
  }

  // Emergency Contacts CRUD
  async getEmergencyContacts() {
    return this.request('/api/users/emergency-contacts');
  }

  async addEmergencyContact(contactData) {
    return this.request('/api/users/emergency-contacts', {
      method: 'POST',
      body: JSON.stringify(contactData),
    });
  }

  async updateEmergencyContact(contactId, contactData) {
    return this.request(`/api/users/emergency-contacts/${contactId}`, {
      method: 'PUT',
      body: JSON.stringify(contactData),
    });
  }

  async deleteEmergencyContact(contactId) {
    return this.request(`/api/users/emergency-contacts/${contactId}`, {
      method: 'DELETE',
    });
  }

  // Emergency Alerts CRUD
  async createEmergencyAlert(alertData) {
    return this.request('/api/emergency/alert', {
      method: 'POST',
      body: JSON.stringify(alertData),
    });
  }

  async getEmergencyAlerts() {
    return this.request('/api/emergency/alerts');
  }

  async resolveEmergencyAlert(alertId) {
    return this.request(`/api/emergency/alerts/${alertId}/resolve`, {
      method: 'PUT',
    });
  }

  // Navigation Sessions CRUD
  async createNavigationSession(userId, sessionData) {
    return this.request('/api/navigation/sessions', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...sessionData }),
    });
  }

  async getNavigationSession(sessionId) {
    return this.request(`/api/navigation/sessions/${sessionId}`);
  }

  async updateNavigationSession(sessionId, sessionData) {
    return this.request(`/api/navigation/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify(sessionData),
    });
  }

  async endNavigationSession(sessionId) {
    return this.request(`/api/navigation/sessions/${sessionId}/end`, {
      method: 'POST',
    });
  }

  // Saved Locations CRUD
  async getSavedLocations() {
    return this.request('/api/users/saved-locations');
  }

  async addSavedLocation(locationData) {
    return this.request('/api/users/saved-locations', {
      method: 'POST',
      body: JSON.stringify(locationData),
    });
  }

  async updateSavedLocation(locationId, locationData) {
    return this.request(`/api/navigation/locations/${locationId}`, {
      method: 'PUT',
      body: JSON.stringify(locationData),
    });
  }

  async deleteSavedLocation(locationId) {
    return this.request(`/api/navigation/locations/${locationId}`, {
      method: 'DELETE',
    });
  }

  // Detection Sessions CRUD
  async createDetectionSession(userId, sessionData) {
    return this.request('/api/ai/detection-sessions', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...sessionData }),
    });
  }

  async getDetectionSessions(userId) {
    return this.request(`/api/ai/detection-sessions/${userId}`);
  }

  // OCR Sessions CRUD
  async createOCRSession(userId, sessionData) {
    return this.request('/api/ai/ocr-sessions', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...sessionData }),
    });
  }

  async performOCR(imageBase64) {
    return this.request('/api/ai/ocr', {
      method: 'POST',
      body: JSON.stringify({ image: imageBase64 }),
    });
  }

  // System Logs
  async createSystemLog(userId, logData) {
    return this.request('/api/logs', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...logData }),
    });
  }

  async getSystemLogs(userId, filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/api/logs/${userId}?${params.toString()}`);
  }

  // Offline Maps CRUD
  async getOfflineMaps(userId) {
    return this.request(`/api/offline-maps/${userId}`);
  }

  async downloadOfflineMap(userId, mapData) {
    return this.request('/api/offline-maps', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, ...mapData }),
    });
  }

  async deleteOfflineMap(mapId) {
    return this.request(`/api/offline-maps/${mapId}`, {
      method: 'DELETE',
    });
  }
}

export default new ApiService();
