# Look Up API, serving the built station portal from its own address (the showcase on Render).
# Build from the repository root:   docker build -f infra/docker/api.Dockerfile .
# Render builds it from render.yaml; nothing secret is built in (.dockerignore keeps every .env out).

# ---- 1. Build the contracts, the API, its setup scripts and the portal -------------------------------------------
FROM node:24-bookworm-slim AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /repository
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/portal/package.json apps/portal/
RUN npm ci
COPY packages packages
COPY apps/api apps/api
COPY apps/portal apps/portal
# The human check's site key is public: it is written into the portal's code when it is built.
ARG VITE_HUMAN_CHECK_SITE_KEY
RUN npm run build -w @lookup/api \
 && npm run build:tools -w @lookup/api \
 && npm run build -w @lookup/portal

# ---- 2. Only what the API needs to run (no compilers, no test tools, no portal packages) --------------------------
FROM node:24-bookworm-slim AS runtime-packages
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/portal/package.json apps/portal/
RUN npm ci --omit=dev --workspace=@lookup/api --workspace=@lookup/contracts

# ---- 3. The image Render runs --------------------------------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORTAL_STATIC_DIRECTORY=/app/apps/portal/dist
WORKDIR /app
COPY --from=runtime-packages /app/package.json ./
COPY --from=runtime-packages /app/node_modules ./node_modules
COPY --from=build /repository/packages/contracts/package.json packages/contracts/
COPY --from=build /repository/packages/contracts/dist packages/contracts/dist
COPY --from=build /repository/apps/api/package.json apps/api/
COPY --from=build /repository/apps/api/dist apps/api/dist
COPY --from=build /repository/apps/api/dist-tools apps/api/dist-tools
COPY --from=build /repository/apps/portal/dist apps/portal/dist
COPY infra/docker/*.sh infra/docker/
# Never as root: the files belong to root and the API only reads them.
USER node
EXPOSE 3100
CMD ["sh", "/app/infra/docker/start-api.sh"]
