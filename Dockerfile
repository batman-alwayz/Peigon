FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV STORAGE_PATH=/var/vaultdrop
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/client/dist ./client/dist
COPY server.js ./
RUN addgroup -S peigon && adduser -S peigon -G peigon \
  && mkdir -p /var/vaultdrop/data /var/vaultdrop/uploads \
  && chown -R peigon:peigon /app /var/vaultdrop
USER peigon
EXPOSE 3000
CMD ["node", "server.js"]
