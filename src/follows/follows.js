// Following. It's one-way: I follow you, you may follow me back, and two people who follow each other are friends.
// An open profile takes a follow at once; a private one (follow_policy "approve") gets a request to accept or decline.
// Every write answers with the new { relation } (the same shape as the profile's). The person followed hears about it
// (follow, or follow_request), and so does somebody whose request is accepted (follow_accepted).
import { fail, json } from '../shared/http.js';
import { REF_COLS, ref, refOf, visibleUser, followOf, canSeePosts, relationTo, blockedEither, limit, isOnline, NOT_BLOCKED, LISTS } from '../shared/db.js';
import { notify } from '../shared/notify.js';

// the person named in the URL, who has to be somebody else
async function other(c, message = 'that\'s you!') {
  const u = await visibleUser(c, c.params.name);
  if (u.id === c.user.id) fail(400, message);
  return u;
}

// POST /api/follows/:name — follow them, or ask to if they approve their followers
export async function followUser(c) {
  const u = await other(c, 'you can\'t follow yourself. (we checked.)');
  if (u.banned) fail(404, 'nobody by that name lives here.');
  if (await blockedEither(c.env, c.user.id, u.id)) fail(403, 'you can\'t follow this person.');
  if (!await followOf(c.env, c.user.id, u.id)) {
    await limit(c, 'follow:' + c.user.id, [[20, 3600000], [100, 86400000]], 'that\'s a lot of following. take a breather.');
    const open = u.follow_policy !== 'approve';
    await c.env.DB.batch([
      notify(c, open ? 'follow' : 'follow_request', [u.id], null, 'NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ?1 AND followee_id = t.value)'),
      c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, status, created, accepted) VALUES (?, ?, ?, ?, ?)')
        .bind(c.user.id, u.id, open ? 'accepted' : 'pending', c.now, open ? c.now : null),
    ]);
  }
  return json({ relation: await relationTo(c, u) });
}

// DELETE /api/follows/:name — unfollow, or take back my request (and the notification about it)
export async function unfollowUser(c) {
  const u = await other(c);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(c.user.id, u.id),
    c.env.DB.prepare('DELETE FROM notifications WHERE actor_id = ? AND user_id = ? AND kind IN (\'follow\', \'follow_request\')').bind(c.user.id, u.id),
  ]);
  return json({ relation: await relationTo(c, u) });
}

// POST /api/followers/:name — accept their request to follow me
export async function acceptFollower(c) {
  const u = await other(c);
  const [, r] = await c.env.DB.batch([
    notify(c, 'follow_accepted', [u.id], null, 'EXISTS (SELECT 1 FROM follows WHERE follower_id = t.value AND followee_id = ?1 AND status = \'pending\')'),
    c.env.DB.prepare('UPDATE follows SET status = \'accepted\', accepted = ? WHERE follower_id = ? AND followee_id = ? AND status = \'pending\'')
      .bind(c.now, u.id, c.user.id),
  ]);
  if (!r.meta.changes && !await followOf(c.env, u.id, c.user.id)) fail(404, `${u.name} hasn't asked to follow you.`);
  return json({ relation: await relationTo(c, u) });
}

// DELETE /api/followers/:name — stop them following me, or decline their request
export async function removeFollower(c) {
  const u = await other(c);
  await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(u.id, c.user.id).run();
  return json({ relation: await relationTo(c, u) });
}

// GET /api/requests — people asking to follow me, and my requests still waiting on others
export async function requests(c) {
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('x', '')}, f.follower_id, f.created
    FROM follows f JOIN users x ON x.id = CASE WHEN f.follower_id = ?1 THEN f.followee_id ELSE f.follower_id END
    WHERE (f.follower_id = ?1 OR f.followee_id = ?1) AND f.status = 'pending' AND x.banned = 0 AND ${NOT_BLOCKED('x.id')}
    ORDER BY f.created DESC LIMIT 200`).bind(c.user.id).all();
  const row = r => ({ user: ref(r), created: r.created });
  return json({
    incoming: results.filter(r => r.follower_id !== c.user.id).map(row),
    outgoing: results.filter(r => r.follower_id === c.user.id).map(row),
  });
}

// GET /api/users/:name/followers | following | friends — up to 500 people, newest first. A private profile's lists
// are only for its followers (and the owner and moderators).
async function listOf(c, which) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('x', '')}, x.last_seen FROM ${LISTS[which].from}
    ORDER BY ${LISTS[which].since} DESC LIMIT 500`).bind(c.user ? c.user.id : 0, u.id).all();
  return json({ user: refOf(u), people: results.map(r => ({ ...ref(r), online: isOnline(r, c.now) })) });
}

export const followersOf = c => listOf(c, 'followers');
export const followingOf = c => listOf(c, 'following');
export const friendsOf = c => listOf(c, 'friends');
