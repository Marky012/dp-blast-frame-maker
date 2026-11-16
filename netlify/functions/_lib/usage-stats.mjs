import { getStore } from '@netlify/blobs';
import { getEnv } from './env.mjs';

const USAGE_STORE_NAME = 'dp-blast-usage-stats';
const DEFAULT_TIMEZONE = 'Asia/Manila';
const RETENTION_DAYS = 30;

export const QUARTER_META = [
  { key: 'Q1', label: 'Q1 (12am–6am)', range: '12:00am–5:59am' },
  { key: 'Q2', label: 'Q2 (6am–12pm)', range: '6:00am–11:59am' },
  { key: 'Q3', label: 'Q3 (12pm–6pm)', range: '12:00pm–5:59pm' },
  { key: 'Q4', label: 'Q4 (6pm–12am)', range: '6:00pm–11:59pm' },
];

export function getUsageStore() {
  return getStore({ name: USAGE_STORE_NAME, consistency: 'strong' });
}

export function getTimeInfo(now = new Date()) {
  let timezone = getEnv('TIMEZONE', DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
  } catch {
    timezone = DEFAULT_TIMEZONE;
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
  }

  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = map.year;
  const month = map.month;
  const day = map.day;
  const hour = Number(map.hour) % 24;
  const dateKey = `${year}-${month}-${day}`;

  let quarterKey = 'Q4';
  if (hour < 6) quarterKey = 'Q1';
  else if (hour < 12) quarterKey = 'Q2';
  else if (hour < 18) quarterKey = 'Q3';

  return { timezone, dateKey, hour, quarterKey };
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function createEmptyQuarter() {
  return {
    sessionsStarted: 0,
    peakConcurrent: 0,
    rejectedFull: 0,
    rejectedIp: 0,
  };
}

function createEmptyDay(dateKey) {
  return {
    date: dateKey,
    sessionsStarted: 0,
    peakConcurrent: 0,
    rejectedFull: 0,
    rejectedIp: 0,
    quarters: {
      Q1: createEmptyQuarter(),
      Q2: createEmptyQuarter(),
      Q3: createEmptyQuarter(),
      Q4: createEmptyQuarter(),
    },
  };
}

async function pruneOldDays(store, todayDateKey) {
  const cutoffKey = shiftDateKey(todayDateKey, -RETENTION_DAYS);
  try {
    const { blobs } = await store.list();
    const expired = (blobs || []).filter(
      (b) => /^\d{4}-\d{2}-\d{2}$/.test(b.key) && b.key < cutoffKey
    );
    if (expired.length > 0) {
      await Promise.all(expired.map((b) => store.delete(b.key)));
    }
  } catch (err) {
    console.error('Failed to prune old usage stats:', err);
  }
}

/**
 * Records a /api/session/start outcome ('started' | 'rejectedFull' | 'rejectedIp')
 * into today's counter blob keyed by date in TIMEZONE. Stores zero PII or IPs.
 */
export async function recordSessionStartEvent({ outcome, activeCount = 0 }) {
  const store = getUsageStore();
  const { dateKey, quarterKey } = getTimeInfo();

  const existing = await store.get(dateKey, { type: 'json', consistency: 'strong' });
  const isNewDay = !existing;
  const dayData = existing && typeof existing === 'object' ? existing : createEmptyDay(dateKey);

  if (!dayData.quarters) {
    dayData.quarters = createEmptyDay(dateKey).quarters;
  }
  if (!dayData.quarters[quarterKey]) {
    dayData.quarters[quarterKey] = createEmptyQuarter();
  }

  const q = dayData.quarters[quarterKey];
  const countNum = Math.max(0, Number(activeCount) || 0);

  if (outcome === 'started') {
    dayData.sessionsStarted = (dayData.sessionsStarted || 0) + 1;
    q.sessionsStarted = (q.sessionsStarted || 0) + 1;
  } else if (outcome === 'rejectedFull') {
    dayData.rejectedFull = (dayData.rejectedFull || 0) + 1;
    q.rejectedFull = (q.rejectedFull || 0) + 1;
  } else if (outcome === 'rejectedIp') {
    dayData.rejectedIp = (dayData.rejectedIp || 0) + 1;
    q.rejectedIp = (q.rejectedIp || 0) + 1;
  }

  dayData.peakConcurrent = Math.max(dayData.peakConcurrent || 0, countNum);
  q.peakConcurrent = Math.max(q.peakConcurrent || 0, countNum);

  await store.setJSON(dateKey, dayData);

  if (isNewDay) {
    await pruneOldDays(store, dateKey);
  }
}

/**
 * Aggregates usage counters across the last `days` (1, 7, or 30) in TIMEZONE.
 */
export async function getAggregatedStats({ days = 1, activeNow = 0, maxConcurrent = 50 }) {
  const store = getUsageStore();
  const { timezone, dateKey: todayKey, quarterKey: currentQuarter } = getTimeInfo();

  const validDays = days === 7 || days === 30 ? days : 1;
  const dateKeys = [];
  for (let i = 0; i < validDays; i++) {
    dateKeys.push(shiftDateKey(todayKey, -i));
  }

  const dayBlobs = await Promise.all(
    dateKeys.map((k) => store.get(k, { type: 'json', consistency: 'strong' }).catch(() => null))
  );

  const todayBlob = dayBlobs[0] || createEmptyDay(todayKey);
  const peakToday = Math.max(todayBlob.peakConcurrent || 0, activeNow);
  const rejectedFullToday = todayBlob.rejectedFull || 0;
  const rejectedIpToday = todayBlob.rejectedIp || 0;

  const quarterTotals = {};
  for (const meta of QUARTER_META) {
    quarterTotals[meta.key] = {
      key: meta.key,
      label: meta.label,
      range: meta.range,
      sessionsStarted: 0,
      peakConcurrent: 0,
    };
  }

  for (let idx = 0; idx < dayBlobs.length; idx++) {
    const day = dayBlobs[idx];
    if (!day || !day.quarters) continue;
    for (const meta of QUARTER_META) {
      const q = day.quarters[meta.key];
      if (!q) continue;
      quarterTotals[meta.key].sessionsStarted += q.sessionsStarted || 0;
      quarterTotals[meta.key].peakConcurrent = Math.max(
        quarterTotals[meta.key].peakConcurrent,
        q.peakConcurrent || 0
      );
    }
  }

  // Ensure live activeNow is reflected in current quarter's peakConcurrent
  quarterTotals[currentQuarter].peakConcurrent = Math.max(
    quarterTotals[currentQuarter].peakConcurrent,
    activeNow
  );

  // Best-effort cleanup of blobs >30 days old
  await pruneOldDays(store, todayKey);

  return {
    activeNow,
    maxConcurrent,
    peakToday,
    rejectedFullToday,
    rejectedIpToday,
    quarters: QUARTER_META.map((m) => quarterTotals[m.key]),
    currentQuarter,
    timezone,
    days: validDays,
    updatedAt: new Date().toISOString(),
  };
}

