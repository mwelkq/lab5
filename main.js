const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { program } = require('commander');
const superagent = require('superagent');

// ---------- Опції командного рядка ----------
program
  .helpOption('--help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешем');

program.parse(process.argv);
const options = program.opts();

const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Помилка: порт має бути цілим числом від 1 до 65535');
  process.exit(1);
}

const cacheDir = path.resolve(options.cache);
const MAX_BODY = 10 * 1024 * 1024; // 10 МБ

// ---------- Допоміжні функції ----------
function send(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

function sendImage(res, data, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'X-Image-Source': source,
  });
  res.end(data);
}

// Тіло запиту — це потік; збираємо його в Buffer через for await (без колбеків)
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error('Тіло запиту завелике');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Запис через тимчасовий файл + rename, щоб у кеші не було напівзаписаних файлів
async function saveToCache(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// ---------- Обробники методів ----------
async function handleGet(req, res, code, file) {
  // 1. Пробуємо кеш
  try {
    const cached = await fs.readFile(file);
    return sendImage(res, cached, 'cache');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // 2. У кеші немає — йдемо на http.cat
  let image;
  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .responseType('blob')
      .timeout({ response: 10000, deadline: 20000 });
    image = response.body;
  } catch (err) {
    const reason = err.status || err.code || err.message;
    return send(res, 404, `Картинку для коду ${code} не знайдено (http.cat: ${reason})`);
  }

  if (!Buffer.isBuffer(image) || image.length === 0) {
    return send(res, 404, `http.cat не повернув картинку для коду ${code}`);
  }

  // 3. Спочатку зберігаємо в кеш, потім віддаємо клієнту
  await saveToCache(file, image);
  sendImage(res, image, 'http.cat');
}

async function handlePut(req, res, code, file) {
  const body = await readBody(req);
  if (body.length === 0) {
    return send(res, 400, 'Тіло запиту порожнє: потрібно передати картинку');
  }
  await saveToCache(file, body);
  send(res, 201, `Картинку для коду ${code} збережено в кеш`);
}

async function handleDelete(req, res, code, file) {
  send(res, 501, 'DELETE ще не реалізовано');
}

const handlers = new Map([
  ['GET', handleGet],
  ['PUT', handlePut],
  ['DELETE', handleDelete],
]);

// ---------- Головний обробник запиту (єдиний дозволений колбек) ----------
async function handleRequest(req, res) {
  try {
    const handler = handlers.get(req.method);
    if (!handler) {
      return send(res, 405, `Метод ${req.method} не дозволено`, { Allow: 'GET, PUT, DELETE' });
    }

    const { pathname } = new URL(req.url, 'http://localhost');
    const match = /^\/(\d{3})$/.exec(pathname);
    if (!match) {
      return send(res, 400, 'Некоректний шлях. Очікується /<код стану>, наприклад /404');
    }

    const code = match[1];
    const file = path.join(cacheDir, `${code}.jpg`);
    await handler(req, res, code, file);
  } catch (err) {
    console.error(err);
    if (res.headersSent) {
      res.end();
    } else {
      send(res, err.status || 500, err.status === 413 ? err.message : 'Внутрішня помилка сервера');
    }
  }
}

// ---------- Запуск ----------
async function main() {
  await fs.mkdir(cacheDir, { recursive: true });
  const server = http.createServer(handleRequest);
  server.listen(port, options.host);
  await once(server, 'listening');
  console.log(`Сервер працює на http://${options.host}:${port}, кеш: ${cacheDir}`);
}

main().catch((err) => {
  console.error('Не вдалося запустити сервер:', err.message);
  process.exit(1);
});