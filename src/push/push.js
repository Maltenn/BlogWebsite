// Push notifications to the phones (docs/mobile/contract.md §9). Two ways in, one way out:
//   · a notification row (written by every feature, inside its own batch) puts a line in `push_outbox` by a trigger
//     (migrations/0012_push_shown.sql, first 0010_devices.sql), and the cron, once a minute, sends what is waiting (drainPush);
//   · a chat message, where a minute is too slow, is pushed straight from sendChatMessage (pushChat, in waitUntil).
// Everything is silent when the secrets are unset (pushReady), like mailReady: nothing is sent, and the outbox is kept
// empty. Each line is sent to every device of the person that has a push token and a live session: APNs for iOS, FCM
// for Android (apns.js, fcm.js). A token the service says is dead is forgotten.
//
// INVARIANT: A PUSH NEVER CARRIES WHAT A MEMBER WROTE. No message text, no post or comment excerpt, no group or board
// title, no profile text, not even "just the first 40 characters". A push is handed to Apple's and Google's servers, which
// read it in the clear; whatever is in it is disclosed to them, has to be declared on both stores' privacy forms, and
// cannot be taken back. A push says who and what kind ("kat sent you a message", "ann liked your post") and the app
// fetches the rest itself, over its own session, when it is opened. The sender's screen name is the only member-chosen
// text allowed, and it is the same name anyone sees. Nor does a push say anything about moderation (strikes, appeals).
// The outbox's lines are fixed phrases written by migrations/0012_push_shown.sql; pushChat below does the same for chats.
// Pinned by test/push.test.mjs ("a push never carries member-written text"). Do not "improve" this by adding a preview.
import { apnsReady, sendApns } from './apns.js';
import { fcmReady, sendFcm } from './fcm.js';
import { SHOWN } from '../shared/notify.js';

export const pushReady = env => apnsReady(env) || fcmReady(env);

// THE LIMIT THIS RESPECTS. A Worker on the free plan may make 50 subrequests to the outside world in one invocation
// (docs/decisions/004), and every push is one `fetch` to APNs or FCM (plus one to Google for an access token on a cold
// FCM run). So the cap that matters is on *sends* (a line for a person with two phones is two), not on lines: the old
// "20 lines" was 20 sends only for people with one phone and could have been 40 or more. A run makes at most SENDS sends;
// 45 leaves one for the FCM token exchange and four to spare. The database work is a constant handful of batches
// (D1's own limit is 50 queries an invocation on the free plan, 1000 on the paid one). On the paid plan, where the limit
// is 10,000 subrequests, set the variable PUSH_SENDS_PER_RUN (say 500) and the same code does more per minute.
const SENDS = 45;
const sendsPerRun = env => Math.max(1, Math.min(Number(env.PUSH_SENDS_PER_RUN) || SENDS, 5000));
// Fairness: lines are taken round-robin over people (everybody's oldest line, then everybody's second, ...), at most
// PER_USER a person per run, so one busy member's hundred likes cannot keep anybody else's line waiting. Lines nobody
// could be told (no device left) cost no send, so more lines than sends are looked at.
const PER_USER = 10;
const lookAt = env => Math.max(50, sendsPerRun(env) * 2);
const GIVE_UP = 5;                             // attempts, then the line is dropped
const STALE_MS = 86400000;                     // a day-old "someone liked your post" is no use

// (the `kind` rides in the payload too, so it is part of what Apple and Google read: a strike or an appeal goes out as a
// plain "notification", the same as the body and address say)
const wireKind = kind => (/^ai_/.test(kind) ? 'notification' : kind);

const send = (env, d, msg, now) => (d.push_provider === 'apns' ? (apnsReady(env) ? sendApns(env, d.push_token, msg, now) : 'skip')
  : d.push_provider === 'fcm' ? (fcmReady(env) ? sendFcm(env, d.push_token, msg, now) : 'skip') : 'drop');

// Sends `msg` ({ title, body, url, kind }) to each of `devices` ([{ id, push_token, push_provider }]), forgetting the
// tokens that are dead. → [[device, 'ok' | 'gone' | 'retry' | 'drop' | 'skip'], ...]: 'retry' is the only answer to try again.
async function deliver(env, devices, msg, now) {
  const results = await Promise.all(devices.map(async d => [d, await send(env, d, msg, now)]));
  const dead = results.filter(([, r]) => r === 'gone').map(([d]) => d);
  if (dead.length) {
    await env.DB.batch(dead.map(d => env.DB.prepare('UPDATE devices SET push_token = NULL, push_provider = NULL WHERE id = ? AND push_token = ?').bind(d.id, d.push_token)))
      .catch(e => console.error('push: forgetting dead tokens failed:', (e && e.stack) || e));
  }
  return results;
}

// The devices of these users that can be pushed to: a push token, not revoked, and a session that is still good.
const DEVICES = `SELECT d.id, d.user_id, d.push_token, d.push_provider FROM devices d JOIN sessions s ON s.token_hash = d.token_hash
  WHERE d.user_id IN (SELECT value FROM json_each(?1)) AND d.push_token IS NOT NULL AND d.revoked = 0 AND s.expires > ?2`;

// Each person's oldest PER_USER lines, numbered (rn) within the person: the lines the cron may take this minute.
const NEXT = `SELECT id, user_id, kind, title, body, url, notification_id,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id) AS rn FROM push_outbox`;
// SQL: the notification of line `ob` is still one its person is shown, by the very rule the Notifications tab uses
// (SHOWN: not hidden, deleted, blocked, banned, declined or out of reach any more). SHOWN is written for one person, ?1;
// here the person is the line's.
const STILL_SHOWN = `EXISTS (SELECT 1 FROM ${SHOWN.replace(/\?1(?!\d)/g, 'ob.user_id')} AND n.id = ob.notification_id)`;

// The cron, once a minute: send the lines waiting in the outbox.
//  1. Lines out of tries, a day old, or whose notification is gone leave; so do those among the next ones whose
//     notification would no longer show (STILL_SHOWN), so a like that was hidden or blocked after it was written (R6) is
//     never pushed. (This is checked in the same batch that picks the lines, and again for nothing later: what changes
//     during the few seconds of the sends themselves is not chased.)
//  2. The lines are picked round-robin over people (NEXT) and the devices each still has to be told are counted out of
//     the sends this run may make (SENDS). A device a line already reached (push_sent) is not sent to again.
//  3. Lines are claimed by counting an attempt first, so a run that dies halfway doesn't send twice in a row, and a line
//     that keeps failing is dropped after GIVE_UP tries. A line whose every device was dealt with is deleted; one with a
//     device that answered "try again later" stays, remembering the devices that did get it.
export async function drainPush(env, now) {
  const DB = env.DB;
  // Not set up: nothing can be sent, so nothing waits (switching push on later doesn't flood anyone with old news)
  if (!pushReady(env)) { await DB.prepare('DELETE FROM push_outbox').run(); return; }
  const budget = sendsPerRun(env);
  const [, , { results: lines }] = await DB.batch([
    DB.prepare('DELETE FROM push_outbox WHERE attempts >= ?1 OR created < ?2 OR notification_id IS NULL').bind(GIVE_UP, now - STALE_MS),
    DB.prepare(`DELETE FROM push_outbox WHERE id IN (SELECT ob.id FROM (${NEXT}) ob WHERE ob.rn <= ${PER_USER} AND NOT ${STILL_SHOWN})`),
    DB.prepare(`SELECT id, user_id, kind, title, body, url FROM (${NEXT}) WHERE rn <= ${PER_USER} ORDER BY rn, id LIMIT ${lookAt(env)}`),
  ]);
  if (!lines.length) return;
  const [{ results: devices }, { results: reached }] = await DB.batch([
    DB.prepare(DEVICES).bind(JSON.stringify([...new Set(lines.map(l => l.user_id))]), now),
    DB.prepare('SELECT outbox_id, device_id FROM push_sent WHERE outbox_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(lines.map(l => l.id))),
  ]);
  const had = new Set(reached.map(r => `${r.outbox_id}/${r.device_id}`));
  let left = budget;
  const finished = [];                           // lines with nobody left to tell
  const work = [];                               // { line, todo: devices to send to now, whole: that is all of them }
  for (const l of lines) {
    const todo = devices.filter(d => d.user_id === l.user_id && !had.has(`${l.id}/${d.id}`));
    if (!todo.length) finished.push(l.id);       // (no device left to tell, or every one told already: nothing to wait for)
    else if (left) {
      const now_ = todo.slice(0, left);
      left -= now_.length;
      work.push({ line: l, todo: now_, whole: now_.length === todo.length });
    }                                            // (else: no sends left this minute; it keeps its place for the next)
  }
  if (work.length) {
    await DB.prepare('UPDATE push_outbox SET attempts = attempts + 1 WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(work.map(w => w.line.id))).run();
    await Promise.all(work.map(async w => { w.results = await deliver(env, w.todo, { ...w.line, kind: wireKind(w.line.kind) }, now); }));
    const handled = [];                          // [line, device] pairs that need no second try
    for (const w of work) {
      const retry = w.results.some(([, r]) => r === 'retry');
      if (w.whole && !retry) finished.push(w.line.id);
      else for (const [d, r] of w.results) if (r !== 'retry') handled.push([w.line.id, d.id]);
    }
    // (joined to both tables, so a device or a line that went during the sends doesn't fail the batch)
    const writes = [];
    if (handled.length) {
      writes.push(DB.prepare(`INSERT OR IGNORE INTO push_sent (outbox_id, device_id)
        SELECT ob.id, d.id FROM json_each(?1) j JOIN push_outbox ob ON ob.id = json_extract(j.value, '$[0]') JOIN devices d ON d.id = json_extract(j.value, '$[1]')`).bind(JSON.stringify(handled)));
    }
    if (finished.length) writes.push(DB.prepare('DELETE FROM push_outbox WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(finished)));
    if (writes.length) await DB.batch(writes);
  } else if (finished.length) {
    await DB.prepare('DELETE FROM push_outbox WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(finished)).run();
  }
}

// A chat message, pushed at once to the other joined members of the conversation who have a device (not people with a
// block either way: `skip`, user ids). Called as c.ctx.waitUntil(...) after the message is stored and told live. It says
// only who sent it ("kat" / "sent you a message"): never the message (see the invariant at the top), and not the group's
// name either, which a member chose. (A huge group is cut at the same number of sends a cron run may make, the free plan's
// subrequest limit; nobody is retried: the message is in the chat when they open the app.)
export async function pushChat(env, { chatId, kind, from, skip = [], now = Date.now() }) {
  const { results: devices } = await env.DB.prepare(`SELECT d.id, d.user_id, d.push_token, d.push_provider
    FROM devices d JOIN sessions s ON s.token_hash = d.token_hash
    JOIN conversation_members cm ON cm.user_id = d.user_id AND cm.conversation_id = ?1 AND cm.status = 'joined'
    WHERE d.user_id != ?2 AND d.user_id NOT IN (SELECT value FROM json_each(?3)) AND d.push_token IS NOT NULL AND d.revoked = 0 AND s.expires > ?4
    ORDER BY d.id LIMIT ?5`)
    .bind(chatId, from.id, JSON.stringify(skip), now, sendsPerRun(env)).all();
  if (!devices.length) return;
  await deliver(env, devices, {
    kind: 'chat_message',
    title: from.name,
    body: kind === 'dm' ? 'sent you a message' : 'sent a message in a group chat',
    url: `/messages/${chatId}`,
  }, now);
}
