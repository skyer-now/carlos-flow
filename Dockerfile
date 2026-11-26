# Carlos Flow 的 Dockerfile（适配 Docker MCP Catalog 镜像构建）
FROM node:22-alpine

WORKDIR /app

# 安装 carlos-flow
RUN npm install -g carlos-flow@3.3.3

# 配置运行用户（非 root 安全执行）
USER node

# 启动标准 MCP Stdio 服务端
ENTRYPOINT ["carlos-flow-server"]

