// Sending email (only "reset your password" for now), through Resend's HTTP API when RESEND_API_KEY and MAIL_FROM are
// set. Without them: on a local dev server the message is printed to the terminal instead; on a real server the
// caller is told email isn't set up (it never pretends a message went out).
import { fail } from './http.js';

export function mailReady(env, url) {
  return !!(env.RESEND_API_KEY && env.MAIL_FROM) || isLocal(url);
}

const isLocal = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

export async function sendMail(c, { to, subject, text }) {
  if (c.env.RESEND_API_KEY && c.env.MAIL_FROM) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.env.MAIL_FROM, to: [to], subject, text }),
    });
    if (!r.ok) {
      console.error('email failed:', r.status, (await r.text()).slice(0, 300));
      fail(502, 'we couldn\'t send the email just now. try again in a few minutes.');
    }
    return;
  }
  if (isLocal(c.url)) {
    console.log(`[mail] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  fail(503, 'email isn\'t set up on this server yet, so password resets don\'t work. ask a moderator for help.');
}
