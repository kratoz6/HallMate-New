// HallMate — App-level configuration constants.
// All cross-cutting constants live here so other modules stay environment-agnostic.

export const APP = Object.freeze({
  name: 'Zenter',
  tagline: 'Find your exam centre mates',
  version: '0.1.0',
  supportEmail: 'support@zenter.in',
  supportPhone: '+91 6363613007',
});

// Public Supabase project credentials. Anon key is safe to ship to the browser
// as long as Row Level Security is enforced on every table.
export const SUPABASE = Object.freeze({
  url: 'https://wppuzqaigtffcpuvjolt.supabase.co',
  anonKey: 'sb_publishable_Xx0JyGt9HuYDa4LHhEv41w_Bn5grq7a',
});

// Firebase Web SDK config. Replace with values from the Firebase console.
// All of these are publishable identifiers — security comes from App Check + rules.
export const FIREBASE = Object.freeze({
  apiKey: 'AIzaSyBwb6P5QJNhcaO5bHG39CUQFb1szcCDzW4',
  authDomain: 'new-hallmate.firebaseapp.com',
  projectId: 'new-hallmate',
  appId: '1:404992201739:web:00c14c914104775268230e',
});

export const ROUTES = Object.freeze({
  landing: '/index.html',
  login: '/login.html',
  onboarding: '/onboarding.html',
  dashboard: '/dashboard.html',
  connections: '/connections.html',
  profile: '/profile.html',
  contact: '/contact.html',
});

export const STORAGE_KEYS = Object.freeze({
  authUser: 'hm.auth.user',
  profile: 'hm.profile',
  redirectAfterLogin: 'hm.auth.redirect',
  profileCompleted: 'hm.profile.completed', // 'true' | 'false' — set after login / onboarding
});

export const FEATURE_FLAGS = Object.freeze({
  enableAnalytics: false,
  enableRecaptchaInvisible: true,
});
