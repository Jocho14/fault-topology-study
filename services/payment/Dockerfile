FROM node:20-alpine AS build
WORKDIR /app/services/payment
COPY services/payment/package*.json ./
RUN npm ci
COPY services/payment/ .
RUN npm run build

FROM node:20-alpine
WORKDIR /app/services/payment
COPY services/payment/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/payment/dist ./dist
COPY proto/ /app/proto/

EXPOSE 3003 50053
CMD ["node", "dist/main.js"]
