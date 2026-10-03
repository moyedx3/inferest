ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /opt/inferest
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit
COPY app/dashboard/ ./app/dashboard/
RUN npm run build:dashboard && npm prune --omit=dev --ignore-scripts --no-audit

FROM node:${NODE_VERSION}-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production
WORKDIR /opt/inferest
COPY --from=build /opt/inferest/node_modules ./node_modules
COPY --from=build /opt/inferest/app/dashboard ./app/dashboard
COPY package.json package-lock.json ./
COPY app/*.ts ./app/
COPY agent/*.ts ./agent/
COPY engine/*.ts ./engine/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "app/cli.ts", "serve"]
