# Real-time object detection (Vision Camera)

The AR screen can use **real-time** object detection (live camera frames) when running in a **development build**. In Expo Go it falls back to snapshot-based detection.

## How it works

- **Real-time mode**: Uses `react-native-vision-camera` + `vision-camera-object-detector` (ML Kit). The camera runs at ~10 FPS through a frame processor; detections update live. No photos are taken.
- **Snapshot mode** (fallback): Takes a picture every 250 ms and runs COCO-SSD (TensorFlow.js). Used when Vision Camera is not available (e.g. Expo Go).

The app automatically uses real-time when the Vision Camera stack is available; no setting required.

## Run real-time on device

1. **Install dependencies** (already in `package.json`):
   - `react-native-vision-camera`
   - `react-native-worklets-core`
   - `vision-camera-object-detector`

2. **Prebuild and run** (required; does **not** work in Expo Go):
   ```bash
   npx expo prebuild
   npx expo run:android
   # or
   npx expo run:ios
   ```
   On iOS, run `npx pod-install` in the `ios` folder if needed.

3. **Permissions**: Camera permission is requested when you open the AR screen. Grant it to use the camera.

4. **Start AR Detection**: On the AR tab, tap “Start AR Detection”. If the build includes Vision Camera, you’ll see real-time detection; otherwise you’ll see the snapshot-based flow.

## If real-time doesn’t start

- You may see: *“Real-time camera requires a development build”* → Run `npx expo prebuild` and then `npx expo run:android` (or `run:ios`). Don’t use Expo Go for real-time.
- **Android**: Ensure `plugins` in `app.json` includes `["react-native-vision-camera", {}]` and run prebuild again.
- **iOS**: Ensure the camera usage description is in `Info.plist` (handled by the Expo camera plugin).
- The `vision-camera-object-detector` plugin was built for Vision Camera v2; if you use v4 and see frame processor errors, the plugin may need to be updated or replaced.

## Babel

`babel.config.js` must include the Reanimated plugin with `globals: ['__detectObjects']` for the object detector plugin. This is already set up.
