/**
 * HazardScoringService - Real-time hazard evaluation for detected objects
 * 
 * Scoring System:
 * - Base score by object class (vehicles = 5, persons = 3, furniture = 1-2)
 * - Distance factor (closer = higher score)
 * - Size factor (larger objects = higher visibility/threat)
 * - Position factor (center = highest priority)
 * 
 * Hazard Levels:
 * - critical (score >= 8): Immediate danger, requires urgent action
 * - high (score >= 6): Significant hazard, requires attention
 * - medium (score >= 4): Moderate concern, monitor closely
 * - low (score < 4): Low risk, informational
 */
class HazardScoringService {
  scoreDetection(d) {
    const baseByClass = {
      car: 5, bus: 5, truck: 5, motorcycle: 4, bicycle: 4,
      person: 3, dog: 3, cat: 2, chair: 1, bench: 2, traffic: 3, 'traffic light': 3, 'stop sign': 4,
      'fire hydrant': 3, 'parking meter': 2, potted_plant: 1, skateboard: 3, umbrella: 1,
      handbag: 1, suitcase: 2, bottle: 1, cup: 1
    };
    const base = baseByClass[d.class] || 2;
    const dist = Math.max(0.2, Math.min(15, d.distance || 5));
    const distanceFactor = 6 - Math.min(5.9, Math.log2(1 + 8 / dist) * 2);
    const area = Math.max(1e-4, (d.boundingBox?.width || 0.1) * (d.boundingBox?.height || 0.1));
    const sizeFactor = Math.min(5, Math.log10(1 + area * 100) * 4);
    const rel = d.position?.relative || 'center';
    const relFactor = rel === 'center' ? 3 : (rel === 'left' || rel === 'right') ? 2 : 1;
    const raw = base + distanceFactor + sizeFactor + relFactor;
    const score = Math.min(10, Math.max(0, raw));
    let level = 'low';
    if (score >= 8) level = 'critical';
    else if (score >= 6) level = 'high';
    else if (score >= 4) level = 'medium';
    return { score, level };
  }
  
  /**
   * Calculate hazard score - compatibility method for tests
   * @param {Object} detection - Detection object with class, distance, position
   * @returns {Object} Hazard evaluation with level and priority
   */
  calculateHazardScore(detection) {
    // Normalize input format for compatibility
    const normalized = {
      class: detection.class,
      distance: detection.distance,
      boundingBox: detection.boundingBox || { width: 0.2, height: 0.3 },
      position: detection.position?.relative ? detection.position : { relative: detection.position || 'center' }
    };
    
    const { score, level } = this.scoreDetection(normalized);
    
    // Map level to priority for test compatibility
    const priorityMap = {
      critical: 'immediate',
      high: 'high',
      medium: 'moderate',
      low: 'low'
    };
    
    return {
      score,
      level,
      priority: priorityMap[level] || 'low'
    };
  }
}
export default new HazardScoringService();
