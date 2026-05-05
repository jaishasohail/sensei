/**
 * faceApiPolyfill.js
 *
 * MUST be imported as the FIRST statement in EmotionDetectionService.js.
 *
 * Why it is needed
 * ────────────────
 * @vladmandic/face-api's ESM build (face-api.esm.js) runs this at module
 * evaluation time:
 *
 *   if      (isBrowser()) setEnv(createBrowserEnv());
 *   else if (isNodejs())  setEnv(createNodejsEnv());
 *   // otherwise ENV stays null
 *
 * In React Native / Hermes:
 *   • isBrowser() checks window?.document?.createElement — undefined → FALSE
 *   • isNodejs()  checks process.versions?.node          — undefined → FALSE
 *
 * → ENV is never set → any later call to getEnv() (e.g. inside loadFromUri)
 *   throws "getEnv - environment is not defined".
 *
 * Fix — inject a minimal window.document mock before face-api's module code
 * runs.  isBrowser() then returns true, createBrowserEnv() creates an ENV
 * object backed by global fetch (available in RN).  Actual DOM/canvas APIs
 * are NEVER invoked because we pass tf.Tensor3D directly to detectAllFaces(),
 * which takes the Tensor branch in NetInput and bypasses all HTML* paths.
 *
 * Duplicate-kernel noise suppression
 * ────────────────────────────────────
 * @vladmandic/face-api bundles some TF.js WebGL kernels inline.  When they
 * register against the same global TF.js registry that @tensorflow/tfjs
 * already populated, React Native prints hundreds of harmless WARN lines:
 *   "The kernel 'X' for backend 'webgl' is already registered"
 * We patch console.warn here (before face-api is required) to drop those
 * specific messages while leaving all other warnings intact.
 */

// ── 1. Silence duplicate TF.js kernel registration noise ─────────────────────
// Must be done BEFORE face-api is required so the patch is in place when
// face-api's module-level code registers its bundled kernels.
const _origWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('already registered')) {
    return; // drop: "The kernel 'X' for backend 'Y' is already registered"
  }
  _origWarn(...args);
};

// ── 2. Minimal window / document stubs for face-api's isBrowser() check ──────

// React Native's global object is `global`.  `window` is typically undefined.
if (typeof global.window === 'undefined') {
  global.window = global;
}

// face-api's isBrowser() test:
//   typeof window !== 'undefined'
//   && typeof window.document !== 'undefined'
//   && typeof window.document.createElement === 'function'
if (!global.window.document) {
  const _noop = () => {};
  const _mockEl = (tag) => {
    // Every element needs addEventListener/removeEventListener — the WebGL
    // backend calls these on the canvas element during context setup.
    // Without them we get: "TypeError: n.addEventListener is not a function"
    // which kills the rn-webgl backend initialisation.
    const el = {
      style:               {},
      tagName:             (tag || '').toUpperCase(),
      addEventListener:    _noop,
      removeEventListener: _noop,
      dispatchEvent:       () => false,
    };
    if (tag === 'canvas') {
      // getContext always returns null — WebGL / 2D canvas never actually works,
      // but face-api only calls this for HTMLImageElement inputs, not Tensors.
      el.getContext  = () => null;
      el.width       = 0;
      el.height      = 0;
      el.toDataURL   = () => '';
    }
    return el;
  };

  global.document = {
    createElement:   (tag)       => _mockEl(tag),
    createElementNS: (_ns, tag)  => _mockEl(tag),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  global.window.document = global.document;
}

// ── 3. Browser globals that createBrowserEnv() reads at env-setup time ────────
// These are only assigned to the env object; they are never instantiated or
// called because inference uses tf.Tensor3D input (no DOM paths).
if (typeof global.HTMLCanvasElement === 'undefined') {
  global.HTMLCanvasElement = class HTMLCanvasElement {};
}
if (typeof global.HTMLVideoElement === 'undefined') {
  global.HTMLVideoElement = class HTMLVideoElement {};
}
if (typeof global.HTMLImageElement === 'undefined') {
  global.HTMLImageElement = class HTMLImageElement {};
}
if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageData {};
}
// CanvasRenderingContext2D is the MISSING piece — vk() (isBrowser) explicitly
// checks `typeof CanvasRenderingContext2D !== 'undefined'`. Without this,
// isBrowser() returns false even when all other globals are present.
if (typeof global.CanvasRenderingContext2D === 'undefined') {
  global.CanvasRenderingContext2D = class CanvasRenderingContext2D {};
}
if (typeof global.Image === 'undefined') {
  global.Image = class Image {
    constructor() {
      this.onload  = null;
      this.onerror = null;
      this.src     = '';
      this.width   = 0;
      this.height  = 0;
    }
  };
}
