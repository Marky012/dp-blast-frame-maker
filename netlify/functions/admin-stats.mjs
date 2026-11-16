import { verifyAdminToken } from './_lib/admin-auth.mjs';
import { getActiveSessionStatus } from './session.mjs';
import { getAggregatedStats } from './_lib/usage-stats.mjs';

export default async (req) => {
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const auth = verifyAdminToken(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const url = new URL(req.url);
    const daysParam = parseInt(url.searchParams.get('days') || '1', 10);
    const days = daysParam === 7 || daysParam === 30 ? daysParam : 1;

    const { activeNow, maxConcurrent } = await getActiveSessionStatus();
    const stats = await getAggregatedStats({ days, activeNow, maxConcurrent });

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Error in GET /api/admin/stats:', err);
    return Response.json({ error: 'Failed to load usage statistics.' }, { status: 500 });
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

