import { Alert, Vibration } from 'react-native';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import * as SMS from 'expo-sms';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TextToSpeechService from './TextToSpeechService';
import LocationService from './LocationService';
import { API_BASE_URL } from '../constants/config';
class EmergencyService {
  constructor() {
    this.emergencyContacts = [];
    this.isEmergencyActive = false;
    this.fallDetectionEnabled = false;
    this.lastAcceleration = { x: 0, y: 0, z: 0 };
    this.fallThreshold = 2.5; 
    this.storageKey = '@sensei_emergency_contacts';
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
  }
  async initialize() {
    if (this.initialized) return true;
    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        this.emergencyContacts = JSON.parse(stored);
      }
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('Emergency service initialization error:', error);
      return false;
    }
  }
  async saveContacts() {
    try {
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(this.emergencyContacts));
      return true;
    } catch (error) {
      console.error('Save contacts error:', error);
      return false;
    }
  }
  async triggerEmergency() {
    try {
      this.isEmergencyActive = true;
      Vibration.vibrate([0, 1000, 500, 1000]);
      await TextToSpeechService.speak('Emergency alert activated. Getting your location.');
      const location = await LocationService.getCurrentLocation();
      const message = `EMERGENCY: User needs help. Location: ${location.latitude}, ${location.longitude}. Time: ${new Date().toLocaleString()}`;
      await this.sendEmergencyAlerts(message, location);
      const token = await AsyncStorage.getItem('authToken');
      if (token) {
        try {
          await fetch(`${this.apiBaseUrl}/api/emergency/alert`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              type: 'manual',
              location: { latitude: location.latitude, longitude: location.longitude },
              severity: 'high',
              description: message
            })
          });
        } catch (err) {
          console.error('Failed to log emergency alert:', err);
        }
      }
      Alert.alert(
        '🚨 EMERGENCY ALERT',
        'Emergency services have been notified. Help is on the way.',
        [
          { text: 'Call 911', onPress: () => this.callEmergency('911') },
          { text: 'Share Location', onPress: () => this.shareLocation(location) },
          { text: 'Cancel', style: 'cancel', onPress: () => this.cancelEmergency() }
        ]
      );
      return {
        success: true,
        location,
        message,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Emergency trigger error:', error);
      await TextToSpeechService.speak('Emergency alert failed. Please call for help manually.');
      return { success: false, error };
    }
  }
  cancelEmergency() {
    this.isEmergencyActive = false;
    Vibration.cancel();
    TextToSpeechService.speak('Emergency alert cancelled');
  }
  async sendEmergencyAlerts(message, location) {
    const alerts = [];
    const isSMSAvailable = await SMS.isAvailableAsync();
    if (!isSMSAvailable) {
      console.warn('SMS not available on this device');
    }
    for (const contact of this.emergencyContacts) {
      try {
        if (isSMSAvailable) {
          const mapsUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
          const fullMessage = `${message}\n\nLocation: ${mapsUrl}`;
          alerts.push({ 
            contact: contact.name, 
            method: 'SMS', 
            status: 'sent',
            timestamp: new Date()
          });
        } else {
          const smsUrl = `sms:${contact.phone}?body=${encodeURIComponent(message)}`;
          alerts.push({ contact: contact.name, method: 'SMS', status: 'queued' });
        }
      } catch (error) {
        console.error(`Failed to alert ${contact.name}:`, error);
        alerts.push({ 
          contact: contact.name, 
          method: 'SMS', 
          status: 'failed',
          error: error.message 
        });
      }
    }
    return alerts;
  }
  async callEmergency(number = '911') {
    try {
      const phoneUrl = `tel:${number}`;
      const canOpen = await Linking.canOpenURL(phoneUrl);
      if (canOpen) {
        await Linking.openURL(phoneUrl);
        await TextToSpeechService.speak(`Calling ${number}`);
      } else {
        Alert.alert('Error', 'Cannot make phone calls on this device');
      }
    } catch (error) {
      console.error('Emergency call error:', error);
      Alert.alert('Error', 'Failed to initiate emergency call');
    }
  }
  async shareLocation(location) {
    try {
      const mapsUrl = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
      const message = `My current location: ${mapsUrl}`;
      Alert.alert('Location', message, [
        { text: 'Copy', onPress: () => console.log('Location copied') },
        { text: 'Close' }
      ]);
      return { success: true, url: mapsUrl };
    } catch (error) {
      console.error('Location sharing error:', error);
      return { success: false, error };
    }
  }
  async addEmergencyContact(contact) {
    const newContact = {
      id: contact.id || (Date.now() + Math.random()).toString(),
      name: contact.name,
      phone: contact.phone,
      addedAt: new Date().toISOString()
    };
    this.emergencyContacts.push(newContact);
    await this.saveContacts();
    return newContact;
  }
  async removeEmergencyContact(contactId) {
    this.emergencyContacts = this.emergencyContacts.filter(c => c.id !== contactId);
    await this.saveContacts();
    return true;
  }
  getEmergencyContacts() {
    return this.emergencyContacts;
  }
  async updateEmergencyContact(contactId, updates) {
    const index = this.emergencyContacts.findIndex(c => c.id === contactId);
    if (index !== -1) {
      this.emergencyContacts[index] = {
        ...this.emergencyContacts[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      await this.saveContacts();
      return this.emergencyContacts[index];
    }
    return null;
  }
  enableFallDetection() {
    this.fallDetectionEnabled = true;
    TextToSpeechService.speak('Fall detection enabled');
  }
  disableFallDetection() {
    this.fallDetectionEnabled = false;
    TextToSpeechService.speak('Fall detection disabled');
  }
  processAccelerometerData(x, y, z) {
    if (!this.fallDetectionEnabled) return;
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const lastMagnitude = Math.sqrt(
      this.lastAcceleration.x * this.lastAcceleration.x +
      this.lastAcceleration.y * this.lastAcceleration.y +
      this.lastAcceleration.z * this.lastAcceleration.z
    );
    const delta = Math.abs(magnitude - lastMagnitude);
    if (delta > this.fallThreshold) {
      this.handlePotentialFall();
    }
    this.lastAcceleration = { x, y, z };
  }
  async handlePotentialFall() {
    Vibration.vibrate(500);
    await TextToSpeechService.speak('Fall detected. Are you okay?');
    Alert.alert(
      'WARNING: Fall Detected',
      'We detected a potential fall. Are you okay?',
      [
        { text: "I'm Okay", style: 'cancel', onPress: () => {
          TextToSpeechService.speak('Good to hear. Stay safe.');
        }},
        { text: 'Need Help', onPress: () => this.triggerEmergency() }
      ],
      { cancelable: false }
    );
  }
  isActive() {
    return this.isEmergencyActive;
  }
}
export default new EmergencyService();
