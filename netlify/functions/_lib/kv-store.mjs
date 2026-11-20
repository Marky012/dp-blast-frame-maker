import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from './env.mjs';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_blobs (
  store_name TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  value_json JSONB,
  value_bytes BYTEA,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  etag TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_name, blob_key)
);
CREATE INDEX IF NOT EXISTS idx_app_blobs_store_name ON app_blobs (store_name);
`;

// In-memory buckets for volatile stores (live sessions & login rate limits) under node-server
const memoryBuckets = new Map();

// Per-store mutex for local disk fallback
const diskLocks = new Map();
function withDiskLock(storeName, fn) {
  const prev = diskLocks.get(storeName) || Promise.resolve();
  const next = prev.then(fn, fn);
  diskLocks.set(
    storeName,
    next.catch(() => {})
  );
  return next;
}

let pgPool = null;
let pgPoolUrl = null;
let schemaReadyPromise = null;
let warnedMissingDbOnRender = false;

export function isNodeServerRuntime() {
  return process.env.APP_RUNTIME === 'node-server' || Boolean(getEnv('RENDER'));
}

export function getStorageMode() {
  if (getEnv('DATABASE_URL')) return 'postgres';
  if (!isNodeServerRuntime() && (getEnv('NETLIFY') || getEnv('NETLIFY_BLOBS_CONTEXT'))) {
    return 'netlify-blobs';
  }
  return 'local-disk';
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new TypeError('Unsupported binary payload type for storage set()');
}

function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function cloneJson(val) {
  if (val === null || val === undefined) return val;
  return typeof structuredClone === 'function'
    ? structuredClone(val)
    : JSON.parse(JSON.stringify(val));
}

// --- 1. In-Memory Store (Volatile state on Node server) ---
function createMemoryStore(storeName) {
  if (!memoryBuckets.has(storeName)) {
    memoryBuckets.set(storeName, new Map());
  }
  const bucket = memoryBuckets.get(storeName);

  const readEntry = (key, opts = {}) => {
    const rec = bucket.get(key);
    if (!rec) return null;
    const type = opts.type || 'text';
    let data = null;
    if (type === 'json') {
      data = rec.kind === 'json' ? cloneJson(rec.valueJson) : JSON.parse(rec.valueBytes.toString('utf8'));
    } else if (type === 'arrayBuffer') {
      const buf = rec.kind === 'bytes' ? rec.valueBytes : Buffer.from(JSON.stringify(rec.valueJson), 'utf8');
      data = bufferToArrayBuffer(buf);
    } else {
      data = rec.kind === 'bytes' ? rec.valueBytes.toString('utf8') : JSON.stringify(rec.valueJson);
    }
    return { data, metadata: cloneJson(rec.metadata || {}), etag: rec.etag };
  };

  const writeEntry = (key, record, opts = {}) => {
    const existing = bucket.get(key);
    if (opts.onlyIfNew && existing) {
      return { modified: false };
    }
    if (opts.onlyIfMatch && (!existing || existing.etag !== opts.onlyIfMatch)) {
      return { modified: false };
    }
    const etag = crypto.randomUUID();
    bucket.set(key, { ...record, etag });
    return { modified: true, etag };
  };

  return {
    async get(key, opts = {}) {
      const entry = readEntry(key, opts);
      return entry ? entry.data : null;
    },
    async getWithMetadata(key, opts = {}) {
      return readEntry(key, opts);
    },
    async set(key, data, opts = {}) {
      const buf = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : toBuffer(data);
      return writeEntry(
        key,
        {
          kind: 'bytes',
          valueBytes: Buffer.from(buf),
          valueJson: null,
          metadata: cloneJson(opts.metadata || {}),
        },
        opts
      );
    },
    async setJSON(key, value, opts = {}) {
      return writeEntry(
        key,
        {
          kind: 'json',
          valueJson: cloneJson(value),
          valueBytes: null,
          metadata: cloneJson(opts.metadata || {}),
        },
        opts
      );
    },
    async list() {
      const blobs = [];
      for (const [key, rec] of bucket.entries()) {
        blobs.push({ key, etag: rec.etag });
      }
      return { blobs };
    },
    async delete(key) {
      bucket.delete(key);
    },
  };
}

// --- 2. PostgreSQL Store (Persistent storage for Render + Neon/Supabase) ---
async function getPgPool() {
  const databaseUrl = getEnv('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured.');
  }

  if (!pgPool || pgPoolUrl !== databaseUrl) {
    const { default: pg } = await import('pg');
    const { Pool } = pg;

    let useSsl = true;
    let cleanConnectionString = databaseUrl;
    try {
      const parsed = new URL(databaseUrl);
      const host = (parsed.hostname || '').toLowerCase();
      const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || sslMode === 'disable') {
        useSsl = false;
      } else if (parsed.searchParams.has('sslmode')) {
        // Strip sslmode so pg-connection-string does not override ssl: { rejectUnauthorized: false }
        parsed.searchParams.delete('sslmode');
        cleanConnectionString = parsed.toString();
      }
    } catch {
      useSsl = true;
    }

    pgPool = new Pool({
      connectionString: cleanConnectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pgPoolUrl = databaseUrl;
    schemaReadyPromise = null;
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = pgPool.query(SCHEMA_SQL).catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  await schemaReadyPromise;

  return pgPool;
}

function createPostgresStore(storeName) {
  const decodeRow = (row, opts = {}) => {
    const type = opts.type || 'text';
    let data = null;

    if (type === 'json') {
      if (row.value_json !== null && row.value_json !== undefined) {
        data = row.value_json;
      } else if (row.value_bytes) {
        data = JSON.parse(Buffer.from(row.value_bytes).toString('utf8'));
      }
    } else if (type === 'arrayBuffer') {
      const buf = row.value_bytes
        ? Buffer.from(row.value_bytes)
        : Buffer.from(JSON.stringify(row.value_json ?? null), 'utf8');
      data = bufferToArrayBuffer(buf);
    } else {
      if (row.value_bytes) {
        data = Buffer.from(row.value_bytes).toString('utf8');
      } else if (row.value_json !== null && row.value_json !== undefined) {
        data = JSON.stringify(row.value_json);
      }
    }

    return {
      data,
      metadata: row.metadata || {},
      etag: row.etag,
    };
  };

  const writePg = async (key, { valueJson, valueBytes }, opts = {}) => {
    const pool = await getPgPool();
    const newEtag = crypto.randomUUID();
    const jsonParam = valueJson !== undefined ? JSON.stringify(valueJson) : null;
    const bytesParam = valueBytes !== undefined && valueBytes !== null ? valueBytes : null;
    const metaParam = JSON.stringify(opts.metadata || {});

    if (opts.onlyIfNew) {
      const res = await pool.query(
        `INSERT INTO app_blobs (store_name, blob_key, value_json, value_bytes, metadata, etag, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, NOW())
         ON CONFLICT (store_name, blob_key) DO NOTHING
         RETURNING etag`,
        [storeName, key, jsonParam, bytesParam, metaParam, newEtag]
      );
      return res.rowCount === 0 ? { modified: false } : { modified: true, etag: newEtag };
    }

    if (opts.onlyIfMatch) {
      const res = await pool.query(
        `UPDATE app_blobs
         SET value_json = $3::jsonb,
             value_bytes = $4,
             metadata = $5::jsonb,
             etag = $6,
             updated_at = NOW()
         WHERE store_name = $1 AND blob_key = $2 AND etag = $7
         RETURNING etag`,
        [storeName, key, jsonParam, bytesParam, metaParam, newEtag, opts.onlyIfMatch]
      );
      return res.rowCount === 0 ? { modified: false } : { modified: true, etag: newEtag };
    }

    await pool.query(
      `INSERT INTO app_blobs (store_name, blob_key, value_json, value_bytes, metadata, etag, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, NOW())
       ON CONFLICT (store_name, blob_key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         value_bytes = EXCLUDED.value_bytes,
         metadata = EXCLUDED.metadata,
         etag = EXCLUDED.etag,
         updated_at = NOW()`,
      [storeName, key, jsonParam, bytesParam, metaParam, newEtag]
    );
    return { modified: true, etag: newEtag };
  };

  return {
    async get(key, opts = {}) {
      const pool = await getPgPool();
      const res = await pool.query(
        `SELECT value_json, value_bytes, metadata, etag FROM app_blobs WHERE store_name = $1 AND blob_key = $2`,
        [storeName, key]
      );
      if (res.rowCount === 0) return null;
      return decodeRow(res.rows[0], opts).data;
    },
    async getWithMetadata(key, opts = {}) {
      const pool = await getPgPool();
      const res = await pool.query(
        `SELECT value_json, value_bytes, metadata, etag FROM app_blobs WHERE store_name = $1 AND blob_key = $2`,
        [storeName, key]
      );
      if (res.rowCount === 0) return null;
      return decodeRow(res.rows[0], opts);
    },
    async set(key, data, opts = {}) {
      const buf = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : toBuffer(data);
      return writePg(key, { valueJson: undefined, valueBytes: buf }, opts);
    },
    async setJSON(key, value, opts = {}) {
      return writePg(key, { valueJson: value, valueBytes: null }, opts);
    },
    async list() {
      const pool = await getPgPool();
      const res = await pool.query(
        `SELECT blob_key, etag FROM app_blobs WHERE store_name = $1 ORDER BY blob_key ASC`,
        [storeName]
      );
      return {
        blobs: res.rows.map((r) => ({ key: r.blob_key, etag: r.etag })),
      };
    },
    async delete(key) {
      const pool = await getPgPool();
      await pool.query(`DELETE FROM app_blobs WHERE store_name = $1 AND blob_key = $2`, [
        storeName,
        key,
      ]);
    },
  };
}

// --- 3. Local Disk Store (Zero-config local Node dev fallback) ---
function createLocalDiskStore(storeName) {
  const baseDir = path.resolve(process.cwd(), '.data', encodeURIComponent(storeName));

  const keyPaths = (key) => {
    const safe = encodeURIComponent(key);
    return {
      dataPath: path.join(baseDir, `${safe}.bin`),
      metaPath: path.join(baseDir, `${safe}.meta.json`),
    };
  };

  const readUnsafe = async (key, opts = {}) => {
    const { dataPath, metaPath } = keyPaths(key);
    let rawData;
    let metaRaw;
    try {
      [rawData, metaRaw] = await Promise.all([
        fs.readFile(dataPath),
        fs.readFile(metaPath, 'utf8'),
      ]);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }

    const metaDoc = JSON.parse(metaRaw);
    const type = opts.type || 'text';
    let data = null;
    if (type === 'json') {
      data = JSON.parse(rawData.toString('utf8'));
    } else if (type === 'arrayBuffer') {
      data = bufferToArrayBuffer(rawData);
    } else {
      data = rawData.toString('utf8');
    }

    return {
      data,
      metadata: metaDoc.metadata || {},
      etag: metaDoc.etag,
    };
  };

  const writeUnsafe = async (key, buf, opts = {}) => {
    await fs.mkdir(baseDir, { recursive: true });
    const { dataPath, metaPath } = keyPaths(key);

    let existingMeta = null;
    try {
      existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }

    if (opts.onlyIfNew && existingMeta) {
      return { modified: false };
    }
    if (opts.onlyIfMatch && (!existingMeta || existingMeta.etag !== opts.onlyIfMatch)) {
      return { modified: false };
    }

    const etag = crypto.randomUUID();
    const metaPayload = JSON.stringify({
      key,
      etag,
      metadata: opts.metadata || {},
    });

    await Promise.all([fs.writeFile(dataPath, buf), fs.writeFile(metaPath, metaPayload, 'utf8')]);
    return { modified: true, etag };
  };

  return {
    async get(key, opts = {}) {
      return withDiskLock(storeName, async () => {
        const entry = await readUnsafe(key, opts);
        return entry ? entry.data : null;
      });
    },
    async getWithMetadata(key, opts = {}) {
      return withDiskLock(storeName, () => readUnsafe(key, opts));
    },
    async set(key, data, opts = {}) {
      const buf = data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : toBuffer(data);
      return withDiskLock(storeName, () => writeUnsafe(key, buf, opts));
    },
    async setJSON(key, value, opts = {}) {
      const buf = Buffer.from(JSON.stringify(value), 'utf8');
      return withDiskLock(storeName, () => writeUnsafe(key, buf, opts));
    },
    async list() {
      return withDiskLock(storeName, async () => {
        let files;
        try {
          files = await fs.readdir(baseDir);
        } catch (err) {
          if (err && err.code === 'ENOENT') return { blobs: [] };
          throw err;
        }
        const blobs = [];
        for (const f of files) {
          if (!f.endsWith('.meta.json')) continue;
          try {
            const metaDoc = JSON.parse(await fs.readFile(path.join(baseDir, f), 'utf8'));
            blobs.push({ key: metaDoc.key, etag: metaDoc.etag });
          } catch {
            // Ignore corrupt/partial metadata file
          }
        }
        return { blobs };
      });
    },
    async delete(key) {
      return withDiskLock(storeName, async () => {
        const { dataPath, metaPath } = keyPaths(key);
        await Promise.all([
          fs.unlink(dataPath).catch(() => {}),
          fs.unlink(metaPath).catch(() => {}),
        ]);
      });
    },
  };
}

// --- 4. Netlify Blobs Lazy Wrapper (Backwards compatibility on Netlify) ---
function createNetlifyBlobsStore(storeName) {
  let storePromise = null;
  const getNativeStore = () => {
    if (!storePromise) {
      storePromise = import('@netlify/blobs').then(({ getStore }) =>
        getStore({ name: storeName, consistency: 'strong' })
      );
    }
    return storePromise;
  };

  return {
    async get(key, opts) {
      return (await getNativeStore()).get(key, opts);
    },
    async getWithMetadata(key, opts) {
      return (await getNativeStore()).getWithMetadata(key, opts);
    },
    async set(key, data, opts) {
      return (await getNativeStore()).set(key, data, opts);
    },
    async setJSON(key, value, opts) {
      return (await getNativeStore()).setJSON(key, value, opts);
    },
    async list(opts) {
      return (await getNativeStore()).list(opts);
    },
    async delete(key) {
      return (await getNativeStore()).delete(key);
    },
  };
}

/**
 * Returns a strongly-consistent key/value & binary store backed by:
 * - In-memory Map for volatile stores (sessions, login throttles) on Node/Render
 * - PostgreSQL (DATABASE_URL) when configured
 * - Netlify Blobs when running on Netlify without DATABASE_URL
 * - Local disk (.data/) for zero-config local development
 */
export function getStorageStore(storeName, { volatile = false } = {}) {
  if (volatile && isNodeServerRuntime()) {
    return createMemoryStore(storeName);
  }

  const mode = getStorageMode();
  if (mode === 'postgres') {
    return createPostgresStore(storeName);
  }
  if (mode === 'netlify-blobs') {
    return createNetlifyBlobsStore(storeName);
  }

  if (getEnv('RENDER') && !warnedMissingDbOnRender) {
    warnedMissingDbOnRender = true;
    console.warn(
      '[kv-store] WARNING: Running on Render without DATABASE_URL. Data is stored on ephemeral local disk and will reset on restart/deploy. Set DATABASE_URL (e.g., Neon or Supabase free Postgres) for persistence.'
    );
  }

  return createLocalDiskStore(storeName);
}

export async function closeStoragePool() {
  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    pgPoolUrl = null;
    schemaReadyPromise = null;
    await pool.end().catch(() => {});
  }
}
