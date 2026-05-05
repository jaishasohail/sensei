// metro.config.js
//
// Required for TensorFlow.js + @vladmandic/face-api to work in Metro:
//
//  1. `.cjs` sourceExt — @tensorflow/tfjs-react-native ships CommonJS modules
//     with a .cjs extension; Metro must know to treat them as JS source files.
//
//  2. transformIgnorePatterns — Metro's default blocklist excludes ALL of
//     node_modules.  We must unblock the packages that ship ES-module or
//     TypeScript source so Babel can transform them:
//       • @tensorflow/* family
//       • @vladmandic/face-api  (ESM build resolved via "browser" package field)
//       • expo-* and react-native-* are already unblocked by the Expo default
//         but are kept here for clarity.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// ── 1. Allow Metro to process .cjs files ─────────────────────────────────────
config.resolver.sourceExts.push('cjs');

// ── 2. Transform TF.js + face-api packages (they ship ESM / TS source) ───────
// The default Expo pattern already un-ignores react-native|expo|… packages.
// We append the TF.js and face-api scopes to that allowlist.
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

// Unblock @tensorflow/* and @vladmandic/* from the default ignore list.
// The Expo default is roughly: /node_modules\/(?!(react-native|expo|…)\/).*/
// We patch it so those extra scopes are also transformed by Babel.
const defaultBlocklist = config.resolver.blockList;
const originalTransformIgnorePatterns =
  config.transformer.transformIgnorePatterns ?? [
    'node_modules/(?!(react-native|@react-native|expo|@expo|react-navigation|@react-navigation)/)',
  ];

// Replace the single default pattern (first element) with an extended one.
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(' +
    [
      'react-native',
      '@react-native',
      'expo',
      '@expo',
      'react-navigation',
      '@react-navigation',
      '@tensorflow',          // tfjs core + tfjs-react-native
      '@vladmandic',          // face-api ESM build
    ].join('|') +
  ')/)',
];

module.exports = config;
