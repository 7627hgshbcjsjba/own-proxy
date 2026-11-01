# own-proxy - no build step, no dependencies.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
# There are no runtime dependencies, so this is a no-op that keeps the
# image cache-friendly.
RUN npm install --omit=dev --no-audit --no-fund || true

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

USER node

CMD ["node", "server.js"]
