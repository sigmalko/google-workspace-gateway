FROM node:24-bookworm-slim
ARG IMAGE_VERSION=dev
ARG IMAGE_REVISION=unknown
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="Google Workspace Gateway" \
      org.opencontainers.image.description="OAuth gateway for Google Calendar and Google Tasks" \
      org.opencontainers.image.source="https://github.com/sigmalko/google-workspace-gateway" \
      org.opencontainers.image.version=$IMAGE_VERSION \
      org.opencontainers.image.revision=$IMAGE_REVISION
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --chown=node:node src ./src
USER node
EXPOSE 8765
CMD ["node", "src/server.mjs"]
