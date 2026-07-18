# Hatcheck server image (server mode; see docker-compose.yml).
# Debian-based oven/bun on purpose -- better-sqlite3 ships glibc prebuilds,
# so alpine/musl would force a native compile.

# ---- Stage 1: install dependencies and build the web bundle ----------------
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json drizzle.sqlite.config.ts drizzle.pg.config.ts ./
COPY src ./src
RUN bun run build

# ---- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/bun.lock /app/tsconfig.json ./
COPY --from=build /app/drizzle.sqlite.config.ts /app/drizzle.pg.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
