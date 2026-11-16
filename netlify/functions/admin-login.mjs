import { getStore } from '@netlify/blobs';
import { getClientIp } from './_lib/env.mjs';
import {
  getAdminConfig,
  constantTimeComparePassword,
  createAdminToken,
} from './_lib/admin-auth.mjs';

const LOGIN_STORE = 'dp-blast-admin-ratelimit';
const LOGIN_KEY = 'login-attempts';
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_DELAY_MS = 350;

let loginMutex = Promise.resolve();
function runSerialized(fn) {
  const res = loginMutex.then(fn, fn);
  loginMutex = res.catch(() => {});
  return res;
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const cfg = getAdminConfig();
  if (!cfg.configured) {
    return Response.json({ error: cfg.error }, { status: 503 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const clientIp = getClientIp(req, context);
  const store = getStore({ name: LOGIN_STORE, consistency: 'strong' });

  return await runSerialized(async () => {
    const now = Date.now();
    const state = (await store.get(LOGIN_KEY, { type: 'json', consistency: 'strong' })) || {};

    // Purge expired login failure records across all IPs
    for (const [ip, timestamps] of Object.entries(state)) {
      if (!Array.isArray(timestamps)) {
        delete state[ip];
        continue;
      }
      const recent = timestamps.filter((ts) => now - ts < WINDOW_MS);
      if (recent.length === 0) {
        delete state[ip];
      } else {
        state[ip] = recent;
      }
    }

    const ipFailures = state[clientIp] || [];
    if (ipFailures.length >= MAX_FAILED_ATTEMPTS) {
      const oldest = Math.min(...ipFailures);
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
      await store.setJSON(LOGIN_KEY, state);
      return Response.json(
        {
          error: `Too many failed login attempts (${MAX_FAILED_ATTEMPTS} max per 10 minutes). Please try again in ${retryAfter}s.`,
          retryAfter,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfter) },
        }
      );
    }

    const password = typeof body.password === 'string' ? body.password : '';
    const isValid = constantTimeComparePassword(password, cfg.adminPassword, cfg.adminSecret);

    if (!isValid) {
      // Small delay on failures
      await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
      const failTime = Date.now();
      if (!state[clientIp]) state[clientIp] = [];
      state[clientIp].push(failTime);
      await store.setJSON(LOGIN_KEY, state);

      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - state[clientIp].length);
      if (remaining === 0) {
        const oldest = Math.min(...state[clientIp]);
        const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (failTime - oldest)) / 1000));
        return Response.json(
          {
            error: `Invalid password. Maximum login attempts (${MAX_FAILED_ATTEMPTS}) reached. Try again in ${retryAfter}s.`,
            retryAfter,
          },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }

      return Response.json(
        {
          error: `Invalid password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        },
        { status: 401 }
      );
    }

    // Success: clear failure record for this IP and return signed token
    if (state[clientIp]) {
      delete state[clientIp];
      await store.setJSON(LOGIN_KEY, state);
    }

    const { token, expiresAt } = createAdminToken(cfg.adminSecret);
    return Response.json({ token, expiresAt });
  });
};

export const config = {
  path: ['/api/admin/login', '/.netlify/functions/admin-login', '/.netlify/functions/admin/login'],
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

