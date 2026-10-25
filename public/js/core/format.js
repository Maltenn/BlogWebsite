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
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
  return when(ms);
}
// the reader's own calendar day, for the astrology endpoints
export function today() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `date=${date}&tz=${d.getTimezoneOffset()}`;
}
