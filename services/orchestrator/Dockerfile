FROM node:22-alpine AS build
WORKDIR /app/services/orchestrator
COPY services/orchestrator/package*.json ./
RUN npm ci
COPY services/orchestrator/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app/services/orchestrator
COPY services/orchestrator/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/orchestrator/dist ./dist
COPY proto/ /app/proto/

EXPOSE 3005
CMD ["node", "dist/main.js"]
