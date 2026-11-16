import { getFrameBytes } from './_lib/teams-store.mjs';

export default async (req, context) => {
  if (req.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const url = new URL(req.url);
    let teamId = context?.params?.id;
    if (!teamId) {
      const parts = url.pathname.split('/').filter(Boolean);
      teamId = parts[parts.length - 1];
    }

    if (!teamId) {
      return Response.json({ error: 'Missing frame ID' }, { status: 400 });
    }

    const buf = await getFrameBytes(decodeURIComponent(teamId));
    if (!buf) {
      return Response.json({ error: 'Frame not found' }, { status: 404 });
    }

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.error('Error in GET /api/frames/:id:', err);
    return Response.json({ error: 'Failed to load frame' }, { status: 500 });
  }
};

export const config = {
  path: ['/api/frames/:id', '/.netlify/functions/frames/:id'],
  rateLimit: {
    windowLimit: 200,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

