// The site's public contact address: the one place it is read. CONTACT_EMAIL (wrangler.jsonc → vars, a public setting,
// not a secret) is what the legal pages show to people with questions and to anyone, member or not, who needs a
// moderator: a Take It Down request, a report about someone they can't reach. Unset, or not an email address: null, and
// the pages simply don't show one (/api/me carries it as `contact`, so the apps, which bundle the pages, show the same).
// Nothing here ever makes an address up.
const EMAIL = /^[^\s@<>()[\]\,;:"]+@[^\s@<>()[\]\,;:"]+\.[A-Za-z]{2,}$/;

export function contactEmail(env) {
  const v = String((env && env.CONTACT_EMAIL) || '').trim();
  return v.length <= 254 && EMAIL.test(v) ? v : null;
}
