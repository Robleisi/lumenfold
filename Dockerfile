# 折光织界 · 外网一体服（页面 + 中继）
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV LUMENFOLD_PORT=8787
ENV LUMENFOLD_SERVE_STATIC=1
EXPOSE 8787
CMD ["node", "server/wan.mjs"]
