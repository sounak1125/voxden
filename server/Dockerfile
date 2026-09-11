# The Voxden account service: one Node process, no npm dependencies, one
# SQLite file under /data. Build context is this directory.
#
#   docker build -t voxden-account server/
#   docker run -p 8787:8787 -v voxden-data:/data --env-file .env voxden-account

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    VOXDEN_DB=/data/voxden.sqlite \
    NODE_OPTIONS=--no-warnings

WORKDIR /app
COPY --chown=node:node . /app

# The database lives on a volume owned by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "index.js"]
