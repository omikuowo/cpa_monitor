FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
COPY package.json ./
COPY src ./src
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
CMD ["node", "server/node.js"]
