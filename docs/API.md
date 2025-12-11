# Sensei API

Base URL: `http://<server>:3001`

- `GET /health` — server health

Auth

- `POST /api/auth/register` { email, password } -> { token, user }
- `POST /api/auth/login` { email, password } -> { token, user }

Users

- `GET /api/users/me` Bearer -> profile
- `PUT /api/users/me` Bearer { ...partialProfile } -> profile

AI

- `POST /api/ai/ocr` { image: base64 } -> { text, confidence }
- `POST /api/ai/emotion` { faceImage: base64 } -> { emotion, confidence }
- `POST /api/ai/depth` { image: base64 } -> { nearest, mean }

Navigation

- `POST /api/navigation/route` (Bearer) { origin, destination, mode } -> session
- `GET /api/navigation/status` (Bearer) -> session
- `POST /api/navigation/stop` (Bearer) -> { stopped }

Emergency

- `POST /api/emergency/alert` { location, message } -> { ok }

WebSocket Events

- `hello` — on connect
- `emergency` — broadcast of alerts
