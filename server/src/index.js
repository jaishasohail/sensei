import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import connectDatabase from './config/database.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import aiRouter from './routes/ai.js';
import navigationRouter from './routes/navigation.js';
import emergencyRouter from './routes/emergency.js';
import offlineMapsRouter from './routes/offline-maps.js';
import logsRouter from './routes/logs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

connectDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── face-api.js model files served as static assets ──────────────────────────
// Client downloads TinyFaceDetector + FaceExpressionNet weights once at startup.
// Path: /models/face-api/<model-name>-weights_manifest.json + *.bin
const FACE_API_MODELS = path.resolve(
  __dirname, '..', 'node_modules', '@vladmandic', 'face-api', 'model'
);
app.use('/models/face-api', express.static(FACE_API_MODELS));

// ── coco-ssd model files served as static assets ─────────────────────────────
// Avoids runtime CDN downloads (storage.googleapis.com) which fail when the
// device is on a LAN-only Wi-Fi with no internet access.
// Run `node server/scripts/download-coco-ssd.js` once to populate these files.
// Path: /models/coco-ssd/ssdlite_mobilenet_v2/model.json  (+ weight shards)
//       /models/coco-ssd/ssd_mobilenet_v1/model.json
const COCO_SSD_MODELS = path.resolve(__dirname, '..', 'models', 'coco-ssd');
app.use('/models/coco-ssd', express.static(COCO_SSD_MODELS));

app.get('/health', (req, res) => res.json({ status: 'ok', database: 'connected' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', database: 'connected' }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/ai', aiRouter);
app.use('/api/navigation', navigationRouter);
app.use('/api/emergency', emergencyRouter);
app.use('/api/offline-maps', offlineMapsRouter);
app.use('/api/logs', logsRouter);

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.emit('hello', { message: 'Sensei server connected' });
});

app.set('io', io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Sensei server listening on port ${PORT}`);
});
