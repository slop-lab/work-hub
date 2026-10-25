FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY application ./application
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:24-bookworm-slim AS service
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/application ./application
COPY --from=build /app/dist ./dist
USER node
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
