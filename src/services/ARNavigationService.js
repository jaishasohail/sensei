class ARNavigationService {
  constructor() {
    this.anchors = [];
  }
  addAnchor({ id, position, instruction }) {
    const anchor = { id: id || `${Date.now()}-${Math.random()}`, position, instruction };
    this.anchors.push(anchor);
    return anchor;
  }
  clearAnchors() {
    this.anchors = [];
  }
  raycast(screenX, screenY) {
    if (!this.anchors.length) return null;
    return { anchor: this.anchors[0], hit: { distance: 2.0 } };
  }
}
export default new ARNavigationService();
