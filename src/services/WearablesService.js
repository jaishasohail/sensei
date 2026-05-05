import { Vibration } from 'react-native';
import * as Battery from 'expo-battery';
import BluetoothService from './BluetoothService';
import TextToSpeechService from './TextToSpeechService';

class WearablesService {
  constructor() {
    this.initialized = false;
    this.devices = [];
    this.smartwatch = null;   // deviceId of connected smartwatch (if any)
  }
  async initialize() {
    const ok = await BluetoothService.initialize();
    this.initialized = ok;
    return ok;
  }
  async startScanning(onDevices) {
    return BluetoothService.startScanning((devices) => {
      this.devices = devices;
      if (onDevices) onDevices(devices);
    });
  }
  stopScanning() {
    BluetoothService.stopScanning();
  }

  // ── Haptic helpers ──────────────────────────────────────────────────────────

  async pulseDirection(direction, intensity = 'normal') {
    const base = intensity === 'high' ? 600 : intensity === 'low' ? 200 : 400;
    const pattern = direction === 'left'
      ? [0, base, 100, base]
      : direction === 'right'
      ? [0, base, 100, base, 100, base]
      : [0, base];
    // Phone-side haptic feedback (always works)
    Vibration.vibrate(pattern);
    // Forward to BLE wearable if one is connected
    const connected = BluetoothService.getConnectedDevices();
    if (connected.length > 0) {
      BluetoothService.sendHapticPattern(connected[0].id, pattern);
    }
  }

  async vibratePatternForHazard(level, relative = 'center') {
    let pattern;
    if (level === 'critical') pattern = [0, 200, 100, 200, 100, 200, 200, 300];
    else if (level === 'high') pattern = [0, 200, 100, 200];
    else if (level === 'medium') pattern = [0, 150];
    else pattern = [0, 100];
    // Phone-side haptic feedback (always works)
    Vibration.vibrate(pattern);
    // Forward to BLE wearable if one is connected
    const connected = BluetoothService.getConnectedDevices();
    if (connected.length > 0) {
      BluetoothService.sendHapticPattern(connected[0].id, pattern);
    }
  }

  // ── Smartwatch support ──────────────────────────────────────────────────────

  /**
   * Connect a smartwatch by deviceId via Bluetooth.
   * Stores it in this.smartwatch for subsequent sendWatchNotification calls.
   */
  async connectSmartwatch(deviceId) {
    try {
      await BluetoothService.connectToDevice(deviceId);
      this.smartwatch = deviceId;
      return true;
    } catch (error) {
      console.error('[WearablesService] connectSmartwatch error:', error);
      return false;
    }
  }

  /**
   * Send a notification to the connected smartwatch.
   * Falls back to TTS if no physical watch is reachable.
   */
  sendWatchNotification(message) {
    console.log('[Smartwatch]', message);
    // TTS fallback — always audible on the phone
    TextToSpeechService.speak(message);
  }

  // ── Battery status ──────────────────────────────────────────────────────────

  /**
   * Return the phone battery level as an integer 0–100, or null on error.
   */
  async getPhoneBatteryLevel() {
    try {
      const level = await Battery.getBatteryLevelAsync();
      return Math.round(level * 100);
    } catch (e) {
      console.error('[WearablesService] getPhoneBatteryLevel error:', e.message);
      return null;
    }
  }

  /**
   * Return a combined battery status object:
   *   { phone: 0–100 | null, wearable: null, isCharging: bool }
   */
  async getBatteryStatus() {
    try {
      const level = await Battery.getBatteryLevelAsync();
      const state = await Battery.getBatteryStateAsync();
      const isCharging =
        state === Battery.BatteryState.CHARGING ||
        state === Battery.BatteryState.FULL;
      return {
        phone: Math.round(level * 100),
        wearable: null,
        isCharging,
      };
    } catch (e) {
      console.error('[WearablesService] getBatteryStatus error:', e.message);
      return { phone: null, wearable: null, isCharging: false };
    }
  }
}

export default new WearablesService();
