// HallMate — Dashboard: users feed + filtering + connection system + phone reveal.

import { requireOnboarded } from './auth.js';
import { getAllUsers, getUserByPhone, getMyConnections,
         sendConnectionRequest, respondToRequest, deleteRequest,
         getBlockedUserIds, blockUser } from './supabase.js';
import { debounce } from './utils.js';
import { toast, setButtonBusy } from './ui.js';
import * as Relationships from './relationships.js';
import { populateStateSelect, wireDistrictCascade } from './location-data.js';

const { REL } = Relationships;

let allUsers        = [];
let displayedUsers  = [];
let lastFocusedCard = null;
let modalUser       = null;
let myUserId        = null;
let firebaseUser    = null;   // stored for lazy connections load
let connectionsLoaded = false;
let blockedUserIds  = new Set(); // blocked_user_id values for the current user

const FILTERS = [
  // fallback: old users who predate exam_centre_* columns still match via state/district
  { id: 'hm-filter-exam-state',    key: 'exam_centre_state',    fallback: 'state',    type: 'select' },
  { id: 'hm-filter-exam-district', key: 'exam_centre_district', fallback: 'district', type: 'select' },
  { id: 'hm-filter-center',        key: 'exam_center',                                type: 'text'   },
  { id: 'hm-filter-gender',        key: 'gender',                                     type: 'select' },
  { id: 'hm-filter-travel',        key: 'travel_mode',                                type: 'select' },
  { id: 'hm-filter-stay',          key: 'stay_plan',                                  type: 'select' },
];

const AVATAR_COLORS = ['#FF6B35','#4F46E5','#10B981','#F59E0B','#8B5CF6','#06B6D4','#EF4444'];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  firebaseUser = await requireOnboarded();
  if (!firebaseUser) return;

  wireTabs();

  const { data: me } = await getUserByPhone(firebaseUser.phoneNumber);
  myUserId = me?.id || null;

  // Load blocked-user IDs up front so filtering is instant throughout the session.
  if (myUserId) {
    const { data: blocked } = await getBlockedUserIds(myUserId);
    blockedUserIds = new Set((blocked || []).map(b => b.blocked_user_id));
  }

  wireExamSwitcher();
  wireFilters();
  wireModal();
  wireConnectionActions();
  wireBlockModal();

  // Subscribe once — drives all incremental UI updates across cards, modal, requests tab.
  Relationships.subscribe((changedUserId) => {
    refreshCardCta(changedUserId);
    renderModalActions();
    renderRequests();
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
  allUsers = (usersRes.data || []).filter(
    (u) => u.id !== myUserId && !blockedUserIds.has(u.id)
  );

  renderRequests();
  updateNavBadge();
  applyFilters();
}

// ─── Tab switching ────────────────────────────────────────────────────────────

const VALID_TABS = ['requests', 'find-mates', 'connections'];

function wireTabs() {
  // Resolve starting tab from URL hash; default to 'find-mates'
  const initialHash = location.hash.slice(1);
  const startTab = VALID_TABS.includes(initialHash) ? initialHash : 'find-mates';
  if (startTab !== 'find-mates') activateTab(startTab); // HTML already shows find-mates

  document.querySelectorAll('.hm-tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      activateTab(t);
      // 'find-mates' is the canonical default — no hash needed
      history.replaceState(null, '', t === 'find-mates' ? location.pathname : `#${t}`);
    });
  });

  // Respond to hash changes (e.g. nav-bar Connections link while on dashboard)
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    activateTab(VALID_TABS.includes(h) ? h : 'find-mates');
  });
}

async function activateTab(name) {
  const tab = VALID_TABS.includes(name) ? name : 'requests';

  document.querySelectorAll('.hm-tab[data-tab]').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  const panels = {
    'requests':    document.getElementById('hm-panel-requests'),
    'find-mates':  document.getElementById('hm-panel-find-mates'),
    'connections': document.getElementById('hm-panel-connections'),
  };
  Object.entries(panels).forEach(([key, el]) => { if (el) el.hidden = key !== tab; });

  // Render Requests tab content (derived from in-memory data — no extra fetch)
  if (tab === 'requests') renderRequests();

  // Lazy-load Connections on first activation
  if (tab === 'connections' && !connectionsLoaded && firebaseUser) {
    connectionsLoaded = true;
    const root = document.getElementById('hm-connections-root');
    if (root) {
      const { runConnections } = await import('./connections.js');
      await runConnections(root, firebaseUser);
    }
  }
}

// ─── Exam-type switcher ───────────────────────────────────────────────────────

const ACTIVE_EXAM = 'NEET PG'; // only live exam context for now

function wireExamSwitcher() {
  const btn  = document.getElementById('hm-exam-switcher-btn');
  const menu = document.getElementById('hm-exam-switcher-menu');
  if (!btn || !menu) return;

  // Toggle dropdown open/closed
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    btn.setAttribute('aria-expanded', String(opening));
  });

  // Handle option selection
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.hm-exam-switcher__item');
    if (!item) return;
    const exam = item.dataset.exam;

    // Close menu
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');

    if (exam === ACTIVE_EXAM) return; // already on Find Mates for this exam

    // Persist selection for future use, then go to maintenance
    try { localStorage.setItem('hm.selected_exam_type', exam); } catch {}
    window.location.href = '/maintenance.html';
  });

  // Close on any outside click
  document.addEventListener('click', () => {
    if (!menu.hidden) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
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
        const fdef   = FILTERS.find(f => f.key === k);
        // Use fallback field for backward compat (old users without exam_centre_* cols)
        const raw    = u[k] ?? (fdef?.fallback ? u[fdef.fallback] : '');
        const field  = (raw || '').toLowerCase();
        const filter = active[k];
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

  // Populate exam centre state dropdown and wire district cascade
  const stateEl    = document.getElementById('hm-filter-exam-state');
  const districtEl = document.getElementById('hm-filter-exam-district');
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
  document.getElementById('hm-filter-exam-state')?.dispatchEvent(new Event('change'));
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
    if (action === 'block')  { openBlockModal(userId); return; }

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
  connectionsLoaded = false; // Connections tab re-fetches on next activation to include new contact
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
  // Exclude blocked users from the pending-request count.
  const n = Relationships.getIncomingPending()
    .filter(({ userId }) => !blockedUserIds.has(userId))
    .length;
  const navBadge = document.getElementById('hm-requests-badge');
  if (navBadge) { navBadge.textContent = n; navBadge.hidden = n === 0; }
  const tabBadge = document.getElementById('hm-requests-tab-badge');
  if (tabBadge) { tabBadge.textContent = n; tabBadge.hidden = n === 0; }
}

// ─── Requests tab ─────────────────────────────────────────────────────────────

function renderRequests() {
  const grid = document.getElementById('hm-requests-grid');
  if (!grid) return;

  const pending   = Relationships.getIncomingPending();
  const userById  = new Map(allUsers.map((u) => [u.id, u]));
  const items     = pending
    .map(({ userId, connectionId }) => {
      const u = userById.get(userId);
      return u ? { user: u, connectionId } : null;
    })
    .filter(Boolean);

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="hm-empty" style="grid-column:1/-1;">
        <div class="hm-empty__icon" aria-hidden="true">🤝</div>
        <h3>No pending requests</h3>
        <p class="hm-text-muted">When HallMates send you connection requests, they'll appear here.</p>
      </div>`;
    return;
  }

  grid.innerHTML = items.map(({ user, connectionId }) => requestCard(user, connectionId)).join('');
}

function requestCard(user, connectionId) {
  const genderIcon = { Female: '♀', Male: '♂' }[user.gender] || '';
  const genderCls  = { Female: 'hm-badge--female', Male: 'hm-badge--male' }[user.gender] || '';

  const homeDistrict = user.district || '';
  const homeState    = user.state    || '';
  const homeLocHtml  = homeDistrict && homeState
    ? `<strong>${esc(homeDistrict)}</strong><span class="hm-loc-state">, ${esc(homeState)}</span>`
    : `<strong>${esc(homeDistrict || homeState || '—')}</strong>`;

  const centre   = user.exam_center || '';
  const examDist = user.exam_centre_district || user.district || '';
  const examSt   = user.exam_centre_state    || user.state    || '';
  const examLoc  = [examDist, examSt].filter(Boolean).join(', ');

  const travelIcon  = user.travel_mode && TRAVEL_ICON[user.travel_mode];
  const travelLabel = user.travel_mode && TRAVEL_LABEL[user.travel_mode];
  const stayIcon    = user.stay_plan   && STAY_ICON[user.stay_plan];
  const stayLabel   = user.stay_plan   && STAY_LABEL[user.stay_plan];
  const hasBadges   = !!(travelLabel || stayLabel);

  const uid = esc(user.id);
  const cid = esc(connectionId);

  return `
    <article class="hm-card hm-mate" aria-label="Connection request from ${esc(user.full_name)}">

      <div class="hm-mate__head">
        <div class="hm-avatar hm-avatar--card"
             style="background:${avatarColor(user.full_name)};color:#fff;"
             aria-hidden="true">${avatarInitials(user.full_name)}</div>
        <div class="hm-mate__head-info">
          <p class="hm-mate__name">${esc(user.full_name)}</p>
          <div class="hm-mate__badges">
            ${user.gender ? `<span class="hm-badge ${genderCls}">${genderIcon} ${esc(user.gender)}</span>` : ''}
            <span class="hm-badge hm-badge--verified">✓ Verified</span>
          </div>
        </div>
      </div>

      <div class="hm-mate__body">
        <div class="hm-mate__route-wrap">
          <div class="hm-mate__route-track">
            <div class="hm-mate__icon-bubble">🏠</div>
            <div class="hm-mate__route-connector">
              <div class="hm-mate__route-dot hm-mate__route-dot--top"></div>
              <div class="hm-mate__route-dashes"></div>
              <div class="hm-mate__route-dot hm-mate__route-dot--bottom"></div>
            </div>
            <div class="hm-mate__icon-bubble">📋</div>
          </div>
          <div class="hm-mate__route-info">
            <p class="hm-mate__home-loc">${homeLocHtml}</p>
            <div class="hm-mate__exam-info">
              ${centre  ? `<p class="hm-mate__centre-name">${esc(centre)}</p>`    : ''}
              ${examLoc ? `<p class="hm-mate__centre-loc">📍 ${esc(examLoc)}</p>` : ''}
            </div>
          </div>
        </div>
        ${hasBadges ? `<div class="hm-mate__v-divider"></div>` : ''}
        ${hasBadges ? `
          <div class="hm-mate__badge-cards">
            ${travelLabel ? `<div class="hm-mate__badge-card"><span class="hm-mate__badge-icon">${esc(travelIcon)}</span><span class="hm-mate__badge-label">${esc(travelLabel)}</span></div>` : ''}
            ${stayLabel   ? `<div class="hm-mate__badge-card"><span class="hm-mate__badge-icon">${esc(stayIcon)}</span><span class="hm-mate__badge-label">${esc(stayLabel)}</span></div>` : ''}
          </div>` : ''}
      </div>

      <div class="hm-mate__footer">
        <span class="hm-mate__joined">Joined ${formatDate(user.created_at)}</span>
        <div class="d-flex gap-2 flex-shrink-0">
          <button class="hm-btn hm-btn--ghost hm-btn--sm"
            data-conn-action="decline" data-user-id="${uid}" data-conn-id="${cid}">Reject</button>
          <button class="hm-btn hm-btn--primary hm-btn--sm"
            data-conn-action="accept"  data-user-id="${uid}" data-conn-id="${cid}">Accept</button>
        </div>
      </div>

    </article>`;
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
  document.getElementById('hm-modal-state').textContent    = user.exam_centre_state    || user.state    || '—';
  document.getElementById('hm-modal-district').textContent = user.exam_centre_district || user.district || '—';
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

  // Block action — always visible, visually separated from main CTA.
  const blockRow = document.getElementById('hm-modal-block-row');
  if (blockRow) {
    blockRow.innerHTML = `
      <button class="hm-modal__block-btn"
        data-conn-action="block" data-user-id="${esc(user.id)}"
        type="button">🚫 Block this user</button>`;
  }

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
  // Gender: icon symbol + colour class
  const genderIcon = { Female: '♀', Male: '♂' }[user.gender] || '';
  const genderCls  = { Female: 'hm-badge--female', Male: 'hm-badge--male' }[user.gender] || '';

  // Home location: district in bold, state in muted gray
  const homeDistrict = user.district || '';
  const homeState    = user.state    || '';
  const homeLocHtml  = homeDistrict && homeState
    ? `<strong>${esc(homeDistrict)}</strong><span class="hm-loc-state">, ${esc(homeState)}</span>`
    : `<strong>${esc(homeDistrict || homeState || '—')}</strong>`;

  // Exam centre (with fallback for old users without exam_centre_* cols)
  const centre   = user.exam_center || '';
  const examDist = user.exam_centre_district || user.district || '';
  const examSt   = user.exam_centre_state    || user.state    || '';
  const examLoc  = [examDist, examSt].filter(Boolean).join(', ');

  // Right badge cards: separate icon from label
  const travelIcon  = user.travel_mode && TRAVEL_ICON[user.travel_mode];
  const travelLabel = user.travel_mode && TRAVEL_LABEL[user.travel_mode];
  const stayIcon    = user.stay_plan   && STAY_ICON[user.stay_plan];
  const stayLabel   = user.stay_plan   && STAY_LABEL[user.stay_plan];
  const hasBadges   = !!(travelLabel || stayLabel);

  return `
    <article class="hm-card hm-mate hm-card--interactive"
      data-idx="${idx}" tabindex="0" role="button"
      aria-label="View ${esc(user.full_name)}'s profile">

      <!-- Identity row: avatar · name · gender + verified badges -->
      <div class="hm-mate__head">
        <div class="hm-avatar hm-avatar--card"
             style="background:${avatarColor(user.full_name)};color:#fff;"
             aria-hidden="true">${avatarInitials(user.full_name)}</div>
        <div class="hm-mate__head-info">
          <p class="hm-mate__name">${esc(user.full_name)}</p>
          <div class="hm-mate__badges">
            ${user.gender
              ? `<span class="hm-badge ${genderCls}">${genderIcon} ${esc(user.gender)}</span>`
              : ''}
            <span class="hm-badge hm-badge--verified">✓ Verified</span>
          </div>
        </div>
      </div>

      <!-- Body: route timeline (left) + divider + badge cards (right) -->
      <div class="hm-mate__body">

        <!-- Route wrap: icon track + location text column -->
        <div class="hm-mate__route-wrap">

          <!-- Icon track: home → dashed connector with dots → exam -->
          <div class="hm-mate__route-track">
            <div class="hm-mate__icon-bubble">🏠</div>
            <div class="hm-mate__route-connector">
              <div class="hm-mate__route-dot hm-mate__route-dot--top"></div>
              <div class="hm-mate__route-dashes"></div>
              <div class="hm-mate__route-dot hm-mate__route-dot--bottom"></div>
            </div>
            <div class="hm-mate__icon-bubble">📋</div>
          </div>

          <!-- Text: home loc (top, beside home icon) ↔ exam info (bottom) -->
          <div class="hm-mate__route-info">
            <p class="hm-mate__home-loc">${homeLocHtml}</p>
            <div class="hm-mate__exam-info">
              ${centre  ? `<p class="hm-mate__centre-name">${esc(centre)}</p>`    : ''}
              ${examLoc ? `<p class="hm-mate__centre-loc">📍 ${esc(examLoc)}</p>` : ''}
            </div>
          </div>

        </div>

        <!-- Vertical dashed divider (only rendered when badges exist) -->
        ${hasBadges ? `<div class="hm-mate__v-divider"></div>` : ''}

        <!-- Badge cards: travel mode + stay plan -->
        ${hasBadges ? `
          <div class="hm-mate__badge-cards">
            ${travelLabel ? `
              <div class="hm-mate__badge-card">
                <span class="hm-mate__badge-icon">${esc(travelIcon)}</span>
                <span class="hm-mate__badge-label">${esc(travelLabel)}</span>
              </div>` : ''}
            ${stayLabel ? `
              <div class="hm-mate__badge-card">
                <span class="hm-mate__badge-icon">${esc(stayIcon)}</span>
                <span class="hm-mate__badge-label">${esc(stayLabel)}</span>
              </div>` : ''}
          </div>` : ''}

      </div>

      <!-- Footer: join date · connection CTA -->
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

// ─── Block ────────────────────────────────────────────────────────────────────

function openBlockModal(userId) {
  const modal = document.getElementById('hm-block-modal');
  if (!modal) return;
  modal.dataset.targetUserId = userId;
  modal.classList.add('is-open');
}

function wireBlockModal() {
  const modal = document.getElementById('hm-block-modal');
  if (!modal) return;

  document.getElementById('hm-block-cancel')
    ?.addEventListener('click', () => modal.classList.remove('is-open'));

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('is-open');
  });

  document.getElementById('hm-block-confirm')
    ?.addEventListener('click', async () => {
      const userId = modal.dataset.targetUserId;
      if (!userId) return;
      const btn = document.getElementById('hm-block-confirm');
      setButtonBusy(btn, true, 'Blocking…');
      await doBlock(userId);
      setButtonBusy(btn, false);
      modal.classList.remove('is-open');
    });
}

async function doBlock(userId) {
  if (!myUserId) return;
  const { error } = await blockUser(myUserId, userId);
  if (error) { toast(error.message || 'Could not block user.', { variant: 'danger' }); return; }

  blockedUserIds.add(userId);
  allUsers = allUsers.filter((u) => u.id !== userId);

  applyFilters();
  renderRequests();
  updateNavBadge();
  closeModal(); // close the profile modal
  toast('User blocked — they won\'t appear in Find Mates.', { variant: 'info' });
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

// Maps stored values → emoji icon + short label (split for badge-card layout).
const TRAVEL_ICON = {
  'By train':   '🚆',
  'By flight':  '✈️',
  'By bus':     '🚌',
  'Self-drive': '🚗',
  'Other':      '🚕',
};
const TRAVEL_LABEL = {
  'By train':   'Train',
  'By flight':  'Flight',
  'By bus':     'Bus',
  'Self-drive': 'Self-drive',
  'Other':      'Other',
};
const STAY_ICON = {
  'Need accommodation':     '🏨',
  'Have accommodation':     '🏠',
  'Looking for room share': '🛏️',
  'Other':                  '📦',
};
const STAY_LABEL = {
  'Need accommodation':     'Needs stay',
  'Have accommodation':     'Has stay',
  'Looking for room share': 'Room share',
  'Other':                  'Other',
};

document.addEventListener('DOMContentLoaded', init);
