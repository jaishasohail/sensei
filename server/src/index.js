import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import connectDatabase from './config/database.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import aiRouter from './routes/ai.js';
import navigationRouter from './routes/navigation.js';
import emergencyRouter from './routes/emergency.js';
import offlineMapsRouter from './routes/offline-maps.js';
import logsRouter from './routes/logs.js';

connectDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
