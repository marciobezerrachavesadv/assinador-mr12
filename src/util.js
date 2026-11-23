import crypto from 'node:crypto';
import { config } from './config.js';

export const nowIso = () => new Date().toISOString();
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Codigo curto de verificacao (sem caracteres ambiguos)
export function verificationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (const x of b) s += alphabet[x % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export function onlyDigits(s) { return String(s ?? '').replace(/\D+/g, ''); }

export function isValidCpf(value) {
  const c = onlyDigits(value);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

export function formatCpf(value) {
  const c = onlyDigits(value);
  return c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : String(value ?? '');
}

export function normalizePhone(value) {
  let d = onlyDigits(value);
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? d : '';
}

const fmtLocalParts = new Intl.DateTimeFormat('pt-BR', {
  timeZone: config.tz, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return fmtLocalParts.format(d).replace(',', '');
}
export function fmtUtc(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
// 'AAAA-MM-DD' de hoje no fuso da empresa
export function todayLocalDate() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;
}

export function safeFilename(name, fallback = 'documento') {
  const base = String(name ?? '').normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
  return base || fallback;
}

export function dataUrlToBuffer(dataUrl, mimes) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl ?? ''));
  if (!m || !mimes.includes(m[1].toLowerCase())) return null;
  return Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
}

export const isPng = (b) => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
export const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isPdf = (b) => b.length > 8 && b.subarray(0, 1024).toString('latin1').includes('%PDF-');
export function pngSize(b) { return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
