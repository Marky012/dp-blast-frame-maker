import { verifyAdminToken } from './_lib/admin-auth.mjs';
import { getActiveSessionStatus } from './session.mjs';
import { getAggregatedStats, setTeamParticipationCount } from './_lib/usage-stats.mjs';
import { getTeamsList } from './_lib/teams-store.mjs';

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const auth = verifyAdminToken(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    if (req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'Invalid JSON payload.' }, { status: 400 });
      }

      const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : '';
      if (!teamId) {
        return Response.json({ error: 'Valid teamId is required.' }, { status: 400 });
      }

      const rawCount = body?.count;
      const numCount = Number(rawCount);
      if (
        rawCount === '' ||
        rawCount === null ||
        rawCount === undefined ||
        !Number.isFinite(numCount) ||
        numCount < 0 ||
        numCount > 1000000
      ) {
        return Response.json(
          { error: 'Count must be a valid number between 0 and 1,000,000.' },
          { status: 400 }
        );
      }

      const teams = await getTeamsList();
      if (!teams.some((t) => t.id === teamId)) {
        return Response.json({ error: 'Team not found.' }, { status: 404 });
      }

      await setTeamParticipationCount({ teamId, count: Math.floor(numCount) });

      const daysParam = parseInt(body?.days || '1', 10);
      const days = daysParam === 7 || daysParam === 30 ? daysParam : 1;
      const { activeNow, maxConcurrent } = await getActiveSessionStatus();
      const stats = await getAggregatedStats({ days, activeNow, maxConcurrent, teams });

      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    const url = new URL(req.url);
    const daysParam = parseInt(url.searchParams.get('days') || '1', 10);
    const days = daysParam === 7 || daysParam === 30 ? daysParam : 1;

    const [{ activeNow, maxConcurrent }, teams] = await Promise.all([
      getActiveSessionStatus(),
      getTeamsList(),
    ]);
    const stats = await getAggregatedStats({ days, activeNow, maxConcurrent, teams });

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error(`Error in ${req.method} /api/admin/stats:`, err);
    return Response.json({ error: 'Failed to process usage statistics.' }, { status: 500 });
  }
};

export const config = {
  path: ['/api/admin/stats', '/.netlify/functions/admin-stats', '/.netlify/functions/admin/stats'],
  rateLimit: {
    windowLimit: 120,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

