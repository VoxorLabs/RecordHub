FROM node:20-alpine

LABEL maintainer="PresenterHub"
LABEL version="2.2.0"
LABEL description="RecordHub — OBS recording automation sidecar"
LABEL note="Requires OBS Studio with WebSocket plugin on the same host (ws://localhost:4455). ffmpeg must be installed on host for remux/web-ready export."

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN rm -rf data recordings && mkdir -p data recordings public

ENV NODE_ENV=production

EXPOSE 3299

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3299/health || exit 1

VOLUME ["/app/data", "/app/recordings"]

CMD ["node", "recordhub.js"]
