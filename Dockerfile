# UA-RADAR: сервер збору обстановки.
#
# Залежностей немає, тож образ — це просто Node і вихідники.
# Пам'яті процес їсть близько 140 МБ (основне — довідник на 33 тисячі
# населених пунктів), тому обмежуємо купу, щоб влізти в машину 256 МБ.
FROM node:20-alpine

WORKDIR /app

# спершу метадані — шар кешується, поки package.json не змінився
COPY package.json ./

COPY *.js ./
COPY data ./data
COPY public ./public

RUN mkdir -p cache

ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS=--max-old-space-size=200

EXPOSE 8080

# Перевірка життя: сервер має віддавати стан тривог. Якщо джерела
# впали, він усе одно відповідає останнім знімком — це нормально.
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/status > /dev/null || exit 1

CMD ["node", "server.js"]
