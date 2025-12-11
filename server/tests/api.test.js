import request from 'supertest';
import express from 'express';
import authRouter from '../src/routes/auth.js';

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);

describe('Auth routes', () => {
  test('register + login', async () => {
    const email = `user${Math.floor(Math.random()*10000)}@test.com`;
    const password = 'pass1234';
    const reg = await request(app).post('/api/auth/register').send({ email, password });
    expect(reg.status).toBe(200);
    expect(reg.body.token).toBeDefined();
    const login = await request(app).post('/api/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeDefined();
  });
});
