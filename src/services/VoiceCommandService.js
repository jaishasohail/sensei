import TextToSpeechService from './TextToSpeechService';
import ObjectDetectionService from './ObjectDetectionService';
import LocationService from './LocationService';
import MicToneService from './MicToneService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Lazy-load the native speech recognition module.
// requireNativeModule("ExpoSpeechRecognition") throws if the app hasn't been
// rebuilt after installing expo-speech-recognition, so we guard it here to
// prevent a hard crash and degrade gracefully instead.
let ExpoSpeechRecognitionModule = null;
try {
  ExpoSpeechRecognitionModule =
    require('expo-speech-recognition').ExpoSpeechRecognitionModule;
} catch (e) {
  console.warn(
    '[VoiceCommandService] expo-speech-recognition native module not found.\n' +
    'Run:  npx expo prebuild --clean --platform android\n' +
    '      npx expo run:android\n' +
    'Voice commands will be disabled until the app is rebuilt.'
  );
}

// ============================================================================
// FUZZY MATCHING UTILITIES FOR 100% ACCURATE COMMAND RECOGNITION
// ============================================================================

/**
 * Compute Levenshtein distance between two strings.
 * Used for fuzzy matching when user's speech is slightly misrecognized.
 */
function levenshteinDistance(a, b) {
  const matrix = [];
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  for (let i = 0; i <= bLen; i++) matrix[i] = [i];
  for (let j = 0; j <= aLen; j++) matrix[0][j] = j;
  for (let i = 1; i <= bLen; i++) {
    for (let j = 1; j <= aLen; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[bLen][aLen];
}

/**
 * Calculate similarity score (0-1) between two strings.
 */
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Normalize input: lowercase, trim, remove extra spaces, remove punctuation.
 */
function normalizeInput(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Check if input contains all keywords (in any order).
 */
function containsKeywords(input, keywords) {
  const words = input.split(/\s+/);
  return keywords.every(kw => 
    words.some(w => similarity(w, kw) >= 0.8 || w.includes(kw) || kw.includes(w))
  );
}

// ============================================================================
// COMMAND DEFINITIONS WITH MULTIPLE VARIATIONS FOR EACH ACTION
// ============================================================================

const COMMAND_DEFINITIONS = [
  // ==================== APP NAVIGATION COMMANDS ====================
  {
    action: 'openHome',
    type: 'navigation',
    screen: 'Home',
    variations: [
      'open home', 'go to home', 'go home', 'home screen', 'home page',
      'take me home', 'back to home', 'main screen', 'main menu',
      'show home', 'navigate to home', 'open main', 'open dashboard'
    ],
    keywords: [['home'], ['main', 'screen'], ['dashboard']],
    response: 'Opening home screen'
  },
  {
    action: 'openNavigation',
    type: 'navigation',
    screen: 'Navigation',
    variations: [
      'open navigation', 'go to navigation', 'navigation screen', 'start navigation',
      'navigate', 'open maps', 'show map', 'directions', 'open directions',
      'take me to navigation', 'go to maps', 'open gps', 'turn by turn',
      'route planning', 'plan route', 'get directions'
    ],
    keywords: [['navigation'], ['map'], ['direction'], ['gps'], ['route']],
    response: 'Opening navigation screen'
  },
  {
    action: 'openObjectDetection',
    type: 'navigation',
    screen: 'AR',
    variations: [
      'open object detection', 'start object detection', 'object detection',
      'open ar', 'ar screen', 'open camera', 'start camera', 'start scanning',
      'scan objects', 'detect objects', 'open scanner', 'start detection',
      'what is around me', 'see around', 'open ar view', 'augmented reality',
      'ar mode', 'detection mode', 'open detection', 'go to ar',
      'go to detection', 'go to object detection', 'open ar screen'
    ],
    keywords: [['object', 'detection'], ['ar', 'mode'], ['ar', 'screen'], ['scan'], ['camera'], ['detect']],
    response: 'Opening object detection'
  },
  {
    action: 'openSettings',
    type: 'navigation',
    screen: 'Settings',
    variations: [
      'open settings', 'go to settings', 'settings', 'preferences', 'options',
      'configuration', 'config', 'open preferences', 'open options',
      'show settings', 'app settings', 'take me to settings'
    ],
    keywords: [['settings'], ['preference'], ['option'], ['config']],
    response: 'Opening settings'
  },

  // ==================== EMERGENCY COMMANDS ====================
  {
    action: 'callEmergency',
    type: 'emergency',
    variations: [
      'call emergency', 'emergency call', 'call 911', 'dial 911', 'call nine one one',
      'emergency', 'help me', 'i need help', 'call for help', 'sos',
      'emergency number', 'dial emergency', 'call police', 'call ambulance',
      'panic', 'danger', 'im in danger', 'call emergency number',
      'contact emergency', 'emergency contact', 'alert emergency'
    ],
    keywords: [['emergency'], ['911'], ['sos'], ['help'], ['panic'], ['danger']],
    response: 'Activating emergency alert',
    priority: 'critical'
  },
  {
    action: 'contactEmergency',
    type: 'emergency',
    variations: [
      'contact emergency number', 'call my emergency contact', 'contact emergency',
      'call my contact', 'reach my emergency contact', 'notify emergency contact',
      'send emergency alert', 'alert my contacts', 'emergency contacts',
      'call saved contact', 'notify my family', 'call family'
    ],
    keywords: [['contact', 'emergency'], ['notify', 'contact'], ['alert', 'contact']],
    response: 'Contacting your emergency contacts',
    priority: 'critical'
  },

  // ==================== DETECTION CONTROL COMMANDS ====================
  {
    action: 'startDetection',
    type: 'control',
    variations: [
      'start detection', 'start scanning', 'begin scanning', 'enable detection',
      'turn on detection', 'activate detection', 'start looking', 'begin detection',
      'enable scanner', 'start object scanner', 'detect now', 'scan now'
    ],
    keywords: [['start', 'detection'], ['enable', 'detection'], ['begin', 'scan']],
    response: 'Starting object detection'
  },
  {
    action: 'stopDetection',
    type: 'control',
    variations: [
      'stop detection', 'stop scanning', 'disable detection', 'turn off detection',
      'deactivate detection', 'stop looking', 'end detection', 'pause detection',
      'stop scanner', 'disable scanner', 'quit scanning'
    ],
    keywords: [['stop', 'detection'], ['disable', 'detection'], ['end', 'scan']],
    response: 'Stopping object detection'
  },

  // ==================== INFORMATION COMMANDS ====================
  {
    action: 'describeScene',
    type: 'information',
    variations: [
      'what do you see', 'what can you see', 'describe scene', 'describe surroundings',
      'what is around me', 'tell me what you see', 'describe view', 'scan area',
      'look around', 'survey area', 'what objects', 'list objects'
    ],
    keywords: [['what', 'see'], ['describe'], ['around'], ['objects']],
    response: 'Analyzing the scene'
  },
  {
    action: 'listNearby',
    type: 'information',
    variations: [
      'what is nearby', 'nearby objects', 'objects near me', 'whats around',
      'list nearby', 'show nearby', 'near me', 'close objects', 'surrounding objects'
    ],
    keywords: [['nearby'], ['near', 'me'], ['around'], ['close', 'object']],
    response: 'Listing nearby objects'
  },
  {
    action: 'currentLocation',
    type: 'information',
    variations: [
      'where am i', 'my location', 'current location', 'tell me where i am',
      'what is my location', 'gps location', 'show location', 'my position',
      'get location', 'location please'
    ],
    keywords: [['where', 'am'], ['my', 'location'], ['current', 'location']],
    response: 'Getting your current location'
  },
  {
    action: 'identifyObject',
    type: 'information',
    variations: [
      'what is this', 'what is that', 'identify this', 'identify that',
      'what am i looking at', 'tell me about this', 'describe this',
      'what object is this', 'identify object', 'recognize this'
    ],
    keywords: [['what', 'this'], ['identify'], ['recognize']],
    response: 'Identifying object'
  },

  // ==================== NAVIGATION TO PLACES ====================
  {
    action: 'navigateTo',
    type: 'routing',
    variations: [
      'navigate to', 'take me to', 'directions to', 'route to',
      'how do i get to', 'find route to', 'guide me to', 'get me to',
      'start navigation to', 'i want to go to', 'bring me to', 'lead me to',
    ],
    keywords: [['navigate', 'to'], ['direction', 'to'], ['route', 'to'], ['guide', 'to']],
    response: 'Starting navigation',
    extractDestination: true
  },

  // ── "find location X" — opens nav screen with search pre-filled, no auto-start ──
  {
    action: 'findLocation',
    type: 'routing',
    variations: [
      'find location', 'search location', 'find place', 'find address',
      'look up', 'search for place', 'locate place', 'find on map',
      'search map for', 'map search', 'show on map', 'open map for',
      'where is', 'search for', 'find nearby'
    ],
    keywords: [['find', 'location'], ['search', 'place'], ['locate', 'place'], ['where', 'is']],
    response: 'Searching for location',
    extractDestination: true
  },

  // ==================== OBJECT FINDING COMMANDS ====================
  {
    action: 'findObject',
    type: 'location',
    variations: [
      'where is', 'find the', 'locate the', 'find', 'locate', 'where are'
    ],
    keywords: [['where', 'is'], ['find'], ['locate']],
    response: 'Searching for object',
    extractTarget: true
  },

  // ==================== MEMORY COMMANDS ====================
  {
    action: 'saveRoute',
    type: 'memory',
    variations: [
      'save route', 'save this route', 'remember route', 'save path',
      'remember this path', 'bookmark location', 'save location'
    ],
    keywords: [['save', 'route'], ['remember', 'route'], ['bookmark']],
    response: 'Saving current route'
  },

  // ==================== READ TEXT / OCR ====================
  {
    action: 'readText',
    type: 'ocr',
    variations: [
      'read text', 'read this', 'what does it say', 'read sign', 'read label',
      'ocr', 'text recognition', 'scan text', 'read the text', 'what is written'
    ],
    keywords: [['read', 'text'], ['read', 'this'], ['ocr'], ['scan', 'text']],
    response: 'Reading text'
  },

  // ==================== EMOTION DETECTION ====================
  {
    action: 'detectEmotion',
    type: 'information',
    screen: 'EmotionDetection',
    variations: [
      'detect emotion', 'detect face emotion', 'read emotion', 'what emotion',
      'scan emotion', 'emotion detection', 'detect feelings', 'read face',
      'how is this person feeling', 'analyze face', 'face analysis',
      'emotion scan', 'what is the emotion', 'show emotion', 'open emotion detection'
    ],
    keywords: [
      ['detect', 'emotion'], ['emotion'], ['face', 'emotion'],
      ['read', 'face'], ['analyze', 'face']
    ],
    response: 'Opening emotion detection'
  },

  // ==================== HELP ====================
  {
    action: 'showHelp',
    type: 'help',
    variations: [
      'help', 'what can you do', 'commands', 'list commands', 'available commands',
      'how to use', 'instructions', 'tutorial', 'guide', 'what commands'
    ],
    keywords: [['help'], ['command'], ['instruction'], ['guide']],
    response: 'Here are the available commands'
  },

  // ==================== LOCATION SHARING ====================
  {
    action: 'shareLocation',
    type: 'emergency',
    variations: [
      'share location', 'share my location', 'send location', 'send my location',
      'share location with', 'send location to', 'share my location with',
      'share where i am', 'tell contact my location', 'send my coordinates',
    ],
    keywords: [['share', 'location'], ['send', 'location'], ['share', 'where']],
    response: 'Sharing your location',
    extractTarget: true
  },
  {
    action: 'shareLiveLocation',
    type: 'emergency',
    variations: [
      'share live location', 'share live location with', 'send live location',
      'start live location', 'live location', 'share real time location',
      'share realtime location', 'track my location', 'start tracking',
    ],
    keywords: [['live', 'location'], ['real', 'time', 'location'], ['track', 'location']],
    response: 'Starting live location sharing',
    extractTarget: true
  },
  {
    action: 'stopLiveLocation',
    type: 'emergency',
    variations: [
      'stop live location', 'stop location sharing', 'stop sharing location',
      'stop tracking', 'end live location', 'cancel live location',
    ],
    keywords: [['stop', 'live', 'location'], ['stop', 'sharing', 'location'], ['stop', 'tracking']],
    response: 'Stopping live location sharing'
  }
];

// ============================================================================
// VOICE COMMAND SERVICE
// ============================================================================

class VoiceCommandService {
  constructor() {
    this.isListening = false;
    this.recognitionTimeout = null;
    this.lastCommand = null;
    this.commandHistory = [];
    this.detectedObjects = [];
    this.currentLocation = null;
    this.apiBaseUrl = API_BASE_URL;
    
    // Navigation reference - will be set by App.js
    this._navigationRef = null;
    
    // Context callbacks - will be set by screens
    this._callbacks = {
      onStartDetection: null,
      onStopDetection: null,
      onEmergency: null,
      onNavigate: null,
      onSaveRoute: null,
      onReadText: null,
    };
    
    // Minimum confidence threshold for command matching
    this.minConfidence = 0.65;

    // ── Continuous STT state ──────────────────────────────────────────────
    this._continuousListening = false;
    this._wakeWordMode = true;   // true = passive (waiting for "hey sensei")
                                 // false = active (any speech runs a command)
    this._onStateChange = null;
    this._sttListeners = [];
    this._restartTimer = null;
    this._sttActive = false;     // true while an STT session is open on Android
    this._errorBackoffMs = 1000;
    this._maxBackoffMs = 30000;
  }

  // ── Wake word detection ───────────────────────────────────────────────────
  /**
   * Returns true if transcript matches "hey sensei" (with fuzz tolerance).
   * Handles common STT mis-transcriptions like "hey sensai", "hey senpai",
   * "a sensei", "ok sensei", "hi sensei", or bare "sensei".
   */
  _isWakeWord(transcript) {
    const normalized = normalizeInput(transcript);
    const words = normalized.split(/\s+/);

    // Direct phrase similarity
    const wakeVariations = [
      'hey sensei', 'hey sensai', 'hey senpai', 'hey sensi',
      'hey censure', 'hey sense', 'ok sensei', 'okay sensei',
      'hi sensei', 'yo sensei', 'a sensei', 'hey 센세이',
    ];
    for (const v of wakeVariations) {
      if (similarity(normalized, v) >= 0.72) return true;
    }

    // Keyword-level match: any word ≈ "sensei" + any word ≈ "hey"
    const hasSensei = words.some(w => similarity(w, 'sensei') >= 0.78);
    const hasHey    = words.some(w => similarity(w, 'hey') >= 0.75 ||
                                      ['hi', 'ok', 'okay', 'yo'].includes(w));
    if (hasSensei && hasHey) return true;

    // Short utterance that is just "sensei" (some STT drops "hey")
    if (words.length <= 2 && hasSensei) return true;

    return false;
  }

  // ==================== CONFIGURATION ====================

  /**
   * Set the navigation reference for screen navigation.
   */
  setNavigationRef(ref) {
    this._navigationRef = ref;
  }

  /**
   * Register callbacks for various actions.
   */
  setCallbacks(callbacks) {
    this._callbacks = { ...this._callbacks, ...callbacks };
  }

  /**
   * Update detected objects for object-related commands.
   */
  setDetectedObjects(objects) {
    this.detectedObjects = objects || [];
  }

  /**
   * Update current location for location-related commands.
   */
  setCurrentLocation(location) {
    this.currentLocation = location;
  }

  // ==================== COMMAND MATCHING ====================

  /**
   * Find the best matching command for the given input.
   * Uses fuzzy matching with Levenshtein distance for high accuracy.
   * Returns { command, confidence, match } or null if no match.
   */
  findBestMatch(input) {
    const normalized = normalizeInput(input);
    if (!normalized) return null;

    let bestMatch = null;
    let bestConfidence = 0;
    let extractedParam = null;

    for (const cmd of COMMAND_DEFINITIONS) {
      // Check exact variations first (most accurate)
      for (const variation of cmd.variations) {
        const normalizedVariation = normalizeInput(variation);
        
        // Exact match
        if (normalized === normalizedVariation) {
          return { command: cmd, confidence: 1.0, extractedParam: null };
        }
        
        // Check if input starts with variation (for commands with parameters)
        if (normalized.startsWith(normalizedVariation + ' ')) {
          const param = normalized.slice(normalizedVariation.length).trim();
          if (bestConfidence < 0.95) {
            bestMatch = cmd;
            bestConfidence = 0.95;
            extractedParam = param;
          }
        }
        
        // Check if variation is contained in input
        if (normalized.includes(normalizedVariation)) {
          const conf = 0.9 * (normalizedVariation.length / normalized.length);
          if (conf > bestConfidence) {
            bestMatch = cmd;
            bestConfidence = conf;
            // Extract parameter after the variation
            const idx = normalized.indexOf(normalizedVariation);
            extractedParam = normalized.slice(idx + normalizedVariation.length).trim() || null;
          }
        }
        
        // Fuzzy match using Levenshtein distance
        const sim = similarity(normalized, normalizedVariation);
        if (sim > bestConfidence && sim >= this.minConfidence) {
          bestMatch = cmd;
          bestConfidence = sim;
          extractedParam = null;
        }
      }

      // Check keyword combinations (for flexible matching)
      for (const kwSet of cmd.keywords || []) {
        if (containsKeywords(normalized, kwSet)) {
          const conf = 0.85;
          if (conf > bestConfidence) {
            bestMatch = cmd;
            bestConfidence = conf;
            // Try to extract parameter (words not in keywords)
            const inputWords = normalized.split(/\s+/);
            const keywordSet = new Set(kwSet.map(k => k.toLowerCase()));
            const paramWords = inputWords.filter(w => !keywordSet.has(w) && w.length > 2);
            extractedParam = paramWords.join(' ') || null;
          }
        }
      }
    }

    if (bestMatch && bestConfidence >= this.minConfidence) {
      return { command: bestMatch, confidence: bestConfidence, extractedParam };
    }

    return null;
  }

  // ==================== COMMAND PROCESSING ====================

  /**
   * Process a voice command (or text input simulating voice).
   * Returns detailed result with action taken and confidence.
   */
  async processCommand(commandText, context = {}) {
    if (!commandText || typeof commandText !== 'string') {
      return { success: false, error: 'No command provided' };
    }

    const input = commandText.trim();
    this.lastCommand = input;
    this.commandHistory.push({ command: input, timestamp: new Date() });

    // Update context
    if (context.detectedObjects) this.detectedObjects = context.detectedObjects;
    if (context.currentLocation) this.currentLocation = context.currentLocation;
    if (context.callbacks) this._callbacks = { ...this._callbacks, ...context.callbacks };
    if (context.navigationRef) this._navigationRef = context.navigationRef;

    // Find best matching command
    const match = this.findBestMatch(input);

    if (!match) {
      await TextToSpeechService.speak('Sorry, I did not understand that command. Say help for available commands.');
      await this._logCommand(input, null, false, 0);
      return { 
        success: false, 
        command: input, 
        error: 'Command not recognized',
        feedback: 'Command not recognized',
        suggestions: this._getSuggestions(input)
      };
    }

    const { command, confidence, extractedParam } = match;

    // Execute the matched command
    try {
      const result = await this._executeCommand(command, extractedParam, context);
      await this._logCommand(input, command.action, true, confidence);
      
      return {
        success: true,
        command: input,
        action: command.action,
        type: command.type,
        confidence,
        extractedParam,
        result,
        feedback: command.response || `Executing ${command.action}`,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('VoiceCommand execution error:', error);
      await TextToSpeechService.speak('Sorry, I encountered an error executing that command.');
      return {
        success: false,
        command: input,
        action: command.action,
        error: error.message,
        feedback: 'Error executing command'
      };
    }
  }

  /**
   * Execute a matched command.
   */
  async _executeCommand(cmd, param, context) {
    // Speak response first (immediate feedback)
    if (cmd.response) {
      await TextToSpeechService.speak(cmd.response, {}, cmd.priority === 'critical' ? 'critical' : 'normal');
    }

    switch (cmd.action) {
      // ==================== APP NAVIGATION ====================
      case 'openHome':
      case 'openNavigation':
      case 'openObjectDetection':
      case 'openSettings':
        return await this._navigateToScreen(cmd.screen);

      // ==================== EMERGENCY ====================
      case 'callEmergency':
        return await this._triggerEmergency();
      case 'contactEmergency':
        return await this._contactEmergencyContacts();

      // ==================== DETECTION CONTROL ====================
      case 'startDetection':
        return await this._controlDetection(true, context);
      case 'stopDetection':
        return await this._controlDetection(false, context);

      // ==================== INFORMATION ====================
      case 'describeScene':
        return await this._describeScene();
      case 'listNearby':
        return await this._listNearbyObjects();
      case 'currentLocation':
        return await this._announceLocation();
      case 'identifyObject':
        return await this._identifyObject();

      // ==================== NAVIGATION TO PLACES ====================
      case 'navigateTo':
        return await this._startNavigation(param, context, true);   // search + auto-start
      case 'findLocation':
        return await this._startNavigation(param, context, false);  // search only, user picks

      // ==================== OBJECT FINDING ====================
      case 'findObject':
        return await this._findObject(param);

      // ==================== MEMORY ====================
      case 'saveRoute':
        return await this._saveRoute(context);

      // ==================== OCR ====================
      case 'readText':
        return await this._readText(context);

      // ==================== EMOTION DETECTION ====================
      case 'detectEmotion':
        return await this._detectEmotion();

      // ==================== LOCATION SHARING ====================
      case 'shareLocation':
        return await this._shareLocationToContact(param);
      case 'shareLiveLocation':
        return await this._shareLiveLocationToContact(param);
      case 'stopLiveLocation':
        return await this._stopLiveLocation();

      // ==================== HELP ====================
      case 'showHelp':
        return await this._showHelp();

      default:
        return { executed: false, reason: 'Unknown action' };
    }
  }

  // ==================== ACTION IMPLEMENTATIONS ====================

  async _navigateToScreen(screenName, params = null) {
    if (!this._navigationRef || !this._navigationRef.current) {
      console.warn('VoiceCommand: Navigation ref not set');
      return { navigated: false, reason: 'Navigation not available' };
    }

    try {
      this._navigationRef.current.navigate(screenName, params ?? undefined);
      return { navigated: true, screen: screenName };
    } catch (error) {
      console.error('VoiceCommand: Navigation error:', error);
      await TextToSpeechService.speak(`Unable to open ${screenName}`);
      return { navigated: false, error: error.message };
    }
  }

  async _triggerEmergency() {
    // Dynamic import to avoid circular dependency
    const EmergencyService = require('./EmergencyService').default;
    await EmergencyService.initialize();
    const result = await EmergencyService.triggerEmergency();
    return { emergency: true, result };
  }

  async _contactEmergencyContacts() {
    const EmergencyService = require('./EmergencyService').default;
    await EmergencyService.initialize();

    if (!EmergencyService.emergencyContacts || EmergencyService.emergencyContacts.length === 0) {
      await TextToSpeechService.speak('No emergency contacts saved. Please add contacts in settings.');
      return { contacted: false, reason: 'No contacts' };
    }

    const count = EmergencyService.emergencyContacts.length;
    await TextToSpeechService.speak(
      `Contacting ${count} emergency contact${count !== 1 ? 's' : ''}.`
    );
    const location = await LocationService.getCurrentLocation();
    await EmergencyService.shareLocationToAllContacts(location, true);
    return { contacted: true, count };
  }

  async _controlDetection(start, context) {
    if (start) {
      if (this._callbacks.onStartDetection) {
        this._callbacks.onStartDetection();
      }
      // Also navigate to AR screen
      await this._navigateToScreen('AR');
    } else {
      if (this._callbacks.onStopDetection) {
        this._callbacks.onStopDetection();
      }
    }
    return { detection: start };
  }

  async _describeScene() {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('I cannot see any objects. Please ensure object detection is running.');
      return { objects: [], described: false };
    }

    const counts = {};
    this.detectedObjects.forEach(obj => {
      counts[obj.class] = (counts[obj.class] || 0) + 1;
    });

    const description = Object.entries(counts)
      .map(([name, count]) => count > 1 ? `${count} ${name}s` : `a ${name}`)
      .join(', ');

    await TextToSpeechService.speak(`I can see ${description}`);
    return { objects: this.detectedObjects, summary: counts, described: true };
  }

  async _listNearbyObjects() {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('No objects detected nearby');
      return { objects: [] };
    }

    const nearby = this.detectedObjects
      .filter(obj => obj.distance < 5)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    if (nearby.length === 0) {
      await TextToSpeechService.speak('No objects within 5 meters');
      return { objects: [] };
    }

    const description = nearby
      .map(obj => `${obj.class} at ${obj.distance.toFixed(1)} meters ${obj.position?.relative || ''}`)
      .join(', ');

    await TextToSpeechService.speak(`Nearby: ${description}`);
    return { objects: nearby };
  }

  async _announceLocation() {
    try {
      const location = await LocationService.getCurrentLocation();
      await TextToSpeechService.speak(
        `Your location is latitude ${location.latitude.toFixed(4)}, longitude ${location.longitude.toFixed(4)}`
      );
      return { location, announced: true };
    } catch (error) {
      await TextToSpeechService.speak('Unable to get your current location');
      return { location: null, error: error.message };
    }
  }

  async _identifyObject() {
    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('No objects detected. Please ensure the camera is active.');
      return { identified: false };
    }

    const closest = this.detectedObjects.sort((a, b) => a.distance - b.distance)[0];
    await TextToSpeechService.speak(
      `The closest object is a ${closest.class}, approximately ${closest.distance.toFixed(1)} meters ${closest.position?.relative || 'away'}`
    );
    return { identified: true, object: closest };
  }

  async _startNavigation(destination, context, autoNavigate = true) {
    if (!destination) {
      await TextToSpeechService.speak(
        autoNavigate ? 'Please specify a destination' : 'Where would you like to search?'
      );
      return { navigating: false, reason: 'No destination' };
    }

    if (autoNavigate) {
      await TextToSpeechService.speak(`Navigating to ${destination}`);
    } else {
      await TextToSpeechService.speak(`Searching for ${destination}`);
    }

    if (this._callbacks.onNavigate) {
      this._callbacks.onNavigate(destination);
    }

    // Navigate to Navigation screen, passing destination + mode flag
    await this._navigateToScreen('Navigation', { destination, autoNavigate });

    return { navigating: autoNavigate, destination };
  }

  async _findObject(objectName) {
    if (!objectName) {
      await TextToSpeechService.speak('Please specify what object to find');
      return { found: false };
    }

    if (!this.detectedObjects || this.detectedObjects.length === 0) {
      await TextToSpeechService.speak('No objects detected. Please start object detection first.');
      return { found: false, reason: 'No objects detected' };
    }

    const matches = this.detectedObjects.filter(obj =>
      obj.class.toLowerCase().includes(objectName.toLowerCase()) ||
      similarity(obj.class.toLowerCase(), objectName.toLowerCase()) >= 0.7
    );

    if (matches.length === 0) {
      await TextToSpeechService.speak(`I cannot find ${objectName} nearby`);
      return { found: false, objectName };
    }

    const closest = matches.sort((a, b) => a.distance - b.distance)[0];
    await TextToSpeechService.speak(
      `${objectName} found ${closest.distance.toFixed(1)} meters ${closest.position?.relative || 'away'}`
    );

    return { found: true, objectName, object: closest, count: matches.length };
  }

  async _saveRoute(context) {
    if (this._callbacks.onSaveRoute) {
      this._callbacks.onSaveRoute();
    }
    return { saved: true };
  }

  async _readText(context) {
    if (this._callbacks.onReadText) {
      this._callbacks.onReadText();
    }
    return { reading: true };
  }

  async _detectEmotion() {
    // Navigate to the EmotionDetection screen (registered in the root Stack).
    // If navigation is unavailable, fall back to a spoken error message.
    const result = await this._navigateToScreen('EmotionDetection');
    if (!result.navigated) {
      await TextToSpeechService.speak('Unable to open emotion detection');
    }
    return result;
  }

  async _shareLocationToContact(param) {
    const EmergencyService = require('./EmergencyService').default;
    await EmergencyService.initialize();
    try {
      const location = await LocationService.getCurrentLocation();
      if (param) {
        const contact = EmergencyService.findContactByName(param);
        if (!contact) {
          await TextToSpeechService.speak(
            `Contact ${param} not found. Add them in emergency contacts settings.`
          );
          return { shared: false, reason: 'Contact not found' };
        }
        await EmergencyService.shareLocationToContact(contact, location, false);
        await TextToSpeechService.speak(`Location shared with ${contact.name}.`);
        return { shared: true, contact: contact.name };
      } else {
        if (EmergencyService.emergencyContacts.length === 0) {
          await TextToSpeechService.speak(
            'No emergency contacts saved. Please add contacts in settings first.'
          );
          return { shared: false, reason: 'No contacts' };
        }
        await EmergencyService.shareLocationToAllContacts(location, false);
        await TextToSpeechService.speak('Location shared with all emergency contacts.');
        return { shared: true };
      }
    } catch (err) {
      console.error('VoiceCommand: shareLocation error:', err);
      await TextToSpeechService.speak('Failed to share location. Please try again.');
      return { shared: false, error: err.message };
    }
  }

  async _shareLiveLocationToContact(param) {
    const EmergencyService = require('./EmergencyService').default;
    await EmergencyService.initialize();
    try {
      const result = await EmergencyService.startLiveLocationSharing(param || null);
      if (result.started) {
        await TextToSpeechService.speak(
          `Live location sharing started with ${result.contact}.`
        );
      }
      return result;
    } catch (err) {
      console.error('VoiceCommand: shareLiveLocation error:', err);
      await TextToSpeechService.speak('Failed to start live location sharing.');
      return { started: false, error: err.message };
    }
  }

  async _stopLiveLocation() {
    const EmergencyService = require('./EmergencyService').default;
    EmergencyService.stopLiveLocationSharing();
    // TTS already spoken via EmergencyService; add confirmation here as well.
    return { stopped: true };
  }

  async _showHelp() {
    const helpText = `Available commands:
      Open home, Open navigation, Open object detection, Open settings.
      Start detection, Stop detection.
      Call emergency to call nine one one immediately.
      Contact emergency to share location with all saved contacts.
      Share location, or Share location with contact name.
      Share live location, or Share live location with contact name. Stop live location.
      What do you see, Where am I, Navigate to destination.
      Detect emotion, to scan a face and identify feelings.
      Say hey sensei before any command.`;

    await TextToSpeechService.speak(helpText);
    
    return {
      commands: COMMAND_DEFINITIONS.map(cmd => ({
        action: cmd.action,
        examples: cmd.variations.slice(0, 3)
      }))
    };
  }

  // ==================== HELPERS ====================

  _getSuggestions(input) {
    const normalized = normalizeInput(input);
    const suggestions = [];
    
    for (const cmd of COMMAND_DEFINITIONS) {
      for (const variation of cmd.variations) {
        const sim = similarity(normalized, normalizeInput(variation));
        if (sim >= 0.4 && sim < this.minConfidence) {
          suggestions.push({
            suggestion: variation,
            similarity: sim,
            action: cmd.action
          });
        }
      }
    }
    
    return suggestions
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .map(s => s.suggestion);
  }

  async _logCommand(command, action, recognized, confidence) {
    try {
      const token = await AsyncStorage.getItem('authToken');
      if (!token) return;

      await fetch(`${this.apiBaseUrl}/api/ai/voice-command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          command,
          action: action || 'unknown',
          recognized,
          confidence
        })
      });
    } catch (err) {
      console.error('Failed to log voice command:', err);
    }
  }

  // ==================== ALWAYS-ON STT (continuous listening) ====================

  /**
   * Start always-on speech recognition.
   * Requests permissions, sets up listeners, and auto-restarts after each utterance.
   * @param {function} onStateChange  - called with ('idle'|'listening'|'processing'|'error', transcript?)
   */
  /**
   * Start always-on speech recognition.
   * Phase 1 — WAKE: passively listens for "hey sensei".
   * Phase 2 — ACTIVE: every utterance is executed as a command immediately.
   * @param {function} onStateChange  called with ('wake'|'listening'|'processing'|'error', transcript?)
   */
  async startContinuousListening(onStateChange) {
    if (this._continuousListening) return;

    if (!ExpoSpeechRecognitionModule) {
      console.warn('VoiceCommandService: native speech recognition module unavailable — rebuild required.');
      if (onStateChange) onStateChange('error');
      return;
    }

    this._continuousListening = true;
    this._wakeWordMode = true;        // always begin in passive wake-word phase
    this._onStateChange = onStateChange || null;

    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) {
      console.warn('VoiceCommandService: speech recognition permission denied');
      this._continuousListening = false;
      if (this._onStateChange) this._onStateChange('error');
      return;
    }

    this._setupSTTListeners();
    this._startSTT();
  }

  /**
   * Stop always-on speech recognition and reset to wake-word mode.
   */
  stopContinuousListening() {
    this._continuousListening = false;
    this._wakeWordMode = true;        // reset for next startContinuousListening call
    this._sttActive = false;
    this._onStateChange = null;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._removeSTTListeners();
    if (ExpoSpeechRecognitionModule) {
      try { ExpoSpeechRecognitionModule.abort(); } catch (_) {}
    }
    // Tone: signal that SENSEI has stopped listening
    MicToneService.playOff();
  }

  _setupSTTListeners() {
    if (!ExpoSpeechRecognitionModule) return;
    this._removeSTTListeners();

    // ── start: mark session open + update UI state ────────────────────────
    const startSub = ExpoSpeechRecognitionModule.addListener('start', () => {
      this._sttActive = true;
      if (this._onStateChange) {
        this._onStateChange(this._wakeWordMode ? 'wake' : 'listening');
      }
    });

    // ── result: two-mode handler ──────────────────────────────────────────
    const resultSub = ExpoSpeechRecognitionModule.addListener('result', async (event) => {
      if (!event.isFinal) return;
      const transcript = event.results?.[0]?.transcript?.trim();
      if (!transcript) return;

      this._errorBackoffMs = 1000; // reset backoff on any real speech

      if (this._wakeWordMode) {
        // ── WAKE WORD MODE: only "hey sensei" unlocks the mic ────────────
        if (this._isWakeWord(transcript)) {
          this._wakeWordMode = false;
          if (this._onStateChange) this._onStateChange('listening');
          // Tone: mic is now open for a command
          MicToneService.playOn();
          try {
            await TextToSpeechService.speak("I'm listening");
          } catch (_) {}
          // Reopen mic for the first real command after TTS finishes (~1.5 s)
          if (this._continuousListening) this._scheduleRestart(1500);
        } else {
          // Not the wake word — restart wake listener immediately
          if (this._continuousListening) this._scheduleRestart(300);
        }

      } else {
        // ── ACTIVE COMMAND MODE: every utterance is a command ────────────
        if (this._onStateChange) this._onStateChange('processing', transcript);
        try {
          await this.processCommand(transcript);
        } catch (err) {
          console.error('VoiceCommandService: processCommand error:', err);
        }
        // Return to wake-word mode after each command so user must say
        // "hey sensei" again for the next one (intentional design).
        this._wakeWordMode = true;
        // Tone: mic closed / back to passive listening
        MicToneService.playOff();
        if (this._onStateChange) this._onStateChange('wake');
        // processCommand awaits TTS, so by this point speech has already
        // finished — 1 s buffer is sufficient before reopening the mic.
        if (this._continuousListening) this._scheduleRestart(1000);
      }
    });

    // ── error: silent for all expected Android STT error codes ───────────
    const errorSub = ExpoSpeechRecognitionModule.addListener('error', (event) => {
      // ROOT-CAUSE FIX: event.error can be undefined, null, or '' —
      // none of these are real errors; treat them the same as no-speech.
      const errCode = event?.error ?? '';
      const silentCodes = new Set([
        'no-speech', 'audio-capture', 'aborted', 'speech-timeout', ''
      ]);
      if (silentCodes.has(errCode)) {
        // Expected — just restart quietly after a short pause
        if (this._continuousListening) this._scheduleRestart(600);
        return;
      }
      // Only truly unexpected errors reach here
      console.warn('VoiceCommandService STT error:', errCode, event?.message ?? '');
      if (this._onStateChange) this._onStateChange('error');
      if (this._continuousListening) {
        this._scheduleRestart(this._errorBackoffMs);
        this._errorBackoffMs = Math.min(this._errorBackoffMs * 2, this._maxBackoffMs);
      }
    });

    // ── end: mark session closed; safety-net restart if nothing else did ─
    const endSub = ExpoSpeechRecognitionModule.addListener('end', () => {
      this._sttActive = false;  // session is gone — safe to start a new one
      if (this._continuousListening && !this._restartTimer) {
        this._scheduleRestart(400);
      }
    });

    this._sttListeners = [startSub, resultSub, errorSub, endSub];
  }

  _removeSTTListeners() {
    this._sttListeners.forEach(sub => { try { sub.remove(); } catch (_) {} });
    this._sttListeners = [];
  }

  _startSTT() {
    if (!this._continuousListening) return;
    if (!ExpoSpeechRecognitionModule) return;

    // ROOT-CAUSE FIX: never start a new session while one is already open.
    // This was the main source of double-start errors when continuous:true
    // kept the session alive while our restart timer also fired start().
    if (this._sttActive) return;

    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: false,
        maxAlternatives: 1,
        // ROOT-CAUSE FIX: continuous:false — our manual restart loop IS the
        // continuous mechanism.  continuous:true kept the Android session
        // open between utterances, so every manual restart fired start() on
        // an already-running session → error storm → commands stop working.
        continuous: false,
      });
    } catch (err) {
      console.warn('VoiceCommandService: STT start error:', err?.message ?? err);
      this._sttActive = false;
      if (this._continuousListening) this._scheduleRestart(this._errorBackoffMs);
    }
  }

  _scheduleRestart(delayMs) {
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._continuousListening) this._startSTT();
    }, delayMs);
  }

  // ==================== PUBLIC API ====================

  /** Legacy stub kept for compatibility — real STT is startContinuousListening(). */
  async startListening(callback) {
    this.isListening = true;
    if (callback) callback({ status: 'listening' });
    return true;
  }

  stopListening() {
    this.isListening = false;
    if (this.recognitionTimeout) {
      clearTimeout(this.recognitionTimeout);
      this.recognitionTimeout = null;
    }
  }

  getCommandHistory() {
    return this.commandHistory;
  }

  clearHistory() {
    this.commandHistory = [];
  }

  /**
   * Get all available commands (for UI display).
   */
  getAvailableCommands() {
    return COMMAND_DEFINITIONS.map(cmd => ({
      action: cmd.action,
      type: cmd.type,
      examples: cmd.variations.slice(0, 5),
      response: cmd.response
    }));
  }

  /**
   * Simulate a voice command (for testing).
   */
  async simulateVoiceCommand(text, context = {}) {
    return await this.processCommand(text, context);
  }
}

export default new VoiceCommandService();
