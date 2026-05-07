# syntax=docker/dockerfile:1.7

# ─── deps ────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile

# ─── build ───────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next standalone output. Build-time placeholders for vars the runtime needs
# present at module load. Real values come from env at container start.
ENV NEXT_TELEMETRY_DISABLED=1
ENV BETTER_AUTH_SECRET=build-placeholder
ENV BETTER_AUTH_URL=http://localhost:3000
ENV NODE_ENV=production

RUN bun run --bun next build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN addgroup -S app && adduser -S -G app app

# Standalone server bundle
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public

# Migrations + scripts needed at startup
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/src ./src

# postgres + drizzle-orm need to be importable from /scripts at runtime
COPY --from=deps --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 3000

# Default command runs migrations then boots Next. Compose may override this
# to run scripts/bootstrap-prod.ts as a one-shot.
CMD ["sh", "-c", "bun scripts/migrate.ts && bun server.js"]
