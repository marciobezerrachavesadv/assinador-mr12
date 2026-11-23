// Selo digital PAdES (CAdES detached) com o certificado A1 da empresa.
// O CMS e montado aqui (node-forge so para ASN.1/RSA) para controlar os atributos assinados:
//   contentType, messageDigest, signingTime, signing-certificate-v2 e, se configurada, a politica de assinatura.
// IMPORTANTE: sem a politica ICP (AD-RB) conferida no LPA do ITI, o selo e um PAdES-B-B valido tecnicamente,
// mas a "conformidade ICP-Brasil" so e atestada pelo Validar do ITI.
import fs from 'node:fs';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { config } from '../config.js';

const { asn1, pki, pkcs12 } = forge;
const U = asn1.Class.UNIVERSAL;
const C = asn1.Class.CONTEXT_SPECIFIC;
const T = asn1.Type;

const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertV2: '1.2.840.113549.1.9.16.2.47',
  sigPolicy: '1.2.840.113549.1.9.16.2.15',
  spUri: '1.2.840.113549.1.9.16.5.1',
};

const seq = (a) => asn1.create(U, T.SEQUENCE, true, a);
const set = (a) => asn1.create(U, T.SET, true, a);
const oid = (s) => asn1.create(U, T.OID, false, asn1.oidToDer(s).getBytes());
const octets = (b) => asn1.create(U, T.OCTETSTRING, false, b);
const nul = () => asn1.create(U, T.NULL, false, '');
const ia5 = (s) => asn1.create(U, T.IA5STRING, false, s);
const int1 = () => asn1.create(U, T.INTEGER, false, String.fromCharCode(1));
const ctx = (n, a) => asn1.create(C, n, true, a);
const algId = (o) => seq([oid(o), nul()]);
const attr = (type, value) => seq([oid(type), set([value])]);
const derOf = (node) => asn1.toDer(node).getBytes();

function certParts(cert) {
  const tbs = cert.tbsCertificate || pki.getTBSCertificate(cert);
  const hasVersion = tbs.value[0].tagClass === C && tbs.value[0].type === 0;
  return {
    serial: tbs.value[hasVersion ? 1 : 0],
    issuer: tbs.value[hasVersion ? 3 : 2],
  };
}

function signingCertificateV2(cert) {
  const der = derOf(pki.certificateToAsn1(cert));
  const certHash = crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest().toString('binary');
  const { serial, issuer } = certParts(cert);
  const issuerSerial = seq([seq([ctx(4, [issuer])]), serial]);
  // hashAlgorithm omitido (DEFAULT sha256)
  return seq([seq([seq([octets(certHash), issuerSerial])])]);
}

function policyValue({ oid: pOid, hashHex, uri }) {
  const hash = Buffer.from(hashHex, 'hex').toString('binary');
  const parts = [oid(pOid), seq([algId(OID.sha256), octets(hash)])];
  if (uri) parts.push(seq([seq([oid(OID.spUri), ia5(uri)])]));
  return seq(parts);
}

class A1Signer extends Signer {
  constructor({ key, cert, chain, policy }) {
    super();
    Object.assign(this, { key, cert, chain, policy });
  }

  async sign(content, signingTime = new Date()) {
    const md = crypto.createHash('sha256').update(content).digest().toString('binary');
    const attrs = [
      attr(OID.contentType, oid(OID.data)),
      attr(OID.messageDigest, octets(md)),
      attr(OID.signingTime, asn1.create(U, T.UTCTIME, false, asn1.dateToUtcTime(signingTime))),
      attr(OID.signingCertV2, signingCertificateV2(this.cert)),
    ];
    if (this.policy) attrs.push(attr(OID.sigPolicy, policyValue(this.policy)));
    // DER SET OF: ordenado pelos bytes codificados
    const sorted = attrs.map((a) => ({ a, d: derOf(a) })).sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0)).map((x) => x.a);

    const toSign = forge.md.sha256.create();
    toSign.update(derOf(set(sorted)));
    const signature = this.key.sign(toSign);

    const { serial, issuer } = certParts(this.cert);
    const signerInfo = seq([
      int1(),
      seq([issuer, serial]),
      algId(OID.sha256),
      ctx(0, sorted),
      algId(OID.sha256WithRSA),
      octets(signature),
    ]);
    const signedData = seq([
      int1(),
      set([algId(OID.sha256)]),
      seq([oid(OID.data)]),
      ctx(0, this.chain.map((c) => pki.certificateToAsn1(c))),
      set([signerInfo]),
    ]);
    const contentInfo = seq([oid(OID.signedData), ctx(0, [signedData])]);
    return Buffer.from(derOf(contentInfo), 'binary');
  }
}

const cnOf = (name) => name.getField('CN')?.value || name.attributes.map((a) => a.value).join(', ');

export function loadSealer() {
  const { p12Path, p12Password, policyOid, policyHashSha256, policyUri, signatureBytes } = config.icp;
  if (!p12Path) return null;

  let p12;
  try {
    const der = fs.readFileSync(p12Path).toString('binary');
    p12 = pkcs12.pkcs12FromAsn1(asn1.fromDer(der), false, p12Password);
  } catch {
    throw new Error('Nao foi possivel abrir o certificado A1 (arquivo ausente, invalido ou senha incorreta). Verifique ICP_P12_PATH e ICP_P12_PASSWORD.');
  }
  const bagsOf = (t) => p12.getBags({ bagType: t })[t] || [];
  const keyBag = [...bagsOf(pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(pki.oids.keyBag)][0];
  const certs = bagsOf(pki.oids.certBag).map((b) => b.cert).filter(Boolean);
  if (!keyBag?.key || !certs.length) throw new Error('O arquivo .p12 nao tem chave privada e certificado.');

  const cert = certs.find((c) => c.publicKey.n.compareTo(keyBag.key.n) === 0 && c.publicKey.e.compareTo(keyBag.key.e) === 0);
  if (!cert) throw new Error('Nenhum certificado do .p12 corresponde a chave privada.');

  const now = new Date();
  if (now < cert.validity.notBefore || now > cert.validity.notAfter) {
    throw new Error(`O certificado A1 esta fora da validade (${cert.validity.notBefore.toISOString().slice(0, 10)} a ${cert.validity.notAfter.toISOString().slice(0, 10)}).`);
  }

  // cadeia: certificado do titular primeiro, depois os demais (sem duplicar)
  const chain = [cert, ...certs.filter((c) => c !== cert)];

  let policy = null;
  if (policyOid || policyHashSha256) {
    if (!/^\d+(\.\d+)+$/.test(policyOid) || !/^[0-9a-f]{64}$/.test(policyHashSha256)) {
      throw new Error('ICP_POLICY_OID / ICP_POLICY_HASH_SHA256 invalidos (use o OID e o hash SHA-256 em hexadecimal do LPA do ITI).');
    }
    policy = { oid: policyOid, hashHex: policyHashSha256, uri: policyUri || '' };
  }

  const signer = new A1Signer({ key: keyBag.key, cert, chain, policy });
  const info = {
    subject: cnOf(cert.subject),
    issuer: cnOf(cert.issuer),
    serialHex: cert.serialNumber,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    daysLeft: Math.floor((cert.validity.notAfter - now) / 864e5),
    signaturePolicy: policy ? policy.oid : null,
  };

  return {
    info,
    // pdfDoc: PDFDocument do pdf-lib ja montado. Devolve os bytes do PDF selado.
    async seal(pdfDoc) {
      const signingTime = new Date();
      pdflibAddPlaceholder({
        pdfDoc,
        reason: 'Selo digital do documento assinado eletronicamente',
        contactInfo: config.admin.email || config.org.name,
        name: info.subject,
        location: config.org.name,
        signingTime,
        signatureLength: signatureBytes,
        subFilter: SUBFILTER_ETSI_CADES_DETACHED,
        appName: 'AssinadorMR12',
      });
      const bytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
      return new SignPdf().sign(bytes, signer, signingTime);
    },
  };
}
