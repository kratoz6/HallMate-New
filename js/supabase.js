import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE } from './config.js';

export const supabase = createClient(SUPABASE.url, SUPABASE.anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-client-info': 'hallmate-web/0.1.0' },
  },
});

export function toUiError(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return null;
  const msg = err.message || err.error_description || err.hint || fallback;
  return { code: err.code || 'unknown', message: msg };
}

export async function query(builder) {
  try {
    const { data, error } = await builder;
    return { data, error: error ? toUiError(error) : null };
  } catch (err) {
    return { data: null, error: toUiError(err) };
  }
}

export function from(table) {
  return supabase.from(table);
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

// Check if a user with this phone exists and whether profile is complete.
export function getUserByPhone(phone) {
  return query(
    from('users').select('id, profile_completed').eq('phone', phone).maybeSingle()
  );
}

// Fetch the full profile row for the current user (looked up by phone).
export function getProfileByPhone(phone) {
  return query(
    from('users')
      .select(
        'id, phone, full_name, gender, state, district, ' +
        'exam_centre_state, exam_centre_district, exam_center, exam_type, ' +
        'college, travel_mode, stay_plan, bio, ' +
        'profile_completed, is_profile_paused, created_at'
      )
      .eq('phone', phone)
      .maybeSingle()
  );
}

// Insert or update a user record (conflict key: phone).
export function upsertUser(payload) {
  return query(
    from('users').upsert(payload, { onConflict: 'phone' }).select('id').single()
  );
}

// Fetch all users with completed, non-paused profiles for the dashboard feed.
// Paused users are excluded. Old users without is_profile_paused (null) still appear.
export function getAllUsers() {
  return query(
    from('users')
      .select('id, full_name, gender, state, district, exam_centre_state, exam_centre_district, exam_center, phone, travel_mode, stay_plan, bio, created_at')
      .eq('profile_completed', true)
      .or('is_profile_paused.is.null,is_profile_paused.eq.false')
      .order('created_at', { ascending: false })
  );
}

// Set or clear the is_profile_paused flag for the current user.
export function setPausedStatus(phone, paused) {
  return query(
    from('users')
      .update({ is_profile_paused: paused })
      .eq('phone', phone)
      .select('id')
      .single()
  );
}

// Delete all user data: connections first (FK), then the profile row itself.
export async function deleteUserData(userId) {
  const { error: connErr } = await query(
    from('connections')
      .delete()
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
  );
  if (connErr) return { error: connErr };
  return query(from('users').delete().eq('id', userId));
}

// ─── Connection helpers ───────────────────────────────────────────────────────

export function getMyConnections(userId) {
  return query(
    from('connections')
      .select('id, sender_id, receiver_id, status')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .in('status', ['pending', 'accepted', 'rejected'])
  );
}

// Fetch only ACCEPTED connections for the connections page.
// Returns rows with sender_id + receiver_id so the caller can derive the
// "other" user's id (whichever side is NOT the current user).
export function getAcceptedConnections(userId) {
  return query(
    from('connections')
      .select('id, sender_id, receiver_id')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq('status', 'accepted')
  );
}

// Batch-fetch user profiles by an array of ids.
// Includes enrichment fields so connections cards can show travel/stay context.
export function getUsersByIds(ids) {
  if (!ids || ids.length === 0) return Promise.resolve({ data: [], error: null });
  return query(
    from('users')
      .select('id, full_name, state, district, exam_centre_state, exam_centre_district, exam_center, phone, travel_mode, stay_plan, bio')
      .in('id', ids)
  );
}

// ─── Block helpers ────────────────────────────────────────────────────────────

/** Returns { blocked_user_id }[] for every user blocked by userId. */
export function getBlockedUserIds(userId) {
  return query(
    from('blocked_users')
      .select('blocked_user_id')
      .eq('blocker_user_id', userId)
  );
}

/** Full block list with reason + timestamps — for the Blocked Users page. */
export function getBlockedList(userId) {
  return query(
    from('blocked_users')
      .select('id, blocked_user_id, reason, created_at')
      .eq('blocker_user_id', userId)
      .order('created_at', { ascending: false })
  );
}

export function blockUser(blockerUserId, blockedUserId, reason = null) {
  return query(
    from('blocked_users')
      .insert({
        blocker_user_id: blockerUserId,
        blocked_user_id: blockedUserId,
        reason: reason && String(reason).trim() ? String(reason).trim() : null,
      })
      .select('id')
      .single()
  );
}

export function unblockUser(blockerUserId, blockedUserId) {
  return query(
    from('blocked_users')
      .delete()
      .eq('blocker_user_id', blockerUserId)
      .eq('blocked_user_id', blockedUserId)
  );
}

export function sendConnectionRequest(senderId, receiverId) {
  return query(
    from('connections')
      .insert({ sender_id: senderId, receiver_id: receiverId, status: 'pending' })
      .select('id')
      .single()
  );
}

export function respondToRequest(connectionId, status) {
  return query(
    from('connections')
      .update({ status })
      .eq('id', connectionId)
      .select('id')
      .single()
  );
}

export function deleteRequest(connectionId) {
  return query(
    from('connections').delete().eq('id', connectionId)
  );
}
