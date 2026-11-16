import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { getEnv, getClientIp } from './_lib/env.mjs';

const GATEKEEPER_STORE = 'dp-blast-gatekeeper';
const STATE_KEY = 'gatekeeper-state';
const START_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// In-process mutex to serialize concurrent operations within the same warm function instance
let mutex = Promise.resolve();
function runSerialized(fn) {
  const res = mutex.then(fn, fn);
  mutex = res.catch(() => {});
  return res;
}

function getLimits() {
  return {
    maxConcurrent: parseInt(getEnv('MAX_CONCURRENT', '50'), 10) || 50,
    maxPerIp: parseInt(getEnv('MAX_PER_IP', '3'), 10) || 3,
    sessionTtlSeconds: parseInt(getEnv('SESSION_TTL_SECONDS', '60'), 10) || 60,
    startLimitPerWindow: parseInt(getEnv('START_LIMIT_PER_WINDOW', '10'), 10) || 10,
  };
}

function getGatekeeperStore() {
  return getStore({ name: GATEKEEPER_STORE, consistency: 'strong' });
}

async function mutateState(mutator) {
  const store = getGatekeeperStore();
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await store.getWithMetadata(STATE_KEY, { type: 'json', consistency: 'strong' });
    const currentState =
      entry && entry.data && typeof entry.data === 'object'
        ? entry.data
        : { sessions: {}, ipStarts: {} };
    const etag = entry ? entry.etag : null;

    if (!currentState.sessions) currentState.sessions = {};
    if (!currentState.ipStarts) currentState.ipStarts = {};

    const result = mutator(currentState);
    if (result.skipWrite) {
      return result.response;
    }

    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const writeRes = await store.setJSON(STATE_KEY, currentState, writeOpts);
    if (!writeRes || writeRes.modified !== false) {
      return result.response;
    }
    // Small random backoff before retry on ETag conflict
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 25)));
  }

  // Fallback unconditional write if high contention exhausted retries
  const state = (await store.get(STATE_KEY, { type: 'json', consistency: 'strong' })) || {
    sessions: {},
    ipStarts: {},
  };
  const result = mutator(state);
  if (!result.skipWrite) {
    await store.setJSON(STATE_KEY, state);
  }
  return result.response;
}

function purgeExpired(state, now, ttlMs) {
  for (const [sid, sess] of Object.entries(state.sessions)) {
    if (!sess || now - sess.lastSeen > ttlMs) {
      delete state.sessions[sid];
    }
  }
  for (const [ip, timestamps] of Object.entries(state.ipStarts)) {
    if (!Array.isArray(timestamps)) {
      delete state.ipStarts[ip];
      continue;
    }
    const valid = timestamps.filter((ts) => now - ts < START_WINDOW_MS);
    if (valid.length === 0) {
      delete state.ipStarts[ip];
    } else {
      state.ipStarts[ip] = valid;
    }
  }
}

async function readBodyJson(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(req.url);
  let action = context?.params?.action;
  if (!action) {
    const parts = url.pathname.split('/').filter(Boolean);
    action = parts[parts.length - 1];
  }

  const limits = getLimits();
  const ttlMs = limits.sessionTtlSeconds * 1000;
  const clientIp = getClientIp(req, context);
  const body = await readBodyJson(req);

  try {
    return await runSerialized(async () => {
      if (action === 'start') {
        return await mutateState((state) => {
          const now = Date.now();
          purgeExpired(state, now, ttlMs);

          // If client sent an existing sessionId that is still valid, reuse it
          if (body.sessionId && state.sessions[body.sessionId]) {
            state.sessions[body.sessionId].lastSeen = now;
            return {
              skipWrite: false,
              response: Response.json({
                status: 'ok',
                sessionId: body.sessionId,
                activeCount: Object.keys(state.sessions).length,
                maxConcurrent: limits.maxConcurrent,
              }),
            };
          }

          const activeSessions = Object.values(state.sessions);
          const ipActiveCount = activeSessions.filter((s) => s.ip === clientIp).length;
          const ipRecentStarts = state.ipStarts[clientIp] || [];

          // Check per-IP start frequency limit (max START_LIMIT_PER_WINDOW per 10 mins)
          if (ipRecentStarts.length >= limits.startLimitPerWindow) {
            const oldestStart = Math.min(...ipRecentStarts);
            const retryAfter = Math.max(
              1,
              Math.ceil((START_WINDOW_MS - (now - oldestStart)) / 1000)
            );
            return {
              skipWrite: false,
              response: Response.json(
                {
                  status: 'rate_limited',
                  reason: 'start_limit',
                  message: `Too many sessions started from your network (${limits.startLimitPerWindow} max per 10 minutes). Please try again in ${retryAfter}s.`,
                  retryAfter,
                },
                { status: 429, headers: { 'Retry-After': String(retryAfter) } }
              ),
            };
          }

          // Check per-IP concurrent active session limit (max MAX_PER_IP active sessions per IP)
          if (ipActiveCount >= limits.maxPerIp) {
            const retryAfter = Math.min(limits.sessionTtlSeconds, 30);
            return {
              skipWrite: false,
              response: Response.json(
                {
                  status: 'rate_limited',
                  reason: 'per_ip_active',
                  message: `Maximum active sessions (${limits.maxPerIp}) reached for your IP address. Close other open tabs or wait ${retryAfter}s.`,
                  retryAfter,
                },
                { status: 429, headers: { 'Retry-After': String(retryAfter) } }
              ),
            };
          }

          // Check global concurrent cap
          if (activeSessions.length >= limits.maxConcurrent) {
            return {
              skipWrite: false,
              response: Response.json(
                {
                  status: 'full',
                  message: 'The app is busy. You are in line, retrying automatically...',
                  retryAfter: 30,
                },
                { status: 429, headers: { 'Retry-After': '30' } }
              ),
            };
          }

          const sessionId = crypto.randomUUID();
          state.sessions[sessionId] = {
            id: sessionId,
            ip: clientIp,
            lastSeen: now,
          };
          if (!state.ipStarts[clientIp]) {
            state.ipStarts[clientIp] = [];
          }
          state.ipStarts[clientIp].push(now);

          return {
            skipWrite: false,
            response: Response.json({
              status: 'ok',
              sessionId,
              activeCount: Object.keys(state.sessions).length,
              maxConcurrent: limits.maxConcurrent,
            }),
          };
        });
      }

      if (action === 'heartbeat') {
        const { sessionId } = body;
        if (!sessionId) {
          return Response.json({ error: 'Missing sessionId' }, { status: 400 });
        }

        return await mutateState((state) => {
          const now = Date.now();
          purgeExpired(state, now, ttlMs);

          const sess = state.sessions[sessionId];
          if (!sess) {
            return {
              skipWrite: false,
              response: Response.json(
                { status: 'expired', message: 'Session unknown or expired' },
                { status: 410 }
              ),
            };
          }

          sess.lastSeen = now;
          return {
            skipWrite: false,
            response: Response.json({ status: 'ok', sessionId }),
          };
        });
      }

      if (action === 'end') {
        const { sessionId } = body;
        if (!sessionId) {
          return Response.json({ status: 'ok' });
        }

        return await mutateState((state) => {
          const now = Date.now();
          purgeExpired(state, now, ttlMs);
          delete state.sessions[sessionId];
          return {
            skipWrite: false,
            response: Response.json({ status: 'ok' }),
          };
        });
      }

      return Response.json({ error: 'Unknown session action' }, { status: 404 });
    });
  } catch (err) {
    console.error(`Error in /api/session/${action}:`, err);
    return Response.json({ error: 'Gatekeeper internal error' }, { status: 500 });
  }
};

export const config = {
  path: ['/api/session/:action', '/.netlify/functions/session/:action'],
  rateLimit: {
    windowLimit: 180,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};
