# Hatcheck server image (server mode; see docker-compose.yml).
# Debian-based oven/bun keeps the GNU native dependencies used by the web
# build. The running API uses Bun's SQLite/password implementations.

# ---- Stage 1: install dependencies and build the web bundle ----------------
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY package.json bun.lock ./
# Bun does not load better-sqlite3's Node addon; its postinstall rejects Bun.
# Skip lifecycle scripts while retaining frozen lockfile/integrity checks.
# Platform packages already contain the Vite/Tailwind binaries used here.
# Optional BuildKit certificate bundle for environments with a private network
# CA. It is mounted only for installation and is never copied into the image.
RUN --mount=type=secret,id=network_ca \
    if [ -f /run/secrets/network_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/network_ca bun install --frozen-lockfile --ignore-scripts --network-concurrency 4; \
    else bun install --frozen-lockfile --ignore-scripts --network-concurrency 4; fi

COPY tsconfig.json drizzle.sqlite.config.ts drizzle.pg.config.ts ./
COPY src ./src
RUN bun run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=bun:bun --from=build /app/package.json /app/bun.lock /app/tsconfig.json ./
COPY --chown=bun:bun --from=build /app/drizzle.sqlite.config.ts /app/drizzle.pg.config.ts ./
COPY --chown=bun:bun --from=build /app/node_modules ./node_modules
COPY --chown=bun:bun --from=build /app/src ./src
COPY --chown=bun:bun --from=build /app/dist ./dist
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun infra/aws/rds-ca ./infra/aws/rds-ca
RUN mkdir -p /app/data /app/runtime-tmp \
    && chown bun:bun /app/data /app/runtime-tmp \
    && chmod 0700 /app/runtime-tmp
VOLUME ["/app/runtime-tmp"]
USER bun

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/api/v1/ready"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "src/server/index.ts"]
