# Multi-Tenant AI Booking & Service Scheduler PWA

A complete, lightweight, multi-tenant Progressive Web App for business appointment booking with Gemini AI assistant support.

**Built for portfolio use** — vanilla HTML/CSS/JS, Tailwind CDN, Firebase, Vercel serverless. No React, Vue, Vite, or npm build step. Easy to edit from Android (Acode + Termux).

---

## Features

- **Multi-tenant isolation**: each business owner = one Firebase Auth UID = one `tenantId`
- **Tenant dashboard**: business settings, services CRUD, operating hours, real-time appointments
- **Public booking page**: `booking.html?tenant=UID`
- **Conflict-safe booking**: Vercel serverless + Firestore transaction
- **Gemini AI assistant**: tenant-aware Q&A (API key never exposed in frontend)
- **PWA**: manifest + service worker (static assets only)
- **Mobile-first** Tailwind UI

---

## Project structure

```
multi-tenant-ai-booking-pwa/
├── index.html              # Login / Sign up
├── dashboard.html          # Tenant dashboard (auth required)
├── booking.html            # Public booking page
├── firebase-config.js      # Firebase init (replace placeholders)
├── app.js                  # Shared helpers (time slots, conflicts, etc.)
├── firestore.rules         # Security rules
├── manifest.json
├── service-worker.js
├── vercel.json
├── README.md
├── api/
│   ├── gemini.js           # Secure Gemini proxy
│   └── create-booking.js   # Secure slot preview + booking creation
└── assets/icons/
    └── README.txt          # Place icon-192.png and icon-512.png here
```

---

## Quick start (local)

1. Open the folder in a static server (or just open `index.html` — modules need a server for CORS-free Firebase).
2. Replace Firebase config in `firebase-config.js` (see below).
3. Deploy to Vercel for full API + booking functionality.

---

## 1. Firebase setup (required)

### Create project
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project (or use an existing one)
3. Disable Google Analytics if you want simplicity

### Enable Authentication
1. **Build → Authentication → Get started**
2. **Sign-in method → Email/Password → Enable → Save**

### Create Firestore
1. **Build → Firestore Database → Create database**
2. Start in **production mode**
3. Choose a region close to you

### Deploy security rules
1. Open the **Rules** tab in Firestore
2. Replace everything with the contents of `firestore.rules` from this project
3. **Publish**

### Get web config
1. Project settings (gear) → **Your apps** → Add web app (</>)
2. Copy the `firebaseConfig` object
3. Paste into `firebase-config.js` (replace all `YOUR_…` placeholders)

---

## 2. Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. **Do not** put this key in any frontend file or GitHub
4. You will add it only as a Vercel environment variable: `GEMINI_API_KEY`

---

## 3. Firebase Admin credentials (for secure booking API)

The `/api/create-booking` function needs privileged access to read appointments and write bookings safely.

1. Firebase Console → Project settings → **Service accounts**
2. **Generate new private key** → download the JSON
3. From that JSON you need:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY`  
     (keep the `\n` characters; Vercel will handle them, or paste with real newlines)

**Never commit the service account JSON to GitHub.**

---

## 4. Deploy to GitHub + Vercel

### Push to GitHub
```bash
cd multi-tenant-ai-booking-pwa
git init
git add .
git commit -m "Initial multi-tenant AI booking PWA"
# Create a new empty repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

### Connect Vercel
1. [vercel.com](https://vercel.com) → Add New Project → Import your GitHub repo
2. Framework Preset: **Other**
3. Root directory: leave default
4. Deploy

### Environment variables (Vercel)
Project → Settings → Environment Variables → add:

| Name                    | Value                          | Notes                          |
|-------------------------|--------------------------------|--------------------------------|
| `GEMINI_API_KEY`        | your Gemini key                | from AI Studio                 |
| `FIREBASE_PROJECT_ID`   | from service account JSON      |                                |
| `FIREBASE_CLIENT_EMAIL` | from service account JSON      |                                |
| `FIREBASE_PRIVATE_KEY`  | from service account JSON      | include quotes if needed; keep `\n` |

After adding variables, **Redeploy** the project so the functions pick them up.

---

## 5. Testing checklist

- [ ] Tenant signup works
- [ ] Tenant login works
- [ ] Dashboard redirects unauthenticated users
- [ ] Business setup (first login) works
- [ ] Services can be created / edited / deleted
- [ ] Operating hours save correctly
- [ ] Public booking link appears and copies
- [ ] Invalid `?tenant=` shows error
- [ ] Public services load
- [ ] Available slots calculate (via `/api/create-booking`)
- [ ] Booking can be created
- [ ] Schedule conflicts are rejected
- [ ] Appointment appears under the correct tenant
- [ ] Dashboard updates in real time (no refresh)
- [ ] Tenant A cannot see Tenant B data (rules + UID isolation)
- [ ] Gemini assistant answers with business context
- [ ] Gemini key is not in any frontend source
- [ ] Mobile layout is usable
- [ ] PWA install prompt / manifest works
- [ ] Vercel deployment serves pages and `/api/*`

---

## Security summary

| Data                         | Who can read              | Who can write                          |
|-----------------------------|---------------------------|----------------------------------------|
| Business settings (public)  | Anyone                    | Owner only                             |
| Services                    | Anyone                    | Owner only                             |
| Appointments                | Owner only                | Owner **or** Admin SDK (serverless)    |
| Gemini API key              | Server only (env)         | —                                      |

- Public users **cannot** list or read appointments.
- Booking creation and conflict checks run on the server inside a Firestore transaction.
- Client-side slot generation is only a UX helper; the server is authoritative.

### Trade-offs / production upgrades
- High-concurrency booking could use Cloud Functions with more sophisticated locking.
- Rate-limit `/api/gemini` and `/api/create-booking` (Vercel middleware or Upstash).
- Add email confirmation (SendGrid / Resend) after booking.
- Add optional customer auth if you need appointment history for customers.

---

## Tech stack

- HTML5 + Tailwind CSS (CDN)
- Vanilla ES6 modules
- Firebase Auth + Firestore (Modular SDK v10 via CDN)
- Gemini API (serverless proxy)
- Vercel Serverless Functions
- PWA (manifest + service worker)

---

## License

MIT — free for portfolio and learning use.
