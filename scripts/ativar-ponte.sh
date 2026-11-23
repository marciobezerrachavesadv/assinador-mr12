#!/bin/bash
# Roda NO SERVIDOR: liga a ponte com o SST MR12 (conector MCP) e mostra o endereco para cadastrar no Claude.
cd /opt/assinadormr12 || exit 1
if ! grep -q '^MCP_TOKEN=.\{32,\}' .env 2>/dev/null; then
  T=$(openssl rand -hex 32)
  grep -v '^MCP_TOKEN=' .env > .env.novo 2>/dev/null; echo "MCP_TOKEN=$T" >> .env.novo
  mv .env.novo .env; chmod 600 .env
  echo "Token da ponte criado."
fi
docker compose up -d --build || exit 1
URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2- | tr -d "'\"" | sed 's#/*$##')
TOK=$(grep '^MCP_TOKEN=' .env | cut -d= -f2- | tr -d "'\"")
echo
echo "== Ponte ativa =="
echo "No claude.ai: Configuracoes > Conectores > Adicionar conector personalizado"
echo "  Nome: AssinadorMR12"
echo "  URL:  $URL/mcp/$TOK"
echo "Trate esse endereco como senha: nao compartilhe."
