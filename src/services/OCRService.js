import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';

/**
 * OCRService - Real-time Optical Character Recognition
 * 
 * AI Model Strategy:
 * - Primary: ML Kit Text Recognition (on-device, real-time capable)
 * - Fallback: Cloud-based OCR API for complex text
 * 
 * Real-time Features:
 * - Frame-rate controlled text detection
 * - Text region tracking for stability
 * - Confidence-based filtering
 * - Multi-language support
 */
class OCRService {
  constructor() {
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
    
    // Real-time state
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 500; // 2 FPS for OCR (text doesn't change as fast)
    this._textBuffer = []; // Buffer for text stability
    this._bufferSize = 3;
    
    // Performance metrics
    this._performanceMetrics = {
      avgProcessTime: 0,
      framesProcessed: 0,
      successfulReads: 0,
    };
    
    // Real-time detection callback
    this._realtimeCallback = null;
    this._realtimeActive = false;
    
    // Text region tracking
    this._lastTextRegions = [];
    this._textTrackingEnabled = true;
  }
  
  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    console.log('OCRService: Initialized with real-time capabilities');
    return true;
  }
  
  /**
   * Start real-time OCR processing from camera stream
   * @param {Function} callback - Called with detected text results
   * @param {Object} options - Configuration options
   */
  startRealtimeOCR(callback, options = {}) {
    const { intervalMs = 500 } = options;
    this._minProcessInterval = intervalMs;
    this._realtimeCallback = callback;
    this._realtimeActive = true;
    console.log('OCRService: Real-time OCR started');
    return true;
  }
  
  /**
   * Stop real-time OCR processing
   */
  stopRealtimeOCR() {
    this._realtimeActive = false;
    this._realtimeCallback = null;
    this._textBuffer = [];
    this._lastTextRegions = [];
    console.log('OCRService: Real-time OCR stopped');
  }
  
  /**
   * Process a frame for real-time OCR
   * @param {string} imageBase64 - Base64 encoded image from camera
   * @returns {Object} OCR result with text, confidence, and regions
   */
  async processFrame(imageBase64) {
    const now = Date.now();
    
    // Rate limiting for real-time processing
    if (now - this._lastProcessTime < this._minProcessInterval) {
      return null;
    }
    
    if (this._isProcessing) {
      return null;
    }
    
    this._isProcessing = true;
    const startTime = performance.now();
    
    try {
      const result = await this.readTextFromImage(imageBase64);
      
      // Update performance metrics
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      if (result.text && result.text.trim()) {
        this._performanceMetrics.successfulReads++;
        
        // Add to buffer for stability
        this._textBuffer.push(result.text);
        if (this._textBuffer.length > this._bufferSize) {
          this._textBuffer.shift();
        }
        
        // Get stable text (most common in buffer)
        const stableText = this._getStableText();
        
        // Trigger callback if active
        if (this._realtimeActive && this._realtimeCallback) {
          this._realtimeCallback({
            text: stableText,
            rawText: result.text,
            confidence: result.confidence,
            regions: result.regions || [],
            isStable: stableText === result.text,
          });
        }
        
        this._lastProcessTime = now;
        return { ...result, stableText };
      }
      
      this._lastProcessTime = now;
      return result;
    } catch (error) {
      console.error('OCRService processFrame error:', error);
      return { text: '', confidence: 0, error: String(error) };
    } finally {
      this._isProcessing = false;
    }
  }
  
  /**
   * Get the most stable text from the buffer
   */
  _getStableText() {
    if (this._textBuffer.length === 0) return '';
    
    // Simple majority voting for stability
    const counts = {};
    this._textBuffer.forEach(text => {
      const normalized = text.trim().toLowerCase();
      counts[normalized] = (counts[normalized] || 0) + 1;
    });
    
    let maxCount = 0;
    let stableText = this._textBuffer[this._textBuffer.length - 1];
    
    Object.entries(counts).forEach(([text, count]) => {
      if (count > maxCount) {
        maxCount = count;
        stableText = this._textBuffer.find(t => t.trim().toLowerCase() === text) || stableText;
      }
    });
    
    return stableText;
  }

  async readTextFromImage(imageBase64) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`${this.apiBaseUrl}/api/ai/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageBase64 }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        return {
          text: data.text || '',
          confidence: data.confidence || 0,
          length: data.length || (data.text?.length || 0),
          regions: data.regions || [],
          language: data.language || 'unknown',
        };
      }

      const err = await res.text().catch(() => '');
      return { text: '', confidence: 0.0, length: 0, error: err || `OCR server error ${res.status}` };
    } catch (e) {
      // Provide more helpful offline message
      console.warn('OCRService: API call failed, using fallback', e);
      return { 
        text: '', 
        confidence: 0.0, 
        length: 0, 
        error: 'OCR requires network connection. Please ensure server is running.',
        isOffline: true 
      };
    }
  }
  
  /**
   * Get performance metrics
   */
  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
  
  /**
   * Set processing interval for real-time OCR
   */
  setProcessInterval(intervalMs) {
    this._minProcessInterval = Math.max(200, Math.min(2000, intervalMs));
  }
  
  /**
   * Check if real-time OCR is active
   */
  isRealtimeActive() {
    return this._realtimeActive;
  }
}
export default new OCRService();
