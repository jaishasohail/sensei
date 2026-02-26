# Building and running on Android (development build)

Use this when you run **`npx expo run:android`** (e.g. for real-time AR). Expo Go only needs `npm start`.

---

## 1. Use Java 11 or newer

The Android build **fails with Java 8**. You need Java 11+ (17 recommended).

**Check current Java:**
```bash
java -version
```

If you see `1.8.x`, install Java 17:

**On Mac (Homebrew):**
```bash
brew install openjdk@17
```

**Use it for this build** (same terminal where you run the app):

- **Apple Silicon (M1/M2/M3):**
  ```bash
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ```
- **Intel Mac:**
  ```bash
  export JAVA_HOME=/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ```

Or, if `java_home` finds it:
```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

Then run:
```bash
cd /path/to/sensei
npx expo run:android
```

---

## 2. Android SDK (ANDROID_HOME)

If you see **"ANDROID_HOME is set to a non-existing path"**:

- **Option A – Android Studio (easiest)**  
  1. Install [Android Studio](https://developer.android.com/studio).  
  2. Open it → **More Actions** → **SDK Manager** and install **Android SDK** (and note the path, e.g. `~/Library/Android/sdk`).  
  3. In your shell profile (`~/.zshrc` or `~/.bash_profile`):
     ```bash
     export ANDROID_HOME=$HOME/Library/Android/sdk
     export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/tools
     ```
  4. Restart the terminal and run `npx expo run:android` again.

- **Option B – Command-line tools only**  
  Install the [Android command-line tools](https://developer.android.com/studio#command-tools) and set `ANDROID_HOME` to the folder that contains `platform-tools` and `tools`.

---

## 3. Run on a physical phone

1. On the phone: **Settings** → **Developer options** → **USB debugging** → On.  
2. Connect the phone with USB.  
3. In the project folder (with `JAVA_HOME` and, if needed, `ANDROID_HOME` set):
   ```bash
   npx expo run:android
   ```
   The app will build, install, and launch on the phone.

---

## Quick checklist

| Issue | Fix |
|-------|-----|
| "This build uses a Java 8 JVM" | Install Java 17, set `JAVA_HOME` to it, then run the build again. |
| "ANDROID_HOME is set to a non-existing path" | Install Android Studio (or SDK tools) and set `ANDROID_HOME` (see above). |
| Build succeeds but app doesn’t install | Connect the phone with USB, enable USB debugging, and run `npx expo run:android` again. |
