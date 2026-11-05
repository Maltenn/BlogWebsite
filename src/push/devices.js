// The phones and tablets signed in to the apps: the app registers itself (and its push token) after signing in, Settings
// lists the devices, and revoking one signs it out. A device is tied to the session it signed in with (devices.token_hash),
// so the session ending takes the device with it. All three routes are the member's own business, so none is held back by
// the write gate (src/index.js).
import { fail, json, readBody, int } from '../shared/http.js';
import { line } from '../shared/text.js';
import { limit } from '../shared/db.js';
import { signOut } from '../shared/live.js';

const PROVIDER = { ios: 'apns', android: 'fcm' };
const TOKEN = /^[\w:.\-/+=]{8,4096}$/;          // (an APNs token is 64 hex characters; an FCM one around 160 of these)

const out = (d, mine) => ({
  id: d.id, platform: d.platform, label: d.label, push: d.push_token != null,
  created: d.created, lastSeen: d.last_seen, current: d.token_hash === mine,
});

// GET /api/me/devices — { devices }: where I'm signed in through an app, the one asking marked `current`
export async function myDevices(c) {
  const { results } = await c.env.DB.prepare(`SELECT d.* FROM devices d JOIN sessions s ON s.token_hash = d.token_hash
    WHERE d.user_id = ? AND d.revoked = 0 AND s.expires > ? ORDER BY d.last_seen DESC, d.id DESC`).bind(c.user.id, c.now).all();
  return json({ devices: results.map(d => out(d, c.user.tokenHash)) });
}

// POST /api/me/devices { platform: 'ios' | 'android', label, pushToken? } — this device, for the session it is using:
// made the first time, updated after. pushToken: the APNs device token or FCM registration token; left out, the one we
// have stays; null, it's forgotten (notifications turned off). A token belongs to one device: giving it here takes it
// from any other row. → { device }
export async function registerDevice(c) {
  const b = await readBody(c.req);
  if (!PROVIDER[b.platform]) fail(400, 'the platform is ios or android.');
  const label = line(b.label, 60) || (b.platform === 'ios' ? 'iPhone' : 'Android phone');
  const setToken = 'pushToken' in b;
  const token = b.pushToken == null ? null : String(b.pushToken).trim();
  if (token != null && !TOKEN.test(token)) fail(400, 'that push token doesn\'t look right.');
  await limit(c, 'device:' + c.user.id, [[30, 3600000]], 'too many device changes. try again later.');
  const hash = c.user.tokenHash;
  const [, , row] = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO devices (user_id, token_hash, platform, label, push_token, push_provider, created, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT (token_hash) DO UPDATE SET platform = ?3, label = ?4, last_seen = ?7,
        push_token = CASE WHEN ?8 THEN ?5 ELSE push_token END, push_provider = CASE WHEN ?8 THEN ?6 ELSE push_provider END`)
      .bind(c.user.id, hash, b.platform, label, token, token ? PROVIDER[b.platform] : null, c.now, setToken ? 1 : 0),
    c.env.DB.prepare('UPDATE devices SET push_token = NULL, push_provider = NULL WHERE push_token = ?1 AND token_hash != ?2 AND ?1 IS NOT NULL').bind(token, hash),
    c.env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(hash),
  ]);
  return json({ device: out(row.results[0], hash) });
}

// DELETE /api/me/devices/:id — sign that device out: its session is deleted, and its live sockets close. The device
// asking may revoke itself. → { ok, current }
export async function revokeDevice(c) {
  const id = int(c.params.id, 0);
  const d = id > 0 && await c.env.DB.prepare('SELECT id, token_hash FROM devices WHERE id = ? AND user_id = ? AND revoked = 0').bind(id, c.user.id).first();
  if (!d) fail(404, 'that device isn\'t there.');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE devices SET revoked = 1, push_token = NULL, push_provider = NULL WHERE id = ?').bind(d.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(d.token_hash),
  ]);
  await signOut(c.env, c.user.id, { only: d.token_hash });
  return json({ ok: true, current: d.token_hash === c.user.tokenHash });
}
