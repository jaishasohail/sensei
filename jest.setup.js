import '@testing-library/jest-native/extend-expect';

jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper');

jest.mock('expo-camera', () => ({
  Camera: {
    Constants: {
      Type: {
        back: 'back',
        front: 'front',
      },
    },
  },
}));

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(() => 
    Promise.resolve({ status: 'granted' })
  ),
  getCurrentPositionAsync: jest.fn(() =>
    Promise.resolve({
      coords: {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 10,
      },
    })
  ),
  watchPositionAsync: jest.fn(),
}));

jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(() => Promise.resolve(true)),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
  },
  Gyroscope: {
    isAvailableAsync: jest.fn(() => Promise.resolve(true)),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('expo-speech', () => ({
  speak: jest.fn(),
  stop: jest.fn(),
  isSpeakingAsync: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('expo-sms', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(true)),
  sendSMSAsync: jest.fn(() => Promise.resolve({ result: 'sent' })),
}));

jest.mock('expo-contacts', () => ({
  requestPermissionsAsync: jest.fn(() => 
    Promise.resolve({ status: 'granted' })
  ),
  getContactsAsync: jest.fn(() =>
    Promise.resolve({
      data: [
        { id: '1', name: 'John Doe', phoneNumbers: [{ number: '+1-555-0100' }] },
      ],
    })
  ),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}));

jest.mock('@tensorflow/tfjs-react-native', () => ({
  ready: jest.fn(() => Promise.resolve()),
}));

jest.mock('@tensorflow-models/coco-ssd', () => ({
  load: jest.fn(() =>
    Promise.resolve({
      detect: jest.fn(() =>
        Promise.resolve([
          {
            class: 'person',
            score: 0.9,
            bbox: [100, 100, 200, 300],
          },
        ])
      ),
    })
  ),
}));

global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
