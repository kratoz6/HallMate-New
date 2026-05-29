# Zenter

> **Branding migration note:** `main` is the active **Zenter** app. The prior
> HallMate prototype is preserved untouched on the `hallmate-prototype` branch
> (`git checkout hallmate-prototype` to inspect / run the original brand).
> Internals (CSS prefixes `hm-`, storage keys `hm.*`, Firebase project, Supabase
> schema) are intentionally unchanged — only user-visible branding moved.

Find your NEET PG exam centre mates. Coordinate travel, share stays, walk in together — safely.

**Stack:** HTML5 · Bootstrap 5 · Vanilla JS (ES Modules) · Custom CSS · Supabase (Postgres) · Firebase Phone OTP · Vercel

---

## Phase 1 — Foundation only

This repo currently contains the **foundation + setup only**. No business logic (auth flow, onboarding wizard, mate matching, connection requests) is implemented yet — those land in Phase 2.

---

## Setup

### 1. Configure credentials

Edit `js/config.js` and replace the placeholders:

```js
SUPABASE.url        = 'https://<project-ref>.supabase.co';
SUPABASE.anonKey    = '<supabase-anon-key>';
FIREBASE.apiKey     = '<firebase-web-api-key>';
FIREBASE.authDomain = '<project>.firebaseapp.com';
FIREBASE.projectId  = '<project-id>';
FIREBASE.appId      = '<firebase-app-id>';
```

### 2. Firebase (Phone OTP)

1. Firebase console → **Authentication → Sign-in method** → enable **Phone**.
2. **Authentication → Settings → Authorized domains** → add `localhost` and your Vercel domain (e.g. `hallmate.vercel.app`).
3. (Recommended) Enable **App Check** with reCAPTCHA v3 before launch.

### 3. Supabase

1. Create a project at supabase.com.
2. Copy the project URL + anon key into `js/config.js`.
3. Tables (`profiles`, `centres`, `connections`, …) and RLS policies will be added in Phase 2.

### 4. Run locally

ES Modules and `fetch()` for shared partials require an HTTP server — `file://` will not work.

```bash
# Any of these works:
npx serve .
python3 -m http.server 5173
# Then open http://localhost:5173/
```

### 5. Deploy to Vercel

```bash
npx vercel        # link + preview
npx vercel --prod # production
```

The `vercel.json` ships clean URLs, sane security headers, and cache rules for `/assets/*`.

---

## File-by-file map

```
HallMate/
├── index.html               Landing — hero, how-it-works, safety, CTA
├── login.html               Phone + OTP shell (Firebase reCAPTCHA mount)
├── onboarding.html          3-step profile wizard shell
├── dashboard.html           Centre-mates feed + filter sidebar shell
├── profile.html             Profile view + edit shell
│
├── css/
│   ├── style.css            Design tokens, typography, base layout
│   ├── components.css       Buttons, cards, forms, navbar, footer, toasts
│   ├── auth.css             Login + onboarding visuals
│   ├── dashboard.css        Dashboard + profile visuals
│   └── responsive.css       Mobile-first breakpoint overrides
│
├── js/
│   ├── config.js            App + Firebase + Supabase config
│   ├── firebase-config.js   Firebase init + OTP primitives
│   ├── supabase.js          Supabase client + query helper surface
│   ├── auth.js              Auth state + route guards
│   ├── utils.js             Pure helpers (phone, debounce, route)
│   ├── ui.js                DOM helpers, partial loader, toast, loader
│   └── app.js               Route-aware bootstrap entry
│
├── components/
│   ├── navbar.html          Shared responsive navbar
│   ├── footer.html          Shared footer
│   └── loaders.html         Spinner + skeleton + empty templates
│
├── assets/
│   ├── images/              (empty — add marketing imagery)
│   ├── icons/               (empty — add inline/svg icons)
│   └── logos/favicon.svg    Brand mark / favicon
│
├── vercel.json              Hosting config (headers, cache, clean URLs)
├── .gitignore
└── README.md
```

---

## Phase 1 — validation checklist

Run a local server, then verify each item:

- [ ] `index.html` loads with no console errors
- [ ] Inter + Poppins fonts render (not system fallback)
- [ ] Navbar and footer mount from `/components/*.html` on every page
- [ ] Navbar collapses to a working hamburger drawer below 992px
- [ ] All 5 pages render without layout breaks at 360px, 768px, 1280px
- [ ] Primary (`#FF6B35`), Secondary (`#4F46E5`), Accent (`#10B981`) appear correctly
- [ ] Buttons (`.hm-btn--primary/secondary/ghost/soft`) hover and focus cleanly
- [ ] Cards (`.hm-card`, `.hm-card--glass`) render with shadow + radius
- [ ] Forms (`.hm-input`, `.hm-input-prefix`, `.hm-otp__cell`) focus ring matches brand
- [ ] `window.__hm` is present in DevTools after page load (auth boot succeeded)
- [ ] Visiting `/dashboard.html` or `/profile.html` redirects to `/login.html` (route guard)
- [ ] `/login.html` skips to `/dashboard.html` if already signed in
- [ ] Vercel preview deploy succeeds with no 404s on assets

---

## What's next (Phase 2)

- Login flow: phone → reCAPTCHA → OTP → Firebase session
- Onboarding wizard: persist to Supabase `profiles`
- Dashboard: centre-matched mate feed + filters
- Connection requests: mutual consent + phone reveal
- Realtime updates via Supabase channels
- Reporting + block
