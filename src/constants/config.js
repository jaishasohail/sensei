export const APP_NAME = 'SENSEI';
export const APP_VERSION = '1.0.0';
export const APP_DESCRIPTION = 'Smart Environmental Navigation System for Enhanced Independence';
export const API_BASE_URL = 'http://192.168.18.106:3001';
export const NAVIGATION_CONSTANTS = {
  UPDATE_INTERVAL: 5000,
  MIN_ACCURACY: 10,
  STEP_COMPLETION_THRESHOLD: 10,
  MAX_ROUTE_DISTANCE: 10000,
};
export const DETECTION_CONSTANTS = {
  DETECTION_INTERVAL: 1000,
  MAX_DETECTION_DISTANCE: 10,
  CONFIDENCE_THRESHOLD: 0.7,
  MAX_OBJECTS_TRACKED: 10,
};
export const AUDIO_CONSTANTS = {
  DEFAULT_VOLUME: 1.0,
  DEFAULT_RATE: 0.9,
  DEFAULT_PITCH: 1.0,
  SPATIAL_AUDIO_ENABLED: true,
};
export const BLUETOOTH_CONSTANTS = {
  SCAN_DURATION: 10000,
  AUTO_RECONNECT: true,
  MAX_CONNECTED_DEVICES: 3,
};
export const AR_CONSTANTS = {
  CAMERA_FOV: 75,
  NEAR_PLANE: 0.1,
  FAR_PLANE: 1000,
  MARKER_SIZE: 0.3,
};
export const OBJECT_TYPES = {
  PERSON: 'person',
  VEHICLE: 'vehicle',
  OBSTACLE: 'obstacle',
  WARNING: 'warning',
  INFO: 'info',
};
export const PRIORITY_LEVELS = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};
export const NAVIGATION_DIRECTIONS = {
  FORWARD: 'forward',
  LEFT: 'left',
  RIGHT: 'right',
  BACKWARD: 'backward',
};
