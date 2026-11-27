FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY . .
ENV PORT=3000
CMD ["node", "bot.mjs"]
