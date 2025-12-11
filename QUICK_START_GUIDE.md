# SENSEI Quick Start Guide

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v16 or higher) - [Download](https://nodejs.org/)
- **MongoDB** (v5.0 or higher) - [Download](https://www.mongodb.com/try/download/community)
- **npm** or **yarn** package manager
- **Expo CLI** (for React Native development)
- **Git** (optional, for version control)

## Step 1: Install MongoDB

### Windows:

1. Download MongoDB Community Edition from the official website
2. Run the installer and follow the installation wizard
3. MongoDB will start automatically as a Windows service
4. Verify installation:

```powershell
mongod --version
```

### Start MongoDB (if not running):

```powershell
net start MongoDB
```

## Step 2: Install Dependencies

### Backend Dependencies:

```powershell
cd server
npm install
```

This will install:

- express
- mongoose
- jsonwebtoken
- bcryptjs
- cors
- dotenv
- socket.io

### Frontend Dependencies:

```powershell
cd ..
npm install
```

This will install:

- expo
- react-native
- react-navigation
- tensorflow.js
- All other project dependencies

## Step 3: Configure Environment Variables

### Backend Configuration:

Create a `.env` file in the `server` directory:

```powershell
cd server
New-Item -ItemType File -Path .env
```

Add the following content to `server/.env`:

```env
PORT=3001
MONGODB_URI=mongodb://localhost:27017/sensei
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
NODE_ENV=development
```

**Important:** Change `JWT_SECRET` to a secure random string in production!

## Step 4: Start MongoDB

Ensure MongoDB is running:

```powershell
mongod
```

Or if running as a service:

```powershell
net start MongoDB
```

Verify MongoDB is accessible:

```powershell
mongosh
```

You should see the MongoDB shell. Type `exit` to leave.

## Step 5: Start the Backend Server

Open a new terminal window and navigate to the server directory:

```powershell
cd c:\Users\LAptopa\OneDrive\Desktop\sensei\server
npm start
```

You should see:

```
Sensei server listening on port 3001
MongoDB connected successfully
```

**Backend is now running on:** `http://localhost:3001`

### Test Backend Health:

Open a browser and visit: `http://localhost:3001/api/health`

You should see:

```json
{
  "status": "ok",
  "database": "connected"
}
```

## Step 6: Start the Frontend App

Open a **NEW** terminal window (keep backend running) and navigate to the project root:

```powershell
cd c:\Users\LAptopa\OneDrive\Desktop\sensei
npm start
```

This will start the Expo development server. You should see a QR code and menu options.

## Step 7: Run the App

You have several options:

### Option A: Android Emulator

Press `a` in the Expo terminal to launch on Android emulator (requires Android Studio)

### Option B: iOS Simulator (Mac only)

Press `i` in the Expo terminal to launch on iOS simulator (requires Xcode)

### Option C: Physical Device

1. Install **Expo Go** app on your phone
2. Scan the QR code with your camera (iOS) or Expo Go app (Android)
3. The app will load on your device

### Option D: Web Browser

Press `w` in the Expo terminal to run in web browser

## Step 8: Test the Connection

Once the app loads:

1. **Authentication Screen** should appear
2. **Register a new account**:

   - Enter name: `Test User`
   - Enter email: `test@example.com`
   - Enter password: `password123`
   - Confirm password: `password123`
   - Click "Register"

3. You should hear "Registration successful" via text-to-speech
4. You'll be logged in automatically

## Verifying Everything Works

### Check Backend Logs:

You should see in the backend terminal:

```
POST /api/auth/register 201
POST /api/auth/login 200
```

### Check MongoDB:

```powershell
mongosh
use sensei
db.users.find().pretty()
```

You should see your registered user in the database.

### Test App Features:

- **Home Screen**: Should display app overview and quick actions
- **Navigation Screen**: Start a navigation session
- **AR Screen**: View augmented reality features
- **Settings Screen**: Configure app preferences

## Common Issues and Solutions

### Issue 1: MongoDB Not Running

**Error:** `MongoDB connection error`

**Solution:**

```powershell
net start MongoDB
```

### Issue 2: Port Already in Use

**Error:** `Port 3001 is already in use`

**Solution:**

```powershell
# Find process using port 3001
netstat -ano | findstr :3001

# Kill the process (replace PID with actual process ID)
taskkill /PID <PID> /F
```

### Issue 3: Backend Not Connecting

**Error:** `Network request failed` in frontend

**Solution:**

- Ensure backend is running on port 3001
- Check `src/constants/config.js` has correct `API_BASE_URL`
- For physical device, use your computer's IP address instead of `localhost`:
  ```javascript
  export const API_BASE_URL = "http://192.168.1.X:3001";
  ```

### Issue 4: Cannot Connect from Physical Device

**Error:** `Network error` when using Expo Go

**Solution:**

1. Find your computer's IP address:

```powershell
ipconfig
```

Look for "IPv4 Address" (e.g., 192.168.1.100)

2. Update `src/constants/config.js`:

```javascript
export const API_BASE_URL = "http://192.168.1.100:3001";
```

3. Ensure your phone and computer are on the same WiFi network
4. Restart the Expo dev server

### Issue 5: Dependencies Installation Failed

**Error:** `npm install` errors

**Solution:**

```powershell
# Clear npm cache
npm cache clean --force

# Delete node_modules and package-lock.json
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json

# Reinstall
npm install
```

## Development Workflow

### Running Both Servers:

You need **TWO terminal windows**:

**Terminal 1 (Backend):**

```powershell
cd server
npm start
```

**Terminal 2 (Frontend):**

```powershell
npm start
```

### Stopping Servers:

Press `Ctrl + C` in each terminal window

### Restarting Servers:

If you make changes to the code:

- **Backend:** Server auto-restarts with nodemon (if installed)
- **Frontend:** Expo auto-reloads on file save

## API Endpoints Available

Once running, these endpoints are available:

### Authentication:

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user

### User Management:

- `GET /api/users/me` - Get current user profile
- `PUT /api/users/me` - Update user profile
- `GET /api/users/preferences` - Get user preferences
- `PUT /api/users/preferences` - Update preferences

### Navigation:

- `POST /api/navigation/route` - Start navigation
- `POST /api/navigation/stop` - Stop navigation
- `GET /api/navigation/status` - Get navigation status
- `GET /api/navigation/history` - Get navigation history

### Emergency:

- `POST /api/emergency/alert` - Create emergency alert
- `GET /api/emergency/alerts` - Get alert history
- `PUT /api/emergency/alerts/:id/resolve` - Resolve alert

### AI Services:

- `POST /api/ai/ocr` - Perform OCR on image
- `POST /api/ai/detection/start` - Start object detection
- `POST /api/ai/detection/stop` - Stop object detection
- `POST /api/ai/voice-command` - Log voice command

### System:

- `GET /api/health` - Check server health
- `GET /api/logs` - Get system logs

## Testing the API

### Using cURL:

```powershell
# Test health endpoint
curl http://localhost:3001/api/health

# Register user
curl -X POST http://localhost:3001/api/auth/register `
  -H "Content-Type: application/json" `
  -d '{"email":"test@example.com","password":"test123","name":"Test User"}'

# Login
curl -X POST http://localhost:3001/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{"email":"test@example.com","password":"test123"}'
```

### Using Postman:

Import the API endpoints from the documentation and test each one.

## Next Steps

1. **Explore the App**: Try all features (navigation, AR, voice commands)
2. **Check Documentation**: Read `docs/API_INTEGRATION.md` for detailed API info
3. **Review Architecture**: See `docs/ARCHITECTURE.md` for system design
4. **Run Tests**: Execute `npm test` in the server directory
5. **Customize**: Modify settings, themes, and preferences

## Database Exploration

### View All Collections:

```powershell
mongosh
use sensei
show collections
```

You should see:

- users
- user_profiles
- user_preferences
- emergency_contacts
- navigation_sessions
- routes
- detection_sessions
- detected_objects
- voice_commands
- emergency_alerts
- ocr_sessions
- wearable_devices
- saved_locations
- offline_maps
- system_logs

### View Data:

```javascript
db.users.find().pretty();
db.navigation_sessions.find().pretty();
db.emergency_alerts.find().pretty();
```

## Production Deployment

### Backend:

1. Set `NODE_ENV=production` in `.env`
2. Use a strong `JWT_SECRET`
3. Configure MongoDB Atlas for cloud database
4. Deploy to services like Heroku, AWS, or DigitalOcean
5. Enable HTTPS

### Frontend:

1. Build production app: `expo build:android` or `expo build:ios`
2. Update `API_BASE_URL` to production server URL
3. Submit to Google Play Store / Apple App Store

## Getting Help

- **Backend Logs**: Check the server terminal for errors
- **Frontend Logs**: Check the Expo terminal or Metro bundler
- **MongoDB Logs**: Check MongoDB log files
- **Documentation**: Review files in the `docs/` directory
- **Test Suite**: Run `npm test` in server directory

## System Requirements

### Minimum:

- 8GB RAM
- 4 CPU cores
- 10GB free disk space
- Windows 10/11, macOS 10.15+, or Linux

### Recommended:

- 16GB RAM
- 8 CPU cores
- 20GB free disk space
- SSD storage
- Stable internet connection

## Summary

You should now have:

- ✅ MongoDB running on localhost:27017
- ✅ Backend server running on localhost:3001
- ✅ Frontend app running on Expo
- ✅ Full API connectivity between frontend and backend
- ✅ User authentication working
- ✅ All 16 database collections created and accessible

**Congratulations! Your SENSEI development environment is ready!** 🎉
