FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=web /app/dist ./dist
# Inside the container it listens on all interfaces; compose publishes it on 127.0.0.1 only.
ENV NODE_NO_WARNINGS=1 HOST=0.0.0.0 PORT=17000 DATA_DIR=/data \
    CATALOG_DIR=/repo/catalog/cases DRAFTS_DIR=/repo/docs/drafts/cases TESTS_DIR=/repo/tests
RUN mkdir -p /data && chown node /data
USER node
EXPOSE 17000
HEALTHCHECK --interval=10s CMD node -e "fetch('http://localhost:17000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
