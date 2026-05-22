// HallMate — Profile page: hydration + inline section editing.
// Each card section (About / Centre / Travel) is independently editable.
//
// Edit flow per section:
//   1. Click "Edit" → dd elements become inputs, button swaps to Save + Cancel
//   2. Click "Save" → validate → upsertUser (Supabase) → re-render read view
//   3. Click "Cancel" → restore read view from in-memory profileData (no fetch)

import { requireOnboarded, logout }                    from './auth.js';
import { getProfileByPhone, upsertUser,
         setPausedStatus, deleteUserData }              from './supabase.js';
import { formatPhonePretty }                           from './utils.js';
import { STORAGE_KEYS, ROUTES }                        from './config.js';
import { setButtonBusy, toast }                        from './ui.js';
import { STATES, wireDistrictCascade }                 from './location-data.js';

// ─── Module state ─────────────────────────────────────────────────────────────
let profilePhone = '';   // Firebase E.164 phone number
let profileData  = {};   // Latest Supabase row; updated optimistically on save

// ─── Option lists ─────────────────────────────────────────────────────────────
const GENDER_OPTS = ['Female', 'Male', 'Prefer not to say'];

// STATES imported from location-data.js — single source of truth for all 36 entries.

const EXAM_TYPE_OPTS = ['NEET PG', 'NEET UG', 'INICET', 'NEET MDS', 'NEET SS'];

const TRAVEL_OPTS = ['By train', 'By flight', 'By bus', 'Self-drive', 'Other'];

const STAY_OPTS = [
  'Need accommodation', 'Have accommodation', 'Looking for room share', 'Other',
];

// ─── Section configs ──────────────────────────────────────────────────────────
// key         → matches Object.entries() key used to wire buttons
// sectionId   → <article> id
// editBtnId   → Edit button id
// fields[]    → defines each row: Supabase column key, dd element id, input type
const SECTIONS = {
  about: {
    sectionId: 'hm-section-about',
    editBtnId: 'hm-edit-about',
    fields: [
      {
        key: 'full_name', ddId: 'hm-kv-name', type: 'text',
        placeholder: 'Your full name', prompt: 'Add your name', required: true,
      },
      {
        key: 'gender', ddId: 'hm-kv-gender', type: 'select',
        options: GENDER_OPTS, prompt: 'Add your gender',
      },
      {
        key: 'college', ddId: 'hm-kv-college', type: 'text',
        placeholder: 'Your medical college', prompt: 'Add your college',
      },
    ],
  },

  centre: {
    sectionId: 'hm-section-centre',
    editBtnId: 'hm-edit-centre',
    fields: [
      {
        key: 'exam_type', ddId: 'hm-kv-exam-type', type: 'select',
        options: EXAM_TYPE_OPTS, prompt: 'Add your exam type',
      },
      {
        key: 'exam_centre_state', ddId: 'hm-kv-exam-state', type: 'select',
        options: STATES, prompt: 'Add exam centre state',
        fallback: 'state',
      },
      {
        key: 'exam_centre_district', ddId: 'hm-kv-exam-district', type: 'select',
        options: [], prompt: 'Add exam centre district',
        fallback: 'district',
      },
      {
        key: 'exam_center', ddId: 'hm-kv-exam-center', type: 'text',
        placeholder: 'e.g. Tirupati Medical College', prompt: 'Add your exam centre',
      },
    ],
  },

  travel: {
    sectionId: 'hm-section-travel',
    editBtnId: 'hm-edit-travel',
    fields: [
      {
        key: 'travel_mode', ddId: 'hm-kv-travel', type: 'select',
        options: TRAVEL_OPTS, prompt: 'Add travel preference',
      },
      {
        key: 'stay_plan', ddId: 'hm-kv-stay', type: 'select',
        options: STAY_OPTS, prompt: 'Add your stay plan',
      },
    ],
  },
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  const firebaseUser = await requireOnboarded();
  if (!firebaseUser) return;

  profilePhone = firebaseUser.phoneNumber || '';
  if (!profilePhone) {
    setText('hm-profile-name', 'Cannot read phone — please sign in again.');
    return;
  }

  // Show phone immediately (from Firebase, no Supabase latency)
  setText('hm-profile-phone', formatPhonePretty(profilePhone));

  setAllLoading();

  const { data, error } = await getProfileByPhone(profilePhone);
  if (error) {
    console.error('[profile] load error', error);
    setText('hm-profile-name', error.message || 'Could not load profile.');
    return;
  }

  profileData = data || {};
  hydrateAll();
  wireEditButtons();
  wireAccountActions();
}

// ─── Read-mode hydration ──────────────────────────────────────────────────────

function setAllLoading() {
  Object.values(SECTIONS).forEach(sec => {
    sec.fields.forEach(f => setDd(f.ddId, null, ''));
  });
}

function hydrateAll() {
  const name = trimOrNull(profileData.full_name);

  // Identity card (left column)
  setText('hm-profile-name', name || 'Your name');
  setAvatar(name);

  // Cache initials for the navbar avatar across all pages
  cacheInitials(name);

  // All section fields
  Object.values(SECTIONS).forEach(sec => hydrateSection(sec));
}

function hydrateSection(sec) {
  sec.fields.forEach(f => {
    // Use fallback field for backward compat (old users without exam_centre_* cols)
    const value = trimOrNull(profileData[f.key])
               ?? (f.fallback ? trimOrNull(profileData[f.fallback]) : null);
    setDd(f.ddId, value, f.prompt);
  });
}

// Sets a <dd> to a value or an italic prompt when value is absent.
function setDd(ddId, value, prompt) {
  const dd = document.getElementById(ddId);
  if (!dd) return;
  if (value) {
    dd.textContent = value;
    dd.classList.remove('hm-kv__empty');
  } else {
    dd.textContent = prompt;
    dd.classList.add('hm-kv__empty');
  }
}

// ─── Edit mode ────────────────────────────────────────────────────────────────

function wireEditButtons() {
  // Single "Edit profile" button opens all sections at once
  document.getElementById('hm-edit-all')
    ?.addEventListener('click', enterEditAll);
  document.getElementById('hm-cancel-all')
    ?.addEventListener('click', exitEditAll);
  document.getElementById('hm-save-all')
    ?.addEventListener('click', () => saveAll(document.getElementById('hm-save-all')));
}

// ── Global edit: enter all sections at once ───────────────────────────────────

function enterEditAll() {
  document.getElementById('hm-edit-all').hidden = true;
  document.getElementById('hm-edit-all-actions').hidden = false;
  Object.keys(SECTIONS).forEach(key => enterEditMode(key));
}

async function saveAll(saveBtn) {
  // Clear previous error
  document.getElementById('hm-save-all-error')?.remove();

  // Collect + validate all field values across every section
  const updates = {};
  let valid = true;
  for (const sec of Object.values(SECTIONS)) {
    for (const f of sec.fields) {
      const dd  = document.getElementById(f.ddId);
      const inp = dd?.querySelector('[data-field-key]');
      if (!inp) continue;
      const v = inp.value.trim() || null;
      if (f.required && !v) {
        inp.classList.add('hm-input--invalid');
        valid = false;
      } else {
        inp.classList.remove('hm-input--invalid');
        updates[f.key] = v;
      }
    }
  }
  if (!valid) return;

  setButtonBusy(saveBtn, true, 'Saving…');
  const { error } = await upsertUser({ phone: profilePhone, profile_completed: true, ...updates });
  setButtonBusy(saveBtn, false);

  if (error) {
    const errEl = document.createElement('p');
    errEl.id = 'hm-save-all-error';
    errEl.style.cssText = 'color:var(--hm-danger);font-size:var(--hm-text-xs);margin-top:8px;margin-bottom:0;';
    errEl.textContent = error.message || 'Save failed. Please try again.';
    saveBtn.before(errEl);
    return;
  }

  // Optimistic merge
  Object.assign(profileData, updates);
  if ('full_name' in updates) {
    const name = trimOrNull(profileData.full_name);
    setText('hm-profile-name', name || 'Your name');
    setAvatar(name);
    cacheInitials(name);
  }

  exitEditAll();
}

function exitEditAll() {
  Object.keys(SECTIONS).forEach(key => exitEditMode(key));
  document.getElementById('hm-save-all-error')?.remove();
  document.getElementById('hm-edit-all').hidden = false;
  document.getElementById('hm-edit-all-actions').hidden = true;
}

// ── Per-section input rendering (no button swap — controlled globally) ─────────

function enterEditMode(sectionKey) {
  const sec     = SECTIONS[sectionKey];
  const article = document.getElementById(sec.sectionId);
  if (!article) return;

  // Replace each <dd> text with the appropriate input
  sec.fields.forEach(f => {
    const dd = document.getElementById(f.ddId);
    if (!dd) return;
    // Fallback to legacy field so old users see their existing data pre-filled
    const currentVal = trimOrNull(profileData[f.key])
                    ?? (f.fallback ? trimOrNull(profileData[f.fallback]) : null)
                    ?? '';
    dd.textContent = '';
    dd.classList.remove('hm-kv__empty');
    const input = buildInput(f, currentVal);
    input.setAttribute('data-field-key', f.key);
    dd.appendChild(input);
  });

  // Wire state → district cascade for the centre section
  if (sectionKey === 'centre') {
    const stateEl = document.getElementById('hm-kv-exam-state')?.querySelector('select');
    const distEl  = document.getElementById('hm-kv-exam-district')?.querySelector('select');
    if (stateEl && distEl) {
      wireDistrictCascade(stateEl, distEl);
      const savedDist = trimOrNull(profileData.exam_centre_district)
                     ?? trimOrNull(profileData.district)
                     ?? '';
      if (savedDist) distEl.value = savedDist;
    }
  }

  article.classList.add('is-editing');
}

function buildInput(field, currentVal) {
  if (field.type === 'text') {
    const el = document.createElement('input');
    el.type        = 'text';
    el.className   = 'hm-input';
    el.value       = currentVal;
    el.placeholder = field.placeholder || '';
    if (field.required) el.required = true;
    return el;
  }

  if (field.type === 'select') {
    const el = document.createElement('select');
    el.className = 'hm-select';
    // Blank default option
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = 'Select…';
    blank.selected = !currentVal;
    el.appendChild(blank);
    (field.options || []).forEach(opt => {
      const o = document.createElement('option');
      o.value = o.textContent = opt;
      o.selected = (opt === currentVal);
      el.appendChild(o);
    });
    return el;
  }

  if (field.type === 'textarea') {
    const el = document.createElement('textarea');
    el.className   = 'hm-textarea hm-profile-bio';
    el.value       = currentVal;
    el.placeholder = field.placeholder || '';
    el.rows        = 3;
    return el;
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveSection(sectionKey, saveBtn) {
  const sec     = SECTIONS[sectionKey];
  const article = document.getElementById(sec.sectionId);

  // Remove any previous inline error
  article.querySelector('.hm-profile-save-error')?.remove();

  // Collect + validate field values
  const updates = {};
  let valid = true;

  for (const f of sec.fields) {
    const dd  = document.getElementById(f.ddId);
    const inp = dd?.querySelector('[data-field-key]');
    if (!inp) continue;

    const val = inp.value.trim() || null;
    if (f.required && !val) {
      inp.classList.add('hm-input--invalid');
      valid = false;
    } else {
      inp.classList.remove('hm-input--invalid');
      updates[f.key] = val;
    }
  }
  if (!valid) return;

  setButtonBusy(saveBtn, true, 'Saving…');

  const { error } = await upsertUser({
    phone: profilePhone,
    profile_completed: true,
    ...updates,
  });

  setButtonBusy(saveBtn, false);

  if (error) {
    console.error('[profile] save error', error);
    const errEl = document.createElement('p');
    errEl.className = 'hm-profile-save-error';
    errEl.style.cssText =
      'color:var(--hm-danger);font-size:var(--hm-text-xs);' +
      'margin-top:var(--hm-space-3);grid-column:1/-1;';
    errEl.textContent = error.message || 'Save failed. Please try again.';
    article.querySelector('.hm-kv')?.appendChild(errEl);
    return;
  }

  // Optimistic merge into in-memory profileData
  Object.assign(profileData, updates);

  // Keep identity card in sync if name changed
  if ('full_name' in updates) {
    const name = trimOrNull(profileData.full_name);
    setText('hm-profile-name', name || 'Your name');
    setAvatar(name);
    cacheInitials(name);
  }

  exitEditMode(sectionKey);
}

// ─── Exit edit mode ───────────────────────────────────────────────────────────

function exitEditMode(sectionKey) {
  const sec     = SECTIONS[sectionKey];
  const article = document.getElementById(sec.sectionId);
  if (!article) return;
  article.classList.remove('is-editing');
  hydrateSection(sec);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setAvatar(name) {
  const el = document.getElementById('hm-profile-avatar');
  if (el) el.textContent = avatarInitials(name);
}

function cacheInitials(name) {
  try {
    const initials = avatarInitials(name);
    sessionStorage.setItem(STORAGE_KEYS.profile, JSON.stringify({ initials }));
    const navAvatar = document.getElementById('hm-navbar-avatar');
    if (navAvatar && initials !== 'HM') navAvatar.textContent = initials;
  } catch { /* ignore — storage may be unavailable in private mode */ }
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function avatarInitials(name) {
  const s = (name || '').trim();
  if (!s) return 'HM';
  return s.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ─── Account actions: pause + delete ─────────────────────────────────────────

function openModal(id)  { document.getElementById(id)?.classList.add('is-open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('is-open'); }

/** Sync the Pause button label + paused notice with current profileData state. */
function renderPauseState() {
  const btn    = document.getElementById('hm-pause-profile');
  const notice = document.getElementById('hm-paused-notice');
  const paused = !!profileData.is_profile_paused;
  if (btn)    btn.textContent = paused ? 'Reactivate profile' : 'Pause my profile';
  if (notice) notice.hidden   = !paused;
}

function wireAccountActions() {
  renderPauseState();

  // ── Pause / Reactivate ────────────────────────────────────────────────────
  document.getElementById('hm-pause-profile')?.addEventListener('click', () => {
    if (profileData.is_profile_paused) {
      // Reactivate: no confirmation needed — just a beneficial toggle
      doPauseToggle(false);
    } else {
      openModal('hm-modal-pause');
    }
  });

  document.getElementById('hm-modal-pause-cancel')
    ?.addEventListener('click', () => closeModal('hm-modal-pause'));

  document.getElementById('hm-modal-pause')
    ?.addEventListener('click', e => {
      if (e.target.id === 'hm-modal-pause') closeModal('hm-modal-pause');
    });

  document.getElementById('hm-modal-pause-confirm')
    ?.addEventListener('click', async () => {
      const btn = document.getElementById('hm-modal-pause-confirm');
      setButtonBusy(btn, true, 'Pausing…');
      await doPauseToggle(true);
      setButtonBusy(btn, false);
      closeModal('hm-modal-pause');
    });

  // ── Delete account ────────────────────────────────────────────────────────
  document.getElementById('hm-delete-account')
    ?.addEventListener('click', () => openModal('hm-modal-delete'));

  document.getElementById('hm-modal-delete-cancel')
    ?.addEventListener('click', () => closeModal('hm-modal-delete'));

  document.getElementById('hm-modal-delete')
    ?.addEventListener('click', e => {
      if (e.target.id === 'hm-modal-delete') closeModal('hm-modal-delete');
    });

  document.getElementById('hm-modal-delete-confirm')
    ?.addEventListener('click', async () => {
      const btn = document.getElementById('hm-modal-delete-confirm');
      setButtonBusy(btn, true, 'Deleting…');
      await doDeleteAccount(btn);
    });
}

async function doPauseToggle(pausing) {
  const { error } = await setPausedStatus(profilePhone, pausing);
  if (error) {
    toast(error.message || 'Could not update profile. Please try again.', { variant: 'danger' });
    return;
  }
  profileData.is_profile_paused = pausing;
  renderPauseState();
  toast(
    pausing ? 'Profile paused — you\'re hidden from Find Mates.'
            : 'Profile reactivated — you\'re visible again!',
    { variant: pausing ? 'info' : 'success' }
  );
}

async function doDeleteAccount(confirmBtn) {
  if (!profileData.id) {
    toast('Cannot delete — profile not loaded. Please refresh.', { variant: 'danger' });
    setButtonBusy(confirmBtn, false);
    return;
  }

  const { error } = await deleteUserData(profileData.id);
  if (error) {
    toast(error.message || 'Delete failed. Please try again.', { variant: 'danger' });
    setButtonBusy(confirmBtn, false);
    return;
  }

  // Sign out Firebase session then go to landing
  await logout(ROUTES.landing);
}

document.addEventListener('DOMContentLoaded', init);
