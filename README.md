# AssinadorMR12

Assinatura eletrônica de documentos para uso próprio da MR12: você sobe um PDF, gera um link por signatário, o cliente assina na tela (celular ou PC), com selfie opcional, e o PDF final sai com termo de assinaturas, relatório de evidências, QR de verificação e **selo digital com o e-CNPJ A1 da empresa**. Inclui validador de PDFs assinados.

Uma organização só, sem planos nem créditos. Não foi feito para revenda.

> **Publicar no ar com HTTPS:** servidor com Docker + Caddy, tudo pronto em `Dockerfile`, `docker-compose.yml` e `Caddyfile` (HTTPS automático). Esqueceu a senha do painel: `docker compose exec app node scripts/reset-senha.mjs email "nova-senha"`.

## O que ele faz

- Painel (`/admin/`): login, novos documentos, signatários, ordem de assinatura, prazo, links, botão de WhatsApp (abre `wa.me` com a mensagem pronta), histórico, cancelamento, equipe.
- Página do signatário (`/s/<token>`): lê o PDF, confirma CPF, selfie (câmera ou foto), assinatura desenhada ou digitada, aceite do termo, localização opcional, opção de recusar.
- PDF final: páginas originais + termo + relatório (CPF, data/hora em Rio Branco e UTC, IP, aparelho, aceite, selfie, histórico, hash) + rodapé em todas as páginas + selo A1.
- Verificação pública (`/verificar/<código>`): mostra situação, hashes e quem assinou (sem CPF).
- Validar PDF (painel): integridade, cadeia, identidade do certificado (CNPJ/CPF, tipo A1/A3), atributos CAdES. **Não consulta revogação (LCR/OCSP)**.

## Rodar

```bash
npm install
cp .env.example .env      # edite os valores
# carregue o .env (ex.: node --env-file=.env src/server.js)
npm start
```

Variáveis principais (`.env.example` tem todas): `PUBLIC_URL` (endereço real, com https), `ADMIN_EMAIL` e `ADMIN_PASSWORD` (mín. 10 caracteres; só criam o primeiro usuário), `ORG_NAME`, `TRUST_PROXY` (1 se estiver atrás de nginx/Caddy).

**HTTPS é obrigatório em produção**: o navegador só abre a câmera da selfie em HTTPS. Coloque atrás de Caddy/nginx. Dados ficam em `data/` (SQLite) e `storage/` (PDFs, assinaturas, selfies): faça backup dos dois.

## E-mail, posição das assinaturas, vários documentos e localização

- **Cópia por e-mail:** quando o último signatário assina, o PDF selado é enviado para cada signatário (no e-mail que ele informou ao assinar) e para as caixas internas de `MAIL_COPY`, uma mensagem para cada pessoa. Configure `SMTP_*` e `MAIL_*` no `.env` (Google Workspace: `smtp.gmail.com`, porta 587, "senha de app"). Falha de e-mail nunca desfaz a assinatura; o painel tem o botão "Reenviar cópias por e-mail". Teste: `docker compose exec app node scripts/teste-email.mjs`.
- **E-mail do signatário:** a tela de assinatura pede o e-mail (vem preenchido se o remetente cadastrou) e é para ele que vai a via assinada.
- **Onde cada um assina:** na tela "Novo documento" o painel mostra as páginas (pdf.js) e você arrasta uma caixa por pessoa. A assinatura sai carimbada nesse lugar (com nome e data), inclusive em páginas giradas. Sem posições, a assinatura aparece só no termo, no fim.
- **Vários arquivos:** escolha mais de um PDF e decida entre "tudo junto" (um PDF só) ou "em separado" (um documento, link e PDF final para cada arquivo).
- **Localização automática:** a página de assinatura pede a localização ao abrir. Por padrão ela é obrigatória (desmarque por signatário se não quiser). O navegador sempre pergunta ao usuário; a posição é registrada no relatório e o painel mostra o link do mapa. Lembre que é um dado pessoal (LGPD) e que pode ser imprecisa em computador sem GPS.
- **Backup:** `scripts/backup.sh` (banco + arquivos), agendado diariamente por cron; atualização segura com `scripts/reconstruir.sh`.

## Selo com o e-CNPJ A1

1. Copie o `.pfx` para o servidor (fora do repositório, ex.: `/etc/assinadormr12/mr12.pfx`, modo 600).
2. No `.env`: `ICP_P12_PATH=/etc/assinadormr12/mr12.pfx` e `ICP_P12_PASSWORD=...`.
3. Reinicie. A faixa verde no painel mostra titular e validade. Se o certificado estiver vencido ou a senha errada, **os documentos não são finalizados** (ficam em "erro" até corrigir, depois use "Tentar finalizar de novo"), para nunca sair um arquivo sem o selo esperado.

Nunca mande o `.pfx` ou a senha por chat, e-mail ou repositório.

### O que o selo é, e o que ainda precisa ser conferido

Sem política de assinatura, o selo é **PAdES-B-B (CAdES detached)** feito com certificado ICP-Brasil: protege contra alteração e identifica a empresa. Para ser **AD-RB** da ICP-Brasil é preciso informar a política:

- `ICP_POLICY_OID`, `ICP_POLICY_HASH_SHA256` e `ICP_POLICY_URI` devem ser copiados da LPA/política publicada pelo ITI (gov.br/iti). O sistema não inventa esses valores.
- Depois de assinar o primeiro documento real, envie o PDF em **validar.iti.gov.br**. Só ele diz oficialmente "Aprovado". O validador interno do painel não afirma conformidade ICP.
- Sem carimbo do tempo de ACT, a data do selo é a do relógio do servidor (mantenha NTP ativo).

Para o validador interno marcar a cadeia como confiável, baixe as raízes ICP-Brasil do ITI e coloque os `.crt`/`.pem` em `certs/raizes/`.

## Testes

```bash
./scripts/make-test-cert.sh   # cria AC e e-CNPJ de TESTE em certs/teste/ (não é ICP-Brasil)
npm test                      # 50 verificações ponta a ponta
```

O teste sobe o servidor, cria documento, assina em ordem com dois signatários (um com selfie), sela com o certificado de teste e confere com o validador interno, `pdfsig` e `qpdf`.

## Segurança

Senhas com scrypt; sessões com token em hash, cookie HttpOnly/SameSite=Strict; limite de tentativas em login e assinatura; CSP sem script inline; links com 24 bytes aleatórios; arquivos com nomes aleatórios e modo 0600; PDFs já assinados, protegidos por senha ou corrompidos são recusados no envio; webhook só para a URL do `.env`.

## Limites conhecidos (seja claro com os clientes e com você mesmo)

- A assinatura dos clientes é **eletrônica avançada/simples por evidências** (Lei 14.063/2020), não ICP-Brasil individual. Alguns tribunais exigem certificado ICP-Brasil para procurações em processos judiciais: nesses casos o cliente precisa assinar com o próprio certificado.
- A selfie é só prova guardada; não há comparação facial nem prova de vida.
- Não há token por SMS/WhatsApp/e-mail: quem tem o link assina. Envie o link só ao cliente, e use CPF pré-cadastrado e prazo curto.
- O envio por WhatsApp é um link `wa.me` (você clica e envia). A integração automática com o MRZap/Baileys é uma fase futura (há webhook `NOTIFY_WEBHOOK_URL` para isso).
- Selfie, CPF e localização são dados pessoais: defina prazo de guarda, mantenha disco criptografado e backup protegido, e confirme a base legal e o texto do termo com a sua assessoria jurídica/LGPD.
