// The Moderation page's child-safety wording and its photo buttons, on the pretend browser (helpers/fake-dom.mjs): what
// the banner may claim (a moderator acts on it under a clock), an image of someone who may be under 18 is never sent down
// the Take It Down path, and a held photo's buttons say what they will do. What the server enforces is in
// test/child-safety.test.mjs; this is what a moderator reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, answer } from './helpers/fake-dom.mjs';

const dom = installDom();
const { S } = await import('../public/js/core/state.js');
const { renderAdmin } = await import('../public/js/pages/admin.js');
const { moderatePhoto } = await import('../public/js/widgets/photoqueue.js');

// (a moderator's action reloads the page: the router draws into this)
const main = document.createElement('div');
main.setAttribute('id', 'ms-content');
document.body.append(main);

const person = (id, name) => ({ id, name, avatar: '/assets/avatars/preset_01.png' });
const photo = (id, more) => ({ id, url: `/media/${id}.png`, width: 40, height: 30, alt: '', hidden: false, held: false, gone: false, ...more });
const report = more => ({ id: 1, type: 'post', targetId: 9, reason: 'other', details: '', snapshot: { kind: 'status', author: 'kat', body: 'x', media: [] }, created: Date.now() - 3600000,
  status: 'open', resolution: null, resolvedAt: null, resolver: null, reporter: person(2, 'pal'), target: person(3, 'kat'), targetBanned: false, targetHidden: false,
  targetReports: 1, intimate: false, deadline: null, preserved: 0, ...more });

async function page(reports) {
  S.me = { id: 1, name: 'me', avatar: '/assets/avatars/preset_01.png', isAdmin: true };
  const calls = [];
  dom.onFetch = (method, path, body) => {
    calls.push(`${method} ${path} ${body ? JSON.stringify(body) : ''}`.trim());
    if (path.startsWith('/admin/reports?')) return answer(200, { reports });
    if (path === '/admin/log') return answer(200, { log: [] });
    if (path.startsWith('/admin/board-requests')) return answer(200, { requests: [] });
    if (path.startsWith('/admin/media?')) return answer(200, { media: [], next: null });
    if (method === 'POST') return answer(200, { ok: true });
    return answer(200, { held: [], alerts: [], appeals: [], scans: [] });
  };
  const root = document.createElement('div');
  await renderAdmin(root);
  await dom.settle(); await dom.settle();
  return { root, calls, clock: root.querySelector('.mod-clock') };
}
const button = (root, re) => root.querySelectorAll('button').find(b => re.test(b.textContent));

test('H1: a csam report says its photos are held only when they are', async () => {
  const held = await page([report({ reason: 'csam', deadline: Date.now() + 3600000, snapshot: { kind: 'status', author: 'kat', body: 'x', media: [photo(5, { hidden: true, held: true }), photo(6, { hidden: true, held: true })] } })]);
  assert.match(held.clock.textContent, /its photos are held/);
  const one = await page([report({ reason: 'csam', deadline: Date.now() + 3600000, snapshot: { kind: 'status', author: 'kat', body: 'x', media: [photo(5, { hidden: true, held: true })] } })]);
  assert.match(one.clock.textContent, /its photo is held/);
  for (const r of [
    report({ reason: 'csam', deadline: Date.now() + 3600000 }),                                                                              // a post with no photos
    report({ reason: 'csam', deadline: Date.now() + 3600000, type: 'message', snapshot: { author: 'kat', body: 'x' } }),                      // a message
    report({ reason: 'csam', deadline: Date.now() + 3600000, type: 'user', snapshot: { name: 'kat' } }),                                      // a preset picture
    report({ reason: 'csam', deadline: Date.now() + 3600000, snapshot: { kind: 'status', author: 'kat', body: 'x', media: [photo(5, { gone: true })] } }),   // removed since
    report({ reason: 'csam', deadline: Date.now() + 3600000, snapshot: { kind: 'status', author: 'kat', body: 'x', media: [photo(5)] } }),                     // an override put it back
  ]) {
    const { clock } = await page([r]);
    assert.doesNotMatch(clock.textContent, /its photos? (is|are) held/, r.type);
    assert.match(clock.textContent, /no photo is held/);
    assert.match(clock.textContent, /NCMEC/, 'the duty to report doesn\'t depend on a photo');
  }
});

test('H4: a report marked intimate tells the moderator what to do if the person may be under 18, before it says remove', async () => {
  const { clock, root } = await page([report({ intimate: true, deadline: Date.now() + 3600000 })]);
  const said = clock.textContent;
  assert.match(said, /under 18/);
  assert.match(said, /NCMEC/);
  assert.match(said, /don't remove/i);
  assert.ok(said.indexOf('under 18') < said.indexOf('remove the photo'), 'the child comes first');
  assert.match(said, /adult/, 'remove is for an adult');
  assert.ok(button(root, /may be under 18/), 'with a button that does it');
});

test('H4: "may be under 18" makes it a child-safety report on the server, with a note', async () => {
  globalThis.prompt = () => 'looks 15';
  const { root, calls } = await page([report({ id: 7 })]);
  button(root, /may be under 18/).click();
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('POST /admin/reports/7 {"action":"csam","note":"looks 15"}'), calls.join('\n'));
  assert.equal(button((await page([report({ reason: 'csam', deadline: 1 })])).root, /may be under 18/), undefined, 'not on one that already is');
});

test('H2: a reported photo\'s button says what it is now: hidden ones offer Unhide, and a held one says so', async () => {
  const { root } = await page([report({ snapshot: { kind: 'status', author: 'kat', body: 'x', media: [photo(5, { hidden: true }), photo(6), photo(7, { hidden: true, held: true }), photo(8, { gone: true })] } })]);
  const cells = root.querySelectorAll('.mod-photo');
  assert.match(cells[0].textContent, /Unhide photo/);
  assert.match(cells[1].textContent, /Hide photo/);
  assert.doesNotMatch(cells[1].textContent, /Unhide/);
  assert.match(cells[2].textContent, /held for a child-safety report/);
  assert.doesNotMatch(cells[0].textContent, /held for a child-safety report/);
  assert.match(root.querySelectorAll('.mod-photos')[0].textContent, /photo removed/);
  assert.equal(cells.length, 3, 'a removed one has no buttons left to press');
});

test('H2: dismissing a csam report asks why, and a closed one that still holds can be released', async () => {
  let asked = 0;
  globalThis.prompt = () => { asked++; return 'a sunset'; };
  const { root, calls } = await page([report({ id: 8, reason: 'csam', deadline: Date.now() + 3600000 })]);
  button(root, /dismiss/).click();
  await dom.settle(); await dom.settle();
  assert.equal(asked, 1);
  assert.ok(calls.includes('POST /admin/reports/8 {"action":"dismiss","note":"a sunset"}'), calls.join('\n'));
  globalThis.prompt = () => '   ';
  const empty = await page([report({ id: 9, reason: 'csam', deadline: Date.now() + 3600000 })]);
  button(empty.root, /dismiss/).click();
  await dom.settle(); await dom.settle();
  assert.ok(!empty.calls.some(c => c.startsWith('POST /admin/reports/9')), 'no note, nothing sent');
  globalThis.prompt = () => 'the year is over';
  const closed = await page([report({ id: 10, reason: 'csam', status: 'confirmed', resolution: 'confirm', preserved: 3 })]);
  assert.match(closed.root.textContent, /preserved/);
  button(closed.root, /release hold/).click();
  await dom.settle(); await dom.settle();
  assert.ok(closed.calls.includes('POST /admin/reports/10 {"action":"release","note":"the year is over"}'), closed.calls.join('\n'));
  assert.equal(button((await page([report({ status: 'dismissed', reason: 'csam' })])).root, /release hold/), undefined, 'a dismissed report has nothing to release');
});

test('a csam report is confirmed or dismissed, nothing else: confirm asks for the NCMEC number and sends it', async () => {
  globalThis.prompt = () => 'NCMEC 4242';
  const { root, calls } = await page([report({ id: 11, reason: 'csam', deadline: Date.now() + 3600000 })]);
  const labels = root.querySelectorAll('.mod-btns button').map(b => b.textContent);
  assert.ok(labels.some(t => /confirm: apparent CSAM/.test(t)) && labels.some(t => /dismiss/.test(t)), labels.join(' | '));
  assert.ok(!labels.some(t => /hide it|ban the account|hide [+] ban|may be under 18|intimate/.test(t)), 'no other decision: ' + labels.join(' | '));
  button(root, /confirm: apparent CSAM/).click();
  await dom.settle(); await dom.settle();
  assert.ok(calls.includes('POST /admin/reports/11 {"action":"confirm","note":"NCMEC 4242"}'), calls.join(' | '));
  globalThis.prompt = () => '';
  const none = await page([report({ id: 12, reason: 'csam', deadline: Date.now() + 3600000 })]);
  button(none.root, /confirm: apparent CSAM/).click();
  await dom.settle(); await dom.settle();
  assert.ok(!none.calls.some(c => c.startsWith('POST /admin/reports/12')), 'no number, nothing sent');
  const plain = await page([report({ id: 13 })]);
  assert.equal(button(plain.root, /confirm: apparent CSAM/), undefined, 'an ordinary report has no confirm');
  assert.match((await page([report({ id: 14, reason: 'csam', deadline: Date.now() + 3600000 })])).clock.textContent, /confirm it with the report number/);
});

test('H2: a refused photo action offers the override, which carries the note; cancelling sends nothing', async () => {
  const sent = [];
  let refused = 0;
  dom.onFetch = (method, path, body) => {
    sent.push(body);
    if (body.override) return answer(200, { ok: true });
    refused++;
    return answer(409, { error: 'held', code: 'child_safety_hold' });
  };
  const pressOverride = async note => {
    await dom.settle(); await dom.settle();
    const box = document.body.querySelector('.ms-dialog');
    assert.ok(box, 'a dialog asks');
    assert.match(box.textContent, /child-safety/);
    box.querySelector('textarea').value = note;
    box.querySelectorAll('button').find(b => b.textContent === 'Override').click();
  };
  const done = moderatePhoto(5, { action: 'remove', note: '' });
  await pressOverride('court order 12');
  assert.equal(await done, true);
  assert.deepEqual(sent.at(-1), { action: 'remove', note: 'court order 12', override: true });

  const blank = moderatePhoto(5, { action: 'remove' });
  await pressOverride('   ');
  assert.equal(await blank, false, 'a blank note is no override');
  assert.equal(sent.filter(b => b.override).length, 1);

  const before = refused;
  const cancelled = moderatePhoto(5, { action: 'unhide' });
  await dom.settle(); await dom.settle();
  document.body.querySelector('.ms-dialog').querySelectorAll('button').find(b => b.textContent === 'Cancel').click();
  assert.equal(await cancelled, false);
  assert.equal(refused, before + 1);
  assert.equal(sent.filter(b => b.override).length, 1, 'cancelling sends no override');
});
