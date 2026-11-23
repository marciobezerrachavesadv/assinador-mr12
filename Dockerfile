FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional
COPY src ./src
COPY scripts/reset-senha.mjs ./scripts/reset-senha.mjs
COPY scripts/teste-email.mjs ./scripts/teste-email.mjs
COPY certs/raizes ./certs/raizes
# dados e PDFs ficam em volumes (nao dentro da imagem)
ENV DATA_DIR=/dados/data STORAGE_DIR=/dados/storage PORT=3000
RUN mkdir -p /dados && chown -R node:node /dados /app
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
