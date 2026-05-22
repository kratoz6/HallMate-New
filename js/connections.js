// HallMate — Connections page.
// Fetches accepted connections for the signed-in user, resolves the partner
// profile for each, and renders contact cards with WhatsApp + Call CTAs.
//
// Query flow:
//   1. requireAuth()  → Firebase user → phone
//   2. getProfileByPhone(phone) → current user's Supabase row (need the uuid)
//   3. getAcceptedConnections(userId) → rows where sender|receiver = me, status='accepted'
//   4. Derive otherIds = [ the side that is NOT me ] (deduplicated)
//   5. getUsersByIds(otherIds) → batch fetch partner profiles in one query
//   6. Render cards (name · location · exam centre · phone · WhatsApp · Call)

import { requireAuth }           from './auth.js';
import {
  getProfileByPhone,
  getAcceptedConnections,
  getUsersByIds,
  getBlockedUserIds,
}                                from './supabase.js';
import { formatPhonePretty }     from './utils.js';

// Listener registered exactly once — survives re-renders. Removes any card
// matching the blocked userId when the dashboard fires 'hm:user-blocked'.
let blockListenerWired = false;
function wireBlockedListenerOnce(root) {
  if (blockListenerWired) return;
  blockListenerWired = true;
  window.addEventListener('hm:user-blocked', (e) => {
    const id = e.detail?.userId;
    if (!id) return;
    const card = root.querySelector(`[data-conn-card-id="${id}"]`);
    card?.remove();
    if (!root.querySelector('[data-conn-card-id]')) renderEmpty(root);
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const firebaseUser = await requireAuth();
  if (!firebaseUser) return;

  const root = document.getElementById('hm-connections-root');
  if (!root) return;

  await runConnections(root, firebaseUser);
}

// ─── Public entry-point ───────────────────────────────────────────────────────
// Called by dashboard.js when the Connections tab is first activated.
// Accepts an already-resolved firebaseUser so no second requireAuth() is needed.

export async function runConnections(root, firebaseUser) {
  setLoading(root);
  wireBlockedListenerOnce(root);

  const { data: me, error: meErr } = await getProfileByPhone(firebaseUser.phoneNumber);
  if (meErr || !me) {
    renderError(root, 'Could not load your profile. Please sign in again.');
    return;
  }

  // Fetch connections + blocked IDs in parallel.
  const [connsRes, blockedRes] = await Promise.all([
    getAcceptedConnections(me.id),
    getBlockedUserIds(me.id),
  ]);
  if (connsRes.error) {
    renderError(root, connsRes.error.message || 'Could not load connections.');
    return;
  }
  const connections = connsRes.data || [];
  const blockedSet  = new Set((blockedRes.data || []).map(b => b.blocked_user_id));

  if (connections.length === 0) {
    renderEmpty(root);
    return;
  }

  const otherIds = [...new Set(
    connections.map(c => c.sender_id === me.id ? c.receiver_id : c.sender_id)
  )].filter(id => !blockedSet.has(id));

  if (otherIds.length === 0) {
    renderEmpty(root);
    return;
  }

  const { data: partners, error: partnersErr } = await getUsersByIds(otherIds);
  if (partnersErr || !partners) {
    renderError(root, 'Could not load connection profiles.');
    return;
  }

  if (partners.length === 0) {
    renderEmpty(root);
    return;
  }

  const byId = Object.fromEntries(partners.map(u => [u.id, u]));
  renderConnections(root, otherIds, byId);
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function setLoading(root) {
  root.innerHTML = `
    <div style="text-align:center;padding:var(--hm-space-7) var(--hm-space-5);">
      <div class="hm-loader__spinner" style="margin:0 auto;"></div>
      <p class="hm-text-muted" style="margin-top:var(--hm-space-3);">Loading connections…</p>
    </div>`;
}

function renderEmpty(root) {
  root.innerHTML = `
    <div class="hm-empty">
      <div class="hm-empty__icon" aria-hidden="true">🤝</div>
      <h3>No connections yet</h3>
      <p class="hm-text-muted" style="max-width:360px;margin:0 auto var(--hm-space-4);">
        Browse centre mates and send a connection request.
        Phone numbers reveal only after both of you accept.
      </p>
      <a href="/dashboard.html" class="hm-btn hm-btn--primary">Find centre mates</a>
    </div>`;
}

function renderError(root, msg) {
  root.innerHTML = `
    <div class="hm-empty">
      <div class="hm-empty__icon" aria-hidden="true">⚠️</div>
      <h3>Something went wrong</h3>
      <p class="hm-text-muted">${esc(msg)}</p>
      <button type="button" class="hm-btn hm-btn--ghost" onclick="location.reload()">
        Try again
      </button>
    </div>`;
}

function renderConnections(root, otherIds, byId) {
  const cards = otherIds
    .map(id => {
      const user = byId[id];
      return user ? buildCard(user) : '';
    })
    .filter(Boolean)
    .join('');

  root.innerHTML = `<div class="hm-grid-cards">${cards}</div>`;
}

// ─── Card builder ─────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#7C3AED', '#2563EB', '#059669', '#D97706',
  '#DC2626', '#DB2777', '#0891B2',
];

function avatarColor(name) {
  let h = 0;
  for (const ch of (name || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function avatarInitials(name) {
  const safe = (name || '').trim();
  if (!safe) return '?';
  return safe.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

const TRAVEL_LABEL = {
  'By train':   '🚆 Train',
  'By flight':  '✈️ Flight',
  'By bus':     '🚌 Bus',
  'Self-drive': '🚗 Self-drive',
  'Other':      '🚗 Other',
};
const STAY_LABEL = {
  'Need accommodation':     '🏨 Needs stay',
  'Have accommodation':     '🏠 Has stay',
  'Looking for room share': '🛏️ Room share',
  'Other':                  '📦 Other',
};

function travelChips(travelMode, stayPlan) {
  const chips = [];
  if (travelMode && TRAVEL_LABEL[travelMode])
    chips.push(`<span class="hm-chip hm-chip--sm">${esc(TRAVEL_LABEL[travelMode])}</span>`);
  if (stayPlan && STAY_LABEL[stayPlan])
    chips.push(`<span class="hm-chip hm-chip--sm">${esc(STAY_LABEL[stayPlan])}</span>`);
  return chips.join('');
}

function bioSnippet(bio, maxLen = 60) {
  if (!bio) return '';
  const s = String(bio).trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// ─── Card builder ─────────────────────────────────────────────────────────────

function buildCard(user) {
  const name        = user.full_name   || 'Unknown';
  const examLoc     = [user.exam_centre_district, user.exam_centre_state].filter(Boolean).join(', ');
  const location    = examLoc || [user.district, user.state].filter(Boolean).join(', ') || '—';
  const centre      = user.exam_center || '—';
  const phone       = user.phone       || '';
  const phonePretty = phone ? formatPhonePretty(phone) : '—';
  const digits      = phone.replace(/\D/g, '');
  const waHref      = digits ? `https://wa.me/${digits}` : '';
  const telHref     = phone  ? `tel:${phone}` : '';
  const color       = avatarColor(name);
  const initials    = avatarInitials(name);
  const bio         = bioSnippet(user.bio);
  const chips       = travelChips(user.travel_mode, user.stay_plan);

  return `
    <div class="hm-card hm-mate" data-conn-card-id="${esc(user.id)}">
      <!-- Identity -->
      <div class="hm-mate__head">
        <div class="hm-avatar"
             style="background:${color};color:#fff;flex-shrink:0;"
             aria-hidden="true">${esc(initials)}</div>
        <div style="min-width:0;">
          <p class="hm-mate__name">${esc(name)}</p>
          <p class="hm-mate__sub">${esc(location)}</p>
        </div>
      </div>

      <!-- Exam centre -->
      <p class="hm-mate__center">🏛️ ${esc(centre)}</p>

      <!-- Social context: bio + travel/stay chips -->
      ${bio   ? `<p class="hm-mate__bio">${esc(bio)}</p>` : ''}
      ${chips ? `<div class="hm-mate__chips">${chips}</div>` : ''}

      <!-- Revealed contact: full phone + CTAs -->
      <div class="hm-contact-revealed" style="margin-top:auto;padding-top:var(--hm-space-3);border-top:1px solid var(--hm-border);">
        <p class="hm-contact-revealed__number">${esc(phonePretty)}</p>
        <div class="hm-contact-revealed__links">
          ${waHref  ? `<a href="${esc(waHref)}" target="_blank" rel="noopener noreferrer"
                          class="hm-btn hm-btn--soft hm-btn--sm">💬 WhatsApp</a>` : ''}
          ${telHref ? `<a href="${esc(telHref)}"
                          class="hm-btn hm-btn--ghost hm-btn--sm">📞 Call</a>` : ''}
        </div>
      </div>

      <!-- Block action — destructive, visually subdued, right-aligned -->
      <div style="margin-top:var(--hm-space-2);text-align:right;">
        <button class="hm-modal__block-btn" type="button"
                data-conn-action="block" data-user-id="${esc(user.id)}"
                aria-label="Block ${esc(name)}">
          🚫 Block user
        </button>
      </div>
    </div>`;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

document.addEventListener('DOMContentLoaded', init);
