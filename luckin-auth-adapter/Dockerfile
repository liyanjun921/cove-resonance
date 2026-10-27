FROM node:22-alpine AS verified
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY server.mjs ./
COPY test ./test
RUN npm test && npm run check

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=verified --chown=node:node /app/package.json /app/server.mjs ./
USER node
EXPOSE 10000
CMD ["node", "server.mjs"]
