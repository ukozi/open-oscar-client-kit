FROM node:22.23.3-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22.23.3-slim
LABEL org.opencontainers.image.source="https://github.com/ukozi/open-oscar-client-kit"
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY NOTICE LICENSE ./
USER node
EXPOSE 5190
ENTRYPOINT ["node", "dist/lib/cli/main.js", "test-server", "--host", "0.0.0.0"]
