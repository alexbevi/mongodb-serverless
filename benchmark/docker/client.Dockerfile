FROM node:24.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iputils-ping && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install --save-exact mongodb@7.7.0 mongodb-connection-string-url@7.0.2
COPY driver/package.json ./driver/package.json
COPY plugins/local/package.json ./plugins/local/package.json
COPY driver/dist ./driver/dist
COPY plugins/local/dist ./plugins/local/dist
COPY benchmark ./benchmark
CMD ["sleep", "infinity"]
