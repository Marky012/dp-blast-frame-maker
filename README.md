<div align="center">

# DP Blast Frame Maker

**An Initiative by Sentinels' Guild**

[![Live App](https://img.shields.io/badge/Live%20Demo-Netlify-00C7B7?style=for-the-badge&logo=netlify&logoColor=white)](https://dp-blast-frame-maker.netlify.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Netlify Functions](https://img.shields.io/badge/Serverless-Netlify%20Functions-00C7B7?style=for-the-badge&logo=netlify&logoColor=white)](https://docs.netlify.com/functions/overview/)
[![Canvas API](https://img.shields.io/badge/Rendering-HTML5%20Canvas-E34F26?style=for-the-badge&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)

A fast, mobile-first web application built for campus & organization DP blasts. Students pick their team, upload a photo, adjust framing and orientation directly in their browser, and download a finished `1500×1500` composite PNG — with zero student logins and 100% client-side photo privacy.

[Live Student App](https://dp-blast-frame-maker.netlify.app/) · [Admin & Monitor Panel](https://dp-blast-frame-maker.netlify.app/admin)

</div>

---

## Overview

**DP Blast Frame Maker** removes the bottleneck of manually editing profile pictures during organization events and campaigns:

- **Students (`/`)** open the site without logging in, select one of the dynamically configured teams, position/zoom/rotate/flip their photo behind the team's transparent PNG frame, and download their finished DP blast image immediately. Student photos **never leave their device**.
- **Admins (`/admin`)** log in with a password to dynamically add, rename, recolor, reorder, replace frames, or delete teams without code changes — plus monitor live concurrent traffic, daily peaks, rejection counters, and time-of-day usage histograms in real time.

---

## Key Features

### Student Experience (`/`)
- **Zero-Login 3-Screen Flow**: Team Select → Upload & Adjust → Export & Download.
- **100% Client-Side `1500×1500` Compositing**: Built with native HTML5 Canvas. Photos are processed strictly in-memory on the user's device.
- **Mobile-First Controls**:
  - Touch drag & two-finger pinch-to-zoom (`touch-action: none`)
  - Mouse wheel zoom & accessible zoom slider (`0.3×` to `5.0×` of cover-fit)
  - 90° left/right rotation, horizontal mirror flip, and one-tap reset
  - Background color swatches (White, Black, and the selected team's accent color) for zoomed-out framing
  - Optional preview-only circular profile crop guide (excluded from export)
- **Phone Photo Resilience**: EXIF orientation correction (`createImageBitmap(..., { imageOrientation: 'from-image' })` with fallback) and automatic downscaling for oversized camera photos (`>4000px`).
- **Reliable Mobile Downloads**: Synchronous export (`toDataURL` → `Blob`) inside the tap gesture, interactive **Download Progress Modal**, Web Share API (`Share / Save to Photos`) where supported, and a clear banner advising Messenger/Facebook users to open in an external browser (Chrome/Safari) for seamless downloads.

### Dynamic Team & Frame Management (`/admin` → Teams)
- **No Hardcoded Team Count**: Supports 1 to 20 teams stored dynamically in Netlify Blobs (`dp-blast-store-1500`), seeding 7 placeholder teams once on first run.
- **Smart Frame Upload Validation**: Enforces `1500×1500` PNG (`≤ 5 MB`) on both client and server, warns admins if an uploaded PNG has no transparent pixels, and losslessly re-encodes large PNGs (`>3.5 MB`) over `multipart/form-data` to stay safely within serverless payload limits.
- **Instant Cache Busting**: Replacing a frame increments `frameVersion` (`?v={frameVersion}`), paired with `Cache-Control: public, max-age=31536000, immutable` on `/api/frames/:id` for minimal function usage and instant updates.
- **Hardened Admin Auth**: Constant-time HMAC password check, rate-limited login (max 5 failed attempts per IP per 10 minutes), and 8-hour HMAC-SHA256 bearer tokens.

### Traffic Gatekeeper & Live Monitor (`/admin` → Monitor)
- **Concurrency & Rate Protection (Students Only)**:
  - Caps active student sessions (`MAX_CONCURRENT`, default `50`) with a friendly auto-retrying queue screen (`10–15s` jitter + manual **Try again** button).
  - Enforces per-IP active session caps (`MAX_PER_IP`, default `3`) and start-rate caps (`START_LIMIT_PER_WINDOW`, default `10` per 10 minutes), plus Netlify Function `rateLimit` rules.
  - Sends heartbeats every `20s` while visible, frees slots immediately via `navigator.sendBeacon` on tab close, and **fails open** with a small notice if the gatekeeper returns `5xx` or is unreachable.
- **Real-Time Monitor Dashboard**:
  - Large **`X / MAX`** concurrent student readout with color-coded progress bar (`green <70%`, `amber 70–89%`, `red ≥90%` or full + `"FULL, students are being queued"` alert).
  - Daily stat cards: **Peak today**, **Students turned away today (full)**, and **Students blocked today (per-IP)**.
  - Hand-built responsive SVG 4-quarter histogram (`Q1`–`Q4` in configured `TIMEZONE`, default `Asia/Manila`) with **Today / Last 7 days / Last 30 days** toggle, `sessionsStarted` bars, `peakConcurrent` markers, and 5-second visibility-aware auto-refresh.
  - Privacy-preserving storage: daily counter blobs retain 30 days of aggregate counts and store **zero IPs or student data**.

---

## Tech Stack & Project Structure

- **Frontend**: React 18, Vite 5, Plain CSS (mobile-first), HTML5 Canvas
- **Backend / Storage**: Netlify Functions (`.mjs`), Netlify Blobs (`@netlify/blobs`)
- **Testing**: Built-in Node.js test scripts (zero extra test dependencies)

```text
dp-blast-frame-maker/
├── index.html
├── netlify.toml                         # Build settings, functions config, /api/* & SPA redirects
├── package.json
├── vite.config.js
├── .env.example                         # Environment variable template
├── netlify/
│   └── functions/
│       ├── _lib/
│       │   ├── admin-auth.mjs           # Constant-time password check & HMAC-SHA256 tokens
│       │   ├── env.mjs                  # Env reader & client IP extraction
│       │   ├── png.mjs                  # Placeholder 1500x1500 PNG generator & buffer validator
│       │   ├── teams-store.mjs          # Strongly consistent Netlify Blobs team/frame store
│       │   └── usage-stats.mjs          # 30-day timezone-aware quarter usage tracker (no PII)
│       ├── admin-login.mjs              # POST /api/admin/login (with 5-failure rate limit)
│       ├── admin-stats.mjs              # GET /api/admin/stats?days=1|7|30
│       ├── admin-teams.mjs              # POST/PUT/DELETE/reorder /api/admin/teams*
│       ├── frames.mjs                   # GET /api/frames/:id (immutable CDN cached PNG)
│       ├── session.mjs                  # POST /api/session/start|heartbeat|end gatekeeper
│       └── teams.mjs                    # GET /api/teams (30s cached team list)
├── scripts/
│   └── test-limiter.mjs                 # Automated limiter, TTL, per-IP & stats verification
└── src/
    ├── config.js                        # OUTPUT_SIZE (1500) & BRANDING configuration
    ├── main.jsx
    ├── App.jsx                          # Minimal "/" and "/admin" route switcher
    ├── StudentApp.jsx                   # Gatekeeper queue, team select, canvas editor, export modal
    ├── AdminApp.jsx                     # Login, Teams CRUD manager, and live Monitor tab
    ├── styles.css                       # Responsive mobile-first & 375px-safe styles
    └── utils/
        └── image.js                     # EXIF decoding, downscaling, compositing & PNG validation
```

---

## Getting Started (Local Development)

### Prerequisites
- **Node.js** `18+` (recommended `20` or `22`)
- **npm** `9+`

### Installation & Local Run

```bash
# 1. Clone the repository
git clone https://github.com/Marky012/dp-blast-frame-maker.git
cd dp-blast-frame-maker

# 2. Install dependencies
npm install

# 3. Configure local environment variables
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD and ADMIN_SECRET

# 4. Run locally with Vite + Netlify Functions & Blobs emulation
npm run dev
# Or via Netlify CLI:
npx netlify dev
```

Open **http://localhost:8888/** for the student app and **http://localhost:8888/admin** for the admin dashboard.

---

## Environment Variables

Configure these in **Netlify Dashboard → Project configuration → Environment variables** (or `.env` for local development):

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `ADMIN_PASSWORD` | **Yes** | — | Password used to log in at `/admin` |
| `ADMIN_SECRET` | **Yes** | — | Long random secret used to sign & verify 8-hour HMAC-SHA256 admin tokens |
| `MAX_CONCURRENT` | No | `50` | Maximum concurrent active student sessions across the app |
| `MAX_PER_IP` | No | `3` | Maximum concurrent active student sessions allowed per IP address |
| `SESSION_TTL_SECONDS` | No | `60` | Seconds without a heartbeat before an inactive session expires |
| `START_LIMIT_PER_WINDOW` | No | `10` | Maximum new session starts allowed per IP in a 10-minute window |
| `TIMEZONE` | No | `Asia/Manila` | IANA timezone used for daily & quarterly (`Q1`–`Q4`) Monitor analytics |

---

## Admin & Customization Guide

### Managing Teams (`/admin`)
1. Sign in at `/admin` using `ADMIN_PASSWORD`.
2. **Add Team**: Provide a team name, accent color, and a transparent `1500×1500` PNG frame (`≤ 5 MB`), then click **+ Add Team**.
3. **Edit / Replace Frame**: Click **Edit** on any team to rename it, change its accent color, or upload a new `1500×1500` PNG (automatically bumps `frameVersion` so browsers fetch the new frame immediately).
4. **Reorder / Delete**: Use **↑** / **↓** to reorder teams on the student grid, or **Delete** → **Confirm Delete** to remove a team.
5. **Monitor Traffic**: Switch to the **Monitor** tab to watch live concurrency (`X / MAX`), daily peaks/rejections, and the 4-quarter session histogram.

### Changing Output Size or Branding
Edit [`src/config.js`](./src/config.js):
- **`OUTPUT_SIZE`**: Set `export const OUTPUT_SIZE = 1500;` (ensure uploaded frames and `netlify/functions/_lib/png.mjs` match your chosen square dimension).
- **`BRANDING`**: Customize `title`, `subtitle`, `organization`, `creditLine`, `privacyNote`, and `footerText`.

---

## Testing & Rate Limiter Verification

`scripts/test-limiter.mjs` verifies gatekeeper concurrency caps, `429` queue responses, `/api/session/end` slot release, `/api/admin/*` availability while full, TTL auto-expiration, per-IP limits, and privacy-safe quarter stats tracking.

1. Start the local dev server with temporary test limits in `.env`:
   ```env
   MAX_CONCURRENT=3
   MAX_PER_IP=10
   START_LIMIT_PER_WINDOW=100
   SESSION_TTL_SECONDS=60
   ```
2. Run the limiter suite:
   ```bash
   node scripts/test-limiter.mjs
   ```
   Optional flags via environment variables:
   - `TEST_BASE_URL` (defaults to `http://localhost:8888`)
   - `ADMIN_PASSWORD`
   - `TEST_SKIP_TTL=1` (skips waiting for full `SESSION_TTL_SECONDS`)
   - `TEST_SKIP_PER_IP=1` (skips per-IP check when `MAX_PER_IP > MAX_CONCURRENT`)

---

## Deployment

### Deploy to Render.com (Free Web Service) + Neon Postgres (Recommended)
Render Free gives 750 server hours/month and 100 GB bandwidth with zero per-request or per-deploy credit limits. Because Render's free tier has an ephemeral filesystem, pair it with a free **Neon** or **Supabase** PostgreSQL database so uploaded teams, `1500×1500` frames, and participation counts persist across restarts.

1. Create a free PostgreSQL database at [neon.tech](https://neon.tech) (no expiry) and copy its `DATABASE_URL` connection string.
2. Push this repository to GitHub and open [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint** (to auto-read [`render.yaml`](./render.yaml)) or **Web Service**:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
3. Set these **Environment Variables** in Render:
   - `DATABASE_URL`: your Neon/Supabase Postgres connection string (`postgresql://...`)
   - `ADMIN_PASSWORD`: your `/admin` login password
   - `ADMIN_SECRET`: a long random 32+ character string
4. Deploy — the server automatically creates the `app_blobs` table on first run and keeps live session tracking in memory.

### Deploy with Netlify CLI
```bash
npm run build
npx netlify deploy --build --prod
```

### Continuous Deployment via Git
1. Connect `https://github.com/Marky012/dp-blast-frame-maker.git` in Netlify (**Add new site → Import an existing project**).
2. Netlify automatically reads [`netlify.toml`](./netlify.toml) (`command = "npm run build"`, `publish = "dist"`, `directory = "netlify/functions"`).
3. Add `ADMIN_PASSWORD`, `ADMIN_SECRET`, and any optional limiter/timezone variables in Netlify Site Environment Variables, then trigger a deploy.

---

<div align="center">

**Developed & initialized by Sentinels' Guild**

© 2026 Sentinels' Guild. All rights reserved.

</div>
