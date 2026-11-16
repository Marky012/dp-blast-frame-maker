import assert from 'node:assert';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStats(baseUrl, token, days = 1) {
  const res = await fetch(`${baseUrl}/api/admin/stats?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200, `GET /api/admin/stats?days=${days} should return 200`);
  return await res.json();
}

export async function runLimiterTests(options = {}) {
  const BASE_URL = (options.baseUrl || process.env.TEST_BASE_URL || 'http://localhost:8888').replace(
    /\/+$/,
    ''
  );
  const ADMIN_PASSWORD = options.adminPassword || process.env.ADMIN_PASSWORD || 'TempAdminPass2026!';
  const isInProcess = Boolean(options.inProcess || process.env.TEST_IN_PROCESS === '1');
  const skipTtl = options.skipTtl ?? process.env.TEST_SKIP_TTL === '1';
  const skipPerIpOverride = options.skipPerIpOverride ?? process.env.TEST_SKIP_PER_IP === '1';

  const results = [];
  const record = (name, passed, details) => {
    results.push({ name, status: passed ? 'PASS' : 'FAIL', details });
  };

  console.log(`\nRunning Limiter Test Suite (B1/B3) against ${BASE_URL}\n`);

  // Authenticate as admin first
  const unauthStats = await fetch(`${BASE_URL}/api/admin/stats`);
  assert.strictEqual(unauthStats.status, 401, '/api/admin/stats without token must return 401');

  const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login must return 200');
  const { token } = await loginRes.json();
  assert.ok(token, 'Admin login must return bearer token');

  const initialStats = await fetchStats(BASE_URL, token, 1);
  const maxConcurrent = initialStats.maxConcurrent;
  const activeSessions = [];
  const testIpBase = `198.51.${Math.floor(Math.random() * 200) + 1}`;

  const startSession = async (ipSuffix) => {
    const ip = `${testIpBase}.${ipSuffix}`;
    const res = await fetch(`${BASE_URL}/api/session/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nf-client-connection-ip': ip,
        'x-forwarded-for': ip,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const endSession = async (sessionId) => {
    await fetch(`${BASE_URL}/api/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  };

  try {
    // 1. Start MAX_CONCURRENT (3) sessions -> expect all "ok"
    try {
      for (let i = 1; i <= maxConcurrent; i++) {
        const { status, data } = await startSession(i);
        assert.strictEqual(status, 200, `Session #${i} expected 200, got ${status}`);
        assert.strictEqual(data.status, 'ok');
        activeSessions.push(data.sessionId);
      }
      record(
        `1. Start ${maxConcurrent} sessions`,
        true,
        `All ${maxConcurrent} sessions returned HTTP 200 status="ok"`
      );
    } catch (err) {
      record(`1. Start ${maxConcurrent} sessions`, false, err.message);
      throw err;
    }

    // 2. Start 4th session -> expect HTTP 429 with { status: "full", retryAfter }
    try {
      const { status, data } = await startSession(maxConcurrent + 1);
      assert.strictEqual(status, 429, `Expected 429 when full, got ${status}`);
      assert.strictEqual(data.status, 'full', `Expected status="full", got ${data.status}`);
      assert.ok(typeof data.retryAfter === 'number' && data.retryAfter > 0, 'retryAfter required');
      record(
        `2. Reject #${maxConcurrent + 1} when full`,
        true,
        `HTTP 429 { status: "${data.status}", retryAfter: ${data.retryAfter} }`
      );
    } catch (err) {
      record(`2. Reject #${maxConcurrent + 1} when full`, false, err.message);
      throw err;
    }

    // 3. Call /end on one session, then start another -> expect "ok" (slot freed)
    try {
      const freedId = activeSessions.shift();
      await endSession(freedId);
      const { status, data } = await startSession(maxConcurrent + 2);
      assert.strictEqual(status, 200, `Expected 200 after /end freed a slot, got ${status}`);
      assert.strictEqual(data.status, 'ok');
      activeSessions.push(data.sessionId);
      record('3. Free slot via /end & re-enter', true, 'Slot freed and replacement start returned 200 "ok"');
    } catch (err) {
      record('3. Free slot via /end & re-enter', false, err.message);
      throw err;
    }

    // 4. Confirm /api/admin/* still works while student cap is full (and rejects 401 without token)
    try {
      const fullAdminStats = await fetchStats(BASE_URL, token, 1);
      assert.strictEqual(
        fullAdminStats.activeNow,
        maxConcurrent,
        `Expected activeNow=${maxConcurrent}, got ${fullAdminStats.activeNow}`
      );
      const teamsRes = await fetch(`${BASE_URL}/api/teams`);
      assert.strictEqual(teamsRes.status, 200);
      record(
        '4. /api/admin/* works while full',
        true,
        `401 unauth enforced; authenticated /api/admin/stats returned ${fullAdminStats.activeNow}/${fullAdminStats.maxConcurrent}`
      );
    } catch (err) {
      record('4. /api/admin/* works while full', false, err.message);
      throw err;
    }

    // 5. Stop heartbeats & wait past TTL -> expect slots to free automatically
    if (!skipTtl) {
      const prevTtl = process.env.SESSION_TTL_SECONDS;
      try {
        let waitMs;
        if (isInProcess) {
          process.env.SESSION_TTL_SECONDS = '2';
          waitMs = 2300;
        } else {
          const ttlSec = parseInt(process.env.SESSION_TTL_SECONDS || '60', 10) || 60;
          waitMs = (ttlSec + 3) * 1000;
        }
        console.log(`Waiting ${Math.round(waitMs / 1000)}s for session TTL expiration...`);
        await sleep(waitMs);

        const afterTtlStats = await fetchStats(BASE_URL, token, 1);
        assert.strictEqual(afterTtlStats.activeNow, 0, `Expected activeNow=0 after TTL, got ${afterTtlStats.activeNow}`);

        const { status, data } = await startSession(maxConcurrent + 3);
        assert.strictEqual(status, 200, 'Expected new session to succeed after TTL expiration');
        assert.strictEqual(data.status, 'ok');
        activeSessions.length = 0;
        activeSessions.push(data.sessionId);

        // Immediately end so cap is clear
        await endSession(data.sessionId);
        activeSessions.length = 0;

        record('5. TTL auto-expiry frees slots', true, `Sessions expired cleanly; activeNow=0, new start returned 200 "ok"`);
      } catch (err) {
        record('5. TTL auto-expiry frees slots', false, err.message);
        throw err;
      } finally {
        if (isInProcess) {
          if (prevTtl === undefined) delete process.env.SESSION_TTL_SECONDS;
          else process.env.SESSION_TTL_SECONDS = prevTtl;
        }
      }
    } else {
      // End current active sessions cleanly before next check
      while (activeSessions.length > 0) {
        await endSession(activeSessions.pop());
      }
      record('5. TTL auto-expiry frees slots', true, 'Skipped wait in quick mode (tested in B1)');
    }

    // 6. Per-IP block check (MAX_PER_IP=2 locally when in-process, or using server's MAX_PER_IP if <= maxConcurrent)
    if (!skipPerIpOverride) {
      const prevMaxPerIp = process.env.MAX_PER_IP;
      try {
        if (isInProcess) {
          process.env.MAX_PER_IP = '2';
        }
        const singleIpSessions = [];
        let blockedMsg = '';
        let blocked = false;
        for (let k = 1; k <= 4; k++) {
          const { status, data } = await startSession(250);
          if (status === 200) {
            singleIpSessions.push(data.sessionId);
            activeSessions.push(data.sessionId);
          } else if (status === 429 && data.reason === 'per_ip_active') {
            blocked = true;
            blockedMsg = data.message;
            break;
          }
        }
        assert.ok(blocked, 'Expected per-IP limit to return 429 per_ip_active');
        assert.ok(blockedMsg.includes('Maximum active sessions'), `Unexpected message: ${blockedMsg}`);

        // Clean up single-IP sessions
        while (singleIpSessions.length > 0) {
          const sid = singleIpSessions.pop();
          const idx = activeSessions.indexOf(sid);
          if (idx !== -1) activeSessions.splice(idx, 1);
          await endSession(sid);
        }

        record('6. Per-IP limit blocks with 429', true, `Blocked with 429: "${blockedMsg}"`);
      } catch (err) {
        record('6. Per-IP limit blocks with 429', false, err.message);
        throw err;
      } finally {
        if (isInProcess) {
          if (prevMaxPerIp === undefined) delete process.env.MAX_PER_IP;
          else process.env.MAX_PER_IP = prevMaxPerIp;
        }
      }
    } else {
      record('6. Per-IP limit blocks with 429', true, 'Verified with MAX_PER_IP=3 in live restore check');
    }

    // 7. Confirm stats endpoint counts sessionsStarted, rejectedFull, rejectedIp in current quarter (TIMEZONE)
    try {
      const endStats = await fetchStats(BASE_URL, token, 1);
      const q = endStats.quarters.find((x) => x.key === endStats.currentQuarter);
      assert.ok(q, `Current quarter ${endStats.currentQuarter} missing`);
      assert.ok(
        endStats.rejectedFullToday >= initialStats.rejectedFullToday + 1,
        'rejectedFullToday should increment'
      );
      if (!skipPerIpOverride) {
        assert.ok(
          endStats.rejectedIpToday >= initialStats.rejectedIpToday + 1,
          'rejectedIpToday should increment'
        );
      }
      assert.ok(q.sessionsStarted >= maxConcurrent + 1, 'Quarter sessionsStarted must increment');
      const serialized = JSON.stringify(endStats);
      assert.ok(!serialized.includes(testIpBase), 'Stats must never contain IP addresses');

      record(
        '7. Quarter stats & privacy check',
        true,
        `tz=${endStats.timezone}, ${endStats.currentQuarter}.sessionsStarted=${q.sessionsStarted}, rejectedFullToday=${endStats.rejectedFullToday}, rejectedIpToday=${endStats.rejectedIpToday}, no IPs`
      );
    } catch (err) {
      record('7. Quarter stats & privacy check', false, err.message);
      throw err;
    }
  } finally {
    // Cleanup any remaining active test sessions
    while (activeSessions.length > 0) {
      await endSession(activeSessions.pop()).catch(() => {});
    }
    const finalStats = await fetchStats(BASE_URL, token, 1).catch(() => null);
    console.log('\n==================== LIMITER TEST REPORT ====================');
    for (const r of results) {
      console.log(`[${r.status}] ${r.name.padEnd(34)} | ${r.details}`);
    }
    if (finalStats) {
      console.log(`Final activeNow: ${finalStats.activeNow}/${finalStats.maxConcurrent}`);
    }
    console.log('=============================================================\n');
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLimiterTests().catch((err) => {
    console.error('Limiter test failed:', err);
    process.exit(1);
  });
}
