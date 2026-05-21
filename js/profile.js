// HallMate — Profile page hydration.
// Loaded only from profile.html (alongside app.js, which handles chrome + auth).
//
// Flow:
//   1. Wait for Firebase auth to resolve (requireAuth redirects if signed out).
//   2. Look up the user's Supabase row by phone number.
//   3. Hydrate the static profile.html shell with real values, falling back to
//      friendly "Add your X" prompts for fields the onboarding flow doesn't yet
//      capture (college, travel_mode, stay_plan, bio, ...).
//
// Notes:
//   - Onboarding currently persists: full_name, gender, state, district,
//     exam_center, phone. Forward-compat fields (home_city, college,
//     centre_city, centre_name, travel_mode, stay_plan, bio) are read from the
//     row when present and otherwise rendered as empty-state prompts.
//   - "Home city" falls back to `district` so users who only completed
//     onboarding still see a meaningful value.
//   - "Centre name" falls back to `exam_center` for the same reason.

import { requireAuth } from './auth.js';
import { getProfileByPhone } from './supabase.js';
import { formatPhonePretty } from './utils.js';
import { STORAGE_KEYS } from './config.js';

// Field id -> { selector, prompt }
// `prompt` renders when the resolved value is empty/null.
const FIELDS = {
  name:        { id: 'hm-kv-name',        prompt: 'Add your name' },
  gender:      { id: 'hm-kv-gender',      prompt: 'Add your gender' },
  homeCity:    { id: 'hm-kv-city',        prompt: 'Add your home city' },
  college:     { id: 'hm-kv-college',     prompt: 'Add your college' },
  centreCity:  { id: 'hm-kv-centre-city', prompt: 'Add your centre city' },
  centreName:  { id: 'hm-kv-centre-name', prompt: 'Add your centre name' },
  travel:      { id: 'hm-kv-travel',      prompt: 'Add travel preference' },
  stay:        { id: 'hm-kv-stay',        prompt: 'Add your stay plan' },
  bio:         { id: 'hm-kv-bio',         prompt: 'Add a short bio' },
};

const LOADING_TEXT = 'Loading…';
const EMPTY_CLASS = 'hm-kv__empty';

async function init() {
  const firebaseUser = await requireAuth();
  if (!firebaseUser) return;

  setLoadingState();

  const phone = firebaseUser.phoneNumber || null;
  if (!phone) {
    renderError('Could not read your phone number from your sign-in. Please sign in again.');
    return;
  }

  // Always show the verified phone immediately — it comes from Firebase.
  setPhone(phone);

  const { data, error } = await getProfileByPhone(phone);

  if (error) {
    console.error('[profile] failed to load profile', error);
    renderError(error.message || 'Could not load your profile right now.');
    return;
  }

  hydrate(data || {}, phone);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function hydrate(row, phone) {
  const name = trimOrNull(row.full_name);

  // Cache initials to sessionStorage so the navbar avatar can show real initials
  // on every page without needing an additional Supabase fetch.
  try {
    const initials = avatarInitials(name);
    sessionStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ initials }));
    // Also update the navbar avatar on this page immediately.
    const navAvatar = document.getElementById('hm-navbar-avatar');
    if (navAvatar && initials !== 'HM') navAvatar.textContent = initials;
  } catch { /* ignore — storage may be unavailable in private mode */ }

  // Identity card (left column).
  setText('hm-profile-name', name || 'Your name');
  setAvatar(name);

  // Editable sections (right column).
  setField('name',       name);
  setField('gender',     trimOrNull(row.gender));
  // Home city: prefer dedicated column, fall back to onboarding `district`.
  setField('homeCity',   trimOrNull(row.home_city) || trimOrNull(row.district));
  setField('college',    trimOrNull(row.college));
  // Centre city: prefer dedicated column, fall back to onboarding `state`
  // (closest signal we have until centre_city is captured during onboarding).
  setField('centreCity', trimOrNull(row.centre_city) || trimOrNull(row.state));
  // Centre name: prefer dedicated column, fall back to onboarding `exam_center`.
  setField('centreName', trimOrNull(row.centre_name) || trimOrNull(row.exam_center));
  setField('travel',     trimOrNull(row.travel_mode));
  setField('stay',       trimOrNull(row.stay_plan));
  setField('bio',        trimOrNull(row.bio));
}

function setLoadingState() {
  Object.values(FIELDS).forEach(({ id }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = LOADING_TEXT;
    el.classList.remove(EMPTY_CLASS);
  });
}

function setField(key, value) {
  const meta = FIELDS[key];
  if (!meta) return;
  const el = document.getElementById(meta.id);
  if (!el) return;
  if (value) {
    el.textContent = value;
    el.classList.remove(EMPTY_CLASS);
  } else {
    el.textContent = meta.prompt;
    el.classList.add(EMPTY_CLASS);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setPhone(phone) {
  setText('hm-profile-phone', formatPhonePretty(phone) || phone);
}

function setAvatar(name) {
  const el = document.getElementById('hm-profile-avatar');
  if (!el) return;
  el.textContent = avatarInitials(name);
}

function renderError(message) {
  Object.values(FIELDS).forEach(({ id }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
    el.classList.remove(EMPTY_CLASS);
  });
  // Surface the error in the name slot so it's visible without redesigning UI.
  setText('hm-profile-name', message);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function avatarInitials(name) {
  const safe = (name || '').trim();
  if (!safe) return 'HM';
  return safe.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

document.addEventListener('DOMContentLoaded', init);
