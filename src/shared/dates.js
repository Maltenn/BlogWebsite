// Birthdays. Everyone gives one at sign-up: it is how OurSpace checks they are old enough, and where their star sign
// comes from. It is private: other people only ever see the age (if the person allows it) and the sign.
import { fail } from './http.js';

// 'YYYY-MM-DD' → { y, m, d } for a real calendar date, or null
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export const iso = ({ y, m, d }) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// whole years between a birthday and `now` (UTC calendar dates)
export function ageOn(birth, now = Date.now()) {
  const b = typeof birth === 'string' ? parseDate(birth) : birth;
  if (!b) return null;
  const t = new Date(now);
  let age = t.getUTCFullYear() - b.y;
  if (t.getUTCMonth() + 1 < b.m || (t.getUTCMonth() + 1 === b.m && t.getUTCDate() < b.d)) age--;
  return age;
}

// A birthday from a sign-up form, checked. Too young → 403 (the caller also sets a cookie so the form can't simply be
// re-tried with another year, which is what the FTC's guidance on age screens asks for).
export function checkBirthday(input, minAge, now = Date.now()) {
  const b = parseDate(input);
  if (!b) fail(400, 'enter your birthday (month, day and year).');
  const age = ageOn(b, now);
  if (age < 0 || b.y < 1900) fail(400, 'that birthday doesn\'t look right.');
  if (age > 120) fail(400, 'that birthday doesn\'t look right.');
  return { birthdate: iso(b), age, tooYoung: age < minAge };
}
