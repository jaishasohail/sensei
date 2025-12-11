# API Integration Documentation

## Overview

The SENSEI frontend is fully connected to the backend API server running on `http://localhost:3001`.

## Configuration

### API Base URL

Located in: `src/constants/config.js`

```javascript
export const API_BASE_URL = "http://localhost:3001";
```

## Service Integration Status

### 1. Authentication (AuthScreen.js)

- **Endpoint**: `/api/auth/register`, `/api/auth/login`
- **Status**: ✅ Fully Integrated
- **Features**:
  - User registration with email, password, name
  - User login with email, password
  - Token storage in AsyncStorage
  - Automatic token retrieval for authenticated requests

### 2. Navigation Service

- **Endpoints**:
  - POST `/api/navigation/route` - Start navigation session
  - POST `/api/navigation/stop` - Stop navigation session
  - GET `/api/navigation/status` - Get current status
  - GET `/api/navigation/history` - Get navigation history
- **Status**: ✅ Fully Integrated
- **Features**:
  - Creates NavigationSession and Route records in MongoDB
  - Tracks session start/stop times
  - Records waypoints and distance
  - Requires authentication token

### 3. Emergency Service

- **Endpoints**:
  - POST `/api/emergency/alert` - Trigger emergency alert
  - GET `/api/emergency/alerts` - Get alert history
  - PUT `/api/emergency/alerts/:id/resolve` - Resolve alert
- **Status**: ✅ Fully Integrated
- **Features**:
  - Creates EmergencyAlert records with location
  - Tracks alert type, severity, and status
  - Sends SMS to emergency contacts
  - Requires authentication token

### 4. Object Detection Service

- **Endpoints**:
  - POST `/api/ai/detection/start` - Start detection session
  - POST `/api/ai/detection/object` - Log detected object
  - POST `/api/ai/detection/stop` - Stop detection session
- **Status**: ✅ Fully Integrated
- **Features**:
  - Creates DetectionSession and DetectedObject records
  - Tracks object class, confidence, distance, hazard level
  - Automatic session management
  - Requires authentication token

### 5. Voice Command Service

- **Endpoints**:
  - POST `/api/ai/voice-command` - Log voice command
  - GET `/api/ai/voice-commands` - Get command history
- **Status**: ✅ Fully Integrated
- **Features**:
  - Creates VoiceCommand records
  - Tracks command text, action, and recognition status
  - Requires authentication token

### 6. OCR Service

- **Endpoints**:
  - POST `/api/ai/ocr` - Perform OCR on image
  - POST `/api/ai/ocr/translate` - Translate OCR text
- **Status**: ✅ Fully Integrated
- **Features**:
  - Creates OCRSession records
  - Supports text extraction and translation
  - Requires authentication token

### 7. Emotion Detection Service

- **Endpoints**:
  - POST `/api/ai/emotion` - Detect emotion from face image
- **Status**: ✅ Fully Integrated
- **Features**:
  - Logs emotion detection to SystemLog
  - Supports offline fallback
  - Requires authentication token

### 8. Depth Estimation Service

- **Endpoints**:
  - POST `/api/ai/depth` - Estimate depth from image
- **Status**: ✅ Fully Integrated
- **Features**:
  - Logs depth estimation to SystemLog
  - Supports offline fallback
  - Requires authentication token

### 9. Offline Mode Service

- **Endpoints**:
  - GET `/api/health` - Check server availability
- **Status**: ✅ Fully Integrated
- **Features**:
  - Automatic server health checks
  - Cloud/offline mode toggle
  - API base URL configuration

## Authentication Flow

1. User opens app → AuthScreen displayed
2. User registers/logs in → Receives JWT token
3. Token stored in AsyncStorage with key: `authToken`
4. All subsequent API requests include token in Authorization header:
   ```javascript
   headers: {
     'Authorization': `Bearer ${token}`
   }
   ```

## Initialization Flow

1. App starts → AppInitializer.initialize() called
2. Sets API base URL for all services
3. Pings server health endpoint
4. Enables cloud mode if server online, else offline mode
5. Initializes device permissions (location, camera, etc.)
6. Speaks initialization status via TTS

## API Request Pattern

All services follow this pattern:

```javascript
const token = await AsyncStorage.getItem("authToken");
if (token) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/endpoint`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    if (response.ok) {
      const result = await response.json();
      // Handle success
    }
  } catch (err) {
    console.error("API error:", err);
  }
}
```

## Error Handling

- Network errors: Graceful degradation to offline mode
- Authentication errors: User prompted to log in again
- Server errors: Logged to console, user notified via TTS
- All API failures are non-blocking (app continues to function)

## Testing API Connection

Use the API test utility:

```javascript
import { runAllAPITests } from "./src/utils/apiTest";

// Test server health
const results = await runAllAPITests();
console.log(results.health); // { connected: true, status: 'ok' }

// Test all endpoints with token
const token = await AsyncStorage.getItem("authToken");
const fullResults = await runAllAPITests(token);
```

## MongoDB Collections Used

Frontend services interact with these MongoDB collections:

1. **users** - User authentication
2. **user_profiles** - User profile data
3. **user_preferences** - User settings
4. **navigation_sessions** - Navigation tracking
5. **routes** - Saved routes
6. **detection_sessions** - Object detection sessions
7. **detected_objects** - Individual detected objects
8. **voice_commands** - Voice command history
9. **emergency_alerts** - Emergency alert records
10. **ocr_sessions** - OCR processing records
11. **system_logs** - System activity logs

## Server Requirements

- Node.js backend running on port 3001
- MongoDB running on localhost:27017
- Database name: `sensei`
- All API routes require JWT authentication (except /auth endpoints)

## Starting the System

### Backend:

```bash
cd server
npm install
npm start
```

### Frontend:

```bash
npm install
npm start
```

## Environment Variables

### Backend (.env):

```
PORT=3001
MONGODB_URI=mongodb://localhost:27017/sensei
JWT_SECRET=your_jwt_secret_key
```

### Frontend:

API configuration in `src/constants/config.js` (no .env needed)

## API Response Format

### Success:

```json
{
  "success": true,
  "data": { ... },
  "message": "Operation successful"
}
```

### Error:

```json
{
  "success": false,
  "error": "Error message",
  "details": { ... }
}
```

## Security

- All endpoints (except auth) protected by JWT middleware
- Tokens expire after 7 days
- Passwords hashed with bcrypt
- CORS enabled for development
- AsyncStorage used for secure token storage on device

## Performance

- API calls are asynchronous and non-blocking
- Failed API calls don't crash the app
- Offline mode automatically enabled if server unreachable
- Services cache data locally when possible
- Background API calls for logging (don't block UI)

## Future Enhancements

- WebSocket integration for real-time updates
- Push notifications for emergency alerts
- Background location tracking
- Offline data sync when reconnected
- API response caching
- Request retry logic with exponential backoff
