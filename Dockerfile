FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/app/data/orqestra.db LANGCHAIN_CALLBACKS_BACKGROUND=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY server ./server
COPY scripts ./scripts
COPY tsconfig.json ./
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
