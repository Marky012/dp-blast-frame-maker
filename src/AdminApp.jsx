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

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken('');
    setPassword('');
    setEditingTeamId(null);
  }, []);

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
    }
  }, [token, fetchTeams]);

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
      </main>
    </div>
  );
}

