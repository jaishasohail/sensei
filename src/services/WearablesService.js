import BluetoothService from './BluetoothService';
class WearablesService {
  constructor() {
    this.initialized = false;
    this.devices = [];
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
  async pulseDirection(direction, intensity = 'normal') {
    const base = intensity === 'high' ? 600 : intensity === 'low' ? 200 : 400;
    const pattern = direction === 'left'
      ? [0, base, 100, base]
      : direction === 'right'
      ? [0, base, 100, base, 100, base]
      : [0, base];
    console.log('Wearables pulse', { direction, intensity, pattern });
  }
  async vibratePatternForHazard(level, relative = 'center') {
    let pattern;
    if (level === 'critical') pattern = [0, 200, 100, 200, 100, 200, 200, 300];
    else if (level === 'high') pattern = [0, 200, 100, 200];
    else if (level === 'medium') pattern = [0, 150];
    else pattern = [0, 100];
    console.log('Wearables hazard pattern', { level, relative, pattern });
  }
}
export default new WearablesService();
