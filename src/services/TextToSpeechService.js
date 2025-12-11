import * as Speech from 'expo-speech';
class TextToSpeechService {
  constructor() {
    this.isSpeaking = false;
    this.queue = [];
  }
  speak(text, options = {}) {
    const defaultOptions = {
      language: 'en-US',
      pitch: 1.0,
      rate: 0.9,
      volume: 1.0,
      onStart: () => {
        this.isSpeaking = true;
      },
      onDone: () => {
        this.isSpeaking = false;
        this.processQueue();
      },
      onError: (error) => {
        console.error('TTS Error:', error);
        this.isSpeaking = false;
        this.processQueue();
      },
    };
    const mergedOptions = { ...defaultOptions, ...options };
    if (this.isSpeaking) {
      this.queue.push({ text, options: mergedOptions });
    } else {
      Speech.speak(text, mergedOptions);
    }
  }
  processQueue() {
    if (this.queue.length > 0) {
      const { text, options } = this.queue.shift();
      Speech.speak(text, options);
    }
  }
  stop() {
    Speech.stop();
    this.isSpeaking = false;
    this.queue = [];
  }
  pause() {
    Speech.pause();
  }
  resume() {
    Speech.resume();
  }
  getAvailableVoices() {
    return Speech.getAvailableVoicesAsync();
  }
  isSpeakingNow() {
    return this.isSpeaking;
  }
}
export default new TextToSpeechService();
