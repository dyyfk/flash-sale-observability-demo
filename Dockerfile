FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000
EXPOSE 3001

CMD ["sh", "-c", "if [ \"$SERVICE_ROLE\" = \"worker\" ]; then npm run worker; else npm start; fi"]
