FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --chown=node:node src ./src
USER node
EXPOSE 8765
CMD ["node", "src/server.mjs"]
