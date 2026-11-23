// Redefine a senha de um usuario do painel.
// Uso (Docker): docker compose exec app node scripts/reset-senha.mjs email@dominio.com 'nova-senha-grande'
// Uso (sem Docker): node scripts/reset-senha.mjs email@dominio.com 'nova-senha-grande'
import { db } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const [email, senha] = process.argv.slice(2);
if (!email || !senha || senha.length < 10) {
  console.error('Uso: node scripts/reset-senha.mjs email "nova-senha-com-10-ou-mais-caracteres"');
  process.exit(1);
}
const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
if (!u) { console.error('Usuario nao encontrado: ' + email); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(senha), u.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // derruba logins antigos
console.log('Senha redefinida para ' + email);
