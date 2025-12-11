# SENSEI - Smart Environmental Navigation System for Enhanced Independence

SENSEI is an AI-powered mobile navigation application designed to enhance independence for visually impaired users through augmented reality, spatial audio, and intelligent object detection.

## Features

- **Real-time AR Navigation**: Visual and audio guidance using augmented reality
- **Object Detection**: AI-powered detection of obstacles, people, and environmental hazards
- **Spatial Audio**: 3D audio cues for directional awareness
- **Turn-by-Turn Navigation**: Voice-guided navigation with real-time updates
- **Bluetooth Integration**: Connect wearable devices for enhanced feedback
- **Accessible UI**: Fully accessible interface with screen reader support

## Technology Stack

- **Framework**: React Native with Expo
- **AR**: Expo AR with Three.js for 3D rendering
- **AI**: TensorFlow Lite / PyTorch for object detection
- **Audio**: Expo AV and Spatial Audio APIs
- **Bluetooth**: React Native BLE for wearable integration
- **Navigation**: Expo Location for GPS tracking
- **Language**: JavaScript

## Prerequisites

Before you begin, ensure you have the following installed:

- Node.js (version 16.x or higher)
- npm or yarn
- Expo CLI
- iOS Simulator (for macOS) or Android Studio (for Android development)

## Installation

1. **Clone or extract the project**

   ```bash
   cd sensei-app
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

   or

   ```bash
   yarn install
   ```

3. **Install Expo CLI globally** (if not already installed)
   ```bash
   npm install -g expo-cli
   ```

## Running the Application

### Development Mode

1. **Start the Expo development server**

   ```bash
   npm start
   ```

   or

   ```bash
   expo start
   ```

2. **Run on specific platform**
   - **iOS**: Press `i` in the terminal or run `npm run ios`
   - **Android**: Press `a` in the terminal or run `npm run android`
   - **Web**: Press `w` in the terminal or run `npm run web`

### Using Expo Go App

1. Install Expo Go on your mobile device

   - iOS: [App Store](https://apps.apple.com/app/expo-go/id982107779)
   - Android: [Play Store](https://play.google.com/store/apps/details?id=host.exp.exponent)

2. Scan the QR code displayed in the terminal with your device camera

## Project Structure

```
sensei-app/
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── Button.js
│   │   └── Card.js
│   ├── screens/            # Main application screens
│   │   ├── HomeScreen.js
│   │   ├── NavigationScreen.js
│   │   ├── ARScreen.js
│   │   └── SettingsScreen.js
│   ├── services/           # Core business logic
│   │   ├── ARService.js
│   │   ├── BluetoothService.js
│   │   ├── LocationService.js
│   │   ├── NavigationService.js
│   │   ├── ObjectDetectionService.js
│   │   ├── SpatialAudioService.js
│   │   └── TextToSpeechService.js
│   ├── constants/          # App constants and theme
│   │   └── theme.js
│   └── utils/              # Utility functions
│       ├── helpers.js
│       └── validators.js
├── App.js                  # Root component
├── app.json               # Expo configuration
├── babel.config.js        # Babel configuration
├── package.json           # Dependencies and scripts
└── README.md             # This file
```

## Key Modules

### Services

- **ARService**: Manages AR rendering with Three.js, object markers, and 3D scene
- **LocationService**: GPS tracking, location updates, and distance calculations
- **NavigationService**: Turn-by-turn navigation, route generation, and guidance
- **ObjectDetectionService**: AI-powered object detection and classification
- **SpatialAudioService**: 3D audio positioning and directional sound cues
- **TextToSpeechService**: Voice feedback and announcements
- **BluetoothService**: Wearable device connectivity and data exchange

### Screens

- **HomeScreen**: Main dashboard with quick actions and system status
- **NavigationScreen**: Turn-by-turn navigation interface
- **ARScreen**: Live camera view with AR overlays and object detection
- **SettingsScreen**: App configuration and device management

## Permissions

The app requires the following permissions:

- **Camera**: For AR view and object detection
- **Location**: For navigation and positioning
- **Microphone**: For voice commands (future feature)
- **Bluetooth**: For wearable device integration

These permissions will be requested automatically when needed.

## Configuration

### Modifying Settings

Edit `app.json` to customize:

- App name and display name
- Icon and splash screen
- Permissions
- Platform-specific configurations

### Customizing Theme

Edit `src/constants/theme.js` to modify:

- Colors
- Spacing
- Font sizes
- Border radius
- Shadows

## Troubleshooting

### Common Issues

1. **Metro bundler issues**

   ```bash
   expo start -c
   ```

2. **Dependency conflicts**

   ```bash
   rm -rf node_modules
   npm install
   ```

3. **iOS build issues**

   ```bash
   cd ios && pod install && cd ..
   ```

4. **Permission errors**
   - Ensure location services are enabled
   - Grant camera and microphone permissions in device settings

## Building for Production

### iOS

```bash
expo build:ios
```

### Android

```bash
expo build:android
```

Follow the Expo documentation for detailed build instructions: [Expo Build Documentation](https://docs.expo.dev/build/introduction/)

## Development Guidelines

- All code is written in JavaScript
- Follow modular architecture principles
- Services are singleton instances
- UI components are reusable and accessible
- No comments or emojis in code (as per project requirements)

## Accessibility

SENSEI is designed with accessibility as a priority:

- Full screen reader support
- High contrast UI elements
- Audio feedback for all interactions
- Haptic feedback for important events
- Large touch targets for easy interaction

## Future Enhancements

- Voice command integration
- Multi-language support
- Offline map support
- AI model improvements
- Community features

## Support

For issues or questions, please refer to:

- Expo documentation: https://docs.expo.dev/
- React Native documentation: https://reactnative.dev/
- Three.js documentation: https://threejs.org/docs/

## License

Copyright © 2025 SENSEI Project. All rights reserved.

## Version

Current Version: 1.0.0

---

Built with ❤️ for enhanced independence and accessibility
