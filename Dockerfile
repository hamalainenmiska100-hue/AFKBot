# Use Node 22 on Debian Bookworm
FROM node:22-bookworm

# Install build tools required for native modules (RakNet, etc.)
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json first
COPY package.json .

# Clear npm cache and install dependencies
RUN npm cache clean --force && npm install

# Copy the rest of the application code
COPY . .

# Start the bot
CMD ["node", "bot.js"]
