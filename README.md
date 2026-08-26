# Multi-Tenant AI Booking SaaS PWA (v2)

Vanilla HTML + Tailwind CDN + Firebase + Vercel serverless.  
Roles: **Super Admin** · **Tenant** · **Customer**.

## Quick links

| Page | URL |
|------|-----|
| Login / Signup | `/` or `/index.html` |
| Tenant dashboard | `/dashboard.html` |
| Public booking | `/booking.html?tenant={UID}` or `/b/{handle}` |
| Super Admin | `/admin.html` |

## Environment variables (Vercel)

### Required
| Variable | Purpose |
|----------|---------|
| `FIREBASE_PROJECT_ID` | Admin SDK |
| `FIREBASE_CLIENT_EMAIL` | Admin SDK |
| `FIREBASE_CLIENT_EMAIL` | Admin SDK |
| `FIREBASE_PRIVATE_KEY` | Admin SDK (full key, `\n` OK) |
| `GEMINI_API_KEY` | AI assistant |

### Super Admin (required for `/admin.html`)
| Variable | Purpose |
|----------|---------|
| `SUPER_ADMIN_EMAIL` | Admin login email |
| `SUPER_ADMIN_PASSWORD_HASH` | SHA-256 hex of password |
| `JWT_SECRET` | Random long string for admin JWT |

Generate password hash (on any machine with Node):

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YourStrongPassword').digest('hex'))"
```

### Optional SMS
| Variable | Purpose |
|----------|---------|
| `SMS_API_SECRET` | Protects `/api/sms` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | Twilio |
| `SEMAPHORE_API_KEY` / `SEMAPHORE_SENDER` | Semaphore (PH) |

After changing env vars → **Redeploy**.

## Firestore rules

Publish the contents of `firestore.rules` in Firebase Console → Firestore → Rules.

`platformTenants` is **Admin SDK only** (no client access).

## New features (v2)

- Super Admin portal with tenant status, trial extend, metrics
- 14-day trial on business setup (`platformTenants`)
- Booking blocked for suspended/expired tenants (server-side)
- Booking IDs (`BK-2026-XXXXXXXX`)
- Gemini AI cache + 20/day dynamic limit per tenant
- FAQ buttons (zero API cost)
- Tenant analytics (week/month/peak day/hour)
- QR code download/print
- Clean URL `/b/{handle}` (set handle in platform doc)
- Google Calendar link + printable receipt
- Optional SMS abstraction
- Themes: store `theme` in settings (booking page applies)

## Backward compatibility

- Existing `booking.html?tenant=` links still work
- Existing tenants without `platformTenants` are treated as **legacy** (bookable until registered)
- Re-save business settings or re-run setup to create platform record

## Security notes

- Admin password never in frontend; JWT verified on server
- Appointments not publicly readable
- Booking create + conflict checks server-side
- Gemini key server-only
- Deposit screenshots: treat as `pending_verification` only (no auto-paid)

## Mobile (Acode) workflow

1. Edit files in repo clone
2. Push to GitHub
3. Vercel auto-deploys
4. Test on phone browser / Install PWA

## Testing checklist (high level)

- [ ] Tenant signup / login
- [ ] Business setup creates trial
- [ ] Super Admin login + list tenants
- [ ] Suspend tenant → public booking blocked
- [ ] Extend trial / subscription
- [ ] Booking + appears on dashboard real-time
- [ ] QR code opens booking page
- [ ] FAQ buttons answer without Gemini
- [ ] AI works within daily limit
- [ ] Receipt + Google Calendar link
- [ ] Analytics numbers make sense
- [ ] PWA install

