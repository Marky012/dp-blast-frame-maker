import { getStorageStore, isNodeServerRuntime } from './kv-store.mjs';
import { getEnv } from './env.mjs';

const USAGE_STORE_NAME = 'dp-blast-usage-stats';
const TEAM_TOTALS_KEY = 'team-participation-totals';
const DEFAULT_TIMEZONE = 'Asia/Manila';
const RETENTION_DAYS = 30;
const STATS_FLUSH_INTERVAL_MS = 5000;

const pendingSessionEvents = new Map();
let flushTimer = null;
let flushPromise = Promise.resolve();

export const QUARTER_META = [
  { key: 'Q1', label: 'Q1 (12am–6am)', range: '12:00am–5:59am' },
  { key: 'Q2', label: 'Q2 (6am–12pm)', range: '6:00am–11:59am' },
  { key: 'Q3', label: 'Q3 (12pm–6pm)', range: '12:00pm–5:59pm' },
  { key: 'Q4', label: 'Q4 (6pm–12am)', range: '6:00pm–11:59pm' },
];

export function getUsageStore() {
  return getStorageStore(USAGE_STORE_NAME);
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
    totalDownloads: 0,
    teamDownloads: {},
    quarters: {
      Q1: createEmptyQuarter(),
      Q2: createEmptyQuarter(),
      Q3: createEmptyQuarter(),
      Q4: createEmptyQuarter(),
    },
  };
}

async function mutateJsonBlob(store, key, createDefault, mutator) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const isNew = !entry || !entry.data || typeof entry.data !== 'object';
    const data = isNew ? createDefault() : entry.data;
    const etag = entry ? entry.etag : null;

    mutator(data);

    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    const writeRes = await store.setJSON(key, data, writeOpts);
    if (!writeRes || writeRes.modified !== false) {
      return { isNew, data };
    }
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 25)));
  }

  const current = await store.get(key, { type: 'json', consistency: 'strong' });
  const isNew = !current || typeof current !== 'object';
  const fallback = isNew ? createDefault() : current;
  mutator(fallback);
  await store.setJSON(key, fallback);
  return { isNew, data: fallback };
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

function applySessionDelta(dayData, quarterKey, delta) {
  if (!dayData.quarters) {
    dayData.quarters = createEmptyDay(dayData.date).quarters;
  }
  if (!dayData.quarters[quarterKey]) {
    dayData.quarters[quarterKey] = createEmptyQuarter();
  }

  const q = dayData.quarters[quarterKey];
  dayData.sessionsStarted = (dayData.sessionsStarted || 0) + delta.started;
  q.sessionsStarted = (q.sessionsStarted || 0) + delta.started;

  dayData.rejectedFull = (dayData.rejectedFull || 0) + delta.rejectedFull;
  q.rejectedFull = (q.rejectedFull || 0) + delta.rejectedFull;

  dayData.rejectedIp = (dayData.rejectedIp || 0) + delta.rejectedIp;
  q.rejectedIp = (q.rejectedIp || 0) + delta.rejectedIp;

  dayData.peakConcurrent = Math.max(dayData.peakConcurrent || 0, delta.peakConcurrent);
  q.peakConcurrent = Math.max(q.peakConcurrent || 0, delta.peakConcurrent);
}

/**
 * Flushes coalesced session start/rejection metrics to persistent storage.
 */
export async function flushPendingSessionEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (pendingSessionEvents.size === 0) {
    await flushPromise;
    return;
  }

  const entries = Array.from(pendingSessionEvents.entries());
  pendingSessionEvents.clear();

  const runFlush = flushPromise.then(async () => {
    const store = getUsageStore();
    for (const [, bucket] of entries) {
      try {
        const res = await mutateJsonBlob(
          store,
          bucket.dateKey,
          () => createEmptyDay(bucket.dateKey),
          (dayData) => applySessionDelta(dayData, bucket.quarterKey, bucket)
        );
        if (res?.isNew) {
          await pruneOldDays(store, bucket.dateKey);
        }
      } catch (err) {
        console.error('Failed to flush session usage stats:', err);
      }
    }
  });

  flushPromise = runFlush.catch(() => {});
  await runFlush;
}

/**
 * Records a /api/session/start outcome ('started' | 'rejectedFull' | 'rejectedIp')
 * into today's counter blob keyed by date in TIMEZONE. Stores zero PII or IPs.
 * On Node/Render, writes are coalesced in memory every 5s to protect CPU and DB limits.
 */
export async function recordSessionStartEvent({ outcome, activeCount = 0 }) {
  const { dateKey, quarterKey } = getTimeInfo();
  const countNum = Math.max(0, Number(activeCount) || 0);

  if (isNodeServerRuntime()) {
    const bucketKey = `${dateKey}|${quarterKey}`;
    let bucket = pendingSessionEvents.get(bucketKey);
    if (!bucket) {
      bucket = {
        dateKey,
        quarterKey,
        started: 0,
        rejectedFull: 0,
        rejectedIp: 0,
        peakConcurrent: 0,
      };
      pendingSessionEvents.set(bucketKey, bucket);
    }

    if (outcome === 'started') bucket.started += 1;
    else if (outcome === 'rejectedFull') bucket.rejectedFull += 1;
    else if (outcome === 'rejectedIp') bucket.rejectedIp += 1;
    bucket.peakConcurrent = Math.max(bucket.peakConcurrent, countNum);

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingSessionEvents().catch(() => {});
      }, STATS_FLUSH_INTERVAL_MS);
      flushTimer.unref?.();
    }
    return;
  }

  const store = getUsageStore();
  const res = await mutateJsonBlob(
    store,
    dateKey,
    () => createEmptyDay(dateKey),
    (dayData) =>
      applySessionDelta(dayData, quarterKey, {
        started: outcome === 'started' ? 1 : 0,
        rejectedFull: outcome === 'rejectedFull' ? 1 : 0,
        rejectedIp: outcome === 'rejectedIp' ? 1 : 0,
        peakConcurrent: countNum,
      })
  );

  if (res?.isNew) {
    await pruneOldDays(store, dateKey);
  }
}

/**
 * Records a successful student DP Blast export & download for a given teamId.
 * Persists both all-time per-team totals and daily per-team counts. Stores zero PII.
 */
export async function recordTeamParticipation({ teamId }) {
  if (!teamId || typeof teamId !== 'string') return;

  const store = getUsageStore();
  const { dateKey } = getTimeInfo();

  const [, dayRes] = await Promise.all([
    mutateJsonBlob(
      store,
      TEAM_TOTALS_KEY,
      () => ({ counts: {}, updatedAt: null }),
      (totals) => {
        if (!totals.counts || typeof totals.counts !== 'object') {
          totals.counts = {};
        }
        totals.counts[teamId] = (Number(totals.counts[teamId]) || 0) + 1;
        totals.updatedAt = new Date().toISOString();
      }
    ),
    mutateJsonBlob(
      store,
      dateKey,
      () => createEmptyDay(dateKey),
      (dayData) => {
        if (!dayData.teamDownloads || typeof dayData.teamDownloads !== 'object') {
          dayData.teamDownloads = {};
        }
        dayData.teamDownloads[teamId] = (Number(dayData.teamDownloads[teamId]) || 0) + 1;
        dayData.totalDownloads = (Number(dayData.totalDownloads) || 0) + 1;
      }
    ),
  ]);

  if (dayRes?.isNew) {
    await pruneOldDays(store, dateKey);
  }
}

/**
 * Allows an admin to explicitly set/adjust a team's total participation count.
 * Future student downloads will continue incrementing (+1) from this value.
 */
export async function setTeamParticipationCount({ teamId, count }) {
  if (!teamId || typeof teamId !== 'string') return;
  const cleanCount = Math.max(0, Math.floor(Number(count) || 0));

  const store = getUsageStore();
  const { dateKey } = getTimeInfo();

  const [, dayRes] = await Promise.all([
    mutateJsonBlob(
      store,
      TEAM_TOTALS_KEY,
      () => ({ counts: {}, updatedAt: null }),
      (totals) => {
        if (!totals.counts || typeof totals.counts !== 'object') {
          totals.counts = {};
        }
        totals.counts[teamId] = cleanCount;
        totals.updatedAt = new Date().toISOString();
      }
    ),
    mutateJsonBlob(
      store,
      dateKey,
      () => createEmptyDay(dateKey),
      (dayData) => {
        if (!dayData.teamDownloads || typeof dayData.teamDownloads !== 'object') {
          dayData.teamDownloads = {};
        }
        if ((Number(dayData.teamDownloads[teamId]) || 0) > cleanCount) {
          dayData.teamDownloads[teamId] = cleanCount;
          dayData.totalDownloads = Object.values(dayData.teamDownloads).reduce(
            (sum, val) => sum + (Number(val) || 0),
            0
          );
        }
      }
    ),
  ]);

  if (dayRes?.isNew) {
    await pruneOldDays(store, dateKey);
  }
}

/**
 * Aggregates usage counters across the last `days` (1, 7, or 30) in TIMEZONE.
 */
export async function getAggregatedStats({ days = 1, activeNow = 0, maxConcurrent = 50, teams = [] }) {
  await flushPendingSessionEvents();
  const store = getUsageStore();
  const { timezone, dateKey: todayKey, quarterKey: currentQuarter } = getTimeInfo();

  const validDays = days === 7 || days === 30 ? days : 1;
  const dateKeys = [];
  for (let i = 0; i < validDays; i++) {
    dateKeys.push(shiftDateKey(todayKey, -i));
  }

  const [totalsBlob, ...dayBlobs] = await Promise.all([
    store.get(TEAM_TOTALS_KEY, { type: 'json', consistency: 'strong' }).catch(() => null),
    ...dateKeys.map((k) => store.get(k, { type: 'json', consistency: 'strong' }).catch(() => null)),
  ]);

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

  // Per-team participation metrics
  const totalsCounts =
    totalsBlob && totalsBlob.counts && typeof totalsBlob.counts === 'object'
      ? totalsBlob.counts
      : {};
  const todayTeamMap =
    todayBlob.teamDownloads && typeof todayBlob.teamDownloads === 'object'
      ? todayBlob.teamDownloads
      : {};

  const safeTeams = Array.isArray(teams) ? teams : [];
  const rawTeamStats = safeTeams.map((team) => {
    const todayDownloads = Number(todayTeamMap[team.id]) || 0;
    let periodDownloads = 0;
    for (let idx = 0; idx < dayBlobs.length; idx++) {
      const day = dayBlobs[idx];
      if (day?.teamDownloads && typeof day.teamDownloads === 'object') {
        periodDownloads += Number(day.teamDownloads[team.id]) || 0;
      }
    }
    const hasExplicitTotal = Object.prototype.hasOwnProperty.call(totalsCounts, team.id);
    const totalDownloads = hasExplicitTotal
      ? Math.max(0, Number(totalsCounts[team.id]) || 0)
      : periodDownloads;

    return {
      id: team.id,
      name: team.name,
      accentColor: team.accentColor || '#2563eb',
      order: team.order ?? 0,
      totalDownloads,
      todayDownloads,
      periodDownloads,
    };
  });

  rawTeamStats.sort((a, b) => {
    if (b.totalDownloads !== a.totalDownloads) return b.totalDownloads - a.totalDownloads;
    if (b.todayDownloads !== a.todayDownloads) return b.todayDownloads - a.todayDownloads;
    return a.order - b.order;
  });

  const totalDownloadsAllTeams = rawTeamStats.reduce((sum, t) => sum + t.totalDownloads, 0);
  const todayDownloadsAllTeams = rawTeamStats.reduce((sum, t) => sum + t.todayDownloads, 0);
  const periodDownloadsAllTeams = rawTeamStats.reduce((sum, t) => sum + t.periodDownloads, 0);
  const maxTeamTotal =
    rawTeamStats.length > 0 ? Math.max(...rawTeamStats.map((t) => t.totalDownloads)) : 0;

  const teamParticipation = rawTeamStats.map((t, idx) => ({
    ...t,
    rank: idx + 1,
    isLeader: t.totalDownloads > 0 && t.totalDownloads === maxTeamTotal,
    sharePct:
      totalDownloadsAllTeams > 0 ? Math.round((t.totalDownloads / totalDownloadsAllTeams) * 100) : 0,
  }));

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
    teamParticipation,
    totalDownloadsAllTeams,
    todayDownloadsAllTeams,
    periodDownloadsAllTeams,
    updatedAt: new Date().toISOString(),
  };
}

