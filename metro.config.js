// metro.config.js
//
// Required for TensorFlow.js + @vladmandic/face-api to work in Metro:
//
//  1. `.cjs` sourceExt — @tensorflow/tfjs-react-native ships CommonJS modules
//     with a .cjs extension; Metro must know to treat them as JS source files.
//
//  2. transformIgnorePatterns — Metro's default blocklist excludes ALL of
//     node_modules.  We must unblock the packages that ship ES-module or
//     TypeScript source so Babel can transform them.
//
//  3. blockList — exclude android/.gradle, build outputs, and nested Gradle
//     caches inside node_modules.  Without this, metro-file-map tries to
//     serialize hundreds of thousands of files and crashes with OOM on Windows
//     (especially when the project lives under OneDrive).

const path = require('path');
const os = require('os');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// ── 1. Allow Metro to process .cjs files ─────────────────────────────────────
config.resolver.sourceExts.push('cjs');

// ── 2. Transform TF.js + face-api packages ───────────────────────────────────
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(' +
    [
      'react-native',
      '@react-native',
      'expo',
      '@expo',
      'react-navigation',
      '@react-navigation',
      '@tensorflow',
      '@vladmandic',
    ].join('|') +
  ')/)',
];

// ── 3. Exclude build / Gradle artifacts from the file map (prevents OOM) ─────
const escapeForRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = escapeForRegExp(__dirname.replace(/\\/g, '/'));

config.resolver.blockList = new RegExp(
  [
    `${root}/android/\\.gradle/.*`,
    `${root}/android/build/.*`,
    `${root}/android/app/build/.*`,
    `${root}/ios/build/.*`,
    `${root}/ios/Pods/.*`,
    `${root}/server/models/.*`,
    `${root}/docs/.*\\.pdf`,
    `${root}/node_modules/.*/\\.gradle/.*`,
    `${root}/node_modules/@react-native/gradle-plugin/\\.gradle/.*`,
    `${root}/node_modules/@react-native/gradle-plugin/build/.*`,
    `${root}/node_modules/.*/android/build/.*`,
    `${root}/node_modules/puppeteer/.*`,
    `${root}/node_modules/puppeteer-core/.*`,
  ].join('|'),
);

// ── 4. Store Metro cache outside OneDrive (avoids clone/serialize failures) ──
try {
  const { FileStore } = require('metro-cache');
  config.cacheStores = [
    new FileStore({
      root: path.join(os.tmpdir(), 'sensei-metro-cache'),
    }),
  ];
} catch {
  // metro-cache layout differs across versions — non-fatal
}

module.exports = config;
