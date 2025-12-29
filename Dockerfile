FROM node:18-slim

# Install Chrome dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    wget gnupg \
    ca-certificates procps libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Create App Directory
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# Start
CMD ["node", "index.js"]
