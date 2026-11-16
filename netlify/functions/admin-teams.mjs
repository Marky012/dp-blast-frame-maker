import crypto from 'node:crypto';
import { verifyAdminToken } from './_lib/admin-auth.mjs';
import {
  getTeamsList,
  saveTeamsList,
  saveFrameBytes,
  deleteFrameBytes,
} from './_lib/teams-store.mjs';
import { validatePngBuffer } from './_lib/png.mjs';

const MAX_TEAMS = 20;

let adminMutex = Promise.resolve();
function runSerialized(fn) {
  const res = adminMutex.then(fn, fn);
  adminMutex = res.catch(() => {});
  return res;
}

function sanitizeColor(hex) {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) {
    return hex.trim().toLowerCase();
  }
  return '#2563eb';
}

async function parseAdminPayload(req) {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const name = form.get('name');
    const accentColor = form.get('accentColor');
    const file = form.get('frame');
    let frameBuffer = null;
    if (file && typeof file.arrayBuffer === 'function' && file.size > 0) {
      if (file.type && file.type !== 'image/png') {
        throw new Error('Frame must be a 1500x1500 PNG');
      }
      const ab = await file.arrayBuffer();
      frameBuffer = Buffer.from(ab);
    }
    return {
      name: typeof name === 'string' ? name.trim() : '',
      accentColor: typeof accentColor === 'string' ? accentColor.trim() : '',
      frameBuffer,
    };
  }

  const body = await req.json();
  let frameBuffer = null;
  if (body.frameBase64 && typeof body.frameBase64 === 'string') {
    const rawB64 = body.frameBase64.replace(/^data:image\/png;base64,/, '');
    frameBuffer = Buffer.from(rawB64, 'base64');
  }
  return {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    accentColor: typeof body.accentColor === 'string' ? body.accentColor.trim() : '',
    frameBuffer,
    orderedIds: Array.isArray(body.orderedIds) ? body.orderedIds : null,
  };
}

export default async (req, context) => {
  const auth = verifyAdminToken(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  // Path can be /api/admin/teams, /api/admin/teams/reorder, /api/admin/teams/:id
  const teamsIdx = pathParts.lastIndexOf('teams');
  const subParam =
    context?.params?.id ||
    (teamsIdx !== -1 && pathParts.length > teamsIdx + 1
      ? decodeURIComponent(pathParts[teamsIdx + 1])
      : null);

  try {
    return await runSerialized(async () => {
      // 1. POST /api/admin/teams/reorder
      if (req.method === 'POST' && subParam === 'reorder') {
        const { orderedIds } = await parseAdminPayload(req);
        if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
          return Response.json({ error: 'orderedIds array is required.' }, { status: 400 });
        }

        const currentTeams = await getTeamsList();
        const byId = new Map(currentTeams.map((t) => [t.id, t]));
        const reordered = [];

        for (const id of orderedIds) {
          if (byId.has(id)) {
            reordered.push(byId.get(id));
            byId.delete(id);
          }
        }
        // Append any remaining teams not explicitly in orderedIds
        for (const leftover of byId.values()) {
          reordered.push(leftover);
        }

        const saved = await saveTeamsList(reordered);
        return Response.json({ teams: saved });
      }

      // 2. POST /api/admin/teams (Create new team)
      if (req.method === 'POST' && !subParam) {
        const { name, accentColor, frameBuffer } = await parseAdminPayload(req);
        if (!name) {
          return Response.json({ error: 'Team name is required.' }, { status: 400 });
        }
        if (!frameBuffer) {
          return Response.json({ error: 'Frame must be a 1500x1500 PNG' }, { status: 400 });
        }

        const pngCheck = validatePngBuffer(frameBuffer);
        if (!pngCheck.valid) {
          return Response.json({ error: pngCheck.error }, { status: 400 });
        }

        const currentTeams = await getTeamsList();
        if (currentTeams.length >= MAX_TEAMS) {
          return Response.json(
            { error: `Maximum of ${MAX_TEAMS} teams reached.` },
            { status: 400 }
          );
        }

        const newTeam = {
          id: `team-${crypto.randomUUID().slice(0, 8)}`,
          name: name.slice(0, 80),
          accentColor: sanitizeColor(accentColor),
          frameVersion: 1,
          order: currentTeams.length,
        };

        await saveFrameBytes(newTeam.id, frameBuffer, newTeam.frameVersion);
        const updated = await saveTeamsList([...currentTeams, newTeam]);
        return Response.json({ team: newTeam, teams: updated }, { status: 201 });
      }

      // 3. PUT /api/admin/teams/:id (Update team name, accentColor, and/or replace frame)
      if (req.method === 'PUT' && subParam) {
        const { name, accentColor, frameBuffer } = await parseAdminPayload(req);
        const currentTeams = await getTeamsList();
        const idx = currentTeams.findIndex((t) => t.id === subParam);
        if (idx === -1) {
          return Response.json({ error: 'Team not found.' }, { status: 404 });
        }

        const existing = currentTeams[idx];
        let nextFrameVersion = existing.frameVersion || 1;

        if (frameBuffer) {
          const pngCheck = validatePngBuffer(frameBuffer);
          if (!pngCheck.valid) {
            return Response.json({ error: pngCheck.error }, { status: 400 });
          }
          nextFrameVersion += 1;
          await saveFrameBytes(existing.id, frameBuffer, nextFrameVersion);
        }

        const updatedTeam = {
          ...existing,
          name: name ? name.slice(0, 80) : existing.name,
          accentColor: accentColor ? sanitizeColor(accentColor) : existing.accentColor,
          frameVersion: nextFrameVersion,
        };

        currentTeams[idx] = updatedTeam;
        const saved = await saveTeamsList(currentTeams);
        return Response.json({ team: updatedTeam, teams: saved });
      }

      // 4. DELETE /api/admin/teams/:id
      if (req.method === 'DELETE' && subParam) {
        const currentTeams = await getTeamsList();
        const exists = currentTeams.some((t) => t.id === subParam);
        if (!exists) {
          return Response.json({ error: 'Team not found.' }, { status: 404 });
        }

        const remaining = currentTeams.filter((t) => t.id !== subParam);
        const saved = await saveTeamsList(remaining);
        await deleteFrameBytes(subParam);
        return Response.json({ teams: saved });
      }

      return Response.json({ error: 'Method or endpoint not supported.' }, { status: 405 });
    });
  } catch (err) {
    console.error('Error in admin-teams:', err);
    return Response.json({ error: err.message || 'Server error processing request.' }, { status: 400 });
  }
};

export const config = {
  path: [
    '/api/admin/teams',
    '/api/admin/teams/:id',
    '/.netlify/functions/admin-teams',
    '/.netlify/functions/admin/teams',
    '/.netlify/functions/admin/teams/:id',
  ],
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

