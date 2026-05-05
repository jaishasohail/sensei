class BluetoothService {
  constructor() {
    this.isScanning = false;
    this.connectedDevices = [];
  }
  async initialize() {
    try {
      return true;
    } catch (error) {
      console.error('Bluetooth initialization error:', error);
      return false;
    }
  }
  async startScan(onDeviceFound, durationMs = 10000) {
    // TODO: replace with real BLE scanning (react-native-ble-plx / expo-bluetooth not in package.json)
    this.isScanning = true;
    console.log('Bluetooth scanning simulated');
    const mockDevices = [
      { id: 'BLE-001', name: 'Sensei Wearable' },
      { id: 'BLE-002', name: 'Bone Conduction Headset' },
    ];
    let idx = 0;
    const interval = setInterval(() => {
      if (!this.isScanning) { clearInterval(interval); return; }
      if (idx < mockDevices.length) {
        const device = mockDevices[idx++];
        if (typeof onDeviceFound === 'function') onDeviceFound(device);
      } else {
        clearInterval(interval);
      }
    }, Math.max(800, Math.floor(durationMs / (mockDevices.length + 1))));
    setTimeout(() => { this.stopScan(); }, durationMs);
  }
  async startScanning(callback) {
    return this.startScan(callback);
  }
  stopScan() { this.isScanning = false; }
  stopScanning() { this.isScanning = false; }
  async connectToDevice(deviceId) {
    // TODO: replace with real BLE connection when BLE library is available
    console.log('Connect to device simulated:', deviceId);
    // Store the connected device so getConnectedDevices() reflects it
    if (!this.connectedDevices.find(d => d.id === deviceId)) {
      this.connectedDevices.push({ id: deviceId, name: 'Unknown Device' });
    }
    return true;
  }
  async disconnectFromDevice(deviceId) {
    console.log('Disconnect from device simulated:', deviceId);
    this.connectedDevices = this.connectedDevices.filter(d => d.id !== deviceId);
    return true;
  }
  async disconnectAll() {
    this.connectedDevices = [];
    return true;
  }
  getConnectedDevices() {
    return this.connectedDevices;
  }
  /**
   * Send a haptic vibration pattern to a connected BLE wearable.
   * TODO: replace with a real BLE characteristic write once a BLE library is added.
   */
  sendHapticPattern(deviceId, pattern) {
    console.warn('[BluetoothService] sendHapticPattern: no real BLE library present — pattern logged only.', { deviceId, pattern });
  }
}
export default new BluetoothService();
