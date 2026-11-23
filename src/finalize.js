import fs from 'node:fs';
import path from 'node:path';
import { db, logEvent } from './db.js';
import { config } from './config.js';
import { loadSealer } from './pdf/seal.js';
import { buildFinalPdf } from './pdf/final.js';
import { randomToken, sha256Hex, nowIso } from './util.js';
import { emit } from './notify.js';
import { sendCopies } from './mail.js';

let sealer = null;
let sealerError = null;

export function initSealer() {
  try {
    sealer = loadSealer();
    sealerError = null;
    if (sealer) {
      console.log(`Selo ICP ativo: ${sealer.info.subject} (vence em ${sealer.info.daysLeft} dias)`);
      if (sealer.info.daysLeft < 30) console.warn('ATENCAO: o certificado A1 vence em menos de 30 dias.');
      if (!sealer.info.signaturePolicy) console.warn('Aviso: sem politica de assinatura ICP (ICP_POLICY_*). O selo e PAdES-B-B; confira a conformidade no Validar do ITI.');
    } else console.log('Selo ICP desativado (ICP_P12_PATH vazio). Os documentos saem com termo e evidencias, sem selo digital.');
  } catch (e) {
    sealer = null;
    sealerError = e.message;
    console.error(`Selo ICP configurado, mas indisponivel: ${e.message}`);
  }
}
export const sealerStatus = () => ({ enabled: !!sealer, info: sealer?.info ?? null, error: sealerError });

const abs = (kind, file) => (file ? path.join(config.storageDir, kind, file) : null);

export async function finalizeDocument(docId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  try {
    if (sealerError) throw new Error(`Selo ICP indisponivel: ${sealerError}`);
    const signers = db.prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY ord, id').all(docId)
      .map((s) => ({ ...s, signature_path: abs('signatures', s.signature_file), selfie_path: abs('selfies', s.selfie_file) }));
    if (signers.some((s) => s.status !== 'signed')) throw new Error('Ainda ha signatarios pendentes.');
    const names = new Map(signers.map((s) => [s.id, s.name]));
    const events = db.prepare(`SELECT e.*, u.name AS byName FROM events e
                               LEFT JOIN documents d ON d.id = e.document_id
                               LEFT JOIN users u ON u.id = d.created_by AND e.type = 'created'
                               WHERE e.document_id = ? ORDER BY e.at, e.id`).all(docId)
      .map((e) => ({ ...e, signerName: names.get(e.signer_id) || '' }));

    const originalBytes = fs.readFileSync(abs('originals', doc.original_file));
    const pdfDoc = await buildFinalPdf({ originalBytes, doc, signers, events, sealInfo: sealer?.info ?? null });
    const finalBytes = sealer ? Buffer.from(await sealer.seal(pdfDoc)) : Buffer.from(await pdfDoc.save());

    const finalName = `${docId}-${randomToken(12)}.pdf`;
    fs.writeFileSync(abs('finals', finalName), finalBytes, { mode: 0o600 });
    db.prepare(`UPDATE documents SET status='signed', final_file=?, final_sha256=?, seal_info=?, error=NULL, completed_at=? WHERE id=?`)
      .run(finalName, sha256Hex(finalBytes), sealer ? JSON.stringify(sealer.info) : null, nowIso(), docId);
    logEvent(docId, null, 'completed');
    emit('doc_completed', { documentId: docId, code: doc.code, title: doc.title, sealed: !!sealer });
    sendCopies(docId).catch((e) => console.error('Envio da copia por e-mail falhou:', e.message)); // nao trava nem desfaz a assinatura
    return { ok: true };
  } catch (e) {
    db.prepare(`UPDATE documents SET status='error', error=? WHERE id=?`).run(String(e.message).slice(0, 500), docId);
    logEvent(docId, null, 'finalize_error', { detail: { message: String(e.message).slice(0, 300) } });
    emit('doc_error', { documentId: docId, code: doc?.code, message: e.message });
    console.error(`Falha ao finalizar documento ${docId}:`, e);
    return { ok: false, error: e.message };
  }
}
