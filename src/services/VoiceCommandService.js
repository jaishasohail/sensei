import TextToSpeechService from './TextToSpeechService';
import ObjectDetectionService from './ObjectDetectionService';
import LocationService from './LocationService';
import MicToneService from './MicToneService';
import { API_BASE_URL } from '../constants/config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PinnedLocationService from './PinnedLocationService';
import IndoorNavigationService from './IndoorNavigationService';

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
      // ── "me/us" variants must come BEFORE the bare verb forms ─────────────
      // "navigate me to X" — the most common phrasing; listed first so
      // findBestMatch's startsWith path extracts "X" cleanly without "me".
      'navigate me to', 'navigate us to',
      'take me to', 'take us to',
      'guide me to', 'guide us to',
      'get me to', 'get us to',
      'bring me to', 'lead me to',
      // ── bare verb forms ──────────────────────────────────────────────────
      'navigate to', 'directions to', 'route to',
      'how do i get to', 'find route to',
      'start navigation to', 'i want to go to',
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
  },

  // ==================== PINNED LOCATIONS ====================
  {
    action: 'pinLocation',
    type: 'memory',
    variations: [
      'pin my location', 'pin this location', 'save this location', 'save my location',
      'mark this location', 'mark my location', 'bookmark this place', 'save this place',
      'remember this place', 'remember this location', 'drop a pin', 'drop pin here',
      'add a pin', 'tag this location', 'label this location',
    ],
    keywords: [['pin', 'location'], ['save', 'location'], ['mark', 'location'], ['drop', 'pin']],
    response: 'Pinning your location',
  },
  {
    action: 'listPins',
    type: 'memory',
    variations: [
      'show my pins', 'list my pins', 'show saved locations', 'what did i pin',
      'show my saved places', 'list saved places', 'my pinned locations',
    ],
    keywords: [['show', 'pins'], ['list', 'pins'], ['saved', 'locations']],
    response: 'Here are your saved locations',
  },
  {
    action: 'deletePin',
    type: 'memory',
    variations: [
      'delete pin', 'remove pin', 'delete saved location', 'remove saved location',
      'forget this place', 'unpin location', 'delete this pin',
    ],
    keywords: [['delete', 'pin'], ['remove', 'pin'], ['unpin']],
    response: 'Deleting pin',
    extractDestination: true,
  },

  // ==================== INDOOR NAVIGATION ====================
  {
    action: 'startMappingBuilding',
    type: 'indoor',
    variations: [
      'start mapping building', 'map this building', 'start indoor mapping',
      'begin mapping', 'create building map', 'map building', 'start building map',
      'set up indoor navigation', 'configure building', 'start floor plan',
    ],
    keywords: [['start', 'mapping'], ['map', 'building'], ['indoor', 'mapping'], ['floor', 'plan']],
    response: 'Starting building map',
    extractDestination: true,
  },
  {
    action: 'markLandmark',
    type: 'indoor',
    variations: [
      'mark staircase', 'mark door', 'mark elevator', 'mark room',
      'mark this as', 'mark entrance', 'mark exit', 'mark corridor',
      'add landmark', 'mark landmark', 'mark toilet', 'mark bathroom',
      'mark kitchen', 'mark office', 'tag this as',
    ],
    keywords: [['mark'], ['landmark'], ['tag', 'this']],
    response: 'Marking landmark',
    extractDestination: true,
  },
  {
    action: 'finishMapping',
    type: 'indoor',
    variations: [
      'finish mapping', 'done mapping', 'stop mapping', 'save building map',
      'complete building map', 'finish floor plan', 'end mapping',
    ],
    keywords: [['finish', 'mapping'], ['done', 'mapping'], ['save', 'building']],
    response: 'Saving building map',
  },
  {
    action: 'navigateIndoor',
    type: 'indoor',
    variations: [
      'navigate inside to', 'go inside to', 'find inside', 'take me inside to',
      'indoor navigate to', 'walk me to', 'guide me inside to',
    ],
    keywords: [['navigate', 'inside'], ['indoor', 'navigate'], ['walk', 'me', 'to']],
    response: 'Starting indoor navigation',
    extractDestination: true,
  },
  {
    action: 'enterBuilding',
    type: 'indoor',
    variations: [
      'enter building', 'i am inside', 'i entered the building', 'indoor mode',
      'switch to indoor', 'i am in the building',
    ],
    keywords: [['enter', 'building'], ['indoor', 'mode'], ['inside', 'building']],
    response: 'Switching to indoor navigation mode',
  },
  {
    action: 'exitBuilding',
    type: 'indoor',
    variations: [
      'exit building', 'i am outside', 'outdoor mode', 'leave building',
      'switch to outdoor', 'exit indoor mode',
    ],
    keywords: [['exit', 'building'], ['outdoor', 'mode'], ['leave', 'building']],
    response: 'Switching to outdoor navigation',
  },
  {
    action: 'iAmAt',
    type: 'indoor',
    variations: [
      'i am at', 'i am near', 'i am standing at', 'my position is', 'i am by the',
    ],
    keywords: [['i', 'am', 'at'], ['position', 'is']],
    response: 'Got it',
    extractDestination: true,
  },
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

    // ── Direct navigation callback ─────────────────────────────────────────
    // NavigationScreen registers this on mount.  Calling it triggers
    // triggerSearch() directly inside the screen, completely bypassing
    // React Navigation params (which are ignored when the tab is already
    // focused — the tab router treats a navigate() to the active tab as a
    // "tab press", not a params update).
    this._navDirectCb = null;

    // ── Multi-turn conversation state ────────────────────────────────────────
    // When the system asks the user a follow-up question (e.g. "What do you
    // want to save this location as?"), the NEXT speech input is treated as
    // the answer, not a new command.  The wake-word gate is also bypassed so
    // the user doesn't have to say "Hey Sensei" twice.
    //
    // Shape: { type: string, data: any } | null
    //   'awaitPinName'      → data: { latitude, longitude }
    //   'awaitBuildingName' → data: { latitude, longitude }
    //   'awaitLandmarkName' → data: { nodeType, latitude, longitude }
    this._pendingQuestion = null;

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
   * Register a direct navigation callback from NavigationScreen.
   *
   * When set, _startNavigation() calls this function directly with
   * (destination, autoNavigate) instead of relying on React Navigation
   * route.params.  This is required because React Navigation's bottom tab
   * router silently ignores params when navigate() targets an already-focused
   * tab — it treats the call as a "tab press" (reset) rather than a params
   * update, so route.params never changes and no useEffect fires.
   *
   * NavigationScreen calls setNavCallback on mount and passes null on unmount.
   */
  setNavCallback(fn) {
    this._navDirectCb = typeof fn === 'function' ? fn : null;
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

      // ==================== PINNED LOCATIONS ====================
      case 'pinLocation':
        return await this._pinLocation();
      case 'listPins':
        return await this._listPins();
      case 'deletePin':
        return await this._deletePin(param);

      // ==================== INDOOR NAVIGATION ====================
      case 'startMappingBuilding':
        return await this._startMappingBuilding(param);
      case 'markLandmark':
        return await this._markLandmark(param);
      case 'finishMapping':
        return await this._finishMapping();
      case 'navigateIndoor':
        return await this._navigateIndoor(param);
      case 'enterBuilding':
        return await this._enterBuilding();
      case 'exitBuilding':
        return await this._exitBuilding();
      case 'iAmAt':
        return await this._selfLocalise(param);

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
    // ── Sanitize extracted destination ─────────────────────────────────────
    // When the keyword-match path in findBestMatch() fires (e.g. for a phrase
    // like "navigate me to X" that doesn't exactly match a variation), the
    // non-keyword words are joined as the param.  Personal pronouns ("me",
    // "us") are never part of a place name and must be stripped so the
    // geocoder receives a clean query like "COMSATS university lahore"
    // instead of "me COMSATS university lahore".
    if (destination) {
      destination = destination.replace(/^(me|us)\s+/i, '').trim();
    }

    if (!destination) {
      await TextToSpeechService.speak(
        autoNavigate ? 'Please specify a destination' : 'Where would you like to search?'
      );
      return { navigating: false, reason: 'No destination' };
    }

    // ── Check pinned locations FIRST ─────────────────────────────────────────
    // If the user says "take me to the washroom" and "washroom" is a saved
    // pin, navigate directly to the stored coordinates without any geocoding.
    // This works both for outdoor pins and indoor landmarks.
    try {
      await PinnedLocationService.initialize();
      const pin = await PinnedLocationService.findPin(destination);
      if (pin) {
        console.log(`VoiceCommandService: found pin "${pin.displayName}" for query "${destination}"`);
        await PinnedLocationService.recordUsage(pin.id);

        // If the pin is an indoor landmark, use indoor navigation
        if (pin.buildingId) {
          await IndoorNavigationService.initialize();
          await IndoorNavigationService.setActiveBuilding(pin.buildingId, pin.floor ?? 0);
          const result = await IndoorNavigationService.navigateTo(pin.displayName);
          if (result?.steps?.length > 0) {
            await TextToSpeechService.speak(
              `Indoor navigation to ${pin.displayName}. ${result.steps[0].instruction}`
            );
            await this._navigateToScreen('Navigation', {});
            if (this._navDirectCb) {
              this._navDirectCb(`[INDOOR] ${pin.displayName}`, false, {
                indoorSteps: result.steps,
                indoorDest:  result.destination,
              });
            }
            return { navigating: true, pin, indoor: true };
          }
        }

        // Outdoor pin — pass coordinates directly to NavigationScreen
        await TextToSpeechService.speak(`Navigating to your saved location: ${pin.displayName}`);
        await this._navigateToScreen('Navigation', {});
        if (this._navDirectCb) {
          this._navDirectCb(pin.displayName, true, {
            pinnedDest: {
              name:      pin.displayName,
              latitude:  pin.latitude,
              longitude: pin.longitude,
              address:   pin.address ?? '',
            },
          });
        } else {
          setTimeout(() => {
            this._navigationRef?.current?.navigate('Navigation', {
              destination: pin.displayName,
              autoNavigate: true,
              pinnedLat: pin.latitude,
              pinnedLng: pin.longitude,
            });
          }, 200);
        }
        return { navigating: true, pin };
      }
    } catch (pinErr) {
      console.warn('VoiceCommandService: pinned location lookup failed:', pinErr.message);
    }

    // ── No pin found — fall back to geocoder search ───────────────────────────
    if (autoNavigate) {
      await TextToSpeechService.speak(`Navigating to ${destination}`);
    } else {
      await TextToSpeechService.speak(`Searching for ${destination}`);
    }

    if (this._callbacks.onNavigate) {
      this._callbacks.onNavigate(destination);
    }

    // ── Switch to the Navigation tab ──────────────────────────────────────
    await this._navigateToScreen('Navigation', {});

    // ── Trigger search directly ───────────────────────────────────────────
    if (this._navDirectCb) {
      this._navDirectCb(destination, autoNavigate);
    } else {
      setTimeout(() => {
        try {
          this._navigationRef?.current?.navigate('Navigation', {
            destination,
            autoNavigate,
          });
        } catch (_) {}
      }, 200);
    }

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

  // ── Pinned Locations ───────────────────────────────────────────────────────

  /**
   * Step 1 of 2 for pinning a location.
   * Gets GPS, then asks the user what to name the pin.
   * Sets _pendingQuestion so the next speech is captured as the pin name.
   */
  async _pinLocation() {
    try {
      const loc = await LocationService.getCurrentLocation();
      this._pendingQuestion = {
        type: 'awaitPinName',
        data: { latitude: loc.latitude, longitude: loc.longitude },
      };
      await TextToSpeechService.speak('What do you want to save this location as?', {}, 'normal');
      return { waiting: true };
    } catch (e) {
      await TextToSpeechService.speak('Could not get your location. Make sure location is enabled.');
      return { error: e.message };
    }
  }

  async _listPins() {
    await PinnedLocationService.initialize();
    const pins = await PinnedLocationService.getAllPins();
    if (pins.length === 0) {
      await TextToSpeechService.speak('You have no saved locations yet. Say pin my location to save one.');
      return { pins: [] };
    }
    const names = pins.slice(0, 5).map(p => p.displayName).join(', ');
    await TextToSpeechService.speak(`You have ${pins.length} saved location${pins.length > 1 ? 's' : ''}: ${names}`);
    return { pins };
  }

  async _deletePin(name) {
    if (!name) {
      await TextToSpeechService.speak('Which saved location should I delete?');
      return { deleted: false };
    }
    const deleted = await PinnedLocationService.deletePin(name);
    if (deleted) {
      await TextToSpeechService.speak(`Deleted saved location: ${name}`);
    } else {
      await TextToSpeechService.speak(`Could not find a saved location named ${name}`);
    }
    return { deleted };
  }

  // ── Indoor Navigation ──────────────────────────────────────────────────────

  /**
   * Begin mapping a new building.
   * If a name was extracted from the voice command, use it.
   * Otherwise ask for the building name.
   */
  async _startMappingBuilding(name) {
    try {
      const loc = await LocationService.getCurrentLocation();
      if (!name || name.length < 2) {
        this._pendingQuestion = {
          type: 'awaitBuildingName',
          data: { latitude: loc.latitude, longitude: loc.longitude },
        };
        await TextToSpeechService.speak('What is the name of this building?');
        return { waiting: true };
      }
      await IndoorNavigationService.initialize();
      const { building, entranceNode } = await IndoorNavigationService.startMapping(name, loc);
      await TextToSpeechService.speak(
        `Started mapping ${name}. Walk to each landmark and say mark, followed by its type and name. Say finish mapping when done.`
      );
      return { building };
    } catch (e) {
      await TextToSpeechService.speak('Could not start mapping. Make sure location is enabled.');
      return { error: e.message };
    }
  }

  /**
   * Mark a landmark at the current GPS position during mapping.
   * Parses "mark [type] [name]" or "mark this as [name]" from the extracted param.
   *
   * Examples:
   *   "mark staircase ground floor stairs"  → type=staircase, name="ground floor stairs"
   *   "mark door main entrance"             → type=door,      name="main entrance"
   *   "mark room washroom"                  → type=room,      name="washroom"
   */
  async _markLandmark(param) {
    if (!param) {
      this._pendingQuestion = {
        type: 'awaitLandmarkName',
        data: { nodeType: 'custom' },
      };
      await TextToSpeechService.speak('What type and name should I mark here?');
      return { waiting: true };
    }

    const { nodeType, landmarkName } = this._parseLandmarkParam(param);

    try {
      const loc = await LocationService.getCurrentLocation();
      await IndoorNavigationService.initialize();
      const node = await IndoorNavigationService.markLandmark(landmarkName, nodeType, loc);
      await TextToSpeechService.speak(`Marked ${nodeType}: ${landmarkName}`);
      return { node };
    } catch (e) {
      await TextToSpeechService.speak('Could not mark landmark. ' + (e.message ?? ''));
      return { error: e.message };
    }
  }

  /**
   * Parse "staircase main stairs" → { nodeType: 'staircase', landmarkName: 'main stairs' }
   */
  _parseLandmarkParam(param) {
    const { NODE_TYPES } = require('./IndoorNavigationService');
    const p = (param ?? '').toLowerCase().trim();
    const typeAliases = {
      staircase: NODE_TYPES.STAIRCASE, stairs: NODE_TYPES.STAIRCASE, stairway: NODE_TYPES.STAIRCASE,
      elevator: NODE_TYPES.ELEVATOR,  lift: NODE_TYPES.ELEVATOR,
      door: NODE_TYPES.DOOR,          entrance: NODE_TYPES.ENTRANCE, exit: NODE_TYPES.ENTRANCE,
      room: NODE_TYPES.ROOM,          office: NODE_TYPES.OFFICE,
      toilet: NODE_TYPES.TOILET,      bathroom: NODE_TYPES.TOILET, washroom: NODE_TYPES.TOILET,
      kitchen: NODE_TYPES.KITCHEN,    cafeteria: NODE_TYPES.KITCHEN,
      corridor: NODE_TYPES.CORRIDOR,  hallway: NODE_TYPES.CORRIDOR, hall: NODE_TYPES.CORRIDOR,
    };

    const words = p.split(/\s+/);
    let nodeType = NODE_TYPES.CUSTOM;
    let nameStart = 0;

    for (let i = 0; i < Math.min(words.length, 2); i++) {
      if (typeAliases[words[i]]) {
        nodeType  = typeAliases[words[i]];
        nameStart = i + 1;
        break;
      }
    }

    // Strip leading "as" or "a" (e.g. "mark this as washroom" → "washroom")
    while (nameStart < words.length && (words[nameStart] === 'as' || words[nameStart] === 'a')) {
      nameStart++;
    }

    const landmarkName = words.slice(nameStart).join(' ').trim() || param.trim();
    return { nodeType, landmarkName };
  }

  async _finishMapping() {
    await IndoorNavigationService.initialize();
    const building = await IndoorNavigationService.finishMapping();
    if (building) {
      const nodeCount = Object.values(building.floors)
        .reduce((sum, f) => sum + Object.keys(f.nodes).length, 0);
      await TextToSpeechService.speak(
        `Building map saved for ${building.name} with ${nodeCount} landmark${nodeCount !== 1 ? 's' : ''}.`
      );
    } else {
      await TextToSpeechService.speak('No active mapping session to finish.');
    }
    return { finished: true };
  }

  async _navigateIndoor(destination) {
    if (!destination) {
      await TextToSpeechService.speak('Where would you like to go inside the building?');
      return { navigating: false };
    }
    await IndoorNavigationService.initialize();

    if (!IndoorNavigationService.activeBuilding) {
      // Try to auto-detect a nearby building
      try {
        const loc = await LocationService.getCurrentLocation();
        const nearby = await IndoorNavigationService.detectNearbyBuilding(loc.latitude, loc.longitude);
        if (nearby) {
          await IndoorNavigationService.setActiveBuilding(nearby.building.id);
          await TextToSpeechService.speak(`Detected ${nearby.building.name}`);
        } else {
          await TextToSpeechService.speak(
            'No mapped building nearby. Say enter building or start mapping building first.'
          );
          return { navigating: false };
        }
      } catch (_) {
        await TextToSpeechService.speak('Could not get location for indoor navigation.');
        return { navigating: false };
      }
    }

    try {
      const loc = await LocationService.getCurrentLocation().catch(() => null);
      const result = await IndoorNavigationService.navigateTo(destination, loc);
      if (!result) {
        await TextToSpeechService.speak(
          `Could not find ${destination} in this building. Try saying mark ${destination} here first.`
        );
        return { navigating: false };
      }

      const { steps, totalDistanceM } = result;
      if (steps.length === 0) {
        await TextToSpeechService.speak('You are already there.');
        return { navigating: false, alreadyThere: true };
      }

      // Announce first step
      const first = steps[0];
      await TextToSpeechService.speak(
        `Indoor navigation started. Total distance: ${Math.round(totalDistanceM)} metres. ${first.instruction}`
      );

      // Pass to NavigationScreen for live display
      if (this._navDirectCb) {
        this._navDirectCb(`[INDOOR] ${destination}`, false, { indoorSteps: steps, indoorDest: result.destination });
      } else {
        await this._navigateToScreen('Navigation', {});
      }

      return { navigating: true, steps };
    } catch (e) {
      await TextToSpeechService.speak('Indoor navigation failed. ' + (e.message ?? ''));
      return { error: e.message };
    }
  }

  async _enterBuilding() {
    await IndoorNavigationService.initialize();
    try {
      const loc = await LocationService.getCurrentLocation();
      const nearby = await IndoorNavigationService.detectNearbyBuilding(loc.latitude, loc.longitude, 120);
      if (nearby) {
        await IndoorNavigationService.setActiveBuilding(nearby.building.id);
        const nodeCount = Object.values(nearby.building.floors)
          .reduce((sum, f) => sum + Object.keys(f.nodes).length, 0);
        await TextToSpeechService.speak(
          `Entered ${nearby.building.name}. ${nodeCount} landmarks mapped. Say navigate inside to, followed by a location name.`
        );
        return { building: nearby.building };
      }
      await TextToSpeechService.speak(
        'No mapped building found nearby. Say start mapping building to create a new building map.'
      );
      return { building: null };
    } catch (e) {
      await TextToSpeechService.speak('Could not detect building.');
      return { error: e.message };
    }
  }

  async _exitBuilding() {
    IndoorNavigationService.exitBuilding();
    await TextToSpeechService.speak('Switched to outdoor navigation mode.');
    return { exited: true };
  }

  async _selfLocalise(nodeName) {
    if (!nodeName) {
      await TextToSpeechService.speak('Please tell me which landmark you are at.');
      return { localised: false };
    }
    await IndoorNavigationService.initialize();
    const node = IndoorNavigationService.setCurrentNode(nodeName);
    if (node) {
      await TextToSpeechService.speak(`Got it. You are at ${node.name}.`);
      return { localised: true, node };
    }
    await TextToSpeechService.speak(
      `Could not find ${nodeName} in the current building. Try marking it first.`
    );
    return { localised: false };
  }

  // ── Multi-turn answer handler ──────────────────────────────────────────────

  /**
   * Called when _pendingQuestion is set and the user speaks the answer.
   * Routes the answer to the appropriate handler based on question type.
   */
  async _handlePendingAnswer(answerText) {
    const question = this._pendingQuestion;
    this._pendingQuestion = null;  // clear first so errors don't loop

    if (!question || !answerText?.trim()) {
      await TextToSpeechService.speak('Sorry, I did not catch that. Please try again.');
      return;
    }

    const answer = answerText.trim();

    switch (question.type) {
      case 'awaitPinName': {
        // Re-read GPS when the user speaks the name — they may have moved since
        // "pin my location" was first triggered.
        let { latitude, longitude } = question.data;
        try {
          const fresh = await LocationService.getFreshLocation();
          latitude = fresh.latitude;
          longitude = fresh.longitude;
        } catch (_) {}
        await PinnedLocationService.initialize();
        const pin = await PinnedLocationService.savePin(answer, { latitude, longitude });
        await TextToSpeechService.speak(
          `Location saved as ${pin.displayName}. Say take me to ${pin.displayName} to navigate here next time.`
        );
        break;
      }

      case 'awaitBuildingName': {
        // User answered "What is the name of this building?"
        const { latitude, longitude } = question.data;
        await IndoorNavigationService.initialize();
        const { building, entranceNode } = await IndoorNavigationService.startMapping(answer, { latitude, longitude });
        await TextToSpeechService.speak(
          `Started mapping ${answer}. Walk to each landmark and say mark, followed by its type and name. For example: mark staircase ground floor stairs. Say finish mapping when done.`
        );
        break;
      }

      case 'awaitLandmarkName': {
        // User answered a follow-up about landmark type/name
        const { nodeType } = question.data;
        const { nodeType: resolvedType, landmarkName } = this._parseLandmarkParam(answer);
        const finalType = resolvedType !== 'custom' ? resolvedType : nodeType;
        try {
          const loc = await LocationService.getCurrentLocation();
          const node = await IndoorNavigationService.markLandmark(landmarkName, finalType, loc);
          await TextToSpeechService.speak(`Marked ${finalType}: ${landmarkName}`);
        } catch (e) {
          await TextToSpeechService.speak('Could not mark landmark. ' + (e.message ?? ''));
        }
        break;
      }

      default:
        await TextToSpeechService.speak('Sorry, something went wrong. Please try your command again.');
    }
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
      const token = await AsyncStorage.getItem('@sensei_auth_token');
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

      // ── Multi-turn conversation intercept ─────────────────────────────────
      // If the system asked the user a follow-up question (e.g. "What do you
      // want to name this location?"), the next speech response is treated as
      // the answer, not as a new command.  The wake-word gate is skipped so
      // the user doesn't have to say "Hey Sensei" again.
      if (this._pendingQuestion) {
        if (this._onStateChange) this._onStateChange('processing', transcript);
        try {
          await this._handlePendingAnswer(transcript);
        } catch (err) {
          console.error('VoiceCommandService: pendingQuestion handler error:', err);
        }
        this._wakeWordMode = true;
        MicToneService.playOff();
        if (this._onStateChange) this._onStateChange('wake');
        if (this._continuousListening) this._scheduleRestart(1000);
        return;
      }

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
        // Exception: if a pendingQuestion was set by the command handler,
        // stay in active mode so the user's answer is captured immediately.
        if (!this._pendingQuestion) {
          this._wakeWordMode = true;
          MicToneService.playOff();
          if (this._onStateChange) this._onStateChange('wake');
          if (this._continuousListening) this._scheduleRestart(1000);
        } else {
          // Keep mic open — user needs to answer the question
          if (this._onStateChange) this._onStateChange('listening');
          if (this._continuousListening) this._scheduleRestart(800);
        }
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
