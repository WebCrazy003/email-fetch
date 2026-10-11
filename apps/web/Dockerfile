FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_ORIGIN=http://127.0.0.1:3000
ENV VITE_API_ORIGIN=$VITE_API_ORIGIN
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
ENV npm_config_fetch_timeout=600000 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
RUN --mount=type=cache,target=/root/.npm npm install --prefer-offline --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @email-fetch/shared && npm run build -w @email-fetch/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
