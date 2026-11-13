# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-alpine
ENV NODE_ENV=production \
    CONFIG_PATH=/app/config/config.json
WORKDIR /app
COPY package.json LICENSE ./
COPY --from=build /app/dist/src ./dist/src
RUN mkdir -p /app/data /app/config && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["serve"]
