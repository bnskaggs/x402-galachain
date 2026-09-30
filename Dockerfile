FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=4021
EXPOSE 4021
CMD ["npx", "tsx", "service/index.ts"]
