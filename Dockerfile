# 零依赖 Node 应用：镜像只需要 node 运行时 + 源码
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8848
ENV HOST=0.0.0.0
# 公网部署时分享页要允许公网访问（否则 /s/<token> 只放行内网地址）
ENV SHARE_LAN_ONLY=0

COPY package.json ./
COPY app ./app

# 运行时数据目录（会话/上传/分享）——容器内可写即可
RUN mkdir -p /app/app/data/sessions /app/app/data/uploads /app/app/data/shares

EXPOSE 8848

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8848)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server/index.mjs"]
