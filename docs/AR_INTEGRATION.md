# AR Integration (Expo GL + Three.js)

This app uses `expo-gl` + `expo-three` (Three.js) to render AR-like overlays.

## Install dependencies

```powershell
Push-Location "c:\Users\LAptopa\OneDrive\Desktop\sensei"
npm install
Pop-Location
```

## Usage

- Render `ARCanvas` somewhere in your screen to start the renderer.
- Use `ARService` to add anchors or set the camera pose.

Example:

```jsx
import React from "react";
import { View, StyleSheet } from "react-native";
import ARCanvas from "../src/components/ARCanvas";
import ARService from "../src/services/ARService";

export default function ExampleARScreen() {
  return (
    <View style={styles.container}>
      <ARCanvas
        style={styles.canvas}
        onReady={() => {
          ARService.addAnchor({
            position: { x: 0, y: 0, z: -1 },
            geometry: "box",
            color: 0xff0000,
            scale: 0.1,
          });
        }}
        onHit={(hit) => {
          if (hit?.anchor) {
            // Interacted with an anchor
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  canvas: { flex: 1 },
});
```

## Notes

- This is not ARKit/ARCore; it renders 3D over camera preview using Three.js. World tracking and true anchors require native AR frameworks or WebXR.
- For device pose, integrate sensors (accelerometer/gyroscope) to update `ARService.setCameraPose`.
- Combine with detections by calling `ARService.createAnchorFromDetection(d)`.
