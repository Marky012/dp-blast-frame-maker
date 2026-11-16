# DP Blast Frame Maker

A fast, mobile-first web app where students select their team, upload a photo, adjust its position/zoom/rotation/flip behind the team's transparent 1500×1500 PNG frame, and download a finished DP blast image. Includes a password-protected `/admin` panel for managing teams dynamically and a Netlify Blobs traffic gatekeeper capping concurrent active student sessions.

---

## Features

- **100% Client-Side Photo Compositing (`1500×1500`)**: Student photos never leave their device. Supports EXIF orientation (`createImageBitmap`), automatic downscaling for oversized camera photos (`>4000px`), touch drag, pinch-to-zoom, mouse wheel zoom, zoom slider (`0.3×` to `5.0×` of cover-fit), 90° left/right rotation, horizontal mirror flip, background color swatches (White, Black, Team Accent), and an optional preview-only circular profile crop guide.
- **Dynamic Teams & Frame Caching**: Stored in Netlify Blobs (`dp-blast-store-1500`). Seeds 7 placeholder teams on first run (once only). Frame images are served from `/api/frames/:id?v={frameVersion}` with `Cache-Control: public, max-age=31536000, immutable`.
- **Admin Panel (`/admin`)**: Password-protected with constant-time HMAC comparison, rate-limited login (max 5 failed attempts per IP per 10 minutes), and 8-hour HMAC-SHA256 bearer tokens. Add, rename, recolor, reorder, replace frames (auto-bumping `frameVersion`), and delete teams. Validates that uploaded frames are `1500×1500` PNGs (`≤ 5 MB`) and warns if an uploaded PNG has no transparent pixels.
- **Traffic Gatekeeper (Students Only)**: Caps concurrent active student sessions at `MAX_CONCURRENT` (default `50`), limits each IP to `MAX_PER_IP` (default `3`) active sessions and `START_LIMIT_PER_WINDOW` (default `10`) session starts per 10 minutes, sends heartbeats every 20 seconds while visible, frees slots via `navigator.sendBeacon` on tab close, and fails open if the gatekeeper endpoint is unreachable.

---

## Environment Variables

Configure these in **Netlify Dashboard → Project configuration → Environment variables** (or in a local `.env` file for `netlify dev`):

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ADMIN_PASSWORD` | **Yes** | — | Password used to log in at `/admin` |
| `ADMIN_SECRET` | **Yes** | — | Long random string used to sign & verify admin HMAC-SHA256 bearer tokens |
| `MAX_CONCURRENT` | No | `50` | Maximum concurrent active student sessions across the site |
| `MAX_PER_IP` | No | `3` | Maximum concurrent active student sessions per IP address |
| `SESSION_TTL_SECONDS` | No | `60` | Seconds since last heartbeat before a student session expires |
| `START_LIMIT_PER_WINDOW` | No | `10` | Maximum new student session starts per IP per 10-minute window |

---

## How to Manage Teams (`/admin`)

1. Open `/admin` on your site and sign in with your `ADMIN_PASSWORD`.
2. **Add a Team**: Enter the team name, pick an accent color, and choose a `1500×1500` transparent PNG frame (max 5 MB). Click **+ Add Team**. (Supports 1 to 20 teams.)
3. **Edit a Team / Replace Frame**: Click **Edit** next to any team to rename it, change its accent color, or upload a replacement `1500×1500` PNG frame. Replacing a frame automatically increments `frameVersion` so student browsers fetch the new frame immediately.
4. **Reorder Teams**: Use the **↑** and **↓** buttons on any team row to change the display order on the student page.
5. **Delete a Team**: Click **Delete**, then click **Confirm Delete** in the confirmation bar.
6. **Preview as Student**: Click **Preview as student ↗** in the header to open `/` in a new tab.

---

## How to Change Output Size or Branding

Open [`src/config.js`](./src/config.js):

- **`OUTPUT_SIZE`**: Change `export const OUTPUT_SIZE = 1500;` at the top of `src/config.js` to adjust the square output canvas resolution.
- **`BRANDING`**: Update `title`, `subtitle`, `privacyNote`, and `footerText` in `src/config.js`.

---

## Local Development & Deployment

```bash
# Install dependencies
npm install

# Run locally with Netlify Functions and local Netlify Blobs sandbox
npx netlify dev

# Build static production bundle into dist/
npm run build

# Deploy to Netlify production
npx netlify deploy --build --prod
```

