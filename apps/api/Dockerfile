FROM node:22-alpine AS build
WORKDIR /srv
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build
COPY package.json ./
COPY package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma prisma
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/api apps/api
RUN npm run prisma:generate --workspace @attendflow/api
RUN npm run build --workspace @attendflow/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /srv
COPY package.json ./
COPY package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma prisma
RUN npm ci --ignore-scripts --omit=dev --omit=optional --workspace @attendflow/api --include-workspace-root=false --no-audit --no-fund && npm cache clean --force
COPY --from=build /srv/node_modules/.prisma/client /srv/node_modules/.prisma/client
COPY --from=build /srv/node_modules/@prisma/engines /srv/node_modules/@prisma/engines
COPY --from=build /srv/apps/api/dist apps/api/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
