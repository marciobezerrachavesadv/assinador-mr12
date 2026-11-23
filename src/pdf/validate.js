// Validador de assinaturas digitais em PDF (PAdES/CAdES detached).
// Confere: integridade (hash do ByteRange), assinatura criptografica, cobertura do arquivo, validade do
// certificado, cadeia contra as raizes configuradas e atributos CAdES. NAO consulta revogacao (OCSP/LCR)
// e NAO substitui o Validar do ITI para atestar conformidade com a politica ICP-Brasil.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';

const { asn1 } = forge;
const C = asn1.Class.CONTEXT_SPECIFIC;
const U = asn1.Class.UNIVERSAL;

const HASHES = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
const A_CONTENT = {
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  essV1: '1.2.840.113549.1.9.16.2.12',
  essV2: '1.2.840.113549.1.9.16.2.47',
  policy: '1.2.840.113549.1.9.16.2.15',
};
const ICP_OTHER = {
  '2.16.76.1.3.1': 'pf',
  '2.16.76.1.3.2': 'responsavelNome',
  '2.16.76.1.3.3': 'cnpj',
  '2.16.76.1.3.4': 'responsavel',
};

export function loadTrustedRoots(dir) {
  const roots = [];
  if (!dir || !fs.existsSync(dir)) return roots;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(crt|cer|pem|der)$/i.test(f)) continue;
    const raw = fs.readFileSync(path.join(dir, f));
    const text = raw.toString('latin1');
    const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    try {
      if (pems) pems.forEach((p) => roots.push(new crypto.X509Certificate(p)));
      else roots.push(new crypto.X509Certificate(raw));
    } catch { /* arquivo que nao e certificado: ignora */ }
  }
  return roots;
}

const dnToObj = (s) => {
  const o = {};
  for (const line of String(s).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
};
const utf8 = (bin) => Buffer.from(bin, 'binary').toString('utf8');

function certExtensions(x509) {
  const out = {};
  try {
    const tbs = asn1.fromDer(x509.raw.toString('binary')).value[0];
    const extWrap = tbs.value.find((n) => n.tagClass === C && n.type === 3);
    if (!extWrap) return out;
    for (const ext of extWrap.value[0].value) {
      const id = asn1.derToOid(ext.value[0].value);
      const valueNode = ext.value[ext.value.length - 1];
      out[id] = asn1.fromDer(valueNode.value);
    }
  } catch { /* extensao malformada: ignora */ }
  return out;
}

function certIdentity(x509) {
  const ext = certExtensions(x509);
  const idInfo = { policies: [], email: null };
  const san = ext['2.5.29.17'];
  if (san) {
    for (const gn of san.value) {
      if (gn.tagClass !== C) continue;
      if (gn.type === 0) {
        try {
          const o = asn1.derToOid(gn.value[0].value);
          const v = utf8(gn.value[1].value[0].value);
          const kind = ICP_OTHER[o];
          if (kind === 'cnpj') idInfo.cnpj = v.replace(/\D/g, '').slice(0, 14);
          else if (kind === 'pf') idInfo.cpf = v.slice(8, 19);
          else if (kind === 'responsavel') idInfo.cpfResponsavel = v.slice(8, 19);
          else if (kind === 'responsavelNome') idInfo.responsavelNome = v;
        } catch { /* ignora */ }
      } else if (gn.type === 1) idInfo.email = gn.value;
    }
  }
  const pol = ext['2.5.29.32'];
  if (pol) for (const pi of pol.value) { try { idInfo.policies.push(asn1.derToOid(pi.value[0].value)); } catch { /* */ } }
  const a1 = idInfo.policies.find((p) => /^2\.16\.76\.1\.2\.1\.\d+$/.test(p));
  const a3 = idInfo.policies.find((p) => /^2\.16\.76\.1\.2\.3\.\d+$/.test(p));
  idInfo.icpCertificateType = a1 ? 'A1' : a3 ? 'A3' : null;
  return idInfo;
}

const certView = (x509) => {
  const subj = dnToObj(x509.subject);
  const iss = dnToObj(x509.issuer);
  return {
    commonName: subj.CN || '',
    organization: subj.O || '',
    issuer: iss.CN || x509.issuer.replace(/\n/g, ', '),
    serial: x509.serialNumber,
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: new Date(x509.validTo).toISOString(),
    ...certIdentity(x509),
  };
};

function parseCms(derBuf) {
  const ci = asn1.fromDer(derBuf.toString('binary'), { strict: false, parseAllBytes: false });
  const sd = ci.value[1].value[0];
  const certsNode = sd.value.find((n) => n.tagClass === C && n.type === 0);
  const siSet = sd.value[sd.value.length - 1];
  const certs = [];
  for (const c of certsNode?.value || []) {
    if (c.tagClass !== U) continue;
    try { certs.push(new crypto.X509Certificate(Buffer.from(asn1.toDer(c).getBytes(), 'binary'))); } catch { /* */ }
  }
  const si = siSet.value[0];
  let i = 1;
  const sid = si.value[i++];
  const digestOid = asn1.derToOid(si.value[i++].value[0].value);
  let signedAttrs = null;
  if (si.value[i].tagClass === C && si.value[i].type === 0) signedAttrs = si.value[i++];
  i++; // signatureAlgorithm
  const signature = Buffer.from(si.value[i].value, 'binary');
  return { certs, sid, digestOid, signedAttrs, signature };
}

function attrsOf(signedAttrs) {
  const m = {};
  for (const a of signedAttrs?.value || []) {
    try { m[asn1.derToOid(a.value[0].value)] = a.value[1].value[0]; } catch { /* */ }
  }
  return m;
}

function sidMatches(sid, x509) {
  try {
    if (sid.tagClass === U && sid.type === asn1.Type.SEQUENCE) {
      const serialHex = forge.util.bytesToHex(sid.value[1].value).replace(/^0+/, '').toUpperCase();
      return x509.serialNumber.replace(/^0+/, '').toUpperCase() === serialHex;
    }
  } catch { /* */ }
  return false;
}

function buildChain(leaf, embedded, roots, at) {
  const path = [leaf];
  const notes = [];
  const sameCert = (a, b) => a.raw.equals(b.raw);
  const validAt = (c) => new Date(c.validFrom) <= at && at <= new Date(c.validTo);
  if (!roots.length) return { status: 'unchecked', root: null, path, notes: ['Nenhuma raiz configurada (coloque as raizes ICP-Brasil em certs/raizes).'] };
  let cur = leaf;
  for (let hop = 0; hop < 8; hop++) {
    if (!validAt(cur)) notes.push(`Certificado fora da validade na data da assinatura: ${dnToObj(cur.subject).CN || cur.subject}`);
    const anchor = roots.find((r) => sameCert(r, cur) || (cur.checkIssued(r) && cur.verify(r.publicKey)));
    if (anchor) {
      if (!sameCert(anchor, cur)) path.push(anchor);
      if (!validAt(anchor)) notes.push('A raiz esta fora da validade na data da assinatura.');
      return { status: notes.length ? 'untrusted' : 'trusted', root: dnToObj(anchor.subject).CN || anchor.subject, path, notes };
    }
    const next = embedded.find((e) => !path.some((p) => sameCert(p, e)) && cur.checkIssued(e) && cur.verify(e.publicKey) && e.ca);
    if (!next) break;
    path.push(next);
    cur = next;
  }
  notes.push('A cadeia nao chega a nenhuma raiz configurada.');
  return { status: 'untrusted', root: null, path, notes };
}

function windowAround(latin, idx) {
  return latin.slice(Math.max(0, idx - 1500), Math.min(latin.length, idx + 1500));
}

export function validatePdf(buf, { trustedRoots = [] } = {}) {
  const latin = buf.toString('latin1');
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const signatures = [];
  let m;
  while ((m = re.exec(latin))) {
    const br = m.slice(1, 5).map(Number);
    const sig = { index: signatures.length + 1, byteRange: br, messages: [] };
    signatures.push(sig);
    try {
      if (br[0] !== 0 || br[1] + br[3] > buf.length || br[2] + br[3] > buf.length) throw new Error('ByteRange invalido');
      const sub = /\/SubFilter\s*\/([A-Za-z0-9._-]+)/.exec(windowAround(latin, m.index));
      sig.subFilter = sub ? sub[1] : null;
      const gap = buf.subarray(br[1], br[2]).toString('latin1').trim();
      const hex = gap.replace(/^</, '').replace(/>$/, '').replace(/\s+/g, '');
      const cms = parseCms(Buffer.from(hex, 'hex'));
      const content = Buffer.concat([buf.subarray(br[0], br[0] + br[1]), buf.subarray(br[2], br[2] + br[3])]);
      const digestName = HASHES[cms.digestOid];
      if (!digestName) throw new Error(`Algoritmo de resumo nao suportado (${cms.digestOid})`);

      const attrs = attrsOf(cms.signedAttrs);
      const contentDigest = crypto.createHash(digestName).update(content).digest();
      let digestMatches = true;
      let signedBytes = content;
      if (cms.signedAttrs) {
        const md = attrs[A_CONTENT.messageDigest];
        digestMatches = !!md && Buffer.from(md.value, 'binary').equals(contentDigest);
        const copy = asn1.copy(cms.signedAttrs);
        copy.tagClass = U;
        copy.type = asn1.Type.SET;
        signedBytes = Buffer.from(asn1.toDer(copy).getBytes(), 'binary');
      }
      const leaf = cms.certs.find((c) => sidMatches(cms.sid, c)) || cms.certs[0];
      if (!leaf) throw new Error('Assinatura sem certificado embutido');
      const signatureValid = crypto.createVerify(digestName).update(signedBytes).verify(leaf.publicKey, cms.signature);

      let signingTime = null;
      const st = attrs[A_CONTENT.signingTime];
      if (st) signingTime = (st.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(st.value) : asn1.generalizedTimeToDate(st.value)).toISOString();
      if (!signingTime) {
        const mm = /\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(windowAround(latin, m.index));
        if (mm) signingTime = new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6])).toISOString();
      }
      const at = signingTime ? new Date(signingTime) : new Date();

      const tail = buf.subarray(br[2] + br[3]);
      const coversWholeFile = tail.every((b) => b === 0x0a || b === 0x0d || b === 0x20 || b === 0x00);

      const chain = buildChain(leaf, cms.certs, trustedRoots, at);
      const policyAttr = attrs[A_CONTENT.policy];
      let policyOid = null;
      try { if (policyAttr) policyOid = asn1.derToOid(policyAttr.value[0].value); } catch { /* */ }

      Object.assign(sig, {
        signer: certView(leaf),
        signingTime,
        integrity: { digestMatches, signatureValid, coversWholeFile, bytesAfterSignature: tail.length },
        chain,
        cades: { signingCertificateAttr: !!(attrs[A_CONTENT.essV2] || attrs[A_CONTENT.essV1]), signaturePolicyOid: policyOid },
        revocation: 'nao_consultada',
      });
      if (!digestMatches || !signatureValid) {
        sig.verdict = 'invalida';
        sig.verdictLabel = 'Assinatura inválida: o conteúdo foi alterado ou a assinatura não confere.';
      } else if (!coversWholeFile) {
        sig.verdict = 'integra_alterado_depois';
        sig.verdictLabel = 'Assinatura íntegra, mas há conteúdo acrescentado ao arquivo depois dela (outra assinatura ou alteração).';
      } else if (chain.status === 'trusted') {
        sig.verdict = 'integra_cadeia_confiavel';
        sig.verdictLabel = 'Assinatura íntegra e cadeia de certificação confiável. Revogação não consultada.';
      } else {
        sig.verdict = 'integra_cadeia_nao_confiavel';
        sig.verdictLabel = chain.status === 'unchecked'
          ? 'Assinatura íntegra. Cadeia não verificada (nenhuma raiz configurada).'
          : 'Assinatura íntegra, mas a cadeia não foi confirmada pelas raízes configuradas.';
      }
    } catch (e) {
      sig.verdict = 'ilegivel';
      sig.verdictLabel = 'Não foi possível ler esta assinatura.';
      sig.messages.push(String(e.message || e));
    }
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    sha256,
    size: buf.length,
    hasSignatures: signatures.length > 0,
    signatures,
    note: 'Esta conferência técnica não consulta revogação (OCSP/LCR) e não atesta conformidade com a política de assinatura ICP-Brasil. Para validade oficial, confira também no Validar do ITI: https://validar.iti.gov.br',
  };
}
