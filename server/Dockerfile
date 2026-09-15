# The Voxden account service: one Node process, no npm dependencies, one
# SQLite file under /data. The build context is the REPOSITORY ROOT, not this
# directory: app.js reaches out to ../src for the four modules it shares with
# the desktop app, so both trees have to land in the image.
#
#   docker build -t voxden-account -f server/Dockerfile .
#   docker run -p 8787:8787 -v voxden-data:/data --env-file .env voxden-account

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    VOXDEN_DB=/data/voxden.sqlite \
    NODE_OPTIONS=--no-warnings

WORKDIR /app
COPY --chown=node:node server/ /app/
# app.js requires ../src/credits, ../src/quota and ../src/asr; quota pulls in
# ./metrics. From /app that resolves to /src, so they go there and nowhere else.
COPY --chown=node:node src/credits.js src/quota.js src/asr.js src/metrics.js /src/

# The database lives on a volume owned by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "index.js"]
