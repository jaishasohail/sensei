import * as Speech from 'expo-speech';
import TextToSpeechService from './TextToSpeechService';
import ObjectDetectionService from './ObjectDetectionService';
import NavigationService from './NavigationService';
import LocationService from './LocationService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
class VoiceCommandService {
  constructor() {
    this.isListening = false;
    this.recognitionTimeout = null;
    this.lastCommand = null;
    this.commandHistory = [];
    this.detectedObjects = [];
    this.currentLocation = null;
    this.apiBaseUrl = API_BASE_URL;
    this.commandPatterns = [
      { pattern: /where (is|are) (the|a|an)?\s*(.+)/i, action: 'findObject', type: 'location' },
      { pattern: /find (the|a|an)?\s*(.+)/i, action: 'findObject', type: 'location' },
      { pattern: /locate (the|a|an)?\s*(.+)/i, action: 'findObject', type: 'location' },
      { pattern: /what (is|am i|are)\s+(this|that|these|those|in|on|holding)/i, action: 'identifyObject', type: 'identification' },
      { pattern: /identify (this|that|object)/i, action: 'identifyObject', type: 'identification' },
      { pattern: /describe (this|that|what|object)/i, action: 'identifyObject', type: 'identification' },
      { pattern: /navigate to (.+)/i, action: 'navigate', type: 'navigation' },
      { pattern: /take me to (.+)/i, action: 'navigate', type: 'navigation' },
      { pattern: /directions to (.+)/i, action: 'navigate', type: 'navigation' },
      { pattern: /go to (.+)/i, action: 'navigate', type: 'navigation' },
      { pattern: /start (detection|scanning|looking)/i, action: 'startDetection', type: 'control' },
      { pattern: /stop (detection|scanning|looking)/i, action: 'stopDetection', type: 'control' },
      { pattern: /what('s| is) (around|nearby|near me)/i, action: 'listNearby', type: 'information' },
      { pattern: /what (can you see|do you see)/i, action: 'describeScene', type: 'information' },
      { pattern: /where am i/i, action: 'currentLocation', type: 'information' },
      { pattern: /(help|emergency|sos)/i, action: 'emergency', type: 'emergency' },
      { pattern: /save (this|current) route/i, action: 'saveRoute', type: 'memory' },
      { pattern: /remember (this|current) (route|path|location)/i, action: 'saveRoute', type: 'memory' },
    ];
  }
  async startListening(callback) {
    try {
      this.isListening = true;
      await TextToSpeechService.speak('Listening for command');
      if (callback) {
        callback({ status: 'listening' });
      }
      return true;
    } catch (error) {
      console.error('Voice listening error:', error);
      this.isListening = false;
      return false;
    }
  }
  stopListening() {
    this.isListening = false;
    if (this.recognitionTimeout) {
      clearTimeout(this.recognitionTimeout);
      this.recognitionTimeout = null;
    }
  }
  async processCommand(commandText, context = {}) {
    if (!commandText) return null;
    const command = commandText.toLowerCase().trim();
    this.lastCommand = command;
    this.commandHistory.push({ command, timestamp: new Date() });
    if (context.detectedObjects) {
      this.detectedObjects = context.detectedObjects;
    }
    if (context.currentLocation) {
      this.currentLocation = context.currentLocation;
    }
    for (const pattern of this.commandPatterns) {
      const match = command.match(pattern.pattern);
      if (match) {
        const result = await this.executeAction(pattern.action, match, context);
        const token = await AsyncStorage.getItem('authToken');
        if (token) {
          try {
            await fetch(`${this.apiBaseUrl}/api/ai/voice-command`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({
                command,
                action: pattern.action,
                recognized: true,
                confidence: 0.85
              })
            });
          } catch (err) {
            console.error('Failed to log voice command:', err);
          }
        }
        return {
          command,
          action: pattern.action,
          type: pattern.type,
          result,
          timestamp: new Date()
        };
      }
    }
    await TextToSpeechService.speak('Sorry, I did not understand that command');
    return { command, error: 'Command not recognized' };
  }
  async executeAction(action, match, context) {
    switch (action) {
      case 'findObject':
        return await this.findObject(match, context);
      case 'identifyObject':
        return await this.identifyObject(match, context);
      case 'navigate':
        return await this.startNavigation(match, context);
      case 'startDetection':
        return await this.controlDetection(true, context);
      case 'stopDetection':
        return await this.controlDetection(false, context);
      case 'listNearby':
        return await this.listNearbyObjects(context);
      case 'describeScene':
        return await this.describeScene(context);
      case 'currentLocation':
        return await this.announceCurrentLocation(context);
      case 'emergency':
        return await this.triggerEmergency(context);
      case 'saveRoute':
        return await this.saveCurrentRoute(context);
      default:
        return { error: 'Unknown action' };
    }
  }
  async findObject(match, context) {
    const objectName = match[3] || match[2];
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak(`I don't see any objects right now. Please start detection first.`);
      return { found: false, message: 'No objects detected' };
    }
    const foundObjects = this.detectedObjects.filter(obj => 
      obj.class.toLowerCase().includes(objectName.toLowerCase())
    );
    if (foundObjects.length === 0) {
      await TextToSpeechService.speak(`I cannot find ${objectName} nearby`);
      return { found: false, objectName };
    }
    const closest = foundObjects.sort((a, b) => a.distance - b.distance)[0];
    const direction = closest.position.relative;
    const distance = closest.distance.toFixed(1);
    await TextToSpeechService.speak(
      `${objectName} is ${distance} meters ${direction}`
    );
    return {
      found: true,
      objectName,
      object: closest,
      distance: closest.distance,
      direction
    };
  }
  async identifyObject(match, context) {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('I cannot see anything right now. Please ensure the camera is active.');
      return { identified: false };
    }
    const closest = this.detectedObjects.sort((a, b) => a.distance - b.distance)[0];
    if (closest.distance < 1.5) {
      await TextToSpeechService.speak(
        `This is a ${closest.class}, about ${closest.distance.toFixed(1)} meters away`
      );
      return { identified: true, object: closest };
    } else {
      const nearby = this.detectedObjects.filter(obj => obj.distance < 3)
        .slice(0, 3)
        .map(obj => `${obj.class} at ${obj.distance.toFixed(1)} meters ${obj.position.relative}`)
        .join(', ');
      await TextToSpeechService.speak(`I see ${nearby}`);
      return { identified: true, objects: this.detectedObjects.filter(obj => obj.distance < 3) };
    }
  }
  async startNavigation(match, context) {
    const destination = match[1];
    await TextToSpeechService.speak(`Starting navigation to ${destination}`);
    if (context.onNavigate) {
      context.onNavigate(destination);
    }
    return { navigating: true, destination };
  }
  async controlDetection(start, context) {
    if (start) {
      await TextToSpeechService.speak('Starting object detection');
      if (context.onStartDetection) {
        context.onStartDetection();
      }
    } else {
      await TextToSpeechService.speak('Stopping object detection');
      if (context.onStopDetection) {
        context.onStopDetection();
      }
    }
    return { detection: start };
  }
  async listNearbyObjects(context) {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('No objects detected nearby');
      return { objects: [] };
    }
    const nearby = this.detectedObjects
      .filter(obj => obj.distance < 5)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);
    const description = nearby
      .map(obj => `${obj.class} at ${obj.distance.toFixed(1)} meters ${obj.position.relative}`)
      .join(', ');
    await TextToSpeechService.speak(`Nearby objects: ${description}`);
    return { objects: nearby };
  }
  async describeScene(context) {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('I cannot see any objects in the scene');
      return { objects: [] };
    }
    const objectCounts = {};
    this.detectedObjects.forEach(obj => {
      objectCounts[obj.class] = (objectCounts[obj.class] || 0) + 1;
    });
    const description = Object.entries(objectCounts)
      .map(([name, count]) => count > 1 ? `${count} ${name}s` : `1 ${name}`)
      .join(', ');
    await TextToSpeechService.speak(`I can see ${description}`);
    return { objects: this.detectedObjects, summary: objectCounts };
  }
  async announceCurrentLocation(context) {
    try {
      const location = await LocationService.getCurrentLocation();
      await TextToSpeechService.speak(
        `You are at latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}`
      );
      return { location };
    } catch (error) {
      await TextToSpeechService.speak('Unable to get current location');
      return { error: 'Location unavailable' };
    }
  }
  async triggerEmergency(context) {
    await TextToSpeechService.speak('Triggering emergency alert');
    if (context.onEmergency) {
      context.onEmergency();
    }
    return { emergency: true };
  }
  async saveCurrentRoute(context) {
    await TextToSpeechService.speak('Saving current route to memory');
    if (context.onSaveRoute) {
      context.onSaveRoute();
    }
    return { saved: true };
  }
  getCommandHistory() {
    return this.commandHistory;
  }
  clearHistory() {
    this.commandHistory = [];
  }
  async simulateVoiceCommand(text, context) {
    return await this.processCommand(text, context);
  }
}
export default new VoiceCommandService();
