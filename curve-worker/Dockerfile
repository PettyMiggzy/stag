FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PONS_DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "worker.js"]
