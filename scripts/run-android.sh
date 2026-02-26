#!/usr/bin/env bash
# Run Android build with Java 17 if available (required for Expo/Gradle).
set -e
JAVA17_HOME=""
if [ -d "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]; then
  JAVA17_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
elif [ -d "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]; then
  JAVA17_HOME="/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
fi
if [ -n "$JAVA17_HOME" ]; then
  export JAVA_HOME="$JAVA17_HOME"
  echo "Using JAVA_HOME=$JAVA_HOME"
else
  echo "Warning: Java 17 not found. Install with: brew install openjdk@17"
  echo "Build may fail if you have Java 8. See docs/BUILD_ANDROID.md"
fi
cd "$(dirname "$0")/.."
npx expo run:android "$@"
