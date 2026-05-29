// HallMate — Firebase initialization (Phone OTP only).
// Architecture-only: exposes the configured `auth` instance and OTP primitives.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

import { FIREBASE } from './config.js';

const firebaseApp = initializeApp({
  apiKey: FIREBASE.apiKey,
  authDomain: FIREBASE.authDomain,
  projectId: FIREBASE.projectId,
  appId: FIREBASE.appId,
});

export const auth = getAuth(firebaseApp);

// Testing mode is enabled ONLY for Playwright E2E runs.
// Playwright injects `window.__hm_e2e = true` via addInitScript() before any
// module loads. With this flag ON, Firebase accepts fixed test OTPs for phone
// numbers registered in the Firebase Console test list — real SMS is bypassed.
// In production this flag is never present, so real SMS OTP delivery is used.
if (typeof window !== 'undefined' && window.__hm_e2e) {
  auth.settings.appVerificationDisabledForTesting = true;
}

// Keep sessions across reloads. Phone-OTP-only apps want local persistence.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.error('[firebase] persistence init failed', err);
});

// Re-export OTP primitives so feature modules import a single surface.
export { signInWithPhoneNumber, onAuthStateChanged, signOut };

// Returns the appropriate ApplicationVerifier for the current context:
//
// • E2E / Playwright (window.__hm_e2e = true):
//     No-op mock — reCAPTCHA skipped entirely, test phone OTPs accepted.
//
// • Production (real users):
//     ⚠️ TEMPORARY DEBUG (2026-05-24): switched from 'invisible' → 'normal'
//     (visible checkbox) to validate live OTP delivery. Revert to 'invisible'
//     once recaptcha/api2/pat 401 + private-token warnings are confirmed
//     harmless and SMS reliably reaches users on the live domain.
export function createRecaptcha(containerId = 'hm-recaptcha-container') {
  if (typeof window !== 'undefined' && window.__hm_e2e) {
    return {
      type:   'recaptcha',
      verify: () => Promise.resolve(''),
      clear:  () => {},
      render: () => Promise.resolve(0),
      _reset: () => {},
    };
  }

  // Visible reCAPTCHA — renders an inline checkbox in #hm-recaptcha-container.
  const verifier = new RecaptchaVerifier(auth, containerId, {
    size: 'normal',
    callback:           () => {},
    'expired-callback': () => { console.warn('[recaptcha] expired — user must redo the check'); },
    'error-callback':   (err) => { console.warn('[recaptcha] check failed', err); },
  });
  // Ensure _reset exists — Firebase calls it internally after OTP confirmation.
  if (typeof verifier._reset !== 'function') verifier._reset = () => {};
  return verifier;
}
