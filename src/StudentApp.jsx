import React, { useState, useEffect, useRef, useCallback } from 'react';
import { OUTPUT_SIZE, BRANDING } from './config.js';
import {
  loadStudentPhoto,
  renderComposite,
  exportCompositeSync,
  exportCompositeBlob,
  buildExportFilename,
} from './utils/image.js';

const DEFAULT_TRANSFORM = {
  panX: 0,
  panY: 0,
  zoom: 1,
  rotation: 0,
  flipX: false,
};

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 5.0;

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function scheduleRevokeUrl(url) {
  if (!url) return;
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore already-revoked URLs
    }
  }, 60000);
}

function triggerBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) {
      a.parentNode.removeChild(a);
    }
  }, 2000);
}

export default function StudentApp() {
  // Gatekeeper state: 'checking' | 'ok' | 'full' | 'rate_limited'
  const [gateState, setGateState] = useState('checking');
  const [gateMessage, setGateMessage] = useState('');
  const [retryAfterSec, setRetryAfterSec] = useState(12);
  const [failOpenNotice, setFailOpenNotice] = useState('');
  const sessionIdRef = useRef(sessionStorage.getItem('dp_blast_session_id') || null);

  // Screens: 'select_team' | 'editor' | 'export'
  const [screen, setScreen] = useState('select_team');

  // Teams & preloaded frame images
  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState('');
  // frameMap: { [teamId]: { status: 'loading' | 'loaded' | 'error', img: HTMLImageElement | null, url: string } }
  const [frameMap, setFrameMap] = useState({});
  const [selectedTeamId, setSelectedTeamId] = useState(null);

  // Student photo & editor state
  const [photo, setPhoto] = useState(null); // { drawable, width, height, wasDownscaled }
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [transform, setTransform] = useState(DEFAULT_TRANSFORM);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [showCropGuide, setShowCropGuide] = useState(false);
  const [showBrowserWarning, setShowBrowserWarning] = useState(true);

  // Export & download progress modal state
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState(null); // { blob, url, dataUrl, filename, canShare }
  const [downloadModal, setDownloadModal] = useState({
    open: false,
    progress: 0,
    statusText: '',
    done: false,
    filename: '',
    url: '',
    canShare: false,
  });
  const downloadTimersRef = useRef([]);

  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const rafRef = useRef(null);

  // Gesture tracking refs for smooth pointer/touch interaction
  const pointersRef = useRef(new Map());
  const gestureRef = useRef({
    lastCenter: null,
    lastDist: null,
  });

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) || null;
  const selectedFrameEntry = selectedTeam ? frameMap[selectedTeam.id] : null;
  const selectedFrameImage =
    selectedFrameEntry && selectedFrameEntry.status === 'loaded' ? selectedFrameEntry.img : null;

  // --- 1. Gatekeeper Session Management ---
  const startSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current }),
      });

      if (res.status >= 500) {
        // Fail open on 5xx infrastructure problem
        setFailOpenNotice('Traffic monitor temporarily unavailable — continuing in direct mode.');
        setGateState('ok');
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.status === 'ok') {
        sessionIdRef.current = data.sessionId;
        sessionStorage.setItem('dp_blast_session_id', data.sessionId);
        setFailOpenNotice('');
        setGateState('ok');
        return;
      }

      if (res.status === 429) {
        if (data.status === 'full') {
          // Retry every 10 to 15 seconds with jitter
          const jittered = 10 + Math.floor(Math.random() * 6);
          setRetryAfterSec(jittered);
          setGateMessage(
            data.message || "The app is busy. You're in line, retrying automatically..."
          );
          setGateState('full');
          return;
        }
        // Rate-limited per IP
        const waitSec = Number(data.retryAfter) || 30;
        setRetryAfterSec(waitSec);
        setGateMessage(
          data.message || `Rate limit reached for your IP. Please wait ${waitSec} seconds.`
        );
        setGateState('rate_limited');
        return;
      }

      // Unexpected status -> fail open with notice
      setFailOpenNotice('Session check returned an unexpected response — continuing in direct mode.');
      setGateState('ok');
    } catch {
      // Network error -> fail open with small notice
      setFailOpenNotice('Could not reach traffic gatekeeper — continuing in offline-safe mode.');
      setGateState('ok');
    }
  }, []);

  useEffect(() => {
    startSession();
  }, [startSession]);

  // Countdown + auto-retry when 'full' or 'rate_limited'
  useEffect(() => {
    if (gateState !== 'full' && gateState !== 'rate_limited') return;

    const timer = setInterval(() => {
      setRetryAfterSec((prev) => {
        if (prev <= 1) {
          if (gateState === 'full') {
            startSession();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [gateState, startSession]);

  // Heartbeat every 20s while visible; sendBeacon on page unload
  useEffect(() => {
    if (gateState !== 'ok' || !sessionIdRef.current) return;

    const sendHeartbeat = async () => {
      if (document.visibilityState === 'hidden' || !sessionIdRef.current) return;
      try {
        const res = await fetch('/api/session/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        });
        if (res.status === 410) {
          sessionIdRef.current = null;
          sessionStorage.removeItem('dp_blast_session_id');
          startSession();
        }
      } catch {
        // Ignore transient network blips during heartbeat
      }
    };

    const interval = setInterval(sendHeartbeat, 20000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat();
      }
    };

    const handlePageUnload = () => {
      if (sessionIdRef.current && navigator.sendBeacon) {
        const payload = JSON.stringify({ sessionId: sessionIdRef.current });
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/session/end', blob);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageUnload);
    window.addEventListener('beforeunload', handlePageUnload);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageUnload);
      window.removeEventListener('beforeunload', handlePageUnload);
    };
  }, [gateState, startSession]);

  // --- 2. Load Teams & Preload Frames ---
  const fetchTeams = useCallback(async () => {
    setTeamsLoading(true);
    setTeamsError('');
    try {
      const res = await fetch('/api/teams');
      if (!res.ok) throw new Error('Failed to load teams.');
      const data = await res.json();
      const loadedTeams = Array.isArray(data.teams) ? data.teams : [];
      setTeams(loadedTeams);

      // Preload all frame PNGs with ?v={frameVersion}
      const initialMap = {};
      loadedTeams.forEach((team) => {
        const url = `/api/frames/${encodeURIComponent(team.id)}?v=${team.frameVersion || 1}`;
        initialMap[team.id] = { status: 'loading', img: null, url };
      });
      setFrameMap(initialMap);

      loadedTeams.forEach((team) => {
        const url = `/api/frames/${encodeURIComponent(team.id)}?v=${team.frameVersion || 1}`;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          setFrameMap((prev) => ({
            ...prev,
            [team.id]: { status: 'loaded', img, url },
          }));
        };
        img.onerror = () => {
          setFrameMap((prev) => ({
            ...prev,
            [team.id]: { status: 'error', img: null, url },
          }));
        };
        img.src = url;
      });
    } catch (err) {
      setTeamsError(err.message || 'Unable to load teams right now.');
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gateState === 'ok') {
      fetchTeams();
    }
  }, [gateState, fetchTeams]);

  // Defer cleanup of export object URLs so mobile download managers finish reading blobs
  const exportUrlRef = useRef(null);
  useEffect(() => {
    exportUrlRef.current = exportResult?.url || null;
  }, [exportResult]);

  useEffect(() => {
    return () => {
      scheduleRevokeUrl(exportUrlRef.current);
      downloadTimersRef.current.forEach((id) => clearTimeout(id));
    };
  }, []);

  // --- 3. Canvas Rendering with requestAnimationFrame ---
  const scheduleDraw = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      renderComposite(ctx, {
        photo,
        frameImage: selectedFrameImage,
        transform,
        bgColor,
        showCropGuide,
      });
    });
  }, [photo, selectedFrameImage, transform, bgColor, showCropGuide]);

  useEffect(() => {
    if (screen === 'editor') {
      scheduleDraw();
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [screen, scheduleDraw]);

  // Prevent browser wheel scroll on canvas and handle wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || screen !== 'editor') return;

    const handleWheel = (e) => {
      e.preventDefault();
      if (!photo) return;
      const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
      setTransform((prev) => ({
        ...prev,
        zoom: Number(clampZoom(prev.zoom * zoomFactor).toFixed(3)),
      }));
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [screen, photo]);

  // --- 4. Pointer (Mouse + Touch Pinch/Drag) Handlers ---
  const handlePointerDown = (e) => {
    if (!photo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 1) {
      gestureRef.current.lastCenter = { x: pts[0].x, y: pts[0].y };
      gestureRef.current.lastDist = null;
    } else if (pts.length >= 2) {
      const [p1, p2] = pts;
      gestureRef.current.lastCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      gestureRef.current.lastDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
  };

  const handlePointerMove = (e) => {
    if (!photo || !pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleToCanvas = rect.width > 0 ? OUTPUT_SIZE / rect.width : 1;

    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 1) {
      const curr = pts[0];
      const prev = gestureRef.current.lastCenter || curr;
      const dx = (curr.x - prev.x) * scaleToCanvas;
      const dy = (curr.y - prev.y) * scaleToCanvas;
      gestureRef.current.lastCenter = { x: curr.x, y: curr.y };

      setTransform((t) => ({
        ...t,
        panX: t.panX + dx,
        panY: t.panY + dy,
      }));
    } else if (pts.length >= 2) {
      const [p1, p2] = pts;
      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

      const prevCenter = gestureRef.current.lastCenter || center;
      const prevDist = gestureRef.current.lastDist || dist;

      const dx = (center.x - prevCenter.x) * scaleToCanvas;
      const dy = (center.y - prevCenter.y) * scaleToCanvas;
      const ratio = prevDist > 5 ? dist / prevDist : 1;

      gestureRef.current.lastCenter = center;
      gestureRef.current.lastDist = dist;

      setTransform((t) => ({
        ...t,
        panX: t.panX + dx,
        panY: t.panY + dy,
        zoom: Number(clampZoom(t.zoom * ratio).toFixed(3)),
      }));
    }
  };

  const handlePointerUpOrCancel = (e) => {
    pointersRef.current.delete(e.pointerId);
    const pts = Array.from(pointersRef.current.values());
    if (pts.length === 1) {
      gestureRef.current.lastCenter = { x: pts[0].x, y: pts[0].y };
      gestureRef.current.lastDist = null;
    } else if (pts.length === 0) {
      gestureRef.current.lastCenter = null;
      gestureRef.current.lastDist = null;
    }
  };

  // --- 5. User Actions ---
  const handleSelectTeam = (team) => {
    const fEntry = frameMap[team.id];
    if (fEntry?.status === 'error') return;
    setSelectedTeamId(team.id);
    setScreen('editor');
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setPhotoLoading(true);
    setPhotoError('');
    try {
      const loaded = await loadStudentPhoto(file);
      setPhoto((prev) => {
        if (prev?.drawable && typeof prev.drawable.close === 'function') {
          prev.drawable.close();
        }
        return loaded;
      });
      setTransform(DEFAULT_TRANSFORM);
    } catch (err) {
      setPhotoError(err.message || 'Could not load image.');
    } finally {
      setPhotoLoading(false);
    }
  };

  const handleRotate = (deltaDeg) => {
    setTransform((prev) => ({
      ...prev,
      rotation: (((prev.rotation + deltaDeg) % 360) + 360) % 360,
    }));
  };

  const handleFlip = () => {
    setTransform((prev) => ({
      ...prev,
      flipX: !prev.flipX,
    }));
  };

  const handleResetTransform = () => {
    setTransform(DEFAULT_TRANSFORM);
  };

  const startDownloadModalProgress = useCallback(({ url, filename, canShare }) => {
    downloadTimersRef.current.forEach((id) => clearTimeout(id));
    downloadTimersRef.current = [];

    setDownloadModal({
      open: true,
      progress: 25,
      statusText: 'Compositing your photo with the team frame...',
      done: false,
      filename,
      url,
      canShare,
    });

    const t1 = setTimeout(() => {
      setDownloadModal((prev) => ({
        ...prev,
        progress: 65,
        statusText: 'Encoding high-resolution PNG...',
      }));
    }, 220);

    const t2 = setTimeout(() => {
      setDownloadModal((prev) => ({
        ...prev,
        progress: 100,
        statusText:
          'Download started! Check your browser downloads/notifications, or use the buttons below if your phone requires confirmation.',
        done: true,
      }));
    }, 720);

    downloadTimersRef.current = [t1, t2];
  }, []);

  const handleExport = async () => {
    if (!photo || !selectedTeam) return;
    setExporting(true);
    setPhotoError('');
    try {
      let blob;
      let dataUrl = null;
      try {
        const syncResult = exportCompositeSync({
          photo,
          frameImage: selectedFrameImage,
          transform,
          bgColor,
        });
        blob = syncResult.blob;
        dataUrl = syncResult.dataUrl;
      } catch {
        blob = await exportCompositeBlob({
          photo,
          frameImage: selectedFrameImage,
          transform,
          bgColor,
        });
      }

      const filename = buildExportFilename(selectedTeam.name);
      const url = URL.createObjectURL(blob);

      let canShare = false;
      try {
        const fileObj = new File([blob], filename, { type: 'image/png' });
        canShare =
          typeof navigator.canShare === 'function' && navigator.canShare({ files: [fileObj] });
      } catch {
        canShare = false;
      }

      if (exportResult?.url) {
        scheduleRevokeUrl(exportResult.url);
      }

      // Trigger download synchronously within the tap gesture for mobile browser compatibility
      triggerBrowserDownload(url, filename);

      setExportResult({ blob, url, dataUrl, filename, canShare });
      startDownloadModalProgress({ url, filename, canShare });
      setScreen('export');
    } catch (err) {
      setPhotoError(err.message || 'Failed to export PNG.');
    } finally {
      setExporting(false);
    }
  };

  const handleDownloadAgain = () => {
    if (!exportResult) return;
    startDownloadModalProgress({
      url: exportResult.url,
      filename: exportResult.filename,
      canShare: exportResult.canShare,
    });
  };

  const handleWebShare = async () => {
    if (!exportResult) return;
    try {
      const file = new File([exportResult.blob], exportResult.filename, { type: 'image/png' });
      await navigator.share({
        files: [file],
        title: BRANDING.title,
      });
    } catch {
      // User cancelled share sheet
    }
  };

  const handleStartOver = () => {
    if (exportResult?.url) {
      scheduleRevokeUrl(exportResult.url);
    }
    setExportResult(null);
    setScreen('select_team');
  };

  // --- Render Gatekeeper Waiting / Rate-Limited Screens ---
  if (gateState === 'checking') {
    return (
      <div className="app-shell">
        <header className="app-header">
          <h1>{BRANDING.title}</h1>
        </header>
        <main className="main-container center-card">
          <div className="spinner" aria-hidden="true" />
          <p className="status-title">Connecting to frame studio...</p>
        </main>
      </div>
    );
  }

  if (gateState === 'full' || gateState === 'rate_limited') {
    return (
      <div className="app-shell">
        <header className="app-header">
          <h1>{BRANDING.title}</h1>
        </header>
        <main className="main-container">
          <div className="gatekeeper-card" role="status" aria-live="polite">
            <div className="gate-badge">
              {gateState === 'full' ? 'High Traffic Queue' : 'Rate Limit Notice'}
            </div>
            <h2>
              {gateState === 'full'
                ? "The app is busy. You're in line, retrying automatically..."
                : 'Too Many Requests'}
            </h2>
            <p className="gate-message">{gateMessage}</p>
            {retryAfterSec > 0 && (
              <p className="gate-countdown">
                {gateState === 'full' ? 'Next automatic retry in ' : 'You can try again in '}
                <strong>{retryAfterSec}s</strong>
              </p>
            )}
            <button type="button" className="btn btn-primary" onClick={startSession}>
              Try again
            </button>
          </div>
        </main>
        <footer className="app-footer">
          <p>{BRANDING.privacyNote}</p>
          <p className="footer-credit">{BRANDING.creditLine}</p>
          <p className="footer-sub">{BRANDING.footerText}</p>
        </footer>
      </div>
    );
  }

  const isInAppBrowser =
    typeof navigator !== 'undefined' &&
    /FBAN|FBAV|Messenger|Instagram|Line|TikTok/i.test(navigator.userAgent || '');

  const browserWarningText =
    "Using Messenger or Facebook? Please tap the ⋯ menu (top-right) and select 'Open in external browser' (Chrome or Safari) so your DP Blast image can download properly.";

  const renderBrowserWarning = (inline = false) => {
    if (!showBrowserWarning) return null;
    return (
      <div
        className={`browser-warning-banner ${isInAppBrowser ? 'browser-warning-urgent' : ''} ${
          inline ? 'browser-warning-inline' : ''
        }`}
        role="note"
      >
        <div className="browser-warning-content">
          <svg
            className="browser-warning-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="browser-warning-text">{browserWarningText}</span>
        </div>
        <button
          type="button"
          className="browser-warning-close"
          aria-label="Close browser notice"
          onClick={() => setShowBrowserWarning(false)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    );
  };

  const swatches = [
    { label: 'White', value: '#ffffff' },
    { label: 'Black', value: '#000000' },
    ...(selectedTeam?.accentColor
      ? [{ label: `${selectedTeam.name} Accent`, value: selectedTeam.accentColor }]
      : []),
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <div className="org-badge">An Initiative by {BRANDING.organization}</div>
          <h1>{BRANDING.title}</h1>
          <p className="subtitle">{BRANDING.subtitle}</p>
        </div>
      </header>

      {renderBrowserWarning(false)}

      {failOpenNotice && (
        <div className="notice-banner" role="status">
          {failOpenNotice}
        </div>
      )}

      <main className="main-container">
        {/* SCREEN 1: TEAM SELECT */}
        {screen === 'select_team' && (
          <section aria-label="Choose your team">
            <div className="section-header">
              <h2>1. Choose Your Team</h2>
              <span className="team-count-pill">
                {teamsLoading
                  ? 'Loading...'
                  : `${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`}
              </span>
            </div>

            {teamsLoading ? (
              <div className="center-card">
                <div className="spinner" aria-hidden="true" />
                <p>Loading teams...</p>
              </div>
            ) : teamsError ? (
              <div className="error-card" role="alert">
                <p>{teamsError}</p>
                <button type="button" className="btn btn-primary" onClick={fetchTeams}>
                  Retry
                </button>
              </div>
            ) : teams.length === 0 ? (
              <div className="empty-card">
                <p>No teams available yet.</p>
              </div>
            ) : (
              <div className="team-grid">
                {teams.map((team) => {
                  const frameEntry = frameMap[team.id];
                  const isUnavailable = frameEntry?.status === 'error';
                  const isLoaded = frameEntry?.status === 'loaded';

                  return (
                    <button
                      key={team.id}
                      type="button"
                      className={`team-card ${isUnavailable ? 'team-card-disabled' : ''}`}
                      style={{ '--team-accent': team.accentColor || '#2563eb' }}
                      disabled={isUnavailable}
                      onClick={() => handleSelectTeam(team)}
                    >
                      <div className="team-frame-preview checkerboard">
                        {isUnavailable ? (
                          <div className="frame-unavailable-placeholder">Frame unavailable</div>
                        ) : (
                          <img
                            src={
                              frameEntry?.url ||
                              `/api/frames/${encodeURIComponent(team.id)}?v=${team.frameVersion || 1}`
                            }
                            alt={`${team.name} frame preview`}
                            loading="eager"
                          />
                        )}
                        {!isLoaded && !isUnavailable && (
                          <div className="frame-loading-overlay">Loading...</div>
                        )}
                      </div>
                      <div className="team-card-footer">
                        <span
                          className="team-color-dot"
                          style={{ backgroundColor: team.accentColor || '#2563eb' }}
                        />
                        <span className="team-card-name">{team.name}</span>
                      </div>
                      {isUnavailable && (
                        <span className="team-unavailable-tag">Frame unavailable</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* SCREEN 2: UPLOAD & EDIT */}
        {screen === 'editor' && selectedTeam && (
          <section className="editor-section" aria-label="Upload and adjust photo">
            <div className="editor-topbar">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setScreen('select_team')}
              >
                ← Choose another team
              </button>
              <div className="selected-team-badge">
                <span
                  className="team-color-dot"
                  style={{ backgroundColor: selectedTeam.accentColor }}
                />
                <strong>{selectedTeam.name}</strong>
              </div>
            </div>

            <div className="editor-layout">
              {/* Left / Top: 1:1 Interactive Canvas */}
              <div className="canvas-column">
                <div className="canvas-wrapper">
                  <canvas
                    ref={canvasRef}
                    width={OUTPUT_SIZE}
                    height={OUTPUT_SIZE}
                    className="editor-canvas"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUpOrCancel}
                    onPointerCancel={handlePointerUpOrCancel}
                  />
                  {!photo && (
                    <div className="canvas-empty-hint">
                      <p>Upload a photo below, then drag &amp; pinch to fit inside the frame.</p>
                    </div>
                  )}
                </div>
                <p className="privacy-inline">{BRANDING.privacyNote}</p>
              </div>

              {/* Right / Bottom: Upload & Transform Controls */}
              <div className="controls-column">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="sr-only"
                  id="student-photo-input"
                />

                <div className="upload-box">
                  <button
                    type="button"
                    className="btn btn-primary btn-block btn-lg"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={photoLoading}
                  >
                    {photoLoading
                      ? 'Loading photo...'
                      : photo
                        ? 'Change Photo'
                        : 'Upload Photo'}
                  </button>
                </div>

                {photoError && (
                  <div className="alert-error" role="alert">
                    {photoError}
                  </div>
                )}

                <div className={`controls-panel ${!photo ? 'controls-disabled' : ''}`}>
                  {/* Zoom Slider */}
                  <div className="control-group">
                    <div className="control-label-row">
                      <label htmlFor="zoom-slider">Zoom</label>
                      <span className="zoom-readout">{Math.round(transform.zoom * 100)}%</span>
                    </div>
                    <div className="zoom-slider-row">
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={!photo}
                        aria-label="Zoom out"
                        onClick={() =>
                          setTransform((t) => ({
                            ...t,
                            zoom: Number(clampZoom(t.zoom - 0.1).toFixed(2)),
                          }))
                        }
                      >
                        −
                      </button>
                      <input
                        id="zoom-slider"
                        type="range"
                        min={MIN_ZOOM}
                        max={MAX_ZOOM}
                        step="0.01"
                        value={transform.zoom}
                        disabled={!photo}
                        onChange={(e) =>
                          setTransform((t) => ({
                            ...t,
                            zoom: parseFloat(e.target.value),
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="btn btn-icon"
                        disabled={!photo}
                        aria-label="Zoom in"
                        onClick={() =>
                          setTransform((t) => ({
                            ...t,
                            zoom: Number(clampZoom(t.zoom + 0.1).toFixed(2)),
                          }))
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Rotate, Flip, Reset */}
                  <div className="control-group">
                    <label>Orientation &amp; Position</label>
                    <div className="button-row-4">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!photo}
                        onClick={() => handleRotate(-90)}
                        title="Rotate 90° Left"
                      >
                        ↺ 90° Left
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!photo}
                        onClick={() => handleRotate(90)}
                        title="Rotate 90° Right"
                      >
                        ↻ 90° Right
                      </button>
                      <button
                        type="button"
                        className={`btn btn-secondary ${transform.flipX ? 'btn-active' : ''}`}
                        disabled={!photo}
                        onClick={handleFlip}
                      >
                        ⇄ Flip
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!photo}
                        onClick={handleResetTransform}
                      >
                        Reset
                      </button>
                    </div>
                  </div>

                  {/* Background Color Swatches */}
                  <div className="control-group">
                    <label>Background Fill (when zoomed out)</label>
                    <div className="swatch-row">
                      {swatches.map((sw) => (
                        <button
                          key={sw.label}
                          type="button"
                          className={`color-swatch ${
                            bgColor.toLowerCase() === sw.value.toLowerCase()
                              ? 'color-swatch-selected'
                              : ''
                          }`}
                          style={{ backgroundColor: sw.value }}
                          onClick={() => setBgColor(sw.value)}
                          title={sw.label}
                          aria-label={`Background color ${sw.label}`}
                        >
                          <span className="swatch-label">{sw.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Optional Profile Crop Guide Toggle */}
                  <div className="control-group">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={showCropGuide}
                        onChange={(e) => setShowCropGuide(e.target.checked)}
                      />
                      <span>Show profile crop guide (preview only)</span>
                    </label>
                  </div>
                </div>

                {/* Download CTA */}
                <div className="export-cta-group">
                  <button
                    type="button"
                    className="btn btn-success btn-block btn-lg"
                    disabled={!photo || exporting}
                    onClick={handleExport}
                  >
                    {exporting ? 'Generating PNG...' : 'Download DP Blast PNG'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* SCREEN 3: EXPORT / DOWNLOAD COMPLETE */}
        {screen === 'export' && exportResult && selectedTeam && (
          <section className="export-section" aria-label="Download finished DP Blast">
            <div className="export-card">
              <h2>Your DP Blast is Ready!</h2>
              <p className="export-sub">
                Frame for <strong>{selectedTeam.name}</strong>
              </p>

              <div className="export-preview-wrap">
                <img
                  src={exportResult.dataUrl || exportResult.url}
                  alt="Finished DP Blast preview"
                  className="export-preview-img"
                />
              </div>

              {renderBrowserWarning(true)}

              <p className="ios-save-hint">
                On iPhone/iPad or in-app browsers: tap <strong>Download PNG</strong>,{' '}
                <strong>Share / Save to Photos</strong>, or long-press the image above to save.
              </p>

              <div className="export-actions">
                <a
                  href={exportResult.url}
                  download={exportResult.filename}
                  className="btn btn-success btn-lg"
                  onClick={handleDownloadAgain}
                >
                  Download PNG ({exportResult.filename})
                </a>

                {exportResult.canShare && (
                  <button type="button" className="btn btn-primary btn-lg" onClick={handleWebShare}>
                    Share / Save to Photos
                  </button>
                )}

                <a
                  href={exportResult.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary"
                >
                  Open Image in New Tab (Long-press to Save)
                </a>
              </div>

              <div className="export-secondary-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setScreen('editor')}
                >
                  ← Back to Adjust Photo
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleStartOver}>
                  Choose Another Team / Start Over
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      {downloadModal.open && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="download-modal-title"
        >
          <div className="download-modal-card">
            <div className="download-modal-header">
              {downloadModal.done ? (
                <div className="download-done-badge" aria-hidden="true">
                  ✓
                </div>
              ) : (
                <div className="spinner download-modal-spinner" aria-hidden="true" />
              )}
              <h2 id="download-modal-title">
                {downloadModal.done ? 'DP Blast Ready!' : 'Preparing Your PNG...'}
              </h2>
            </div>

            <div
              className="download-progress-track"
              role="progressbar"
              aria-valuenow={downloadModal.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="download-progress-fill"
                style={{ width: `${downloadModal.progress}%` }}
              />
            </div>

            <div className="download-progress-meta">
              <span className="download-modal-step">{downloadModal.statusText}</span>
              <span className="download-progress-pct">{downloadModal.progress}%</span>
            </div>

            {downloadModal.done && (
              <div className="download-modal-actions">
                {renderBrowserWarning(true)}
                <a
                  href={downloadModal.url}
                  download={downloadModal.filename}
                  className="btn btn-success btn-block"
                >
                  Download PNG Again ({downloadModal.filename})
                </a>
                {downloadModal.canShare && (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={handleWebShare}
                  >
                    Share / Save to Photos
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary btn-block"
                  onClick={() => setDownloadModal((m) => ({ ...m, open: false }))}
                >
                  Done / View Preview
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="app-footer">
        <p>{BRANDING.privacyNote}</p>
        <p className="footer-credit">{BRANDING.creditLine}</p>
        <p className="footer-sub">{BRANDING.footerText}</p>
      </footer>
    </div>
  );
}

