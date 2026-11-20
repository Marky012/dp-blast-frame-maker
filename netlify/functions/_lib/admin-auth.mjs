import crypto from 'node:crypto';
import { getEnv } from './env.mjs';

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export function getAdminConfig() {
  const adminPassword = getEnv('ADMIN_PASSWORD');
  const adminSecret = getEnv('ADMIN_SECRET');
  if (!adminPassword || !adminSecret) {
    return {
      configured: false,
      error:
        'Admin authentication is not configured. Please set both ADMIN_PASSWORD and ADMIN_SECRET in your hosting environment variables (Render / Netlify) or local .env file.',
    };
  }
  return {
    configured: true,
    adminPassword,
    adminSecret,
  };
}

export function constantTimeComparePassword(inputPassword, expectedPassword, secret) {
  if (typeof inputPassword !== 'string' || typeof expectedPassword !== 'string') {
    return false;
  }
  const hmacA = crypto.createHmac('sha256', secret).update(inputPassword, 'utf8').digest();
  const hmacB = crypto.createHmac('sha256', secret).update(expectedPassword, 'utf8').digest();
  const digestsMatch = crypto.timingSafeEqual(hmacA, hmacB);
  const lengthsMatch =
    Buffer.byteLength(inputPassword, 'utf8') === Buffer.byteLength(expectedPassword, 'utf8');
  return digestsMatch && lengthsMatch;
}

export function createAdminToken(secret) {
  const now = Date.now();
  const payload = {
    role: 'admin',
    iat: now,
    exp: now + TOKEN_TTL_MS,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', secret)
    .update(payloadB64, 'utf8')
    .digest('base64url');
  return {
    token: `${payloadB64}.${sigB64}`,
    expiresAt: payload.exp,
  };
}

export function verifyAdminToken(req) {
  const cfg = getAdminConfig();
  if (!cfg.configured) {
    return { ok: false, status: 503, error: cfg.error };
  }

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization header.' };
  }

  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, status: 401, error: 'Malformed admin token.' };
  }

  const [payloadB64, sigB64] = parts;
  const expectedSigBuf = crypto
    .createHmac('sha256', cfg.adminSecret)
    .update(payloadB64, 'utf8')
    .digest();

  let providedSigBuf;
  try {
    providedSigBuf = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, status: 401, error: 'Invalid token signature encoding.' };
  }

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    return { ok: false, status: 401, error: 'Invalid admin token signature.' };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.role !== 'admin' || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      return { ok: false, status: 401, error: 'Admin token has expired. Please log in again.' };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 401, error: 'Invalid admin token payload.' };
  }
}

