// Sanity checks for the app build inputs.
//
//   npm run check                                   before a build: placeholders are only NOTES
//   npm run check:release                           before anything that goes to a store: every placeholder is a FAILURE
//   npm run check:release -- --platform android     (or ios, or android,ios; the default is both) which synced platform
//                                                   project(s) must be present and correct. CI passes the one it builds.
//
// A release check fails, naming the exact variable, when:
//   - OURSPACE_ORIGIN is unset/empty (the build would silently use http://localhost:8787 from ourspace.config.json), is not
//     https, or is localhost
//   - OURSPACE_APP_ID is unset/empty (the build would use the unregistered com.ourspace.app)
//   - public/.well-known still has its placeholder team id / signing fingerprint, or does not name the app id
//   - a synced platform project is missing, was synced for another origin / app id, carries a debug-only setting
//     (webContentsDebuggingEnabled, allowMixedContent, a live-reload server.url), or (iOS) lacks associated domains or the
//     privacy manifest. The synced copies are generated files: whatever `cap sync` last wrote is what the store build ships.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cfg = require('./config.cjs');
const file = require('../ourspace.config.json');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, '..', 'public');
const args = process.argv.slice(2);
const release = args.includes('--release');
const pi = args.indexOf('--platform');
const platforms = (pi >= 0 ? String(args[pi + 1] || '') : 'android,ios').split(',').map(s => s.trim()).filter(Boolean);
for (const p of platforms) if (p !== 'android' && p !== 'ios') { console.error(`FAIL: --platform takes android, ios or android,ios, got "${p}"`); process.exit(2); }
const problems = [];
const notes = [];
const need = (ok, msg) => { if (!ok) problems.push(msg); };
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return null; } };
// something that must be real in a release is a problem there and a note otherwise
const forRelease = (bad, msg) => { if (bad) (release ? problems : notes).push(msg); };

// the web side
const appJs = readFileSync(join(pub, 'app.js'), 'utf8');
need((appJs.match(/import '\.\/js\/core\/native\.js'/g) || []).length === 1, "public/app.js must import './js/core/native.js' exactly once");
need(existsSync(join(pub, 'js', 'core', 'native.js')), 'public/js/core/native.js is missing');
// the app-only modules native.js pulls in. They are plain modules in public/, so a rename that is not followed through
// breaks the app's start-up (and nothing in the web build, which never imports them).
for (const m of ['tabspec.js', 'tabbar.js', 'joinphoto.js']) {
  need(existsSync(join(pub, 'js', 'core', m)), `public/js/core/${m} is missing (native.js imports it)`);
}

// the copies the platforms ship (written by `cap sync`; generated, git-ignored)
const PLATFORMS = {
  android: {
    web: join(root, 'android', 'app', 'src', 'main', 'assets', 'public'),
    config: join(root, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json'),
  },
  ios: {
    web: join(root, 'ios', 'App', 'App', 'public'),
    config: join(root, 'ios', 'App', 'App', 'capacitor.config.json'),
    entitlements: join(root, 'ios', 'App', 'App', 'App.entitlements'),
    privacy: join(root, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'),
    project: join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
  },
};
const rel = f => f.slice(root.length + 1).replace(/\\/g, '/');
const resync = p => `run \`npx cap sync ${p}\` with the release environment variables set`;

for (const p of platforms) {
  const d = PLATFORMS[p];
  if (!existsSync(d.web) || !existsSync(d.config)) {
    forRelease(true, `mobile/${p}: not synced (${rel(existsSync(d.web) ? d.config : d.web)} is missing): ${resync(p)}`);
    continue;
  }
  const nc = join(d.web, 'native-config.json');
  const native = readJson(nc);
  need(native && native.origin === cfg.origin, `${rel(nc)} is missing or was built for another origin${native ? ` (${native.origin}, this build is ${cfg.origin})` : ''}: ${resync(p)}`);
  need(native && native.appId === cfg.appId, `${rel(nc)} is missing or was built for another app id${native ? ` (${native.appId}, this build is ${cfg.appId})` : ''}: ${resync(p)}`);
  need(/Content-Security-Policy/.test(readFileSync(join(d.web, 'index.html'), 'utf8')), `${rel(d.web)}/index.html has no CSP meta: ${resync(p)}`);

  // The platform capacitor.config.json is what the shipped app reads at start-up. These settings belong to debug builds
  // only: Capacitor turns webContentsDebuggingEnabled on by itself for a debuggable (debug) APK and leaves it off for a
  // release one, and the debug-only mixed-content allowance lives in MainActivity. So the generated file must not set
  // them at all; "true" here would ship them in a release (chrome://inspect reads the session token out of the web view).
  const pc = readJson(d.config);
  if (!pc) { problems.push(`${rel(d.config)} is unreadable: ${resync(p)}`); continue; }
  const an = pc.android || {};
  const where = `${rel(d.config)} (a stale sync? ${resync(p)})`;
  forRelease(an.webContentsDebuggingEnabled === true, `${where}: android.webContentsDebuggingEnabled is true. A release must not allow chrome://inspect.`);
  forRelease(an.allowMixedContent === true || pc.allowMixedContent === true, `${where}: allowMixedContent is true. A release must not allow http:// content in the https page.`);
  forRelease(!!(pc.server && (pc.server.url || pc.server.cleartext === true)), `${where}: server.url / server.cleartext is set (a live-reload run writes this). A release loads the bundled files.`);
  forRelease(pc.appId !== cfg.appId, `${where}: appId is ${pc.appId}, this build is ${cfg.appId}`);
}

if (platforms.includes('ios') && PLATFORMS.ios.privacy) {
  const d = PLATFORMS.ios;
  need(existsSync(d.privacy), `${rel(d.privacy)} is missing: App Store Connect rejects an upload without a privacy manifest (ITMS-91053)`);
  const proj = existsSync(d.project) ? readFileSync(d.project, 'utf8') : '';
  need(/PrivacyInfo\.xcprivacy in Resources/.test(proj), `${rel(d.project)}: PrivacyInfo.xcprivacy is not in the App target's Resources build phase`);
  // a Swift file that is on disk but not in Sources is not compiled; Xcode's own UI is the usual way one gets dropped
  for (const swift of ['SceneDelegate.swift', 'TabBar.swift']) {
    need(proj.includes(`${swift} in Sources`), `${rel(d.project)}: ${swift} is not in the App target's Sources build phase`);
  }
  // the entitlements are generated by after-copy.mjs from the origin: a release needs the origin's associated domain
  if (existsSync(d.entitlements) && new URL(cfg.origin).hostname !== 'localhost') {
    const host = new URL(cfg.origin).hostname;
    forRelease(!readFileSync(d.entitlements, 'utf8').includes(`applinks:${host}`), `${rel(d.entitlements)} has no applinks:${host} associated domain (universal links would not work): ${resync('ios')}`);
  }
}

// what a store build needs to be real
const aasa = readFileSync(join(pub, '.well-known', 'apple-app-site-association'), 'utf8');
const links = readFileSync(join(pub, '.well-known', 'assetlinks.json'), 'utf8');
JSON.parse(aasa); JSON.parse(links);

const envOrigin = process.env.OURSPACE_ORIGIN || '';
const envAppId = process.env.OURSPACE_APP_ID || '';
const FIX_VAR = name => `Set the ${name} repository variable (Settings > Secrets and variables > Actions > Variables)`;
// (an unset or empty variable falls back to ourspace.config.json, exactly as config.cjs and build.gradle do; the fallback is only
// a problem when it is the dev default, so each message says which of the two it is)
if (!cfg.secure || new URL(cfg.origin).hostname === 'localhost') {
  forRelease(true, envOrigin
    ? `OURSPACE_ORIGIN is ${cfg.origin}: a store build needs the deployed https origin (not http, not localhost)`
    : `OURSPACE_ORIGIN is not set (or is empty), so the build would use ${cfg.origin} from mobile/ourspace.config.json. ${FIX_VAR('OURSPACE_ORIGIN')} to the deployed https origin, e.g. https://ourspace.example.`);
}
if (cfg.appId === 'com.ourspace.app') {
  forRelease(true, envAppId
    ? `OURSPACE_APP_ID is the placeholder ${cfg.appId}: use the id registered with Apple and Google`
    : `OURSPACE_APP_ID is not set (or is empty), so the build would use the unregistered ${cfg.appId} from mobile/ourspace.config.json. ${FIX_VAR('OURSPACE_APP_ID')} to the bundle / application id registered with Apple and Google.`);
}

forRelease(/REPLACE_APPLE_TEAM_ID/.test(aasa), 'public/.well-known/apple-app-site-association still has REPLACE_APPLE_TEAM_ID (put the Apple team id there; it is the same value as the IOS_TEAM_ID secret)');
forRelease(/REPLACE:WITH:THE:SHA256/.test(links), 'public/.well-known/assetlinks.json still has the placeholder signing fingerprint (put the Play app-signing key SHA-256 there)');
forRelease(!aasa.includes(`.${cfg.appId}"`) || !links.includes(`"${cfg.appId}"`), `the .well-known files do not name the app id ${cfg.appId}`);
if (process.env.IOS_TEAM_ID) {
  forRelease(!aasa.includes(`${process.env.IOS_TEAM_ID}.${cfg.appId}`), `public/.well-known/apple-app-site-association does not contain <IOS_TEAM_ID>.${cfg.appId}: universal links would be rejected by iOS`);
}

// The App Review notes. A submission without a working demo account is a rejection on its own (Guideline 2.1), and the
// notes are where the Guideline 4.2 case is actually made, so a release may not be cut while the placeholders are in.
// The demo account's PASSWORD is the one exception, and the reverse: this repository is public, so the password must never be
// in the file (REPLACE_DEMO_PASSWORD stays in it, and the real one is pasted into App Store Connect and Play Console). The gate
// is the REVIEW_DEMO_PASSWORD environment variable instead: a release needs it set (a release-environment secret that proves the
// account exists), and any run fails if that value, or a filled-in "Password:" line, is found in the committed file.
const notesFile = join(root, '..', 'docs', 'mobile', 'review-notes.md');
if (!existsSync(notesFile)) {
  problems.push('docs/mobile/review-notes.md is missing: it is what goes in App Review Information → Notes');
} else {
  const notesText = readFileSync(notesFile, 'utf8');
  const left = [...new Set(notesText.match(/REPLACE_[A-Z_]+/g) || [])].filter(p => p !== 'REPLACE_DEMO_PASSWORD');
  forRelease(left.length > 0, `docs/mobile/review-notes.md still has ${left.join(', ')}: make the demo account on ${cfg.origin} and fill them in before submitting (Guideline 2.1)`);
  const demoPassword = process.env.REVIEW_DEMO_PASSWORD || '';
  forRelease(demoPassword.length < 8, 'REVIEW_DEMO_PASSWORD is not set (or is under 8 characters): make the demo account on ' + cfg.origin + ', then set the password as the REVIEW_DEMO_PASSWORD secret of the release environment. It is only checked here; paste it into App Store Connect and Play Console yourself, never into the repository (Guideline 2.1)');
  need(!demoPassword || !notesText.includes(demoPassword), 'docs/mobile/review-notes.md contains the demo account password (REVIEW_DEMO_PASSWORD). This repository is public: remove it, and change the password, because it has been exposed');
  need(!(/^\s*Password:/m.test(notesText) && !/^\s*Password:\s+REPLACE_DEMO_PASSWORD\s*$/m.test(notesText)), 'docs/mobile/review-notes.md has a "Password:" line with something other than REPLACE_DEMO_PASSWORD: this repository is public, so a password must never be written there');
}

// The app icon. The placeholder was a letter set in a system font; what ships now is drawn (mobile/scripts/make-splash.mjs).
// This only checks the files exist and that the iOS one is the size and the shape the App Store takes — Apple rejects an
// icon with an alpha channel outright, and that is the failure this catches before the upload does.
const iconFile = join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
if (platforms.includes('ios')) {
  if (!existsSync(iconFile)) problems.push(`${rel(iconFile)} is missing: run \`npm run assets --prefix mobile\``);
  else {
    const png = readFileSync(iconFile);
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20), colour = png[25];
    need(width === 1024 && height === 1024, `${rel(iconFile)} is ${width}x${height}; the App Store icon is 1024x1024`);
    need(colour === 2, `${rel(iconFile)} has an alpha channel (PNG colour type ${colour}); the App Store refuses that (ITMS-90717)`);
  }
}
if (platforms.includes('android')) {
  for (const f of ['mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-xxxhdpi/ic_launcher.png', 'mipmap-xxxhdpi/ic_launcher_foreground.png', 'mipmap-xxxhdpi/ic_launcher_monochrome.png']) {
    const p = join(root, 'android', 'app', 'src', 'main', 'res', f);
    need(existsSync(p), `${rel(p)} is missing: run \`npm run assets --prefix mobile\``);
  }
}

notes.forEach(n => console.log('note:', n));
if (problems.length) {
  console.error(`\n${release ? 'release check' : 'check'} failed (${problems.length}):`);
  problems.forEach(p => console.error('FAIL:', p));
  process.exit(1);
}
console.log(`ok (origin ${cfg.origin}, app id ${cfg.appId}${release ? `, release checks on for ${platforms.join(' + ')}` : ''})`);
