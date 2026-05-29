// HallMate — Connections page (3-section relationship hub).
//
// Sections:
//   1. Received requests  — pending where receiver=me   (Accept / Reject)
//   2. Sent requests      — pending where sender=me     (Cancel)
//   3. Connected          — accepted connections        (Contact + Block)
//
// Refresh strategy:
//   The page listens for two window events fired by dashboard.js:
//     'hm:connections-changed' → any accept/decline/withdraw/connect →
//                                  full re-render of the 3 sections
//     'hm:user-blocked'        → drop a single card by data-conn-card-id
//
// Phone numbers are NEVER rendered for received/sent cards — only for
// accepted connections (status === 'accepted').

import { requireOnboarded }      from './auth.js';
import {
  getProfileByPhone,
  getMyConnections,
  getUsersByIds,
  getBlockedUserIds,
}                                from './supabase.js';
import { formatPhonePretty }     from './utils.js';

// ─── Bootstrap (standalone /connections.html path) ─────────────────────────

async function init() {
  const firebaseUser = await requireOnboarded(); // enforces profile completion
  if (!firebaseUser) return;
  const root = document.getElementById('hm-connections-root');
  if (!root) return;
  await runConnections(root, firebaseUser);
}

// ─── Public entry-point ────────────────────────────────────────────────────
// Called by dashboard.js when the Connections tab activates.

export async function runConnections(root, firebaseUser) {
  setLoading(root);
  wireBlockedListenerOnce(root);
  wireConnectionsChangedListenerOnce(root, firebaseUser);

  const { data: me, error: meErr } = await getProfileByPhone(firebaseUser.phoneNumber);
  if (meErr || !me) {
    renderError(root, 'Could not load your profile. Please sign in again.');
    return;
  }

  // Non-NEET UG users are redirected to maintenance (product focus is NEET UG).
  // Legacy users with null exam_type are treated as NEET UG.
  if (me.exam_type && me.exam_type !== 'NEET UG') {
    window.location.replace('/maintenance.html');
    return;
  }

  const [connsRes, blockedRes] = await Promise.all([
    getMyConnections(me.id),
    getBlockedUserIds(me.id),
  ]);
  if (connsRes.error) {
    renderError(root, connsRes.error.message || 'Could not load connections.');
    return;
  }

  // Filter out blocked users from all sections.
  const blockedSet = new Set((blockedRes.data || []).map(b => b.blocked_user_id));
  const allConns = (connsRes.data || []).filter(c => {
    const other = c.sender_id === me.id ? c.receiver_id : c.sender_id;
    return !blockedSet.has(other);
  });

  // Partition into the 3 sections.
  const received = allConns.filter(c => c.status === 'pending'  && c.receiver_id === me.id);
  const sent     = allConns.filter(c => c.status === 'pending'  && c.sender_id   === me.id);
  const accepted = allConns.filter(c => c.status === 'accepted');

  // Fetch profile data for all unique other-users across all sections.
  const otherIds = [...new Set([
    ...received.map(c => c.sender_id),
    ...sent.map(c => c.receiver_id),
    ...accepted.map(c => c.sender_id === me.id ? c.receiver_id : c.sender_id),
  ])];

  let byId = {};
  if (otherIds.length > 0) {
    const { data: users } = await getUsersByIds(otherIds);
    byId = Object.fromEntries((users || []).map(u => [u.id, u]));
  }

  root.innerHTML = `
    ${renderSection({
      title: 'Received requests', icon: '🤝',
      count: received.length,
      empty: 'No pending requests.',
      cards: received.map(c => receivedCard(byId[c.sender_id], c)),
    })}
    ${renderSection({
      title: 'Sent requests', icon: '📤',
      count: sent.length,
      empty: 'No pending sent requests.',
      cards: sent.map(c => sentCard(byId[c.receiver_id], c)),
    })}
    ${renderSection({
      title: 'Connected', icon: '🔗',
      count: accepted.length,
      empty: 'You have not connected with anyone yet.',
      cards: accepted.map(c => {
        const otherId = c.sender_id === me.id ? c.receiver_id : c.sender_id;
        return connectedCard(byId[otherId], c);
      }),
    })}
  `;
}

// ─── Event wiring (idempotent) ─────────────────────────────────────────────

let blockListenerWired = false;
function wireBlockedListenerOnce(root) {
  if (blockListenerWired) return;
  blockListenerWired = true;
  window.addEventListener('hm:user-blocked', (e) => {
    const id = e.detail?.userId;
    if (!id) return;
    root.querySelectorAll(`[data-conn-card-id="${id}"]`).forEach(c => c.remove());
  });
}

let connsChangedListenerWired = false;
function wireConnectionsChangedListenerOnce(root, firebaseUser) {
  if (connsChangedListenerWired) return;
  connsChangedListenerWired = true;
  window.addEventListener('hm:connections-changed', () => {
    runConnections(root, firebaseUser);
  });
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function setLoading(root) {
  root.innerHTML = `
    <div style="text-align:center;padding:var(--hm-space-7) var(--hm-space-5);">
      <div class="hm-loader__spinner" style="margin:0 auto;"></div>
      <p class="hm-text-muted" style="margin-top:var(--hm-space-3);">Loading connections…</p>
    </div>`;
}

function renderError(root, msg) {
  root.innerHTML = `
    <div class="hm-empty">
      <div class="hm-empty__icon" aria-hidden="true">⚠️</div>
      <h3>Something went wrong</h3>
      <p class="hm-text-muted">${esc(msg)}</p>
      <button type="button" class="hm-btn hm-btn--ghost" onclick="location.reload()">Try again</button>
    </div>`;
}

function renderSection({ title, icon, count, empty, cards }) {
  return `
    <section class="hm-conn-section">
      <header class="hm-conn-section__header">
        <h2 class="hm-conn-section__title">
          <span aria-hidden="true">${icon}</span> ${esc(title)}
          <span class="hm-conn-section__count">${count}</span>
        </h2>
      </header>
      ${cards.length === 0
        ? `<p class="hm-conn-section__empty hm-text-muted">${esc(empty)}</p>`
        : `<div class="hm-grid-cards">${cards.filter(Boolean).join('')}</div>`}
    </section>`;
}

// ─── Card builders ─────────────────────────────────────────────────────────

function basicHeader(user) {
  const name     = user.full_name || 'Unknown';
  const examLoc  = [user.exam_centre_district, user.exam_centre_state].filter(Boolean).join(', ');
  const location = examLoc || [user.district, user.state].filter(Boolean).join(', ') || '—';
  const color    = avatarColor(name);
  const initials = avatarInitials(name);
  return `
    <div class="hm-mate__head">
      <div class="hm-avatar"
           style="background:${color};color:#fff;flex-shrink:0;"
           aria-hidden="true">${esc(initials)}</div>
      <div style="min-width:0;">
        <p class="hm-mate__name">${esc(name)}</p>
        <p class="hm-mate__sub">${esc(location)}</p>
      </div>
    </div>
    <p class="hm-mate__center">🏛️ ${esc(user.exam_center || '—')}</p>
    ${travelChips(user.travel_mode, user.stay_plan) ? `<div class="hm-mate__chips">${travelChips(user.travel_mode, user.stay_plan)}</div>` : ''}
  `;
}

// 1. RECEIVED — sender sent me a request; Accept or Reject. No phone.
function receivedCard(user, conn) {
  if (!user) return '';
  return `
    <div class="hm-card hm-mate" data-conn-card-id="${esc(user.id)}">
      ${basicHeader(user)}
      <div class="d-flex gap-2"
           style="margin-top:auto;padding-top:var(--hm-space-3);border-top:1px solid var(--hm-border);">
        <button class="hm-btn hm-btn--primary hm-btn--sm" style="flex:1;"
          data-conn-action="accept" data-user-id="${esc(user.id)}" data-conn-id="${esc(conn.id)}">
          Accept
        </button>
        <button class="hm-btn hm-btn--ghost hm-btn--sm" style="flex:1;"
          data-conn-action="decline" data-user-id="${esc(user.id)}" data-conn-id="${esc(conn.id)}">
          Reject
        </button>
      </div>
    </div>`;
}

// 2. SENT — I sent a request, waiting. Pending badge + Cancel. No phone.
function sentCard(user, conn) {
  if (!user) return '';
  return `
    <div class="hm-card hm-mate" data-conn-card-id="${esc(user.id)}">
      ${basicHeader(user)}
      <div class="d-flex gap-2 align-items-center"
           style="margin-top:auto;padding-top:var(--hm-space-3);border-top:1px solid var(--hm-border);">
        <span class="hm-badge hm-badge--info"
              style="font-size:11px;flex:1;text-align:center;padding:6px 8px;">⌛ Pending</span>
        <button class="hm-btn hm-btn--ghost hm-btn--sm"
          data-conn-action="withdraw" data-user-id="${esc(user.id)}" data-conn-id="${esc(conn.id)}">
          Cancel
        </button>
      </div>
    </div>`;
}

// 3. CONNECTED — mutual accept. Full info + phone reveal + Block.
function connectedCard(user, conn) {
  if (!user) return '';
  const name        = user.full_name   || 'Unknown';
  const phone       = user.phone       || '';
  const phonePretty = phone ? formatPhonePretty(phone) : '—';
  const digits      = phone.replace(/\D/g, '');
  const waHref      = digits ? `https://wa.me/${digits}` : '';
  const telHref     = phone  ? `tel:${phone}` : '';
  const bio         = bioSnippet(user.bio);
  const connectedOn = formatConnectedDate(conn.updated_at || conn.created_at);

  return `
    <div class="hm-card hm-mate" data-conn-card-id="${esc(user.id)}">
      ${basicHeader(user)}
      ${bio ? `<p class="hm-mate__bio">${esc(bio)}</p>` : ''}

      <!-- Revealed contact -->
      <div class="hm-contact-revealed"
           style="margin-top:auto;padding-top:var(--hm-space-3);border-top:1px solid var(--hm-border);">
        <p class="hm-contact-revealed__number">${esc(phonePretty)}</p>
        <div class="hm-contact-revealed__links">
          ${waHref  ? `<a href="${esc(waHref)}" target="_blank" rel="noopener noreferrer"
                          class="hm-btn hm-btn--soft hm-btn--sm">💬 WhatsApp</a>` : ''}
          ${telHref ? `<a href="${esc(telHref)}"
                          class="hm-btn hm-btn--ghost hm-btn--sm">📞 Call</a>` : ''}
        </div>
        ${connectedOn ? `<p class="hm-text-subtle" style="font-size:var(--hm-text-xs);margin:8px 0 0;">✓ ${esc(connectedOn)}</p>` : ''}
      </div>

      <!-- Block action -->
      <div style="margin-top:var(--hm-space-2);text-align:right;">
        <button class="hm-modal__block-btn" type="button"
                data-conn-action="block" data-user-id="${esc(user.id)}"
                aria-label="Block ${esc(name)}">🚫 Block user</button>
      </div>
    </div>`;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

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

function formatConnectedDate(iso) {
  if (!iso) return '';
  return 'Connected on ' + new Date(iso).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function esc(str) {
  return String(str ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

document.addEventListener('DOMContentLoaded', init);
