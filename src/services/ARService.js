import { Renderer } from 'expo-three';
import * as THREE from 'three';
class ARService {
  constructor() {
    this.isInitialized = false;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.gl = null;
    this.pixelRatio = 1;
    this.anchors = new Map();
    this.running = false;
    this._raf = null;
    this._lastFrameTs = 0;
  }
  async initialize(gl, { width, height, pixelRatio = 1 } = {}) {
    this.gl = gl;
    this.pixelRatio = pixelRatio || 1;
    this.renderer = new Renderer({ gl });
    this.renderer.setSize(width || gl.drawingBufferWidth, height || gl.drawingBufferHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(60, (width || gl.drawingBufferWidth) / (height || gl.drawingBufferHeight), 0.01, 1000);
    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(0, 2, 2);
    this.scene.add(light);
    const amb = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(amb);
    this.isInitialized = true;
    return true;
  }
  start() {
    if (!this.isInitialized || this.running) return;
    this.running = true;
    const loop = (ts) => {
      if (!this.running) return;
      this._lastFrameTs = ts;
      if (this.renderer && this.scene && this.camera) {
        this.renderer.render(this.scene, this.camera);
        if (this.gl && this.gl.endFrameEXP) this.gl.endFrameEXP();
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  setCameraPose({ position, quaternion, rotation }) {
    if (!this.camera) return;
    if (position) {
      this.camera.position.set(position.x, position.y, position.z);
    }
    if (quaternion) {
      this.camera.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    } else if (rotation) {
      this.camera.rotation.set(rotation.x, rotation.y, rotation.z);
    }
  }
  addAnchor({ id, position = { x: 0, y: 0, z: -1 }, quaternion = null, color = 0x00aaff, scale = 0.1, geometry = 'sphere' }) {
    if (!this.scene) return null;
    const anchorId = id || `${Date.now()}-${Math.random()}`;
    let mesh;
    if (geometry === 'box') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color }));
    } else if (geometry === 'cone') {
      mesh = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.2, 16), new THREE.MeshStandardMaterial({ color }));
    } else {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 24), new THREE.MeshStandardMaterial({ color }));
    }
    mesh.scale.setScalar(scale);
    mesh.position.set(position.x, position.y, position.z);
    if (quaternion) mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    this.scene.add(mesh);
    this.anchors.set(anchorId, { id: anchorId, object3D: mesh });
    return this.anchors.get(anchorId);
  }
  updateAnchor(id, { position, quaternion, color }) {
    const a = this.anchors.get(id);
    if (!a) return;
    if (position) a.object3D.position.set(position.x, position.y, position.z);
    if (quaternion) a.object3D.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    if (color && a.object3D.material) a.object3D.material.color = new THREE.Color(color);
  }
  removeAnchor(id) {
    const a = this.anchors.get(id);
    if (!a) return;
    if (this.scene && a.object3D) this.scene.remove(a.object3D);
    this.anchors.delete(id);
  }
  clearAll() {
    if (this.scene) {
      this.anchors.forEach(a => this.scene.remove(a.object3D));
    }
    this.anchors.clear();
  }
  raycast(screenX, screenY) {
    if (!this.camera || !this.scene) return null;
    const raycaster = new THREE.Raycaster();
    const nx = (screenX * 2) - 1;
    const ny = -((screenY * 2) - 1);
    raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const objects = Array.from(this.anchors.values()).map(a => a.object3D);
    const hits = raycaster.intersectObjects(objects, true);
    if (!hits.length) return null;
    const h = hits[0];
    const hitAnchor = this._findAnchorByObject(h.object);
    return { anchor: hitAnchor, point: h.point, distance: h.distance };
  }
  createAnchorFromDetection(detection) {
    if (!this.camera) return null;
    const angleDeg = detection?.position?.angle ?? 0;
    const dist = detection?.distance ?? 1.5;
    const angle = (angleDeg * Math.PI) / 180;
    const x = Math.sin(angle) * dist;
    const z = -Math.cos(angle) * dist;
    return this.addAnchor({ position: { x, y: 0, z }, color: 0xff5500, scale: 0.08, geometry: 'cone' });
  }
  _findAnchorByObject(obj) {
    let target = obj;
    while (target && !this._hasAnchorObject(target)) {
      target = target.parent;
    }
    if (!target) return null;
    for (const [id, a] of this.anchors.entries()) {
      if (a.object3D === target) return a;
    }
    return null;
  }
  _hasAnchorObject(obj) {
    for (const a of this.anchors.values()) {
      if (a.object3D === obj) return true;
    }
    return false;
  }
  cleanup() {
    this.stop();
    this.clearAll();
    if (this.renderer) {
      try { this.renderer.dispose(); } catch {}
    }
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.gl = null;
    this.isInitialized = false;
  }
}
export default new ARService();
