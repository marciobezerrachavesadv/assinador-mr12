import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 3000);
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();

export const config = {
  root,
  port,
  publicUrl: env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: env('TRUST_PROXY', '0'),
  dataDir: path.resolve(env('DATA_DIR', path.join(root, 'data'))),
  storageDir: path.resolve(env('STORAGE_DIR', path.join(root, 'storage'))),
  tz: 'America/Rio_Branco',
  org: { name: env('ORG_NAME', 'MR12') },
  admin: {
    email: env('ADMIN_EMAIL'),
    name: env('ADMIN_NAME', 'Administrador'),
    password: process.env.ADMIN_PASSWORD ?? '',
  },
  icp: {
    p12Path: env('ICP_P12_PATH'),
    p12Password: process.env.ICP_P12_PASSWORD ?? '',
    policyOid: env('ICP_POLICY_OID'),
    policyHashSha256: env('ICP_POLICY_HASH_SHA256').toLowerCase(),
    policyUri: env('ICP_POLICY_URI'),
    signatureBytes: Number(env('ICP_SIGNATURE_BYTES', '16384')),
  },
  trustedRootsDir: path.resolve(env('TRUSTED_ROOTS_DIR', path.join(root, 'certs', 'raizes'))),
  mail: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER'),
    pass: (process.env.SMTP_PASS ?? '').replace(/\s+/g, ''), // senha de app do Google vem com espacos
    from: env('MAIL_FROM'),
    copy: env('MAIL_COPY').split(/[,;\s]+/).filter(Boolean),
  },
  notify: { url: env('NOTIFY_WEBHOOK_URL'), secret: env('NOTIFY_WEBHOOK_SECRET') },
  limits: { pdfBytes: 10 * 1024 * 1024, signers: 20, files: 12, placements: 80 },
};

export const isHttps = config.publicUrl.startsWith('https://');
