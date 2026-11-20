import { getStorageStore } from './kv-store.mjs';
import { generatePlaceholderFramePng } from './png.mjs';

const STORE_NAME = 'dp-blast-store-1500';
const TEAMS_KEY = 'teams';

const INITIAL_TEAMS = [
  { id: 'team-1', name: 'Team 1', accentColor: '#e11d48', frameVersion: 1, order: 0 },
  { id: 'team-2', name: 'Team 2', accentColor: '#2563eb', frameVersion: 1, order: 1 },
  { id: 'team-3', name: 'Team 3', accentColor: '#059669', frameVersion: 1, order: 2 },
  { id: 'team-4', name: 'Team 4', accentColor: '#d97706', frameVersion: 1, order: 3 },
  { id: 'team-5', name: 'Team 5', accentColor: '#7c3aed', frameVersion: 1, order: 4 },
  { id: 'team-6', name: 'Team 6', accentColor: '#0891b2', frameVersion: 1, order: 5 },
  { id: 'team-7', name: 'Team 7', accentColor: '#ea580c', frameVersion: 1, order: 6 },
];

export function getBlobsStore() {
  return getStorageStore(STORE_NAME);
}

/**
 * Ensures the store is seeded on first run (when "teams" key is null).
 * Seeding happens only once because once initialized, "teams" is a JSON array (even if later emptied to []).
 */
export async function getTeamsList() {
  const store = getBlobsStore();
  let teams = await store.get(TEAMS_KEY, { type: 'json', consistency: 'strong' });

  if (teams === null) {
    // Seed 7 placeholder teams and their frames once
    for (let i = 0; i < INITIAL_TEAMS.length; i++) {
      const t = INITIAL_TEAMS[i];
      const pngBuf = generatePlaceholderFramePng(t.accentColor, i + 1);
      await store.set(t.id, pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.byteLength), {
        metadata: { contentType: 'image/png', frameVersion: t.frameVersion },
      });
    }
    const writeRes = await store.setJSON(TEAMS_KEY, INITIAL_TEAMS, { onlyIfNew: true });
    if (writeRes && writeRes.modified === false) {
      teams = await store.get(TEAMS_KEY, { type: 'json', consistency: 'strong' });
    } else {
      teams = INITIAL_TEAMS;
    }
  }

  if (!Array.isArray(teams)) {
    teams = [];
  }

  return [...teams].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export async function saveTeamsList(teams) {
  const store = getBlobsStore();
  const normalized = teams.map((t, idx) => ({
    id: t.id,
    name: t.name,
    accentColor: t.accentColor,
    frameVersion: t.frameVersion || 1,
    order: idx,
  }));
  await store.setJSON(TEAMS_KEY, normalized);
  return normalized;
}

export async function getFrameBytes(teamId) {
  const store = getBlobsStore();
  let buf = await store.get(teamId, { type: 'arrayBuffer', consistency: 'strong' });
  if (!buf) {
    // Ensure seeded if store hasn't been initialized yet
    const teams = await getTeamsList();
    const matched = teams.find((t) => t.id === teamId);
    if (matched) {
      buf = await store.get(teamId, { type: 'arrayBuffer', consistency: 'strong' });
    }
  }
  return buf;
}

export async function saveFrameBytes(teamId, pngBuffer, frameVersion = 1) {
  const store = getBlobsStore();
  const arrayBuffer = pngBuffer.buffer.slice(
    pngBuffer.byteOffset,
    pngBuffer.byteOffset + pngBuffer.byteLength
  );
  await store.set(teamId, arrayBuffer, {
    metadata: { contentType: 'image/png', frameVersion },
  });
}

export async function deleteFrameBytes(teamId) {
  const store = getBlobsStore();
  await store.delete(teamId);
}
