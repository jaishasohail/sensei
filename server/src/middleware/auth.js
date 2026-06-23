import jwt from 'jsonwebtoken';
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    req.user = payload;
    next();
  } catch (e) {
    // Distinguish expired tokens from genuinely invalid ones so the client
    // can show a "session expired, please log in again" message instead of
    // a generic error.
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
export function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
}
