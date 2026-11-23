import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
for (const d of ['originals', 'finals', 'signatures', 'selfies']) {
  fs.mkdirSync(path.join(config.storageDir, d), { recursive: true });
}

export const db = new Database(path.join(config.dataDir, 'assinador.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | finalizing | signed | cancelled | error
  ordered INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,                                -- AAAA-MM-DD (fuso da empresa)
  original_file TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  final_file TEXT,
  final_sha256 TEXT,
  seal_info TEXT,                               -- JSON do selo ICP, se houve
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS signers (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  cpf TEXT,
  email TEXT,
  phone TEXT,
  ord INTEGER NOT NULL DEFAULT 1,
  require_selfie INTEGER NOT NULL DEFAULT 0,
  require_cpf INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new',           -- new | viewed | signed | refused
  view_count INTEGER NOT NULL DEFAULT 0,
  first_viewed_at TEXT,
  consent_text TEXT,
  signed_at TEXT,
  cpf_declared TEXT,
  ip TEXT,
  user_agent TEXT,
  geo_lat REAL,
  geo_lng REAL,
  geo_acc REAL,
  auth_method TEXT,
  signature_file TEXT,
  selfie_file TEXT,
  refused_reason TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  signer_id INTEGER REFERENCES signers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signers_doc ON signers(document_id);
CREATE INDEX IF NOT EXISTS idx_events_doc ON events(document_id);
`);

// migracao simples: posicoes das assinaturas no PDF (JSON) — bancos antigos ganham a coluna
if (!db.prepare("PRAGMA table_info(documents)").all().some((c) => c.name === 'placements')) db.exec('ALTER TABLE documents ADD COLUMN placements TEXT');

if (!db.prepare("PRAGMA table_info(signers)").all().some((c) => c.name === 'email_declared')) db.exec('ALTER TABLE signers ADD COLUMN email_declared TEXT');

if (!db.prepare("PRAGMA table_info(signers)").all().some((c) => c.name === 'require_geo')) db.exec('ALTER TABLE signers ADD COLUMN require_geo INTEGER NOT NULL DEFAULT 0');

export function logEvent(documentId, signerId, type, { detail = null, ip = null, ua = null } = {}) {
  db.prepare(`INSERT INTO events (document_id, signer_id, type, detail, ip, user_agent, at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(documentId, signerId, type, detail ? JSON.stringify(detail) : null, ip, ua ? String(ua).slice(0, 300) : null, new Date().toISOString());
}
