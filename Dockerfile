FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run samples && npm run build && mkdir -p /app/data && chown -R node:node /app/data
ENV NODE_ENV=production PORT=3001 DATA_DIR=/app/data
USER node
EXPOSE 3001
CMD ["npm","start"]
