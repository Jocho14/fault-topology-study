FROM node:20-alpine AS build
WORKDIR /app/services/delivery
COPY services/delivery/package*.json ./
RUN npm ci
COPY services/delivery/ .
RUN npm run build

FROM node:20-alpine
WORKDIR /app/services/delivery
COPY services/delivery/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/delivery/dist ./dist
COPY proto/ /app/proto/

EXPOSE 3004 50054
CMD ["node", "dist/main.js"]
