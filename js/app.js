// HallMate — Route-aware bootstrap entry point.
// Every page loads this single file. It mounts shared chrome, wires up nav state,
// and dispatches to a page-specific initializer based on the current route.

import { mountChrome, highlightActiveNav, $, $$, on } from './ui.js';
import { whenReady, onAuthChange, logout, requireAuth, redirectIfAuthed } from './auth.js';
import { currentRoute } from './utils.js';
import { ROUTES, STORAGE_KEYS } from './config.js';

// Route -> initializer. Each page registers its concerns here.
// Phase 1: shells only. Logic lands in Phase 2.
const ROUTE_INITIALIZERS = {
  index: initLanding,
  login: initLogin,
  onboarding: initOnboarding,
  dashboard: initDashboard,
  connections: initConnections,
  profile: initProfile,
};

document.addEventListener('DOMContentLoaded', bootstrap);

async function bootstrap() {
  const route = currentRoute();
  document.body.dataset.route = route;

  await mountChrome();
  highlightActiveNav(route);
  wireGlobalNav();

  // Reflect auth state into the navbar (login button <-> avatar/logout).
  onAuthChange(renderNavAuthState);

  const init = ROUTE_INITIALIZERS[route];
  if (init) {
    try { await init(); }
    catch (err) { console.error(`[app] init error on ${route}`, err); }
  }
}

function wireGlobalNav() {
  // Logout buttons can appear anywhere — delegate from document.
  on(document, 'click', (e) => {
    const target = e.target.closest('[data-action="logout"]');
    if (!target) return;
    e.preventDefault();
    logout().catch((err) => console.error('[app] logout failed', err));
  });
}

function renderNavAuthState(user) {
  // Toggle ALL data-auth elements — the navbar has auth items in multiple
  // locations (hm-nav-cta, hm-nav-actions, hm-nav-profile, nav-link <li>s).
  $$('[data-auth="logged-out"]').forEach((el) => { el.hidden = !!user; });
  $$('[data-auth="logged-in"]').forEach((el) => { el.hidden = !user; });

  // Auth-aware logo routing: logged-in → dashboard, logged-out → landing.
  const brandLink = document.getElementById('hm-brand-link');
  if (brandLink) brandLink.href = user ? ROUTES.dashboard : ROUTES.landing;

  if (user) {
    updateNavbarAvatar();

    // Hide the profile avatar/dropdown during onboarding.
    // handlePostLogin() writes 'false' before redirecting to onboarding, so this
    // fires on the first render of every onboarding page without any extra fetch.
    const navProfile = document.querySelector('.hm-nav-profile');
    if (navProfile) {
      const done = sessionStorage.getItem(STORAGE_KEYS.profileCompleted);
      if (done === 'false') navProfile.hidden = true;
    }
  }
}

// Reads cached initials written by profile.js (STORAGE_KEYS.profile) so the
// avatar shows real initials on every page — no extra Supabase call needed.
function updateNavbarAvatar() {
  const el = document.getElementById('hm-navbar-avatar');
  if (!el) return;
  try {
    const cached = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.profile) || 'null');
    if (cached?.initials) { el.textContent = cached.initials; return; }
  } catch { /* ignore malformed cache */ }
  // Fallback: "Me" renders until the user visits their profile page.
  // el.textContent is already "Me" from the navbar HTML default.
}

// --- Page initializers (shells) ----------------------------------------------

async function initLanding() {
  // Public marketing page — no auth required. Hook hero CTA into login flow.
  const ctaPrimary = $('[data-cta="primary"]');
  on(ctaPrimary, 'click', () => { window.location.href = ROUTES.login; });
}

async function initLogin() {
  // If already signed in, skip the OTP flow.
  await redirectIfAuthed(ROUTES.dashboard);
  // Phase 2: wire phone form -> Firebase RecaptchaVerifier -> signInWithPhoneNumber.
}

async function initOnboarding() {
  const user = await requireAuth();
  if (!user) return;
  // Phase 2: multi-step wizard -> upsert into Supabase `profiles`.
}

async function initDashboard() {
  const user = await requireAuth();
  if (!user) return;
  // Phase 2: load centre mates, filters, connection requests.
}

async function initConnections() {
  const user = await requireAuth();
  if (!user) return;
  // Phase 2: load accepted connections + pending requests.
}

async function initProfile() {
  const user = await requireAuth();
  if (!user) return;
  // Phase 2: load + edit profile, manage privacy + connections.
}

// Surface a one-time ready signal for debugging in DevTools.
whenReady().then((user) => {
  window.__hm = { ready: true, user };
});
