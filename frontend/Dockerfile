FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 注意：由于 Docker Desktop 网络问题，使用官方源更稳定
RUN npm ci
# 预安装 SWC 二进制文件（Linux x64 musl），避免构建时下载超时
RUN npm install --no-save @next/swc-linux-x64-musl

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 切换到 standalone 输出模式（用于 Docker 部署）
RUN sed -i "s/output: 'export'/output: 'standalone'/" next.config.mjs
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
