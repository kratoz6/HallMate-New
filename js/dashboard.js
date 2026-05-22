// HallMate — Dashboard: users feed + filtering + connection system + phone reveal.

import { requireAuth } from './auth.js';
import { getAllUsers, getUserByPhone, getMyConnections,
         sendConnectionRequest, respondToRequest, deleteRequest } from './supabase.js';
import { debounce } from './utils.js';
import { toast, setButtonBusy } from './ui.js';
import * as Relationships from './relationships.js';
import { populateStateSelect, wireDistrictCascade } from './location-data.js';

const { REL } = Relationships;

let allUsers       = [];
let displayedUsers = [];
let lastFocusedCard = null;
let modalUser       = null;
let myUserId        = null;

const FILTERS = [
  { id: 'hm-filter-state',    key: 'state',       type: 'select' },
  { id: 'hm-filter-district', key: 'district',    type: 'select' },
  { id: 'hm-filter-center',   key: 'exam_center', type: 'text'   },
  { id: 'hm-filter-gender',   key: 'gender',      type: 'select' },
];

const AVATAR_COLORS = ['#FF6B35','#4F46E5','#10B981','#F59E0B','#8B5CF6','#06B6D4','#EF4444'];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const firebaseUser = await requireAuth();
  if (!firebaseUser) return;

  const { data: me } = await getUserByPhone(firebaseUser.phoneNumber);
  myUserId = me?.id || null;

  wireFilters();
  wireModal();
  wireConnectionActions();

  // Subscribe once — drives all incremental UI updates across cards, modal, banner.
  Relationships.subscribe((changedUserId) => {
    refreshCardCta(changedUserId);
    renderModalActions();
    renderIncomingRequests();
    updateNavBadge();
  });

  await loadData();
}

async function loadData() {
  renderSkeletons();
  const [usersRes, connsRes] = await Promise.all([
    getAllUsers(),
    myUserId ? getMyConnections(myUserId) : Promise.resolve({ data: [], error: null }),
  ]);

  if (usersRes.error) { renderError(usersRes.error.message); return; }

  Relationships.hydrate(connsRes.data || [], myUserId);
  allUsers = (usersRes.data || []).filter((u) => u.id !== myUserId);

  renderIncomingRequests();
  updateNavBadge();
  applyFilters();
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function getActiveFilters() {
  const out = {};
  FILTERS.forEach(({ id, key }) => {
    const v = (document.getElementById(id)?.value || '').trim().toLowerCase();
    if (v) out[key] = v;
  });
  return out;
}

function applyFilters() {
  const active = getActiveFilters();
  const keys   = Object.keys(active);
  const result = keys.length === 0
    ? allUsers
    : allUsers.filter((u) => keys.every((k) => {
        const field  = (u[k] || '').toLowerCase();
        const filter = active[k];
        const fdef   = FILTERS.find(f => f.key === k);
        // Selects use exact match (normalised values); text fields use substring search
        return fdef?.type === 'select' ? field === filter : field.includes(filter);
      }));

  updateCount(result.length);

  if (result.length === 0 && allUsers.length === 0) renderEmpty(false);
  else if (result.length === 0)                     renderEmpty(true);
  else                                              renderUsers(result);
}

const debouncedApply = debounce(applyFilters, 240);

// ─── Event wiring ─────────────────────────────────────────────────────────────

function wireFilters() {
  FILTERS.forEach(({ id, type }) => {
    document.getElementById(id)
      ?.addEventListener(type === 'text' ? 'input' : 'change', debouncedApply);
  });

  // Populate state dropdown and wire cascading district from location-data
  const stateEl    = document.getElementById('hm-filter-state');
  const districtEl = document.getElementById('hm-filter-district');
  if (stateEl && districtEl) {
    populateStateSelect(stateEl, { defaultLabel: 'All states' });
    wireDistrictCascade(stateEl, districtEl, {
      filterMode:   true,
      noStateLabel: 'All districts',
    });
  }

  document.getElementById('hm-filter-clear')?.addEventListener('click', clearFilters);

  document.getElementById('hm-refresh')?.addEventListener('click', async () => {
    FILTERS.forEach(({ id }) => { const el = document.getElementById(id); if (el) el.value = ''; });
    await loadData();
  });
}

function clearFilters() {
  FILTERS.forEach(({ id }) => { const el = document.getElementById(id); if (el) el.value = ''; });
  // Trigger cascade so district options reset to "All districts" when state is cleared
  document.getElementById('hm-filter-state')?.dispatchEvent(new Event('change'));
  applyFilters();
}

function wireModal() {
  const overlay = document.getElementById('hm-profile-modal');
  document.getElementById('hm-modal-close')?.addEventListener('click', closeModal);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.getElementById('hm-mates-grid')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-conn-action]')) return; // handled by connection wiring
    const card = e.target.closest('[data-idx]');
    if (!card) return;
    lastFocusedCard = card;
    openModal(displayedUsers[Number(card.dataset.idx)]);
  });

  document.getElementById('hm-mates-grid')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-idx]');
    if (!card) return;
    e.preventDefault();
    lastFocusedCard = card;
    openModal(displayedUsers[Number(card.dataset.idx)]);
  });
}

function wireConnectionActions() {
  // Single document-level delegate catches all conn-action buttons anywhere on the page.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-conn-action]');
    if (!btn || btn.disabled) return;
    e.stopPropagation();

    const action = btn.dataset.connAction;
    const userId = btn.dataset.userId;
    const connId = btn.dataset.connId || null;

    if (action === 'reveal') { doReveal(); return; }

    setButtonBusy(btn, true);
    try {
      if (action === 'connect')  await doConnect(userId);
      if (action === 'accept')   await doAccept(userId, connId);
      if (action === 'decline')  await doDecline(userId, connId);
      if (action === 'withdraw') await doWithdraw(userId, connId);
    } finally {
      try { setButtonBusy(btn, false); } catch { /* btn may be detached after re-render */ }
    }
  });
}

// ─── Connection actions ───────────────────────────────────────────────────────

async function doConnect(userId) {
  if (!myUserId || !userId) return;
  const existing = Relationships.get(userId);
  if (existing.status !== REL.NONE) return;

  // Optimistic update — connectionId filled in after server confirms.
  Relationships.set(userId, { status: REL.PENDING_OUT, role: 'sender', connectionId: null });

  const { data, error } = await sendConnectionRequest(myUserId, userId);
  if (error) {
    toast(error.message || 'Could not send request.', { variant: 'danger' });
    Relationships.set(userId, { status: REL.NONE });
    return;
  }
  Relationships.set(userId, { status: REL.PENDING_OUT, role: 'sender', connectionId: data?.id });
  toast('Request sent!', { variant: 'success' });
}

async function doAccept(userId, connId) {
  const { error } = await respondToRequest(connId, 'accepted');
  if (error) { toast(error.message || 'Could not accept.', { variant: 'danger' }); return; }
  Relationships.set(userId, { status: REL.CONNECTED, role: 'receiver', connectionId: connId });
  toast('Connected! You can now reveal their contact.', { variant: 'success' });
}

async function doDecline(userId, connId) {
  const { error } = await respondToRequest(connId, 'rejected');
  if (error) { toast(error.message || 'Could not decline.', { variant: 'danger' }); return; }
  Relationships.set(userId, { status: REL.REJECTED, role: 'receiver', connectionId: connId });
}

async function doWithdraw(userId, connId) {
  const { error } = await deleteRequest(connId);
  if (error) { toast(error.message || 'Could not withdraw.', { variant: 'danger' }); return; }
  Relationships.set(userId, { status: REL.NONE });
}

function doReveal() {
  if (!modalUser?.phone) return;
  const phone  = modalUser.phone;
  const waNum  = phone.replace(/\D/g, '');

  const phoneEl   = document.getElementById('hm-modal-phone');
  const revealEl  = document.getElementById('hm-modal-contact-reveal');
  const actionsEl = document.getElementById('hm-modal-actions');

  if (phoneEl)  phoneEl.hidden = true;
  if (revealEl) revealEl.innerHTML = `
    <div class="hm-contact-revealed">
      <span class="hm-contact-revealed__number">${esc(phone)}</span>
      <div class="hm-contact-revealed__links">
        <a href="tel:${esc(phone)}" class="hm-btn hm-btn--primary hm-btn--sm">📞 Call</a>
        <a href="https://wa.me/${esc(waNum)}" target="_blank" rel="noopener noreferrer" class="hm-btn hm-btn--soft hm-btn--sm">💬 WhatsApp</a>
      </div>
    </div>`;
  if (actionsEl) actionsEl.innerHTML = '';
}

// ─── Count ────────────────────────────────────────────────────────────────────

function updateCount(n) {
  const el = document.getElementById('hm-results-count');
  if (!el) return;
  el.textContent = allUsers.length === 0 ? '' : `${n} ${n === 1 ? 'HallMate' : 'HallMates'} found`;
}

function updateNavBadge() {
  const badge = document.getElementById('hm-requests-badge');
  if (!badge) return;
  const n = Relationships.countIncomingPending();
  badge.textContent = n;
  badge.hidden = n === 0;
}

// ─── Incoming requests banner ─────────────────────────────────────────────────

function renderIncomingRequests() {
  const banner = document.getElementById('hm-requests-banner');
  if (!banner) return;

  const pending = Relationships.getIncomingPending();
  if (pending.length === 0) { banner.hidden = true; banner.innerHTML = ''; return; }

  const userById = new Map(allUsers.map((u) => [u.id, u]));

  const items = pending.map(({ userId, connectionId }) => {
    const u = userById.get(userId);
    if (!u) return '';
    const color = avatarColor(u.full_name);
    return `
      <div class="hm-request-item">
        <div class="hm-avatar" style="background:${color};color:#fff;flex-shrink:0;" aria-hidden="true">${avatarInitials(u.full_name)}</div>
        <span class="hm-request-item__name">${esc(u.full_name)}</span>
        <div class="hm-request-item__actions">
          <button class="hm-btn hm-btn--primary hm-btn--sm"
            data-conn-action="accept" data-user-id="${esc(userId)}" data-conn-id="${esc(connectionId)}">Accept</button>
          <button class="hm-btn hm-btn--ghost hm-btn--sm"
            data-conn-action="decline" data-user-id="${esc(userId)}" data-conn-id="${esc(connectionId)}">Decline</button>
        </div>
      </div>`;
  }).join('');

  banner.hidden = false;
  banner.innerHTML = `
    <div class="hm-requests-banner">
      <p class="hm-requests-banner__title">
        🔔 ${pending.length} pending ${pending.length === 1 ? 'request' : 'requests'}
      </p>
      <div class="hm-requests-banner__list">${items}</div>
    </div>`;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(user) {
  if (!user) return;
  populateModal(user);
  document.getElementById('hm-profile-modal').classList.add('is-open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('hm-modal-close')?.focus(), 60);
}

function closeModal() {
  modalUser = null;
  document.getElementById('hm-profile-modal').classList.remove('is-open');
  document.body.style.overflow = '';
  lastFocusedCard?.focus();
}

function populateModal(user) {
  modalUser = user;

  const avatarEl = document.getElementById('hm-modal-avatar');
  avatarEl.textContent        = avatarInitials(user.full_name);
  avatarEl.style.background   = avatarColor(user.full_name);
  avatarEl.style.color        = '#fff';

  document.getElementById('hm-modal-name').textContent     = user.full_name  || '—';
  document.getElementById('hm-modal-state').textContent    = user.state      || '—';
  document.getElementById('hm-modal-district').textContent = user.district   || '—';
  document.getElementById('hm-modal-center').textContent   = user.exam_center || '—';
  document.getElementById('hm-modal-joined').textContent   = formatDate(user.created_at);

  const badge = document.getElementById('hm-modal-gender-badge');
  const cls   = { Female: 'hm-badge--info', Male: 'hm-badge--success' }[user.gender] || '';
  badge.textContent = user.gender || '';
  badge.className   = `hm-badge ${cls}`.trim();
  badge.hidden      = !user.gender;

  // Reset phone + reveal section
  const phoneEl  = document.getElementById('hm-modal-phone');
  const revealEl = document.getElementById('hm-modal-contact-reveal');
  if (phoneEl)  { phoneEl.textContent = maskPhone(user.phone); phoneEl.hidden = false; }
  if (revealEl) revealEl.innerHTML = '';

  renderModalActions();
}

function renderModalActions() {
  if (!modalUser) return;
  const rel       = Relationships.get(modalUser.id);
  const actionsEl = document.getElementById('hm-modal-actions');
  const privacyEl = document.getElementById('hm-modal-privacy');
  if (!actionsEl) return;

  const uid = esc(modalUser.id);
  const cid = esc(rel.connectionId || '');

  switch (rel.status) {
    case REL.NONE:
      actionsEl.innerHTML = `
        <button class="hm-btn hm-btn--primary hm-btn--block"
          data-conn-action="connect" data-user-id="${uid}">Request to Connect</button>`;
      if (privacyEl) privacyEl.hidden = false;
      break;

    case REL.PENDING_OUT:
      actionsEl.innerHTML = `
        <button class="hm-btn hm-btn--ghost hm-btn--block" disabled>Request Sent</button>
        <button class="hm-btn hm-btn--ghost hm-btn--sm" style="margin-top:8px;"
          data-conn-action="withdraw" data-user-id="${uid}" data-conn-id="${cid}">Withdraw request</button>`;
      if (privacyEl) privacyEl.hidden = false;
      break;

    case REL.PENDING_IN:
      actionsEl.innerHTML = `
        <button class="hm-btn hm-btn--primary hm-btn--block"
          data-conn-action="accept" data-user-id="${uid}" data-conn-id="${cid}">Accept Request</button>
        <button class="hm-btn hm-btn--ghost hm-btn--block" style="margin-top:8px;"
          data-conn-action="decline" data-user-id="${uid}" data-conn-id="${cid}">Decline</button>`;
      if (privacyEl) privacyEl.hidden = false;
      break;

    case REL.CONNECTED:
      actionsEl.innerHTML = `
        <button class="hm-btn hm-btn--soft hm-btn--block"
          data-conn-action="reveal">📞 Reveal Contact</button>`;
      if (privacyEl) privacyEl.hidden = true;
      break;

    case REL.REJECTED:
      actionsEl.innerHTML = `
        <p class="text-center hm-text-subtle" style="font-size:var(--hm-text-sm);margin:0;">
          This request was declined.
        </p>`;
      if (privacyEl) privacyEl.hidden = true;
      break;

    default:
      actionsEl.innerHTML = '';
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderSkeletons() { setGrid(Array.from({ length: 6 }, skeletonCard).join('')); }

function renderUsers(users) {
  displayedUsers = users;
  setGrid(users.map((u, i) => mateCard(u, i)).join(''));
}

function renderEmpty(isFiltered) {
  displayedUsers = [];
  setGrid(`
    <div class="hm-empty" style="grid-column:1/-1;">
      <div class="hm-empty__icon" aria-hidden="true">${isFiltered ? '🔍' : '🏛️'}</div>
      <h3>${isFiltered ? 'No HallMates found' : 'No mates yet'}</h3>
      <p class="hm-text-muted">
        ${isFiltered
          ? 'No HallMates match the selected filters. Try widening your search.'
          : 'Be the first HallMate in your exam centre.'}
      </p>
      ${isFiltered ? `<button class="hm-btn hm-btn--ghost hm-btn--sm" onclick="document.getElementById('hm-filter-clear').click()">Clear filters</button>` : ''}
    </div>`);
}

function renderError(msg) {
  displayedUsers = [];
  setGrid(`
    <div class="hm-empty" style="grid-column:1/-1;">
      <div class="hm-empty__icon" aria-hidden="true">⚠️</div>
      <h3>Could not load mates</h3>
      <p class="hm-text-muted">${esc(msg) || 'Please refresh and try again.'}</p>
      <button class="hm-btn hm-btn--ghost hm-btn--sm" onclick="document.getElementById('hm-refresh').click()">Retry</button>
    </div>`);
}

function setGrid(html) {
  const g = document.getElementById('hm-mates-grid');
  if (g) g.innerHTML = html;
}

// Targeted card CTA refresh — replaces only the footer of the changed card.
function refreshCardCta(userId) {
  const idx = displayedUsers.findIndex((u) => u.id === userId);
  if (idx === -1) return;
  const card   = document.querySelector(`[data-idx="${idx}"]`);
  const footer = card?.querySelector('.hm-mate__footer');
  if (footer) footer.innerHTML = cardFooterHtml(displayedUsers[idx]);
}

// ─── Card templates ───────────────────────────────────────────────────────────

function mateCard(user, idx) {
  const genderCls = { Female: 'hm-badge--info', Male: 'hm-badge--success' }[user.gender] || '';
  const location  = [user.district, user.state].filter(Boolean).join(', ');
  const bio       = bioSnippet(user.bio);
  const chips     = travelChips(user.travel_mode, user.stay_plan);

  return `
    <article class="hm-card hm-mate hm-card--interactive"
      data-idx="${idx}" tabindex="0" role="button"
      aria-label="View ${esc(user.full_name)}'s profile">
      <div class="hm-mate__head">
        <div class="hm-avatar" style="background:${avatarColor(user.full_name)};color:#fff;" aria-hidden="true">${avatarInitials(user.full_name)}</div>
        <div style="min-width:0;">
          <p class="hm-mate__name">${esc(user.full_name)}</p>
          <p class="hm-mate__sub">${esc(location) || '—'}</p>
        </div>
      </div>
      <div class="hm-mate__meta">
        ${user.gender ? `<span class="hm-badge ${genderCls}">${esc(user.gender)}</span>` : ''}
        <span class="hm-badge hm-badge--success">✓ Verified</span>
      </div>
      ${user.exam_center ? `<p class="hm-mate__center">🏛️ ${esc(user.exam_center)}</p>` : ''}
      ${bio   ? `<p class="hm-mate__bio">${esc(bio)}</p>` : ''}
      ${chips ? `<div class="hm-mate__chips">${chips}</div>` : ''}
      <div class="hm-mate__footer">${cardFooterHtml(user)}</div>
    </article>`;
}

function cardFooterHtml(user) {
  const rel    = Relationships.get(user.id);
  const joined = `<span class="hm-mate__joined">Joined ${formatDate(user.created_at)}</span>`;

  const uid = esc(user.id);
  const cid = esc(rel.connectionId || '');

  let cta = '';
  switch (rel.status) {
    case REL.NONE:
      cta = `<button class="hm-btn hm-btn--primary hm-btn--sm"
               data-conn-action="connect" data-user-id="${uid}">Connect</button>`;
      break;
    case REL.PENDING_OUT:
      cta = `<span class="hm-badge hm-badge--info" style="font-size:11px;">Sent</span>`;
      break;
    case REL.PENDING_IN:
      cta = `
        <button class="hm-btn hm-btn--primary hm-btn--sm"
          data-conn-action="accept" data-user-id="${uid}" data-conn-id="${cid}">Accept</button>
        <button class="hm-btn hm-btn--ghost hm-btn--sm"
          data-conn-action="decline" data-user-id="${uid}" data-conn-id="${cid}">Decline</button>`;
      break;
    case REL.CONNECTED:
      cta = `<span class="hm-badge hm-badge--success" style="font-size:11px;">✓ Connected</span>`;
      break;
    case REL.REJECTED:
      cta = `<span class="hm-badge" style="font-size:11px;">Declined</span>`;
      break;
  }

  return `${joined}<div class="hm-mate__cta d-flex gap-1 align-items-center">${cta}</div>`;
}

function skeletonCard() {
  return `
    <article class="hm-card hm-mate" aria-hidden="true">
      <div class="hm-mate__head">
        <div class="hm-skeleton" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div class="hm-skeleton" style="height:14px;width:55%;margin-bottom:8px;"></div>
          <div class="hm-skeleton" style="height:12px;width:38%;"></div>
        </div>
      </div>
      <div class="d-flex gap-2 mt-2">
        <div class="hm-skeleton" style="height:22px;width:64px;border-radius:999px;"></div>
        <div class="hm-skeleton" style="height:22px;width:80px;border-radius:999px;"></div>
      </div>
      <div class="hm-skeleton mt-2" style="height:12px;width:75%;"></div>
      <div class="hm-mate__footer" style="margin-top:auto;">
        <div class="hm-skeleton" style="height:12px;width:40%;"></div>
        <div class="hm-skeleton" style="height:30px;width:80px;border-radius:8px;"></div>
      </div>
    </article>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avatarInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (const c of (name || '')) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  return `${s.startsWith('+91') ? '+91 ' : ''}XXXXXXX${s.slice(-3)}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

// Maps stored values → emoji + short label for compact chip display.
const TRAVEL_LABEL = {
  'By train':   '🚆 Train',
  'By flight':  '✈️ Flight',
  'By bus':     '🚌 Bus',
  'Self-drive': '🚗 Self-drive',
  'Other':      '🚗 Other',
};
const STAY_LABEL = {
  'Need accommodation':    '🏨 Needs stay',
  'Have accommodation':    '🏠 Has stay',
  'Looking for room share': '🛏️ Room share',
  'Other':                 '📦 Other',
};

// Returns up to 2 chip spans (travel + stay), or empty string if both absent.
function travelChips(travelMode, stayPlan) {
  const chips = [];
  if (travelMode && TRAVEL_LABEL[travelMode])
    chips.push(`<span class="hm-chip hm-chip--sm">${esc(TRAVEL_LABEL[travelMode])}</span>`);
  if (stayPlan && STAY_LABEL[stayPlan])
    chips.push(`<span class="hm-chip hm-chip--sm">${esc(STAY_LABEL[stayPlan])}</span>`);
  return chips.join('');
}

// Returns a single-line bio snippet truncated to maxLen chars.
function bioSnippet(bio, maxLen = 60) {
  if (!bio) return '';
  const s = String(bio).trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

document.addEventListener('DOMContentLoaded', init);
