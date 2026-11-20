import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

process.env.APP_RUNTIME = 'node-server';

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fsSync.existsSync(envPath)) return;
  try {
    const raw = fsSync.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!key || process.env[key] !== undefined) continue;
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (err) {
    console.warn('Warning: could not parse .env file:', err.message);
  }
}

loadDotEnv();

const [
  { default: teamsHandler },
  { default: framesHandler },
  { default: sessionHandler },
  { default: adminLoginHandler },
  { default: adminStatsHandler },
  { default: adminTeamsHandler },
  { getStorageMode, closeStoragePool },
] = await Promise.all([
  import('./netlify/functions/teams.mjs'),
  import('./netlify/functions/frames.mjs'),
  import('./netlify/functions/session.mjs'),
  import('./netlify/functions/admin-login.mjs'),
  import('./netlify/functions/admin-stats.mjs'),
  import('./netlify/functions/admin-teams.mjs'),
  import('./netlify/functions/_lib/kv-store.mjs'),
]);

const PORT = parseInt(process.env.PORT || '8888', 10) || 8888;
const HOST = '0.0.0.0';
const MAX_BODY_BYTES = 12 * 1024 * 1024; // 12 MB safety cap for multipart/JSON uploads
const DIST_DIR = path.resolve(process.cwd(), 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Request payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function toWebRequest(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || 'http';
  const fullUrl = `${proto}://${host}${req.url || '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const bodyBuf = await readRequestBody(req);
    if (bodyBuf.length > 0) {
      init.body = bodyBuf;
    }
  }

  return new Request(fullUrl, init);
}

async function sendWebResponse(res, webRes, method) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const ab = await webRes.arrayBuffer();
  res.end(Buffer.from(ab));
}

function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function matchApiRoute(pathname) {
  if (pathname === '/api/teams') {
    return { handler: teamsHandler, params: {} };
  }
  if (pathname.startsWith('/api/frames/')) {
    const id = decodeURIComponent(pathname.slice('/api/frames/'.length).replace(/\/+$/, ''));
    if (id && !id.includes('/')) {
      return { handler: framesHandler, params: { id } };
    }
  }
  if (pathname.startsWith('/api/session/')) {
    const action = decodeURIComponent(pathname.slice('/api/session/'.length).replace(/\/+$/, ''));
    if (action && !action.includes('/')) {
      return { handler: sessionHandler, params: { action } };
    }
  }
  if (pathname === '/api/admin/login') {
    return { handler: adminLoginHandler, params: {} };
  }
  if (pathname === '/api/admin/stats') {
    return { handler: adminStatsHandler, params: {} };
  }
  if (pathname === '/api/admin/teams') {
    return { handler: adminTeamsHandler, params: {} };
  }
  if (pathname.startsWith('/api/admin/teams/')) {
    const id = decodeURIComponent(pathname.slice('/api/admin/teams/'.length).replace(/\/+$/, ''));
    if (id && !id.includes('/')) {
      return { handler: adminTeamsHandler, params: { id } };
    }
  }
  return null;
}

async function serveStatic(res, pathname, method) {
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  let targetPath = path.resolve(DIST_DIR, relativePath || 'index.html');

  // Guard against path traversal outside dist/
  if (targetPath !== DIST_DIR && !targetPath.startsWith(DIST_DIR + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stat = await fs.stat(targetPath).catch(() => null);
  let isSpaFallback = false;

  if (!stat || !stat.isFile()) {
    targetPath = path.join(DIST_DIR, 'index.html');
    stat = await fs.stat(targetPath).catch(() => null);
    isSpaFallback = true;
  }

  if (!stat || !stat.isFile()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Frontend build not found. Run `npm run build` first.');
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const isHashedAsset = !isSpaFallback && decodedPath.startsWith('/assets/');

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Cache-Control',
    isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'
  );

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const fileBytes = await fs.readFile(targetPath);
  res.end(fileBytes);
}

const server = http.createServer(async (req, res) => {
  const method = (req.method || 'GET').toUpperCase();
  let pathname = '/';
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = parsedUrl.pathname;
  } catch {
    res.statusCode = 400;
    res.end('Invalid URL');
    return;
  }

  try {
    if (pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(JSON.stringify({ status: 'ok', storage: getStorageMode() }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      const route = matchApiRoute(pathname);
      if (!route) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'API route not found' }));
        return;
      }

      const webReq = await toWebRequest(req);
      const context = {
        ip: extractClientIp(req),
        params: route.params,
      };
      const webRes = await route.handler(webReq, context);
      await sendWebResponse(res, webRes, method);
      return;
    }

    await serveStatic(res, pathname, method);
  } catch (err) {
    const status = err?.statusCode || 500;
    console.error(`Server error handling ${method} ${pathname}:`, err);
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: err?.message || 'Internal server error' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `DP Blast Frame Maker server listening on http://${HOST}:${PORT} (storage: ${getStorageMode()})`
  );
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    await closeStoragePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
