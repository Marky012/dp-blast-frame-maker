import assert from 'node:assert';
import { pathToFileURL } from 'node:url';

function getColorState(activeNow, maxConcurrent) {
  const pct = maxConcurrent > 0 ? Math.round((activeNow / maxConcurrent) * 100) : 0;
  if (activeNow >= maxConcurrent || pct >= 90) return { color: 'RED', pct, full: activeNow >= maxConcurrent };
  if (pct >= 70) return { color: 'AMBER', pct, full: false };
  return { color: 'GREEN', pct, full: false };
}

async function fetchStats(baseUrl, token, days = 1) {
  const res = await fetch(`${baseUrl}/api/admin/stats?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200, `GET /api/admin/stats?days=${days} should return 200`);
  return await res.json();
}

export async function runLimiterTests() {
  const BASE_URL = (process.env.TEST_BASE_URL || 'http://localhost:8888').replace(/\/+$/, '');
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TempAdminPass2026!';
  console.log(`Running Gatekeeper & Monitor Limiter Test Suite against ${BASE_URL}\n`);

  // 1. Verify /api/admin/stats rejects unauthenticated requests
  const unauthStats = await fetch(`${BASE_URL}/api/admin/stats`);
  assert.strictEqual(unauthStats.status, 401, '/api/admin/stats without token must return 401');
  console.log('✓ [PASS] GET /api/admin/stats without token rejected with 401.');

  // 2. Log in as admin
  const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-nf-client-connection-ip': '10.77.0.1',
      'x-forwarded-for': '10.77.0.1',
    },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.strictEqual(loginRes.status, 200, 'Admin login must return 200');
  const { token } = await loginRes.json();
  assert.ok(token, 'Admin login returned signed bearer token');

  const initialStats = await fetchStats(BASE_URL, token, 1);
  const maxConcurrent = initialStats.maxConcurrent;
  const startingActive = initialStats.activeNow;
  console.log(`Initial Monitor State: ${startingActive}/${maxConcurrent} active, timezone=${initialStats.timezone}`);

  const createdSessions = [];
  const ipBase = `198.51.${Math.floor(Math.random() * 200) + 1}`;

  try {
    // 3. Test Per-IP limit (4th active session from same IP should return 429 & increment rejectedIpToday)
    const perIpSessions = [];
    const perIpAddr = `${ipBase}.250`;
    let perIpBlocked = false;
    for (let i = 1; i <= 5; i++) {
      const sRes = await fetch(`${BASE_URL}/api/session/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nf-client-connection-ip': perIpAddr,
          'x-forwarded-for': perIpAddr,
        },
        body: JSON.stringify({}),
      });
      const sData = await sRes.json();
      if (sRes.status === 200) {
        perIpSessions.push(sData.sessionId);
        createdSessions.push(sData.sessionId);
      } else if (sRes.status === 429 && sData.reason === 'per_ip_active') {
        perIpBlocked = true;
        break;
      }
    }
    assert.ok(perIpBlocked, 'Per-IP active limit should block exceeding sessions with 429 per_ip_active');
    const afterPerIpStats = await fetchStats(BASE_URL, token, 1);
    assert.ok(
      afterPerIpStats.rejectedIpToday > initialStats.rejectedIpToday,
      'rejectedIpToday should increment after per-IP block'
    );
    console.log(
      `✓ [PASS] Per-IP active block verified (${perIpSessions.length} allowed, next blocked; rejectedIpToday=${afterPerIpStats.rejectedIpToday}).`
    );

    // Free the per-IP sessions before concurrency ramp
    while (perIpSessions.length > 0) {
      const sid = perIpSessions.pop();
      const idx = createdSessions.indexOf(sid);
      if (idx !== -1) createdSessions.splice(idx, 1);
      await fetch(`${BASE_URL}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      });
    }

    // 4. Ramp up to NORMAL (<70%), NEAR-FULL (70-89%), and FULL (100%)
    const normalTarget = Math.max(1, Math.floor(maxConcurrent * 0.2));
    const nearFullTarget = Math.max(normalTarget + 1, Math.floor(maxConcurrent * 0.8));
    const fullTarget = maxConcurrent;

    const startUniqueSession = async (index) => {
      const ip = `${ipBase}.${(index % 240) + 1}`;
      const res = await fetch(`${BASE_URL}/api/session/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nf-client-connection-ip': ip,
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      return { status: res.status, data };
    };

    // Normal state (<70%)
    let i = 0;
    while (createdSessions.length + startingActive < normalTarget) {
      i += 1;
      const { status, data } = await startUniqueSession(i);
      assert.strictEqual(status, 200, `Session ${i} should succeed during normal ramp`);
      createdSessions.push(data.sessionId);
    }
    const normalStats = await fetchStats(BASE_URL, token, 1);
    const normalUi = getColorState(normalStats.activeNow, normalStats.maxConcurrent);
    assert.strictEqual(normalUi.color, 'GREEN', 'Normal state should be GREEN (<70%)');
    console.log(
      `✓ [PASS] Monitor NORMAL state: ${normalStats.activeNow}/${normalStats.maxConcurrent} (${normalUi.pct}%, ${normalUi.color})`
    );

    // Near-full state (70-89%)
    while (createdSessions.length + startingActive < nearFullTarget) {
      i += 1;
      const { status, data } = await startUniqueSession(i);
      assert.strictEqual(status, 200, `Session ${i} should succeed during near-full ramp`);
      createdSessions.push(data.sessionId);
    }
    const nearFullStats = await fetchStats(BASE_URL, token, 1);
    const nearFullUi = getColorState(nearFullStats.activeNow, nearFullStats.maxConcurrent);
    assert.strictEqual(nearFullUi.color, 'AMBER', 'Near-full state should be AMBER (70-89%)');
    console.log(
      `✓ [PASS] Monitor NEAR-FULL state: ${nearFullStats.activeNow}/${nearFullStats.maxConcurrent} (${nearFullUi.pct}%, ${nearFullUi.color})`
    );

    // Full state (100% + 5 overflow requests)
    while (createdSessions.length + startingActive < fullTarget) {
      i += 1;
      const { status, data } = await startUniqueSession(i);
      assert.strictEqual(status, 200, `Session ${i} should succeed up to cap`);
      createdSessions.push(data.sessionId);
    }

    let fullRejects = 0;
    for (let j = 1; j <= 5; j++) {
      i += 1;
      const { status, data } = await startUniqueSession(i);
      assert.strictEqual(status, 429, `Overflow request #${j} must return 429`);
      assert.strictEqual(data.status, 'full', 'Overflow reason must be status="full"');
      fullRejects += 1;
    }

    const fullStats = await fetchStats(BASE_URL, token, 1);
    const fullUi = getColorState(fullStats.activeNow, fullStats.maxConcurrent);
    assert.strictEqual(fullUi.color, 'RED', 'Full state should be RED');
    assert.strictEqual(fullUi.full, true, 'activeNow should be >= maxConcurrent');
    assert.ok(
      fullStats.rejectedFullToday >= initialStats.rejectedFullToday + fullRejects,
      'rejectedFullToday must record all turned-away requests'
    );
    assert.ok(fullStats.peakToday >= maxConcurrent, 'peakToday should equal or exceed maxConcurrent');
    console.log(
      `✓ [PASS] Monitor FULL state: ${fullStats.activeNow}/${fullStats.maxConcurrent} (${fullUi.pct}%, ${fullUi.color}, "FULL, students are being queued"), rejectedFullToday=${fullStats.rejectedFullToday}, peakToday=${fullStats.peakToday}`
    );

    // 5. Verify ?days=1, ?days=7, ?days=30 & verify zero IPs/PII stored in stats response
    for (const days of [1, 7, 30]) {
      const rangeStats = await fetchStats(BASE_URL, token, days);
      assert.strictEqual(rangeStats.quarters.length, 4, `days=${days} must return 4 quarters`);
      const qSum = rangeStats.quarters.reduce((acc, q) => acc + q.sessionsStarted, 0);
      assert.ok(qSum >= createdSessions.length, `days=${days} quarters must include started sessions`);
      const serialized = JSON.stringify(rangeStats);
      assert.ok(!serialized.includes(ipBase), 'Stats payload must NEVER contain client IPs');
      assert.ok(!serialized.includes(perIpAddr), 'Stats payload must NEVER contain client IPs');
    }
    console.log('✓ [PASS] GET /api/admin/stats?days=1|7|30 verified (4 quarters, no IPs/PII).');
  } finally {
    // 6. Clean up all test sessions via /api/session/end sequentially
    for (const sessionId of createdSessions) {
      await fetch(`${BASE_URL}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    }
    const postCleanupStats = await fetchStats(BASE_URL, token, 1);
    assert.strictEqual(
      postCleanupStats.activeNow,
      startingActive,
      `Expected activeNow to return to ${startingActive}, got ${postCleanupStats.activeNow}`
    );
    console.log(
      `✓ [PASS] Cleaned up ${createdSessions.length} test sessions -> activeNow=${postCleanupStats.activeNow}/${postCleanupStats.maxConcurrent}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLimiterTests().catch((err) => {
    console.error('Limiter test failed:', err);
    process.exit(1);
  });
}
