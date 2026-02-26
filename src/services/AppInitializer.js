import LocationService from '../services/LocationService';
import TextToSpeechService from '../services/TextToSpeechService';
import ObjectDetectionService from '../services/ObjectDetectionService';
import SpatialAudioService from '../services/SpatialAudioService';
import BluetoothService from '../services/BluetoothService';
import NavigationService from '../services/NavigationService';
import ARService from '../services/ARService';
import OfflineModeService from '../services/OfflineModeService';
import OCRService from '../services/OCRService';
import EmotionDetectionService from '../services/EmotionDetectionService';
import DepthEstimationService from '../services/DepthEstimationService';
import { API_BASE_URL } from '../constants/config';
class AppInitializer {
  constructor() {
    this.isInitialized = false;
  }
  async initialize() {
    if (this.isInitialized) {
      return;
    }
    try {
      await this.initializeServices();
      this.isInitialized = true;
      return { success: true };
    } catch (error) {
      console.error('App initialization error:', error);
      return { success: false, error };
    }
  }
  async initializeServices() {
    try {
      OfflineModeService.setApiBaseUrl(API_BASE_URL);
      await OCRService.initialize({ apiBaseUrl: API_BASE_URL });
      await EmotionDetectionService.initialize({ apiBaseUrl: API_BASE_URL });
      await DepthEstimationService.initialize({ apiBaseUrl: API_BASE_URL });
      const serverOnline = await OfflineModeService.pingServer();
      if (serverOnline) {
        OfflineModeService.setUseCloud(true);
        TextToSpeechService.speak('Connected to SENSEI server');
      } else {
        OfflineModeService.setUseCloud(false);
        TextToSpeechService.speak('Running in offline mode');
      }
      await LocationService.requestPermissions();
      await ObjectDetectionService.requestPermissions();
      // Preload object detection model in background to reduce latency when opening AR
      ObjectDetectionService.loadModel().then(() => {
        console.log('AppInitializer: ObjectDetection model preloaded');
      }).catch(err => {
        console.warn('AppInitializer: preload model failed', err);
      });
      await SpatialAudioService.initialize();
      await BluetoothService.initialize();
      TextToSpeechService.speak('SENSEI initialized');
    } catch (error) {
      console.error('Service initialization error:', error);
      throw error;
    }
  }
  async cleanup() {
    try {
      LocationService.stopWatchingLocation();
      ObjectDetectionService.stopDetection();
      await SpatialAudioService.stopAllSounds();
      await BluetoothService.disconnectAll();
      NavigationService.stopNavigation();
      ARService.dispose();
      this.isInitialized = false;
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }
  getInitializationStatus() {
    return this.isInitialized;
  }
}
export default new AppInitializer();
