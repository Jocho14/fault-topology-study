FROM node:20-alpine AS build
WORKDIR /app/services/warehouse
COPY services/warehouse/package*.json ./
RUN npm ci
COPY services/warehouse/ .
RUN npm run build

FROM node:20-alpine
WORKDIR /app/services/warehouse
COPY services/warehouse/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/warehouse/dist ./dist
COPY proto/ /app/proto/

EXPOSE 3002 50052
CMD ["node", "dist/main.js"]
