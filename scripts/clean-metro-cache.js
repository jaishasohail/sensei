/**
 * Remove Metro / Expo bundler caches (safe to delete).
 * Usage: npm run clean:metro
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, '.metro'),
  path.join(ROOT, 'node_modules', '.cache'),
  path.join(os.tmpdir(), 'sensei-metro-cache'),
  path.join(os.tmpdir(), 'metro-file-map-sensei'),
];

for (const target of TARGETS) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log('Removed:', target);
    }
  } catch (e) {
    console.warn('Could not remove', target, '-', e.message);
  }
}

console.log('Metro cache clean complete.');
