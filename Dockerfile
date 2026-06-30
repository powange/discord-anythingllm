FROM node:22-alpine

WORKDIR /app

# Dépendances d'abord (meilleur cache de build)
COPY package*.json ./
RUN npm ci --omit=dev

# Code source
COPY . .

ENV NODE_ENV=production

CMD ["node", "bot.js"]
