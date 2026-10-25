/* core/format.js — dates and times, printed the 2006 way. */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Oct 23 2026 7:14 PM" — the way the real thing printed it
export function when(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} ${clock(ms)}`;
}
export function clock(ms) {
  const d = new Date(ms);
  let hr = d.getHours();
  const ap = hr >= 12 ? 'PM' : 'AM';
  hr = hr % 12 || 12;
  return `${hr}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}
export const dayName = ms => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
// "just now", "5 minutes ago", "1 hour ago", "2 days ago", then the date
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const n = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;
  if (s < 90) return 'just now';
  if (s < 3600) return n(Math.round(s / 60), 'minute');
  if (s < 86400) return n(Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return n(Math.round(s / 86400), 'day');
  return when(ms);
}
// the reader's own calendar day, for the astrology endpoints
export function today() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `date=${date}&tz=${d.getTimezoneOffset()}`;
}

/* ---- feed and blog ---- */
// "Tue 14 Oct" — the heading between days in the feed
export const dayLabel = ms => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
// "October 2026" — the headings in a blog's index
export const monthLabel = ms => new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
// "Oct 25" (with the year when it isn't this year)
export function shortDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}` + (d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear());
}
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
// "6 min read" (about 220 words a minute)
export function readTime(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220)) + ' min read';
}
