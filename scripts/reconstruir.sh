#!/bin/bash
# Atualiza o sistema no servidor: faz backup, reconstroi e confere que subiu.
cd /opt/assinadormr12 || exit 1
chmod +x scripts/*.sh
echo "== Backup antes de atualizar =="; ./scripts/backup.sh || { echo "Backup falhou; nao atualizei."; exit 1; }
echo "== Reconstruindo (1 a 3 minutos) =="
docker compose up -d --build 2>&1 | tail -6
sleep 8
docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/me').then(r=>console.log('Sistema respondeu: HTTP',r.status)).catch(e=>{console.log('NAO RESPONDEU',e.message);process.exit(1)})"
docker compose logs --tail=5 app
echo "FIM DA ATUALIZACAO"
