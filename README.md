# BookAI — Multi-Tenant AI Booking SaaS PWA

Vanilla HTML + Tailwind CDN + Firebase + Vercel serverless.

## Deploy

1. Push this repo to GitHub
2. Import project on Vercel
3. Set environment variables (below)
4. Publish `firestore.rules` in Firebase Console → Firestore → Rules
5. Enable Email/Password in Firebase Authentication
6. Redeploy after any env change

## Environment variables (Vercel)

### Required
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (full key; `\n` OK)
- `GEMINI_API_KEY`

### Super Admin (`/admin.html`)
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD_HASH` (SHA-256 hex of password)
- `JWT_SECRET`

### Cron (no-show processor)
- `CRON_SECRET`

### Optional SMS
- `SMS_API_SECRET`
- `SMS_PROVIDER` = `twilio` | `semaphore`
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- Semaphore: `SEMAPHORE_API_KEY`, `SEMAPHORE_SENDER`

If SMS vars are missing, the API returns a clear “not configured” error — it does not fake success.

## PWA install

- Chrome may show **Install app** when criteria are met (HTTPS, manifest, SW, engagement).
- In-app **Install BookAI** button only appears when `beforeinstallprompt` fires.
- If the button is hidden, use browser menu → Install app / Add to Home screen.
- Icons: `/assets/icons/icon-192.png`, `icon-512.png`, maskable variants.

## Themes

Saved on tenant as `settings.config.theme.mode`: `light` | `dark` | `blue` | `pink` | `gold`.  
Applied on dashboard + public booking via `html[data-theme]`.

## Trial / subscription

Public booking is blocked when `platformTenants/{uid}.status` is `expired` or `suspended`, or trial end has passed.  
Extend via Super Admin or Firestore: set `status` to `active`.

## Local testing

Open the Vercel URL (not GitHub Pages). GitHub Pages cannot run `/api/*`.
