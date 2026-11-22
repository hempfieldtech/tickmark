# Tickmark: no build step or npm install needed. The image is Node plus the source.
FROM node:24-alpine

LABEL org.opencontainers.image.title="Tickmark" \
      org.opencontainers.image.description="Self-hosted markdown notes whose tagged checklists sync both ways with CalDAV task lists" \
      org.opencontainers.image.source="https://github.com/hempfieldtech/tickmark"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8087 \
    TICKMARK_VAULT=/vault \
    TICKMARK_DATA=/data \
    NODE_NO_WARNINGS=1

# tzdata so TZ=... works for due dates/times sent to and read from CalDAV; git for note history
RUN apk add --no-cache tzdata git

WORKDIR /app
COPY package.json README.md ./
COPY server ./server
COPY public ./public

# Run as the image's unprivileged "node" user (uid 1000). Bind-mounted folders must be writable by it.
RUN mkdir -p /vault /data && chown node:node /vault /data
USER node

VOLUME ["/vault", "/data"]
EXPOSE 8087

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/manifest.webmanifest').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
