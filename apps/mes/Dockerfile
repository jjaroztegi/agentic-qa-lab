FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_NO_WARNINGS=1 MES_DB=/data/mes.db
RUN mkdir -p /data && chown node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
