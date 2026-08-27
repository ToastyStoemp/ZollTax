# Build from the repo root:  docker compose up -d --build
#
# ZollTax is a zero-dependency Node ESM app, so there is no npm install or build
# step — the image just carries the source and runs the multi-tenant web server.
# (If dependencies are ever added, introduce a `deps` stage that runs `npm ci`
#  and COPY its node_modules, mirroring ZollTool's server/Dockerfile.)
FROM node:22-bookworm-slim
WORKDIR /app

# PORT + data dir are overridable; data (accounts, encrypted client configs,
# sessions) lives on the mounted /data volume so it survives image rebuilds.
ENV NODE_ENV=production \
    PORT=4000 \
    ZOLLTAX_DATA_DIR=/data \
    ZOLLTAX_ENV_FILE=/data/.env

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data
EXPOSE 4000
VOLUME /data
CMD ["node", "src/server.js"]
