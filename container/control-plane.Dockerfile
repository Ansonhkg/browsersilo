FROM docker:27-cli AS docker-cli

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY container ./container
COPY dist/ui ./dist/ui
RUN npm run build:server && npm prune --omit=dev

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="BrowserSilo control plane" \
      org.opencontainers.image.version="0.4.0" \
      io.browsersilo.role="trusted-control-plane"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/container ./container
RUN install -d -o node -g node -m 0700 /var/lib/browsersilo
EXPOSE 4100 4101 4200 4201
CMD ["node", "dist/src/index.js"]
