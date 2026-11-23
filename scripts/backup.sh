#!/bin/bash
# Backup diario do AssinadorMR12: banco (copia consistente) + PDFs/assinaturas/selfies.
# Guarda os ultimos 14 em /opt/backups/assinadormr12. NAO inclui .env nem o certificado .pfx (ficam so no servidor/seu computador).
set -e
cd /opt/assinadormr12
DEST=/opt/backups/assinadormr12
mkdir -p "$DEST"; chmod 700 /opt/backups "$DEST"
NOME="assinador-$(date +%Y%m%d-%H%M).tar.gz"
docker compose exec -T app sh -c 'rm -f /dados/backup-tmp.db && node -e "const D=require(\"better-sqlite3\");const d=new D(\"/dados/data/assinador.db\",{readonly:true});d.exec(\"VACUUM INTO '"'"'/dados/backup-tmp.db'"'"'\");d.close()"'
docker compose exec -T app sh -c 'tar czf - -C /dados backup-tmp.db storage' > "$DEST/$NOME.parcial"
docker compose exec -T app rm -f /dados/backup-tmp.db
mv "$DEST/$NOME.parcial" "$DEST/$NOME"; chmod 600 "$DEST/$NOME"
ls -1t "$DEST"/assinador-*.tar.gz | tail -n +15 | xargs -r rm -f
echo "Backup feito: $DEST/$NOME ($(du -h "$DEST/$NOME" | cut -f1)); guardados: $(ls -1 "$DEST"/assinador-*.tar.gz | wc -l)"
