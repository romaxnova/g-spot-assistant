# G-Spot Assistant: one image for Railway (which builds this file by itself), Docker Compose or any container host.
# Everything the server keeps (one SQLite file) lives in /data: mount a volume there, or each restart starts afresh.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund \
  && find dist \( -name '*.test.js' -o -name '*.test.js.map' \) -delete

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/g-spot-entrypoint
RUN chmod 0755 /usr/local/bin/g-spot-entrypoint && mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Starts as root only to hand the data volume to the "node" user, then runs the server as that user.
ENTRYPOINT ["g-spot-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
