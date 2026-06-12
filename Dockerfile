FROM node:24-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc
# Serve mode by default; mount your config at /etc/toolwarden/toolwarden.yaml
EXPOSE 8484
CMD ["node", "dist/cli.js", "serve", "--config", "/etc/toolwarden/toolwarden.yaml"]
