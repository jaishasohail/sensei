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
  // Backwards-compatible scan API used by SettingsScreen
  async startScan(onDeviceFound, durationMs = 10000) {
    this.isScanning = true;
    console.log('Bluetooth scanning simulated');
    // Simulate discovering a couple devices over time
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
    // Auto-stop after duration
    setTimeout(() => { this.stopScan(); }, durationMs);
  }
  // Legacy alias to avoid breaking older calls
  async startScanning(callback) {
    return this.startScan(callback);
  }
  stopScan() { this.isScanning = false; }
  stopScanning() { this.isScanning = false; }
  async connectToDevice(deviceId) {
    console.log('Connect to device simulated:', deviceId);
    return true;
  }
  async disconnectFromDevice(deviceId) {
    console.log('Disconnect from device simulated:', deviceId);
    return true;
  }
  async disconnectAll() {
    this.connectedDevices = [];
    return true;
  }
  getConnectedDevices() {
    return this.connectedDevices;
  }
}
export default new BluetoothService();
