FROM docker.io/library/node:krypton-alpine AS build
WORKDIR /app

# update corepack
RUN npm install --global corepack@latest
# Install pnpm
RUN corepack enable pnpm

# Copy Web UI
COPY src/package.json src/pnpm-lock.yaml ./
RUN pnpm install

# Build UI
COPY src ./
RUN pnpm build

# Stage externalized packages for the runtime image.
# is-ip (pure ESM, not bundled by Nitro) and libsql (native binary) must be
# present in the runtime image's node_modules.
RUN mkdir -p /app/runtime-modules/@libsql && \
    cp -rL node_modules/is-ip /app/runtime-modules/ && \
    cp -r node_modules/.pnpm/libsql@*/node_modules/libsql /app/runtime-modules/ && \
    for d in node_modules/.pnpm/@libsql+linux-*-musl@*/node_modules/@libsql/*/; do \
        cp -r "$d" /app/runtime-modules/@libsql/; \
    done

# Copy build result to a new image.
# This saves a lot of disk space.
FROM docker.io/library/node:krypton-alpine
WORKDIR /app

# Healthcheck via the web UI instead of wg show (no local WireGuard daemon)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-51821}/api/information 2>/dev/null | grep -q . || exit 1

# Copy build
COPY --from=build /app/.output /app
# Copy migrations
COPY --from=build /app/server/database/migrations /app/server/database/migrations
# Copy externalized packages (libsql native binary + is-ip pure ESM)
# https://github.com/nitrojs/nitro/issues/3328
COPY --from=build /app/runtime-modules /app/server/node_modules
# cli
COPY --from=build /app/cli/cli.sh /usr/local/bin/cli
RUN chmod +x /usr/local/bin/cli

# Install minimal runtime packages
# wireguard-tools kept for local-mode fallback and client keypair generation (wg genkey/pubkey/genpsk)
RUN apk add --no-cache \
    dumb-init \
    wireguard-tools

# Set Environment
ENV DEBUG=Server,WireGuard,RouterOS,Database
ENV PORT=51821
ENV HOST=0.0.0.0
ENV INSECURE=false
ENV INIT_ENABLED=false
ENV DISABLE_IPV6=false

# RouterOS backend — set these at runtime via docker-compose or -e flags
ENV ROUTEROS_HOST=""
ENV ROUTEROS_USER="admin"
ENV ROUTEROS_PASSWORD=""
ENV ROUTEROS_INTERFACE="wg0"
ENV ROUTEROS_VERIFY_SSL="false"

LABEL org.opencontainers.image.source=https://github.com/wg-easy/wg-easy

# Run Web UI
CMD ["/usr/bin/dumb-init", "node", "server/index.mjs"]
