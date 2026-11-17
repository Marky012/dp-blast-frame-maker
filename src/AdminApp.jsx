import React, { useState, useEffect, useCallback } from 'react';
import { BRANDING, OUTPUT_SIZE } from './config.js';
import { validateAdminFrameFile } from './utils/image.js';

const TOKEN_STORAGE_KEY = 'dp_blast_admin_token';

export default function AdminApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const [password, setPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [teams, setTeams] = useState([]);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const [globalSuccess, setGlobalSuccess] = useState('');

  // Add Team form state
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#2563eb');
  const [newFrameFile, setNewFrameFile] = useState(null);
  const [newFrameWarning, setNewFrameWarning] = useState('');
  const [newFrameError, setNewFrameError] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit Team inline modal/drawer state
  const [editingTeamId, setEditingTeamId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#2563eb');
  const [editFrameFile, setEditFrameFile] = useState(null);
  const [editFrameWarning, setEditFrameWarning] = useState('');
  const [editFrameError, setEditFrameError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Confirm delete modal state (works in both normal browsers and headless test environments)
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(null);
  const [busyActionId, setBusyActionId] = useState(null);

  // Admin tabs & live monitor state
  const [activeTab, setActiveTab] = useState('teams'); // 'teams' | 'monitor'
  const [statsDays, setStatsDays] = useState(1); // 1 | 7 | 30
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken('');
    setPassword('');
    setEditingTeamId(null);
    setStats(null);
  }, []);

  const fetchStats = useCallback(
    async (daysToFetch = statsDays) => {
      if (!token) return;
      setStatsLoading(true);
      setStatsError('');
      try {
        const res = await fetch(`/api/admin/stats?days=${daysToFetch}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (res.status === 401) {
          handleLogout();
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load monitor stats.');
        }
        setStats(data);
      } catch (err) {
        setStatsError(err.message || 'Could not load usage statistics.');
      } finally {
        setStatsLoading(false);
      }
    },
    [token, statsDays, handleLogout]
  );

  const fetchTeams = useCallback(async () => {
    setLoadingTeams(true);
    setGlobalError('');
    try {
      const res = await fetch(`/api/teams?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch teams.');
      const data = await res.json();
      setTeams(Array.isArray(data.teams) ? data.teams : []);
    } catch (err) {
      setGlobalError(err.message || 'Could not load teams.');
    } finally {
      setLoadingTeams(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      fetchTeams();
      fetchStats(statsDays);
    }
  }, [token, fetchTeams, fetchStats, statsDays]);

  // Auto-refresh every 5 seconds while visible and on the Monitor tab
  useEffect(() => {
    if (!token || activeTab !== 'monitor') return;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        fetchStats(statsDays);
      }
    };

    const interval = setInterval(tick, 5000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchStats(statsDays);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token, activeTab, statsDays, fetchStats]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Login failed.');
      }
      sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      setToken(data.token);
      setPassword('');
    } catch (err) {
      setLoginError(err.message || 'Unable to log in.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleNewFrameSelect = async (e) => {
    const file = e.target.files?.[0];
    setNewFrameFile(null);
    setNewFrameError('');
    setNewFrameWarning('');
    if (!file) return;

    const result = await validateAdminFrameFile(file);
    if (!result.valid) {
      setNewFrameError(result.error);
      e.target.value = '';
      return;
    }
    if (result.warning) {
      setNewFrameWarning(result.warning);
    }
    setNewFrameFile(result.optimizedFile || file);
  };

  const handleCreateTeam = async (e) => {
    e.preventDefault();
    setGlobalError('');
    setGlobalSuccess('');

    if (!newName.trim()) {
      setNewFrameError('Please enter a team name.');
      return;
    }
    if (!newFrameFile) {
      setNewFrameError(`Please select a valid ${OUTPUT_SIZE}x${OUTPUT_SIZE} PNG frame.`);
      return;
    }

    setAdding(true);
    try {
      const formData = new FormData();
      formData.append('name', newName.trim());
      formData.append('accentColor', newColor);
      formData.append('frame', newFrameFile);

      const res = await fetch('/api/admin/teams', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to add team.');
      }

      setTeams(data.teams || []);
      setNewName('');
      setNewColor('#2563eb');
      setNewFrameFile(null);
      setNewFrameWarning('');
      setNewFrameError('');
      const fileInput = document.getElementById('new-team-frame-input');
      if (fileInput) fileInput.value = '';
      setGlobalSuccess(`Added "${data.team?.name || 'Team'}"!`);
    } catch (err) {
      setGlobalError(err.message || 'Failed to add team.');
    } finally {
      setAdding(false);
    }
  };

  const startEditing = (team) => {
    setEditingTeamId(team.id);
    setEditName(team.name);
    setEditColor(team.accentColor || '#2563eb');
    setEditFrameFile(null);
    setEditFrameWarning('');
    setEditFrameError('');
    setGlobalError('');
    setGlobalSuccess('');
  };

  const handleEditFrameSelect = async (e) => {
    const file = e.target.files?.[0];
    setEditFrameFile(null);
    setEditFrameError('');
    setEditFrameWarning('');
    if (!file) return;

    const result = await validateAdminFrameFile(file);
    if (!result.valid) {
      setEditFrameError(result.error);
      e.target.value = '';
      return;
    }
    if (result.warning) {
      setEditFrameWarning(result.warning);
    }
    setEditFrameFile(result.optimizedFile || file);
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editingTeamId) return;
    if (!editName.trim()) {
      setEditFrameError('Team name cannot be empty.');
      return;
    }

    setSavingEdit(true);
    setGlobalError('');
    setGlobalSuccess('');
    try {
      const formData = new FormData();
      formData.append('name', editName.trim());
      formData.append('accentColor', editColor);
      if (editFrameFile) {
        formData.append('frame', editFrameFile);
      }

      const res = await fetch(`/api/admin/teams/${encodeURIComponent(editingTeamId)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update team.');
      }

      setTeams(data.teams || []);
      setEditingTeamId(null);
      setGlobalSuccess(`Updated "${data.team?.name || 'team'}"!`);
    } catch (err) {
      setGlobalError(err.message || 'Failed to update team.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteTeam = async (team) => {
    setBusyActionId(team.id);
    setGlobalError('');
    setGlobalSuccess('');
    try {
      const res = await fetch(`/api/admin/teams/${encodeURIComponent(team.id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete team.');
      }
      setTeams(data.teams || []);
      setConfirmDeleteTeam(null);
      if (editingTeamId === team.id) setEditingTeamId(null);
      setGlobalSuccess(`Deleted "${team.name}".`);
    } catch (err) {
      setGlobalError(err.message || 'Failed to delete team.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleMoveTeam = async (index, direction) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= teams.length) return;

    const updated = [...teams];
    const [moved] = updated.splice(index, 1);
    updated.splice(targetIdx, 0, moved);
    const orderedIds = updated.map((t) => t.id);

    // Optimistic UI update
    setTeams(updated);
    setBusyActionId(moved.id);
    setGlobalError('');
    setGlobalSuccess('');

    try {
      const res = await fetch('/api/admin/teams/reorder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderedIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleLogout();
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reorder teams.');
      }
      setTeams(data.teams || updated);
    } catch (err) {
      setGlobalError(err.message || 'Failed to reorder teams.');
      fetchTeams();
    } finally {
      setBusyActionId(null);
    }
  };

  // --- Login View ---
  if (!token) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <div className="header-inner">
            <div className="org-badge">{BRANDING.creditLine}</div>
            <h1>{BRANDING.title} — Admin</h1>
            <p className="subtitle">Sign in to manage teams and {OUTPUT_SIZE}×{OUTPUT_SIZE} PNG frames</p>
          </div>
        </header>

        <main className="main-container">
          <form className="admin-login-card" onSubmit={handleLogin}>
            <h2>Admin Login</h2>
            {loginError && (
              <div className="alert-error" role="alert">
                {loginError}
              </div>
            )}
            <div className="form-field">
              <label htmlFor="admin-password-input">Admin Password</label>
              <input
                id="admin-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter ADMIN_PASSWORD"
                required
                autoFocus
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={loginLoading}
            >
              {loginLoading ? 'Signing in...' : 'Sign In'}
            </button>
            <div className="login-footer-link">
              <a href="/" target="_blank" rel="noopener noreferrer">
                Preview as student ↗
              </a>
            </div>
          </form>
        </main>
      </div>
    );
  }

  // --- Authenticated Admin Dashboard ---
  return (
    <div className="app-shell">
      <header className="app-header admin-header">
        <div className="header-inner admin-header-inner">
          <div>
            <div className="org-badge">{BRANDING.creditLine}</div>
            <h1>{BRANDING.title} — Admin</h1>
            <p className="subtitle">Manage dynamic teams &amp; {OUTPUT_SIZE}×{OUTPUT_SIZE} transparent frames</p>
          </div>
          <div className="admin-header-actions">
            <a href="/" target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
              Preview as student ↗
            </a>
            <button type="button" className="btn btn-danger-outline" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="main-container admin-main">
        {/* TAB SWITCHER */}
        <div className="admin-tabs-bar" role="tablist" aria-label="Admin sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'teams'}
            className={`admin-tab-btn ${activeTab === 'teams' ? 'admin-tab-active' : ''}`}
            onClick={() => setActiveTab('teams')}
          >
            Teams ({teams.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'monitor'}
            className={`admin-tab-btn ${activeTab === 'monitor' ? 'admin-tab-active' : ''}`}
            onClick={() => setActiveTab('monitor')}
          >
            Monitor
            {stats && (
              <span className="tab-live-pill">
                {stats.activeNow}/{stats.maxConcurrent}
              </span>
            )}
          </button>
        </div>

        {globalError && (
          <div className="alert-error" role="alert">
            {globalError}
          </div>
        )}
        {globalSuccess && (
          <div className="alert-success" role="status">
            {globalSuccess}
          </div>
        )}

        {/* COMPACT LIVE CONCURRENT CARD ON TEAMS TAB */}
        {activeTab === 'teams' && stats && (
          <div className="admin-live-banner">
            <div className="admin-live-banner-info">
              <strong>Live Concurrent Users:</strong>{' '}
              <span className="live-count-inline">
                {stats.activeNow} / {stats.maxConcurrent}
              </span>
              {stats.activeNow >= stats.maxConcurrent && (
                <span className="live-full-tag">FULL, students are being queued</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setActiveTab('monitor')}
            >
              Open Monitor →
            </button>
          </div>
        )}

        {/* MONITOR TAB */}
        {activeTab === 'monitor' && (() => {
          const activeNow = stats?.activeNow ?? 0;
          const maxConcurrent = stats?.maxConcurrent ?? 50;
          const ratio = maxConcurrent > 0 ? activeNow / maxConcurrent : 0;
          const pct = Math.min(100, Math.round(ratio * 100));
          const isFull = activeNow >= maxConcurrent;
          let loadStateClass = 'load-green';
          if (isFull || pct >= 90) loadStateClass = 'load-red';
          else if (pct >= 70) loadStateClass = 'load-amber';

          const quarters = stats?.quarters || [
            { key: 'Q1', label: 'Q1 (12am–6am)', sessionsStarted: 0, peakConcurrent: 0 },
            { key: 'Q2', label: 'Q2 (6am–12pm)', sessionsStarted: 0, peakConcurrent: 0 },
            { key: 'Q3', label: 'Q3 (12pm–6pm)', sessionsStarted: 0, peakConcurrent: 0 },
            { key: 'Q4', label: 'Q4 (6pm–12am)', sessionsStarted: 0, peakConcurrent: 0 },
          ];

          const maxSessions = Math.max(1, ...quarters.map((q) => q.sessionsStarted));
          const maxPeak = Math.max(1, maxConcurrent, ...quarters.map((q) => q.peakConcurrent));
          const xCenters = [55, 152, 248, 345];
          const barWidth = 46;
          const baselineY = 160;
          const chartHeight = 122;

          const peakPoints = quarters
            .map((q, i) => {
              const py = baselineY - Math.round((q.peakConcurrent / maxPeak) * chartHeight);
              return `${xCenters[i]},${py}`;
            })
            .join(' ');

          return (
            <section className="monitor-section" aria-label="Traffic Monitor">
              <div className="monitor-toolbar">
                <div className="monitor-updated">
                  Last updated:{' '}
                  <strong>
                    {stats?.updatedAt
                      ? new Date(stats.updatedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })
                      : '—'}
                  </strong>
                  <span className="monitor-auto-note"> • Auto-refreshes every 5s</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={statsLoading}
                  onClick={() => fetchStats(statsDays)}
                >
                  {statsLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>

              {statsError && (
                <div className="alert-error" role="alert">
                  {statsError}
                </div>
              )}

              {/* Live Concurrency Card */}
              <div className={`admin-card monitor-live-card ${loadStateClass}`}>
                <div className="monitor-live-header">
                  <div>
                    <h2>Live Concurrent Students</h2>
                    <div className="monitor-live-number">
                      {activeNow} <span className="monitor-live-max">/ {maxConcurrent}</span>
                    </div>
                  </div>
                  <div className="monitor-live-pct">{pct}% capacity</div>
                </div>

                <div
                  className="monitor-progress-track"
                  role="progressbar"
                  aria-valuenow={activeNow}
                  aria-valuemin={0}
                  aria-valuemax={maxConcurrent}
                >
                  <div className="monitor-progress-fill" style={{ width: `${pct}%` }} />
                </div>

                {isFull && (
                  <p className="monitor-full-alert" role="status">
                    FULL, students are being queued
                  </p>
                )}
              </div>

              {/* 3 Stat Cards */}
              <div className="monitor-stats-grid">
                <div className="admin-card monitor-stat-card">
                  <div className="stat-label">Peak today</div>
                  <div className="stat-value">{stats?.peakToday ?? 0}</div>
                </div>
                <div className="admin-card monitor-stat-card">
                  <div className="stat-label">Students turned away today (full)</div>
                  <div className="stat-value">{stats?.rejectedFullToday ?? 0}</div>
                </div>
                <div className="admin-card monitor-stat-card">
                  <div className="stat-label">Students blocked today (per-IP)</div>
                  <div className="stat-value">{stats?.rejectedIpToday ?? 0}</div>
                </div>
              </div>

              {/* 4-Quarter Histogram */}
              <div className="admin-card monitor-chart-card">
                <div className="monitor-chart-header">
                  <div>
                    <h2>Sessions by Time of Day</h2>
                    <p className="monitor-tz-caption">
                      Timezone: {stats?.timezone || 'Asia/Manila'}
                    </p>
                  </div>
                  <div className="range-toggle" role="group" aria-label="Time range">
                    {[
                      { label: 'Today', value: 1 },
                      { label: 'Last 7 days', value: 7 },
                      { label: 'Last 30 days', value: 30 },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`btn btn-sm ${
                          statsDays === opt.value ? 'btn-primary' : 'btn-secondary'
                        }`}
                        onClick={() => setStatsDays(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="chart-legend">
                  <span className="legend-item">
                    <span className="legend-swatch legend-bar" /> Sessions started
                  </span>
                  <span className="legend-item">
                    <span className="legend-swatch legend-peak" /> Peak concurrent (per quarter)
                  </span>
                </div>

                <div className="svg-chart-wrap">
                  <svg
                    viewBox="0 0 400 222"
                    className="quarter-chart-svg"
                    role="img"
                    aria-label="Sessions started and peak concurrent by quarter of the day"
                  >
                    {/* Baseline and mid gridline */}
                    <line x1="16" y1={baselineY - chartHeight} x2="384" y2={baselineY - chartHeight} stroke="#e2e8f0" strokeDasharray="4 4" />
                    <line x1="16" y1={baselineY - Math.round(chartHeight / 2)} x2="384" y2={baselineY - Math.round(chartHeight / 2)} stroke="#e2e8f0" strokeDasharray="4 4" />
                    <line x1="16" y1={baselineY} x2="384" y2={baselineY} stroke="#cbd5e1" strokeWidth="1.5" />

                    {quarters.map((q, i) => {
                      const cx = xCenters[i];
                      const isCurrent = statsDays === 1 && stats?.currentQuarter === q.key;
                      const barH =
                        q.sessionsStarted > 0
                          ? Math.max(4, Math.round((q.sessionsStarted / maxSessions) * chartHeight))
                          : 0;
                      const barY = baselineY - barH;
                      const shortRanges = ['12a–6a', '6a–12p', '12p–6p', '6p–12a'];

                      return (
                        <g key={q.key}>
                          {isCurrent && (
                            <rect
                              x={cx - 42}
                              y={12}
                              width={84}
                              height={204}
                              rx={8}
                              fill="#eff6ff"
                              stroke="#bfdbfe"
                              strokeWidth="1"
                            />
                          )}

                          <rect
                            x={cx - barWidth / 2}
                            y={barY}
                            width={barWidth}
                            height={barH}
                            rx={5}
                            fill={isCurrent ? '#2563eb' : '#60a5fa'}
                          />

                          {/* Exact sessionsStarted value above bar */}
                          <text
                            x={cx}
                            y={Math.max(24, barY - 6)}
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight="700"
                            fill="#0f172a"
                          >
                            {q.sessionsStarted}
                          </text>

                          {/* Quarter label + range + peak */}
                          <text
                            x={cx}
                            y={178}
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight={isCurrent ? '800' : '700'}
                            fill={isCurrent ? '#1d4ed8' : '#0f172a'}
                          >
                            {q.key}
                            {isCurrent ? ' ★' : ''}
                          </text>
                          <text
                            x={cx}
                            y={193}
                            textAnchor="middle"
                            fontSize="10"
                            fill="#64748b"
                          >
                            {shortRanges[i]}
                          </text>
                          <text
                            x={cx}
                            y={208}
                            textAnchor="middle"
                            fontSize="10"
                            fontWeight="700"
                            fill="#b45309"
                          >
                            Peak: {q.peakConcurrent}
                          </text>
                        </g>
                      );
                    })}

                    {/* Secondary peakConcurrent line & markers */}
                    <polyline
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth="2.2"
                      strokeDasharray="4 3"
                      points={peakPoints}
                    />
                    {quarters.map((q, i) => {
                      const cx = xCenters[i];
                      const py = baselineY - Math.round((q.peakConcurrent / maxPeak) * chartHeight);
                      return (
                        <circle
                          key={`${q.key}-peak`}
                          cx={cx}
                          cy={py}
                          r="4.5"
                          fill="#f59e0b"
                          stroke="#ffffff"
                          strokeWidth="1.5"
                        />
                      );
                    })}
                  </svg>
                </div>
              </div>
            </section>
          );
        })()}

        {/* TEAMS TAB: ADD NEW TEAM FORM & LIST */}
        {activeTab === 'teams' && (
          <>
            {/* ADD NEW TEAM FORM */}
        <section className="admin-card" aria-label="Add new team">
          <h2>Add New Team ({teams.length}/20)</h2>
          <form className="admin-add-form" onSubmit={handleCreateTeam}>
            <div className="form-row">
              <div className="form-field form-field-grow">
                <label htmlFor="new-team-name">Team Name</label>
                <input
                  id="new-team-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., Team Phoenix"
                  maxLength={80}
                  required
                />
              </div>

              <div className="form-field">
                <label htmlFor="new-team-color">Accent Color</label>
                <div className="color-picker-wrap">
                  <input
                    id="new-team-color"
                    type="color"
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                  />
                  <span className="color-hex-text">{newColor}</span>
                </div>
              </div>

              <div className="form-field form-field-grow">
                <label htmlFor="new-team-frame-input">Frame PNG ({OUTPUT_SIZE}×{OUTPUT_SIZE}, max 5 MB)</label>
                <input
                  id="new-team-frame-input"
                  type="file"
                  accept="image/png"
                  onChange={handleNewFrameSelect}
                />
              </div>
            </div>

            {newFrameError && (
              <div className="alert-error" role="alert">
                {newFrameError}
              </div>
            )}
            {newFrameWarning && (
              <div className="alert-warning" role="status">
                {newFrameWarning}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              disabled={adding || teams.length >= 20}
            >
              {adding ? 'Uploading & Creating...' : '+ Add Team'}
            </button>
          </form>
        </section>

        {/* TEAMS LIST */}
        <section className="admin-card" aria-label="Manage existing teams">
          <div className="section-header">
            <h2>Teams ({teams.length})</h2>
            <button type="button" className="btn btn-secondary btn-sm" onClick={fetchTeams}>
              Refresh
            </button>
          </div>

          {loadingTeams ? (
            <div className="center-card">
              <div className="spinner" aria-hidden="true" />
              <p>Loading teams...</p>
            </div>
          ) : teams.length === 0 ? (
            <p className="empty-text">No teams configured yet. Add one above!</p>
          ) : (
            <div className="admin-team-list">
              {teams.map((team, idx) => {
                const isEditing = editingTeamId === team.id;
                const isConfirmingDelete = confirmDeleteTeam?.id === team.id;

                return (
                  <div key={team.id} className="admin-team-item">
                    <div className="admin-team-row">
                      <div className="admin-frame-thumb checkerboard">
                        <img
                          src={`/api/frames/${encodeURIComponent(team.id)}?v=${team.frameVersion || 1}`}
                          alt={`${team.name} frame`}
                        />
                      </div>

                      <div className="admin-team-info">
                        <div className="admin-team-title-row">
                          <span
                            className="team-color-dot"
                            style={{ backgroundColor: team.accentColor }}
                          />
                          <strong className="admin-team-name">{team.name}</strong>
                          <span className="version-pill">v{team.frameVersion || 1}</span>
                        </div>
                        <div className="admin-team-meta">
                          ID: <code>{team.id}</code> • Accent: <code>{team.accentColor}</code>
                        </div>
                      </div>

                      <div className="admin-team-actions">
                        <div className="reorder-buttons">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={idx === 0 || busyActionId === team.id}
                            onClick={() => handleMoveTeam(idx, -1)}
                            title="Move up"
                            aria-label={`Move ${team.name} up`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={idx === teams.length - 1 || busyActionId === team.id}
                            onClick={() => handleMoveTeam(idx, 1)}
                            title="Move down"
                            aria-label={`Move ${team.name} down`}
                          >
                            ↓
                          </button>
                        </div>

                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => (isEditing ? setEditingTeamId(null) : startEditing(team))}
                        >
                          {isEditing ? 'Cancel Edit' : 'Edit'}
                        </button>

                        <button
                          type="button"
                          className="btn btn-danger-outline btn-sm"
                          onClick={() => setConfirmDeleteTeam(team)}
                          disabled={busyActionId === team.id}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* INLINE CONFIRM DELETE */}
                    {isConfirmingDelete && (
                      <div className="confirm-delete-bar" role="alertdialog" aria-label="Confirm delete">
                        <span>
                          Delete <strong>{team.name}</strong> and its frame permanently?
                        </span>
                        <div className="confirm-delete-actions">
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={busyActionId === team.id}
                            onClick={() => handleDeleteTeam(team)}
                          >
                            {busyActionId === team.id ? 'Deleting...' : 'Confirm Delete'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmDeleteTeam(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* INLINE EDIT FORM */}
                    {isEditing && (
                      <form className="admin-edit-drawer" onSubmit={handleSaveEdit}>
                        <h3>Edit {team.name}</h3>
                        <div className="form-row">
                          <div className="form-field form-field-grow">
                            <label htmlFor={`edit-name-${team.id}`}>Team Name</label>
                            <input
                              id={`edit-name-${team.id}`}
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              maxLength={80}
                              required
                            />
                          </div>

                          <div className="form-field">
                            <label htmlFor={`edit-color-${team.id}`}>Accent Color</label>
                            <div className="color-picker-wrap">
                              <input
                                id={`edit-color-${team.id}`}
                                type="color"
                                value={editColor}
                                onChange={(e) => setEditColor(e.target.value)}
                              />
                              <span className="color-hex-text">{editColor}</span>
                            </div>
                          </div>

                          <div className="form-field form-field-grow">
                            <label htmlFor={`edit-frame-${team.id}`}>
                              Replace Frame PNG (optional, {OUTPUT_SIZE}×{OUTPUT_SIZE})
                            </label>
                            <input
                              id={`edit-frame-${team.id}`}
                              type="file"
                              accept="image/png"
                              onChange={handleEditFrameSelect}
                            />
                          </div>
                        </div>

                        {editFrameError && (
                          <div className="alert-error" role="alert">
                            {editFrameError}
                          </div>
                        )}
                        {editFrameWarning && (
                          <div className="alert-warning" role="status">
                            {editFrameWarning}
                          </div>
                        )}

                        <div className="edit-drawer-actions">
                          <button type="submit" className="btn btn-primary" disabled={savingEdit}>
                            {savingEdit ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setEditingTeamId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
          </>
        )}
      </main>

      <footer className="app-footer">
        <p className="footer-credit">{BRANDING.footerCreditLine}</p>
        <p className="footer-sub">{BRANDING.footerText}</p>
      </footer>
    </div>
  );
}

