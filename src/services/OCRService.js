import OfflineModeService from './OfflineModeService';
import { API_BASE_URL } from '../constants/config';

class OCRService {
  constructor() {
    this.initialized = false;
    this.apiBaseUrl = API_BASE_URL;
    
    this._isProcessing = false;
    this._lastProcessTime = 0;
    this._minProcessInterval = 500;
    this._textBuffer = [];
    this._bufferSize = 3;
    
    this._performanceMetrics = {
      avgProcessTime: 0,
      framesProcessed: 0,
      successfulReads: 0,
    };
    
    this._realtimeCallback = null;
    this._realtimeActive = false;
    
    this._lastTextRegions = [];
    this._textTrackingEnabled = true;
  }
  
  async initialize({ apiBaseUrl } = {}) {
    if (apiBaseUrl) this.apiBaseUrl = apiBaseUrl;
    this.initialized = true;
    console.log('OCRService: Initialized with real-time capabilities');
    return true;
  }
  
  startRealtimeOCR(callback, options = {}) {
    const { intervalMs = 500 } = options;
    this._minProcessInterval = intervalMs;
    this._realtimeCallback = callback;
    this._realtimeActive = true;
    console.log('OCRService: Real-time OCR started');
    return true;
  }
  
  stopRealtimeOCR() {
    this._realtimeActive = false;
    this._realtimeCallback = null;
    this._textBuffer = [];
    this._lastTextRegions = [];
    console.log('OCRService: Real-time OCR stopped');
  }
  
  async processFrame(imageBase64) {
    const now = Date.now();
    
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
      
      
      const processTime = performance.now() - startTime;
      this._performanceMetrics.framesProcessed++;
      this._performanceMetrics.avgProcessTime = 
        (this._performanceMetrics.avgProcessTime * (this._performanceMetrics.framesProcessed - 1) + processTime) 
        / this._performanceMetrics.framesProcessed;
      
      if (result.text && result.text.trim()) {
        this._performanceMetrics.successfulReads++;
        
        
        this._textBuffer.push(result.text);
        if (this._textBuffer.length > this._bufferSize) {
          this._textBuffer.shift();
        }
        
       
        const stableText = this._getStableText();
        
        
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
  
  _getStableText() {
    if (this._textBuffer.length === 0) return '';
    
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

  /**
   * Public liveness check — callers can run this before attempting OCR so
   * they can give the user early feedback without having to go through
   * readTextFromImage first.
   */
  checkServerHealth() {
    return this._checkServerHealth();
  }

  /**
   * Quick liveness check against /api/health with a 3 s timeout.
   * Returns true when the server is reachable, false otherwise.
   */
  async _checkServerHealth() {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.apiBaseUrl}/api/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async readTextFromImage(imageBase64, { skipHealthCheck = false } = {}) {
    try {
      // Fast server liveness check before sending the large image payload.
      // If the server is down we tell the caller immediately (< 3 s) instead
      // of waiting for the full OCR timeout (120 s).
      // Pass skipHealthCheck: true when the caller already ran checkServerHealth()
      // to avoid paying for two HTTP round-trips.
      if (!skipHealthCheck) {
        const serverAlive = await this._checkServerHealth();
        if (!serverAlive) {
          console.warn('OCRService: Server unreachable (health-check failed)');
          return {
            text: '',
            confidence: 0.0,
            length: 0,
            error: 'Server not running. Please start the server and try again.',
            isOffline: true,
            serverDown: true,
          };
        }
      }

      // 120 s timeout: on first server start Tesseract must download
      // eng.traineddata (~10 MB) from the CDN even with cachePath set (only
      // once — subsequent starts load from disk in ~0.5 s).  120 s is a safe
      // ceiling for the very first download on a slow connection.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      
     
      // Send the image as-is — the server handles size.  Truncating a base64
      // string by character count produces a broken JPEG and causes OCR to fail.
      const res = await fetch(`${this.apiBaseUrl}/api/ai/ocr`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ 
          image: imageBase64,
          save: false
        }),
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
      console.warn(`OCRService: Server error ${res.status}:`, err);
      return { 
        text: '', 
        confidence: 0.0, 
        length: 0, 
        error: err || `OCR server error ${res.status}` 
      };
    } catch (e) {
      if (e.name === 'AbortError') {
        console.warn('OCRService: Request timeout - server may be slow or unavailable');
        return { 
          text: '', 
          confidence: 0.0, 
          length: 0, 
          error: 'OCR request timed out. Server may be processing or unavailable.',
          isTimeout: true 
        };
      }
      
      console.warn('OCRService: API call failed', e.message || e);
      return { 
        text: '', 
        confidence: 0.0, 
        length: 0, 
        error: `OCR unavailable: ${e.message || 'Network error'}. Ensure server is running at ${this.apiBaseUrl}`,
        isOffline: true 
      };
    }
  }
  

  getPerformanceMetrics() {
    return { ...this._performanceMetrics };
  }
 
  setProcessInterval(intervalMs) {
    this._minProcessInterval = Math.max(200, Math.min(2000, intervalMs));
  }
  

  isRealtimeActive() {
    return this._realtimeActive;
  }
}
export default new OCRService();
