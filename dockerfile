FROM node:18-alpine

WORKDIR /app

# Copy package.json first for better layer caching
COPY package.json ./

# Install dependencies using npm install instead of npm ci
RUN npm install --production

# Copy the rest of the application
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]