export const validateCoordinates = (latitude, longitude) => {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return false;
  }
  if (latitude < -90 || latitude > 90) {
    return false;
  }
  if (longitude < -180 || longitude > 180) {
    return false;
  }
  return true;
};
export const validateDistance = (distance) => {
  return typeof distance === 'number' && distance >= 0;
};
export const validateBearing = (bearing) => {
  return typeof bearing === 'number' && bearing >= 0 && bearing <= 360;
};
export const validateDestination = (destination) => {
  if (!destination || typeof destination !== 'object') {
    return false;
  }
  if (!destination.name || typeof destination.name !== 'string') {
    return false;
  }
  if (!validateCoordinates(destination.latitude, destination.longitude)) {
    return false;
  }
  return true;
};
export const sanitizeInput = (input) => {
  if (typeof input !== 'string') {
    return '';
  }
  return input.trim().replace(/[<>]/g, '');
};
export const validateBluetoothDevice = (device) => {
  if (!device || typeof device !== 'object') {
    return false;
  }
  if (!device.id || typeof device.id !== 'string') {
    return false;
  }
  return true;
};
