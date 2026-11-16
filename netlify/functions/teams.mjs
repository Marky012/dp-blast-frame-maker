import { getTeamsList } from './_lib/teams-store.mjs';

export default async (req) => {
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const teams = await getTeamsList();
    const payload = teams.map(({ id, name, accentColor, frameVersion, order }) => ({
      id,
      name,
      accentColor,
      frameVersion,
      order,
    }));

    return new Response(JSON.stringify({ teams: payload }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (err) {
    console.error('Error in GET /api/teams:', err);
    return Response.json({ error: 'Failed to load teams' }, { status: 500 });
  }
};

export const config = {
  path: ['/api/teams', '/.netlify/functions/teams'],
  rateLimit: {
    windowLimit: 120,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

