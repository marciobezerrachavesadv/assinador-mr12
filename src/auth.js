import crypto from 'node:crypto';
import { db } from './db.js';
import { config, isHttps } from './config.js';
import { nowIso } from './util.js';

const COOKIE = 'mr12sid';
const SESSION_DAYS = 7;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const th = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function ensureFirstAdmin() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return;
  const { email, name, password } = config.admin;
  if (!email || password.length < 10) {
    throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD (minimo 10 caracteres) para criar o primeiro usuario.');
  }
  db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)')
    .run(email.toLowerCase(), name, hashPassword(password), nowIso());
  console.log(`Primeiro administrador criado: ${email}`);
}

function cookieAttrs(maxAgeSec) {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps ? '; Secure' : ''}`;
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(th(token), userId, exp);
  res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(SESSION_DAYS * 86400)}`);
}

export function endSession(req, res) {
  const t = readCookie(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th(t));
  res.append('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
}

function readCookie(req) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

export function currentUser(req) {
  const t = readCookie(req);
  if (!t) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, s.expires_at FROM sessions s
                          JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(th(t));
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th(t));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.user = u;
  next();
}

// Limitador simples em memoria (por chave)
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco e tente de novo.' });
    }
    arr.push(now);
    hits.set(k, arr);
    if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(kk);
    next();
  };
}
