import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
class SpatialAudioService {
  constructor() {
    this.soundObjects = new Map();
    this.activeSources = new Map();
    this.isInitialized = false;
    this.listenerPosition = { x: 0, y: 0, z: 0 };
    this.listenerOrientation = { forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
    this.speedOfSound = 343; 
    this.dopplerFactor = 1.0;
    this.rolloffFactor = 1.0;
    this.maxDistance = 100;
    this.refDistance = 1;
  }
  async initialize() {
    try {
      await setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('Audio initialization error:', error);
      throw error;
    }
  }
  async playSpatialSound(soundId, position, options = {}) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      const defaultOptions = {
        volume: 1.0,
        rate: 1.0,
        shouldLoop: false,
        velocity: { x: 0, y: 0, z: 0 }, 
      };
      const mergedOptions = { ...defaultOptions, ...options };
      const spatialParams = this.calculate3DAudioParams(position, mergedOptions.velocity);
      const player = createAudioPlayer(soundId);
      player.volume = spatialParams.volume * mergedOptions.volume;
      player.playbackRate = spatialParams.rate * mergedOptions.rate;
      player.loop = mergedOptions.shouldLoop;
      if (mergedOptions.shouldPlay !== false) {
        try { player.play(); } catch (e) {  }
      }
      this.activeSources.set(soundId, {
        sound: player,
        position,
        velocity: mergedOptions.velocity,
        baseVolume: mergedOptions.volume
      });
      this.soundObjects.set(soundId, player);
      await this.applySpatialEffect(player, spatialParams);
      if (player.addListener) {
        player.addListener('statusChange', (payload) => {
          const status = payload?.status ?? payload;
          if (status?.didJustFinish && !status?.isLooping) {
            this.stopSound(soundId);
          }
        });
      }
      return player;
    } catch (error) {
      console.error('Spatial sound error:', error);
      throw error;
    }
  }
  calculate3DAudioParams(sourcePosition, sourceVelocity = { x: 0, y: 0, z: 0 }) {
    const dx = sourcePosition.x - this.listenerPosition.x;
    const dy = sourcePosition.y - this.listenerPosition.y;
    const dz = sourcePosition.z - this.listenerPosition.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let volume = this.calculateDistanceAttenuation(distance);
    const pan = this.calculatePanning(dx, dz);
    const dopplerRate = this.calculateDopplerShift(
      sourcePosition,
      sourceVelocity,
      { x: 0, y: 0, z: 0 } 
    );
    const elevationFactor = this.calculateElevationEffect(dy, distance);
    volume *= elevationFactor;
    const occlusionFactor = 1.0; 
    volume *= occlusionFactor;
    return {
      volume: Math.max(0, Math.min(1, volume)),
      pan,
      rate: dopplerRate,
      distance,
      azimuth: Math.atan2(dx, dz) * 180 / Math.PI,
      elevation: Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / Math.PI
    };
  }
  calculateDistanceAttenuation(distance) {
    if (distance < this.refDistance) {
      return 1.0;
    }
    if (distance < this.maxDistance) {
      return 1 - this.rolloffFactor * (distance - this.refDistance) / (this.maxDistance - this.refDistance);
    }
    return 0;
  }
  calculatePanning(dx, dz) {
    const angle = Math.atan2(dx, dz);
    const panValue = Math.sin(angle);
    const panIntensity = Math.abs(Math.cos(angle)); 
    return panValue * (1 - panIntensity * 0.3);
  }
  calculateDopplerShift(sourcePos, sourceVel, listenerVel) {
    const dx = sourcePos.x - this.listenerPosition.x;
    const dy = sourcePos.y - this.listenerPosition.y;
    const dz = sourcePos.z - this.listenerPosition.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance === 0) return 1.0;
    const dirX = dx / distance;
    const dirY = dy / distance;
    const dirZ = dz / distance;
    const sourceVelProj = sourceVel.x * dirX + sourceVel.y * dirY + sourceVel.z * dirZ;
    const listenerVelProj = listenerVel.x * dirX + listenerVel.y * dirY + listenerVel.z * dirZ;
    const dopplerShift = (this.speedOfSound - this.dopplerFactor * listenerVelProj) /
                         (this.speedOfSound - this.dopplerFactor * sourceVelProj);
    return Math.max(0.5, Math.min(2.0, dopplerShift)); 
  }
  calculateElevationEffect(dy, distance) {
    if (distance === 0) return 1.0;
    const elevationAngle = Math.atan2(dy, distance);
    const elevationFactor = 1.0 - Math.abs(elevationAngle) / (Math.PI / 2) * 0.2;
    return elevationFactor;
  }
  async applySpatialEffect(sound, spatialParams) {
    try {
      try {
        if (typeof sound.volume !== 'undefined') sound.volume = spatialParams.volume;
        if (typeof sound.playbackRate !== 'undefined') sound.playbackRate = spatialParams.rate;
        if (sound.play && typeof sound.play === 'function') {
          sound.play();
        }
      } catch (e) {
      }
      return true;
    } catch (error) {
      console.error('Apply spatial effect error:', error);
      return false;
    }
  }
  updateListenerPosition(position, orientation = null) {
    this.listenerPosition = position;
    if (orientation) {
      this.listenerOrientation = orientation;
    }
    this.updateAllSources();
  }
  async updateAllSources() {
    for (const [soundId, source] of this.activeSources) {
      const spatialParams = this.calculate3DAudioParams(source.position, source.velocity);
      try {
        if (typeof source.sound.volume !== 'undefined') source.sound.volume = spatialParams.volume * source.baseVolume;
        if (typeof source.sound.playbackRate !== 'undefined') source.sound.playbackRate = spatialParams.rate;
      } catch (error) {
        console.error(`Update source ${soundId} error:`, error);
      }
    }
  }
  async playDirectionalBeep(angle, distance) {
    try {
      const frequency = this.angleToFrequency(angle);
      const position = {
        x: Math.sin(angle * Math.PI / 180) * distance,
        y: 0, 
        z: Math.cos(angle * Math.PI / 180) * distance,
      };
      const beepId = `beep_${Date.now()}`;
      await this.playSpatialSound(beepId, position, { 
        volume: 0.8,
        shouldLoop: false 
      });
      setTimeout(() => this.stopSound(beepId), 500);
    } catch (error) {
      console.error('Directional beep error:', error);
    }
  }
  async playDirectionalStream(streamId, angle, distance, options = {}) {
    const position = {
      x: Math.sin(angle * Math.PI / 180) * distance,
      y: options.elevation || 0,
      z: Math.cos(angle * Math.PI / 180) * distance,
    };
    return await this.playSpatialSound(streamId, position, {
      ...options,
      shouldLoop: true
    });
  }
  async updateSourcePosition(soundId, newPosition, newVelocity = null) {
    const source = this.activeSources.get(soundId);
    if (!source) return false;
    source.position = newPosition;
    if (newVelocity) {
      source.velocity = newVelocity;
    }
    const spatialParams = this.calculate3DAudioParams(source.position, source.velocity);
    try {
      if (typeof source.sound.volume !== 'undefined') source.sound.volume = spatialParams.volume * source.baseVolume;
      if (typeof source.sound.playbackRate !== 'undefined') source.sound.playbackRate = spatialParams.rate;
      return true;
    } catch (error) {
      console.error('Update source position error:', error);
      return false;
    }
  }
  angleToFrequency(angle) {
    return 200 + (angle / 360) * 600;
  }
  distanceToVolume(distance) {
    return this.calculateDistanceAttenuation(distance);
  }
  async playNavigationCue(direction, intensity = 'normal') {
    const cues = {
      forward: { pitch: 1.0, pattern: [200, 100], angle: 0 },
      left: { pitch: 0.8, pattern: [150, 100, 150], angle: -90 },
      right: { pitch: 1.2, pattern: [150, 100, 150], angle: 90 },
      backward: { pitch: 0.6, pattern: [100, 100, 100], angle: 180 },
      'sharp-left': { pitch: 0.7, pattern: [100, 50, 100, 50, 100], angle: -135 },
      'sharp-right': { pitch: 1.3, pattern: [100, 50, 100, 50, 100], angle: 135 },
    };
    const cue = cues[direction] || cues.forward;
    const distance = intensity === 'urgent' ? 1 : 3;
    await this.playDirectionalBeep(cue.angle, distance);
  }
  async stopSound(soundId) {
    const sound = this.soundObjects.get(soundId);
    if (sound) {
      try {
        if (sound.pause && typeof sound.pause === 'function') await sound.pause();
      } catch (e) {}
      try {
        if (sound.remove && typeof sound.remove === 'function') sound.remove();
      } catch (e) {}
      this.soundObjects.delete(soundId);
      this.activeSources.delete(soundId);
    }
  }
  async stopAllSounds() {
    for (const [soundId, sound] of this.soundObjects) {
      try {
        if (sound.pause && typeof sound.pause === 'function') await sound.pause();
      } catch (e) {}
      try {
        if (sound.remove && typeof sound.remove === 'function') sound.remove();
      } catch (e) {}
    }
    this.soundObjects.clear();
    this.activeSources.clear();
  }
  getActiveSourcesCount() {
    return this.activeSources.size;
  }
  setAudioParameters(params) {
    if (params.speedOfSound) this.speedOfSound = params.speedOfSound;
    if (params.dopplerFactor !== undefined) this.dopplerFactor = params.dopplerFactor;
    if (params.rolloffFactor !== undefined) this.rolloffFactor = params.rolloffFactor;
    if (params.maxDistance) this.maxDistance = params.maxDistance;
    if (params.refDistance) this.refDistance = params.refDistance;
  }
}
export default new SpatialAudioService();
