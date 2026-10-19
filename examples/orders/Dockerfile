# syntax=docker/dockerfile:1.7
# One image build for the orders example; pick a target: worker, api or provider.
# Build from the repository root: docker build -f examples/orders/Dockerfile --target worker .

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# Compile the packages, generate .norn, compile the worker and prebuild its workflow bundle.
RUN pnpm build && pnpm --filter @norn/example-orders-worker build
# Without auto-install-peers=false, deploy tries to fetch @norn-ts/cli's optional @norn-ts/* peers from npm.
RUN export npm_config_auto_install_peers=false \
 && pnpm deploy --filter @norn/example-orders-worker --prod --legacy /out/worker \
 && cp -r examples/orders/worker/dist /out/worker/dist \
 && pnpm deploy --filter @norn/example-orders-api --prod --legacy /out/api \
 && pnpm deploy --filter @norn/example-orders-provider --prod --legacy /out/provider
# Node won't strip types inside node_modules, so bundle the API with its (generated, TypeScript)
# contracts package inlined; runtime dependencies stay external.
RUN pnpm exec esbuild examples/orders/api/src/main.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=/out/api/dist/main.js \
      --external:@temporalio/* --external:hono --external:@hono/node-server \
      --external:@norn-ts/client --external:@norn-ts/codec --external:@norn-ts/core --external:@norn-ts/hono

FROM node:24-bookworm-slim AS worker
WORKDIR /app
COPY --from=build /out/worker .
ENV NODE_ENV=production NORN_WORKFLOW_BUNDLE=/app/dist/workflow-bundle.js NORN_HEALTH_PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8081/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Give in-flight activities time to finish: keep stop_grace_period above NORN_SHUTDOWN_GRACE.
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]

FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY --from=build /out/api .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:24-bookworm-slim AS provider
WORKDIR /app
COPY --from=build /out/provider .
ENV PORT=4010
EXPOSE 4010
CMD ["node", "src/main.ts"]
