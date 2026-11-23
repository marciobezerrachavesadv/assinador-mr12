#!/bin/bash
# Roda NO SERVIDOR depois de colar o pacote. Liga o e-mail, o backup diario e reconstroi o sistema.
cd /opt/assinadormr12 || exit 1
chmod +x scripts/backup.sh
echo "== 1/3  E-mail das copias assinadas =="
if grep -q '^SMTP_PASS=' .env 2>/dev/null; then
  read -rp "O e-mail ja esta configurado. Trocar a senha de app? (s/N): " R
  [ "$R" = "s" ] || [ "$R" = "S" ] || PULA=1
fi
if [ -z "$PULA" ]; then
  read -rp "Conta do Google que vai ENVIAR os e-mails (Enter = contato@grupomr12.com): " U
  U=${U:-contato@grupomr12.com}
  read -rsp "Cole a 'senha de app' do Google dessa conta (16 letras; nao aparece na tela): " P; echo
  P=$(printf '%s' "$P" | tr -d ' ')
  case "$P" in ""|*"'"*) echo "Senha vazia ou com aspa. Nada foi alterado no e-mail."; exit 1;; esac
  grep -v -E '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASS|MAIL_FROM|MAIL_COPY)=' .env > .env.novo
  printf "SMTP_HOST=smtp.gmail.com\nSMTP_PORT=587\nSMTP_USER=%s\nSMTP_PASS='%s'\nMAIL_FROM=GRUPO MR12 <%s>\nMAIL_COPY=contato@grupomr12.com,financeiro@grupomr12.com\n" "$U" "$P" "$U" >> .env.novo
  mv .env.novo .env; chmod 600 .env
fi
echo "== 2/3  Reconstruindo o sistema (1 a 3 minutos) =="
docker compose up -d --build 2>&1 | tail -5
sleep 8
echo "== 3/3  Teste de e-mail e backup =="
docker compose exec -T app node scripts/teste-email.mjs
./scripts/backup.sh
( crontab -l 2>/dev/null | grep -v 'assinadormr12/scripts/backup.sh'; echo '30 3 * * * /opt/assinadormr12/scripts/backup.sh >> /var/log/assinador-backup.log 2>&1' ) | crontab -
echo "Backup diario agendado para 03:30."
docker compose logs --tail=4 app
echo "FIM DA ATUALIZACAO"
