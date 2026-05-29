// HallMate — Onboarding wizard: collect profile data and persist to Supabase.
// Loaded only from onboarding.html.

import { requireAuth } from './auth.js';
import { upsertUser } from './supabase.js';
import { setButtonBusy } from './ui.js';
import { ROUTES, STORAGE_KEYS } from './config.js';
import { populateStateSelect, wireDistrictCascade } from './location-data.js';

let firebaseUser = null;
const collected = {};

async function init() {
  firebaseUser = await requireAuth();
  if (!firebaseUser) return;

  // Home state → district cascade (Step 2)
  const stateEl    = document.getElementById('hm-state');
  const districtEl = document.getElementById('hm-district');
  if (stateEl && districtEl) {
    populateStateSelect(stateEl);
    wireDistrictCascade(stateEl, districtEl);
  }

  // Exam centre state → district cascade (Step 3)
  const examStateEl    = document.getElementById('hm-exam-state');
  const examDistrictEl = document.getElementById('hm-exam-district');
  if (examStateEl && examDistrictEl) {
    populateStateSelect(examStateEl);
    wireDistrictCascade(examStateEl, examDistrictEl);
  }

  // Step navigation via data-go-step buttons
  document.querySelectorAll('[data-go-step]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.goStep)));
  });

  document.getElementById('hm-form-step1').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate([
      { id: 'hm-name',   errId: 'hm-err-name',   msg: 'Enter your full name.' },
      { id: 'hm-gender', errId: 'hm-err-gender',  msg: 'Select your gender.' },
    ])) return;
    collected.full_name = val('hm-name');
    collected.gender    = val('hm-gender');
    goToStep(2);
  });

  document.getElementById('hm-form-step2').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate([
      { id: 'hm-state',    errId: 'hm-err-state',    msg: 'Select your state.' },
      { id: 'hm-district', errId: 'hm-err-district',  msg: 'Enter your district.' },
    ])) return;
    collected.state    = val('hm-state');
    collected.district = val('hm-district');
    goToStep(3);
  });

  document.getElementById('hm-form-step3').addEventListener('submit', (e) => {
    e.preventDefault();
    // Only state + district are required — exam centre name is optional and
    // exam_type is no longer collected during onboarding (kept in DB for
    // backward compatibility with existing users).
    if (!validate([
      { id: 'hm-exam-type',     errId: 'hm-err-exam-type',     msg: 'Please select your exam type.' },
      { id: 'hm-exam-state',    errId: 'hm-err-exam-state',    msg: 'Select your exam centre state.' },
      { id: 'hm-exam-district', errId: 'hm-err-exam-district', msg: 'Select your exam centre district.' },
    ])) return;
    collected.exam_type            = val('hm-exam-type');
    collected.exam_centre_state    = val('hm-exam-state');
    collected.exam_centre_district = val('hm-exam-district');
    collected.exam_center          = val('hm-exam-center') || null;
    goToStep(4);
  });

  document.getElementById('hm-form-step4').addEventListener('submit', async (e) => {
    e.preventDefault();
    collected.travel_mode = val('hm-travel-mode') || null;
    collected.stay_plan   = val('hm-stay-plan')   || null;
    await saveProfile();
  });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveProfile() {
  const btn = document.getElementById('hm-finish-btn');
  const errEl = document.getElementById('hm-save-error');
  errEl.hidden = true;
  setButtonBusy(btn, true, 'Saving…');

  const { error } = await upsertUser({
    phone:                 firebaseUser.phoneNumber,
    full_name:             collected.full_name,
    gender:                collected.gender,
    state:                 collected.state,
    district:              collected.district,
    exam_type:             collected.exam_type,
    exam_centre_state:     collected.exam_centre_state,
    exam_centre_district:  collected.exam_centre_district,
    exam_center:           collected.exam_center,
    travel_mode:           collected.travel_mode,
    stay_plan:             collected.stay_plan,
    profile_completed:     true,
  });

  if (error) {
    errEl.textContent = error.message || 'Failed to save profile. Please try again.';
    errEl.hidden = false;
    setButtonBusy(btn, false);
    return;
  }

  // Mark onboarding complete so guards + navbar update immediately on redirect.
  try { sessionStorage.setItem(STORAGE_KEYS.profileCompleted, 'true'); } catch {}

  window.location.replace(ROUTES.dashboard);
}

// ─── Step navigation ─────────────────────────────────────────────────────────

function goToStep(n) {
  document.querySelectorAll('[data-step-panel]').forEach((panel) => {
    panel.hidden = Number(panel.dataset.stepPanel) !== n;
  });
  document.querySelectorAll('[data-step]').forEach((dot) => {
    const s = Number(dot.dataset.step);
    dot.classList.toggle('is-active', s === n);
    dot.classList.toggle('is-done',   s < n);
  });
  document.getElementById('hm-step-current').textContent = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Validation ───────────────────────────────────────────────────────────────

// fields: [{ id, errId, msg }]
// Returns true when all fields are non-empty.
function validate(fields) {
  let ok = true;
  fields.forEach(({ id, errId, msg }) => {
    const el  = document.getElementById(id);
    const err = document.getElementById(errId);
    const empty = !el || !el.value.trim();
    if (err) { err.textContent = empty ? msg : ''; err.hidden = !empty; }
    if (empty) { el?.classList.add('hm-input--invalid'); ok = false; }
    else el?.classList.remove('hm-input--invalid');
  });
  return ok;
}

function val(id) {
  return (document.getElementById(id)?.value || '').trim();
}

document.addEventListener('DOMContentLoaded', init);
