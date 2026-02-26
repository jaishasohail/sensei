# SENSEI – How to Run (Windows)

This project has two run modes:

| Mode | Detection | Use case |
|------|-----------|----------|
| **Expo** | Snapshots (photo every ~250 ms, COCO-SSD) | Quick testing, no native build |
| **Development build** | Real-time (Vision Camera, live frames ~10 FPS) | Full AR with live detection |

---

## Prerequisites (both modes)

- **Node.js 18+** – https://nodejs.org
- **Android device or emulator**
- USB debugging enabled (Settings → Developer options)

---

## Option 1: Expo (snapshots)

**Requires:** Node.js only.

1. Install dependencies:
   ```
   npm install
   ```

2. Start:
   ```
   npm start
   ```

3. Press `a` for Android. Connect a device or start an emulator.

4. Open the app in Expo Go. On the AR tab, use snapshot-based detection (photos every 250 ms).

---

## Option 2: Development build (real-time)

**Requires:** Node.js, JDK 17, Android Studio.

### 1. Install JDK 17

- Download: https://adoptium.net/temurin/releases/ (Windows x64, JDK 17)
- After install, set `JAVA_HOME` (replace path if different):
  ```cmd
  set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.x.x-hotspot
  ```

### 2. Install Android Studio

- Download: https://developer.android.com/studio
- During setup, install Android SDK and SDK Platform-Tools
- Set environment variables (replace `<username>`):
  ```cmd
  set ANDROID_HOME=C:\Users\<username>\AppData\Local\Android\Sdk
  set PATH=%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator
  ```
  To make them permanent: System → Advanced system settings → Environment Variables.

### 3. SDK components (via Android Studio SDK Manager or CLI)

- Android SDK Platform 36 (or latest)
- Build-Tools 36.0.0
- NDK 27.1.12297006
- Android SDK Build-Tools 35 (for Vision Camera)

Or via command line:
```cmd
%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" "ndk;27.1.12297006"
%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat --licenses
```

### 4. Run

```cmd
cd sensei
npm install
npx expo prebuild
npx expo run:android
```

The app installs on the connected device/emulator and uses real-time camera frames on the AR tab.

---

## Quick reference

| Task | Command |
|------|---------|
| Expo (snapshots) | `npm start` → press `a` |
| Real-time build | `npx expo run:android` |
| Clean Android build | `cd android` then `gradlew.bat clean` |
| Fix Java version | `java -version` must show 17. Set `JAVA_HOME` if not. |
| Fix SDK path | Ensure `ANDROID_HOME` points to your Android SDK folder. |

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| "Java 8 JVM" or build fails | Install JDK 17 and set `JAVA_HOME`. |
| "ANDROID_HOME is set to a non-existing path" | Install Android Studio, set `ANDROID_HOME` to the SDK path. |
| "Real-time camera requires a development build" | Use Option 2 (`npx expo run:android`), not Expo Go. |
| App doesn’t install | Enable USB debugging, connect device, run `adb devices`. |
