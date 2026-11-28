// Firebase integration build: turns the untouched game pages into deployable pages in dist/.
//
// The base game (index.html, critters.html) is NOT edited. This script copies it and patches the
// copy at a few fixed anchor points:
//   1. inserts your Firebase web config (FIREBASE_CONFIG is `null` in the source = offline mode)
//   2. points the SDK imports at a self-hosted copy of the Firebase SDK (same version you test with)
//   3. adds Firebase App Check (reCAPTCHA Enterprise) right after the app is initialised
//   4. adds a Content-Security-Policy <meta> tag with a SHA-256 hash of the game's inline script
// If an anchor is missing (the game code changed), the build stops with a clear error instead of
// silently producing a broken page.
//
// Usage:  npm run build            -> production build (needs firebase/config.json or FIREBASE_WEB_CONFIG)
//         npm run build:emulator   -> build that talks to the local Firebase emulators
import {readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const PAGES = ['index.html', 'critters.html'];
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-app-check.js'];
const EMULATOR = process.argv.includes('--emulator');

const fail = msg => { console.error(`\n✖ build failed: ${msg}\n`); process.exit(1); };

// ---------- 1. config (public identifiers, not secrets; access is enforced by security rules + App Check)
function loadConfig() {
  if (EMULATOR) return {firebase: null, appCheckSiteKey: ''};
  const raw = process.env.FIREBASE_WEB_CONFIG || (existsSync(join(ROOT, 'firebase/config.json')) && readFileSync(join(ROOT, 'firebase/config.json'), 'utf8'));
  if (!raw) fail('no Firebase config. Copy firebase/config.example.json to firebase/config.json and fill it in (or set FIREBASE_WEB_CONFIG).');
  let cfg; try { cfg = JSON.parse(raw); } catch (e) { fail('Firebase config is not valid JSON: ' + e.message); }
  const need = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missing = need.filter(k => !cfg.firebase || typeof cfg.firebase[k] !== 'string' || !cfg.firebase[k] || cfg.firebase[k].startsWith('YOUR_'));
  if (missing.length) fail('Firebase config is missing: ' + missing.join(', '));
  const extra = Object.keys(cfg.firebase).filter(k => !['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'].includes(k));
  if (extra.length) fail('unexpected keys in the Firebase web config (never put secrets here): ' + extra.join(', '));
  if (!cfg.appCheckSiteKey) console.warn('⚠ no appCheckSiteKey: App Check is off. Add a reCAPTCHA Enterprise site key before going public.');
  return cfg;
}

// ---------- 2. self-hosted Firebase SDK (copied from node_modules, so deploy == tested version)
function vendorSdk() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/firebase/package.json'), 'utf8'));
  const ver = pkg.version, dir = `vendor/firebase-${ver}`, cdn = `https://www.gstatic.com/firebasejs/${ver}/`;
  mkdirSync(join(OUT, dir), {recursive: true});
  for (const f of SDK_FILES) {
    let js = readFileSync(join(ROOT, 'node_modules/firebase', f), 'utf8');
    js = js.split(cdn).join('./');   // the CDN builds import each other by absolute gstatic URL -> make them relative
    if (js.includes('https://www.gstatic.com/firebasejs/')) fail(`${f} still references the Firebase CDN`);
    writeFileSync(join(OUT, dir, f), js);
  }
  return {ver, path: `./${dir}/`};
}

// ---------- 3. patch one page
function replaceOnce(src, find, repl, what) {
  const n = typeof find === 'string' ? src.split(find).length - 1 : (src.match(new RegExp(find.source, 'g')) || []).length;
  if (n !== 1) fail(`${what}: expected exactly 1 anchor, found ${n}. Did the game's Online section change?`);
  return src.replace(find, () => repl);
}
function csp(cfg, scriptHash) {
  const authDomain = cfg.firebase ? `https://${cfg.firebase.authDomain}` : '';
  const emu = EMULATOR ? ' http://127.0.0.1:8080 http://127.0.0.1:9099 http://localhost:8080 http://localhost:9099' : '';
  return [
    "default-src 'self'",
    // the game's single inline script (by hash), the self-hosted SDK, Google sign-in (gapi) and reCAPTCHA Enterprise
    `script-src 'self' '${scriptHash}' https://apis.google.com https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
    // inline styles only (style attributes in the HUD); style injection can't run code
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseinstallations.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com/recaptcha/${emu}`,
    `frame-src ${authDomain} https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/`.replace('  ', ' '),
    "img-src 'self' data:", "media-src 'self' data:", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "worker-src 'none'",
  ].join('; ');
}
function buildPage(name, cfg, sdk) {
  let src = readFileSync(join(ROOT, name), 'utf8');
  // config + App Check key
  src = replaceOnce(src, 'const FIREBASE_CONFIG = null;',
    `const FIREBASE_CONFIG = ${JSON.stringify(cfg.firebase)};   // [firebase/build.mjs] injected\nconst APPCHECK_SITE_KEY = ${JSON.stringify(cfg.appCheckSiteKey || '')};   // [firebase/build.mjs] injected`, 'config');
  // self-hosted SDK of the tested version
  src = replaceOnce(src, /const FB_VER = '[\d.]+', FB_CDN = `https:\/\/www\.gstatic\.com\/firebasejs\/\$\{FB_VER\}\/`;/,
    `const FB_VER = '${sdk.ver}', FB_CDN = '${sdk.path}';   // [firebase/build.mjs] self-hosted SDK`, 'SDK location');
  if (EMULATOR) src = replaceOnce(src, "const EMULATOR = new URLSearchParams(location.search).has('emulator');", 'const EMULATOR = true;   // [firebase/build.mjs] emulator build', 'emulator flag');
  // App Check must be initialised before Auth/Firestore make their first request
  src = replaceOnce(src, 'const a = app.initializeApp(cfg), au = auth.getAuth(a), db = fs.getFirestore(a);',
    `const a = app.initializeApp(cfg);
      if (!EMULATOR && APPCHECK_SITE_KEY) {   // [firebase/build.mjs] App Check: only genuine copies of this site can use the backend
        const ac = await import(FB_CDN + 'firebase-app-check.js');
        ac.initializeAppCheck(a, {provider: new ac.ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true});
      }
      const au = auth.getAuth(a), db = fs.getFirestore(a);`, 'App Check');
  // CSP: hash of the (patched) inline script
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) fail(`${name}: expected 1 inline script, found ${scripts.length}`);
  const hash = 'sha256-' + createHash('sha256').update(scripts[0][1], 'utf8').digest('base64');
  src = replaceOnce(src, '<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp(cfg, hash)}">`, 'CSP');
  writeFileSync(join(OUT, name), src);
}

// ---------- run
const cfg = loadConfig();
rmSync(OUT, {recursive: true, force: true}); mkdirSync(OUT, {recursive: true});
const sdk = vendorSdk();
for (const p of PAGES) buildPage(p, cfg, sdk);
console.log(`✔ built ${PAGES.join(', ')} -> dist/  (Firebase SDK ${sdk.ver} self-hosted${EMULATOR ? ', EMULATOR mode' : cfg.appCheckSiteKey ? ', App Check on' : ', App Check OFF'})`);
console.log('  files:', readdirSync(OUT).join(', '));
