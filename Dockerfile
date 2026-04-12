FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV DEGIRO_PORTFOLIO_PORT=8000
ENV DEGIRO_PORTFOLIO_DB_DIR=/config

VOLUME ["/config"]
EXPOSE 8000

CMD ["npm", "start"]
