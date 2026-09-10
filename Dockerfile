FROM node:24.19.0-alpine AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/foundation/package.json packages/foundation/package.json
RUN pnpm install --frozen-lockfile

COPY . .
ENV DATABASE_URL=postgresql://pulsefield:pulsefield_local_only@postgres:5432/pulsefield?schema=public
RUN pnpm --filter @pulse-field/api exec prisma generate \
  && pnpm --filter @pulse-field/contracts run build \
  && pnpm --filter @pulse-field/foundation run build \
  && pnpm --filter @pulse-field/design-tokens run build \
  && pnpm --filter @pulse-field/api run build \
  && pnpm --filter @pulse-field/worker run build \
  && pnpm --filter @pulse-field/web run build

FROM build AS api
CMD ["pnpm", "--filter", "@pulse-field/api", "start"]

FROM build AS worker
CMD ["pnpm", "--filter", "@pulse-field/worker", "start"]

FROM build AS web
CMD ["pnpm", "--filter", "@pulse-field/web", "start"]
