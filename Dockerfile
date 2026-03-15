FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create vault directory (will be mounted as persistent volume)
RUN mkdir -p /data/vault

ENV PORT=8080
ENV VAULT_PATH=/data/vault

EXPOSE 8080

CMD ["./entrypoint.sh"]
