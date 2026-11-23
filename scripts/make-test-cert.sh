#!/usr/bin/env bash
# Gera uma AC de TESTE e um certificado "e-CNPJ de teste" (A1) para provar o fluxo de selo.
# NAO e ICP-Brasil: serve so para testar o sistema. Saida em certs/teste/ (ignorado pelo git).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=certs/teste
mkdir -p "$OUT/raizes"
cd "$OUT"

openssl req -x509 -newkey rsa:3072 -nodes -keyout ca.key -out ca.pem -days 3650 -sha256 \
  -subj "/C=BR/O=AC TESTE LOCAL/CN=AC Raiz de Teste" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

cat > leaf.cnf <<CNF
[req]
distinguished_name=dn
prompt=no
[dn]
C=BR
O=ICP-Brasil TESTE
OU=Certificado PJ A1 de TESTE
CN=GRUPO MR12 TESTE:00000000000191
[ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,nonRepudiation
extendedKeyUsage=emailProtection,clientAuth
certificatePolicies=2.16.76.1.2.1.1
subjectAltName=otherName:2.16.76.1.3.3;UTF8:00000000000191,otherName:2.16.76.1.3.2;UTF8:RESPONSAVEL DE TESTE
CNF

openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -config leaf.cnf 2>/dev/null
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 365 -sha256 \
  -extfile leaf.cnf -extensions ext 2>/dev/null

# PBE antigo (3DES/SHA1) porque o node-forge nao le o formato novo do OpenSSL 3
openssl pkcs12 -export -inkey leaf.key -in leaf.pem -certfile ca.pem -out teste.p12 -name "mr12-teste" \
  -passout pass:teste123 -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

cp ca.pem raizes/ac-teste.pem
rm -f leaf.csr ca.srl leaf.cnf
chmod 600 ca.key leaf.key teste.p12
echo "Certificado de teste: $OUT/teste.p12 (senha: teste123) | raiz de teste: $OUT/raizes/ac-teste.pem"
