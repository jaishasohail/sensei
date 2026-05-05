import { Alert, Vibration } from 'react-native';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import * as SMS from 'expo-sms';
import { Accelerometer } from 'expo-sensors';
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
    this._accelSubscription = null;    // accelerometer subscription for fall detection
    this._liveLocationInterval = null; // live location sharing timer
    this._liveLocationContactName = null; // target contact name (null = all)
  }
  async initialize() {
    if (this.initialized) return true;
    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Migrate contacts saved before the `id` field was introduced.
        // Without an id, keyExtractor in FlatList returns undefined → React
        // warns "Each child in a list should have a unique key prop".
        this.emergencyContacts = parsed.map((c, i) => ({
          ...c,
          id: c.id ?? `migrated-${Date.now()}-${i}`,
        }));
      }
      // If nothing in local storage (fresh install, cleared storage, or contacts
      // were only saved server-side), pull from the API and cache locally so
      // that voice commands always find them without needing to visit Settings.
      if (this.emergencyContacts.length === 0) {
        await this._syncFromApi();
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

  // ── Pull contacts from the API and persist locally ────────────────────────
  // Called automatically by initialize() when AsyncStorage is empty.
  // Normalises the server shape { id, name, phone_number } → local { id, name, phone }.
  async _syncFromApi() {
    try {
      // Dynamic require to avoid a circular-import chain at module-eval time.
      const ApiService = require('./ApiService').default;

      // Primary token source: ApiService in-memory token (set after login or
      // after ApiService.initialize() loads it from AsyncStorage).
      // Fallback: read directly from AsyncStorage in case ApiService.initialize()
      // hasn't run yet (e.g. called from a background task very early in startup).
      let token = ApiService?.token;
      if (!token) {
        try {
          token = await AsyncStorage.getItem('@sensei_auth_token');
        } catch (_) {}
      }
      if (!token) return;

      // Use ApiService if its token is already set, otherwise make a raw fetch
      // with the AsyncStorage token to avoid mutating ApiService state.
      let apiContacts;
      if (ApiService?.token) {
        apiContacts = await ApiService.getEmergencyContacts();
      } else {
        const resp = await fetch(
          `${this.apiBaseUrl}/api/users/emergency-contacts`,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        apiContacts = await resp.json();
      }

      if (!Array.isArray(apiContacts) || apiContacts.length === 0) return;
      this.emergencyContacts = apiContacts.map((c, i) => ({
        id:    c.id   != null ? String(c.id) : `api-${Date.now()}-${i}`,
        name:  c.name || '',
        // Server stores the phone as `phone_number`; local schema uses `phone`.
        phone: c.phone_number ?? c.phone ?? '',
      }));
      // Persist so subsequent sessions do not need another API call.
      await this.saveContacts();
      console.log(`[Emergency] Synced ${this.emergencyContacts.length} contact(s) from API`);
    } catch (err) {
      console.warn('[Emergency] API sync skipped:', err?.message ?? err);
    }
  }
  async triggerEmergency() {
    try {
      this.isEmergencyActive = true;
      Vibration.vibrate([0, 500, 200, 500, 200, 500]);
      await TextToSpeechService.speak('Emergency alert activated. Calling nine one one.');
      const location = await LocationService.getCurrentLocation();
      // Share location to all contacts — deliberately NOT awaited so the
      // SMS compose sheet opening does not block the 911 call below.
      this.shareLocationToAllContacts(location, true).catch(err =>
        console.error('[Emergency] shareLocationToAllContacts error:', err)
      );
      // Log to server — fire and forget
      this._logEmergencyAlert(location).catch(() => {});
      // Primary action: call 911 immediately
      await Linking.openURL('tel:911');
      return { success: true, location, timestamp: new Date() };
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
          // BUG FIX: use location.latitude / location.longitude (not bare undefined vars)
          const mapsUrl = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
          const fullMessage = `${message}\n\nLocation: ${mapsUrl}`;
          await SMS.sendSMSAsync([contact.phone], fullMessage);
          alerts.push({
            contact: contact.name,
            method: 'SMS',
            status: 'sent',
            timestamp: new Date()
          });
        } else {
          // Fallback: open the system SMS composer via sms: URL
          const smsUrl = `sms:${contact.phone}?body=${encodeURIComponent(message)}`;
          await Linking.openURL(smsUrl);
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
        await TextToSpeechService.speak('Cannot make phone calls on this device');
      }
    } catch (error) {
      console.error('Emergency call error:', error);
      await TextToSpeechService.speak('Failed to initiate emergency call');
    }
  }
  async shareLocation(location) {
    try {
      await this.shareLocationToAllContacts(location, false);
      return { success: true };
    } catch (error) {
      console.error('Location sharing error:', error);
      return { success: false, error };
    }
  }

  // ── Private: log alert to server ──────────────────────────────────────────
  async _logEmergencyAlert(location) {
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (!token) return;
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
          description: `EMERGENCY: User needs help. Location: ${location.latitude}, ${location.longitude}`
        })
      });
    } catch (err) {
      console.error('[Emergency] Failed to log alert:', err);
    }
  }

  // ── Build a location message for SMS / WhatsApp ────────────────────────────
  _buildLocationMessage(location, isEmergency = false) {
    const mapsUrl = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
    const time = new Date().toLocaleString();
    if (isEmergency) {
      return (
        `EMERGENCY: Sensei user needs help!\n` +
        `Location: ${mapsUrl}\n` +
        `Coordinates: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}\n` +
        `Time: ${time}`
      );
    }
    return (
      `My current location:\n` +
      `${mapsUrl}\n` +
      `Coordinates: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}\n` +
      `Time: ${time}`
    );
  }

  // ── Normalise phone number for WhatsApp deep-link ──────────────────────────
  // Strips all non-digit characters; replaces a leading Pakistani 0 with 92.
  _normalizePhoneForWhatsApp(phone) {
    let digits = (phone || '').replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '92' + digits.slice(1);
    return digits;
  }

  // ── Find a contact by name (case-insensitive, partial match) ──────────────
  findContactByName(name) {
    if (!name) return null;
    const q = name.toLowerCase().trim();
    return (
      this.emergencyContacts.find(c => c.name.toLowerCase() === q) ||
      this.emergencyContacts.find(
        c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())
      ) ||
      null
    );
  }

  // ── Share location with ONE contact via SMS + WhatsApp ────────────────────
  async shareLocationToContact(contact, location, isEmergency = false) {
    const message = this._buildLocationMessage(location, isEmergency);
    const results = { contact: contact.name, sms: null, whatsapp: null };

    // SMS
    try {
      const isSMSAvailable = await SMS.isAvailableAsync();
      if (isSMSAvailable) {
        await SMS.sendSMSAsync([contact.phone], message);
        results.sms = 'sent';
      } else {
        await Linking.openURL(`sms:${contact.phone}?body=${encodeURIComponent(message)}`);
        results.sms = 'queued';
      }
    } catch (err) {
      console.error(`[Emergency] SMS to ${contact.name} failed:`, err);
      results.sms = 'failed';
    }

    // WhatsApp
    try {
      const phone = this._normalizePhoneForWhatsApp(contact.phone);
      const waUrl = `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
      const canOpen = await Linking.canOpenURL(waUrl);
      if (canOpen) {
        await Linking.openURL(waUrl);
        results.whatsapp = 'opened';
      } else {
        results.whatsapp = 'unavailable';
      }
    } catch (err) {
      console.warn(`[Emergency] WhatsApp to ${contact.name} failed:`, err);
      results.whatsapp = 'failed';
    }

    return results;
  }

  // ── Share location with ALL contacts (one SMS compose, WhatsApp for first) ─
  async shareLocationToAllContacts(location, isEmergency = false) {
    if (this.emergencyContacts.length === 0) {
      console.warn('[Emergency] No contacts to share location with');
      return { sent: 0 };
    }
    const message = this._buildLocationMessage(location, isEmergency);
    const phones = this.emergencyContacts.map(c => c.phone);

    // SMS — one compose sheet with all recipients
    try {
      const isSMSAvailable = await SMS.isAvailableAsync();
      if (isSMSAvailable) {
        await SMS.sendSMSAsync(phones, message);
      } else {
        for (const phone of phones) {
          await Linking.openURL(`sms:${phone}?body=${encodeURIComponent(message)}`);
        }
      }
    } catch (err) {
      console.error('[Emergency] Bulk SMS failed:', err);
    }

    // WhatsApp — first contact only (can only open one chat at a time)
    try {
      const first = this.emergencyContacts[0];
      const phone = this._normalizePhoneForWhatsApp(first.phone);
      const waUrl = `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
      const canOpen = await Linking.canOpenURL(waUrl);
      if (canOpen) await Linking.openURL(waUrl);
    } catch (err) {
      console.warn('[Emergency] WhatsApp share failed:', err);
    }

    return { sent: phones.length };
  }

  // ── Live location sharing ─────────────────────────────────────────────────
  // Difference from shareLocation / shareLocationToAllContacts:
  //   • "Share location"      → one-time SMS + WhatsApp (contact gets 1 message)
  //   • "Share live location" → initial SMS + WhatsApp, then a WhatsApp update
  //                             every LIVE_INTERVAL_MS so the contact receives
  //                             fresh coordinates periodically.
  //
  // True background auto-SMS is impossible without a server-side SMS gateway.
  // WhatsApp deep-link is used for updates: it opens WhatsApp pre-filled with
  // the new coordinates.  The blind user hears a TTS cue ("Live update N ready,
  // tap to send") and taps the Send button in the WhatsApp window.
  static LIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between updates

  async startLiveLocationSharing(contactName = null) {
    this.stopLiveLocationSharing(); // clear any existing session

    let targetContact = null;
    if (contactName) {
      targetContact = this.findContactByName(contactName);
      if (!targetContact) {
        await TextToSpeechService.speak(`Contact ${contactName} not found in emergency contacts.`);
        return { started: false, reason: 'Contact not found' };
      }
    }

    // ── Initial share: SMS + WhatsApp (one user tap required) ──────────────
    try {
      const location = await LocationService.getCurrentLocation();
      if (targetContact) {
        await this.shareLocationToContact(targetContact, location, false);
      } else {
        await this.shareLocationToAllContacts(location, false);
      }
    } catch (err) {
      console.error('[Emergency] Initial live location share failed:', err);
    }

    // ── Periodic updates via WhatsApp (every LIVE_INTERVAL_MS) ─────────────
    // Each tick: get fresh coordinates → build an update message → open
    // WhatsApp pre-filled → speak TTS so the blind user knows to tap Send.
    let updateCount = 1;
    this._liveLocationContactName = contactName;
    this._liveLocationInterval = setInterval(async () => {
      updateCount++;
      try {
        const loc = await LocationService.getCurrentLocation();
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const mapsUrl = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
        const message =
          `LIVE LOCATION UPDATE #${updateCount} (${time})\n` +
          `${mapsUrl}\n` +
          `Lat: ${loc.latitude.toFixed(5)}, Lng: ${loc.longitude.toFixed(5)}`;

        // Announce to user first so they know WhatsApp is about to open.
        await TextToSpeechService.speak(
          `Live location update ${updateCount} ready. Opening WhatsApp to send.`
        );

        // Open WhatsApp for each target contact.
        const targets = targetContact
          ? [targetContact]
          : this.emergencyContacts;

        for (const contact of targets) {
          try {
            const phone = this._normalizePhoneForWhatsApp(contact.phone);
            const waUrl = `whatsapp://send?phone=${phone}&text=${encodeURIComponent(message)}`;
            const canOpen = await Linking.canOpenURL(waUrl);
            if (canOpen) await Linking.openURL(waUrl);
          } catch (waErr) {
            console.warn(`[Emergency] Live WhatsApp update to ${contact.name} failed:`, waErr);
          }
        }
      } catch (err) {
        console.error('[Emergency] Live location update error:', err);
      }
    }, EmergencyService.LIVE_INTERVAL_MS);

    return { started: true, contact: targetContact?.name || 'all contacts' };
  }

  stopLiveLocationSharing() {
    if (this._liveLocationInterval) {
      clearInterval(this._liveLocationInterval);
      this._liveLocationInterval = null;
    }
    this._liveLocationContactName = null;
    return { stopped: true };
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
    // Subscribe to the device accelerometer at 100 ms intervals
    Accelerometer.setUpdateInterval(100);
    this._accelSubscription = Accelerometer.addListener(({ x, y, z }) => {
      this.processAccelerometerData(x, y, z);
    });
    TextToSpeechService.speak('Fall detection enabled');
  }
  disableFallDetection() {
    this.fallDetectionEnabled = false;
    // Remove accelerometer subscription to prevent memory leaks
    if (this._accelSubscription) {
      this._accelSubscription.remove();
      this._accelSubscription = null;
    }
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
