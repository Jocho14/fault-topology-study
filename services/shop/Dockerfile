FROM node:22-alpine AS build
WORKDIR app/services/shop
COPY services/shop/package*.json ./
RUN npm ci
COPY services/shop/ .
RUN npm run build

FROM node:22-alpine
WORKDIR app/services/shop
COPY services/shop/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/shop/dist ./dist
COPY proto/ /app/proto/

EXPOSE 3001 50051
CMD ["node", "dist/main.js"]
