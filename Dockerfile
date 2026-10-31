FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 8788
ENV NODE_ENV=production
CMD ["node", "server.js"]
