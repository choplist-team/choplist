// Local tool: a tiny page that signs in with Clerk and calls the API with the
// real session token, so seller routes can be tried before the frontend has a
// working login. Nothing is stored; the page only shows responses.
//
//   Terminal 1:  cd backend; npm run dev          (the API, on port 5000)
//   Terminal 2:  cd backend; npm run clerk:login-test
//   Browser:     http://localhost:5173
//
// It reads CLERK_PUBLISHABLE_KEY from ../.env. That key is public by design (it
// ships in every frontend); the secret key is never read.
//
// The page must be served from an origin listed in ALLOWED_ORIGINS, because the
// API only accepts tokens issued for those origins. Port 5173 matches the
// default. To use another port, add it to ALLOWED_ORIGINS and set
// LOGIN_TEST_PORT. To point at another API (e.g. Render, whose ALLOWED_ORIGINS
// must then include http://localhost:5173), set LOGIN_TEST_API.

import { createServer } from 'node:http';

const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? '';
if (!/^pk_(test|live)_/.test(publishableKey)) {
  console.error('CLERK_PUBLISHABLE_KEY is not set (see .env).');
  process.exit(1);
}

const port = Number(process.env.LOGIN_TEST_PORT ?? 5173);
const apiBase = process.env.LOGIN_TEST_API ?? 'http://localhost:5000/api';

// The key encodes the Clerk host the browser script is loaded from, e.g.
// "pk_test_" + base64("xyz.clerk.accounts.dev$").
const clerkHost = Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ''), 'base64')
  .toString()
  .replace(/\$$/, '');
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clerkHost)) {
  console.error('CLERK_PUBLISHABLE_KEY does not look like a Clerk key.');
  process.exit(1);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChopList Clerk login test</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1d2a22; background: #f8f8f3; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .muted { color: #55645a; font-size: 0.9rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.8rem 0; align-items: center; }
  button { font: inherit; padding: 0.45rem 0.8rem; border-radius: 6px; border: 1px solid #2f6348; background: #2f6348; color: #fff; cursor: pointer; }
  button.secondary { background: #fff; color: #2f6348; }
  input, select, textarea { font: inherit; padding: 0.35rem 0.5rem; border: 1px solid #b9c2b3; border-radius: 6px; }
  input.api { flex: 1 1 18rem; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  pre { background: #eef0e8; border: 1px solid #d9ddd0; border-radius: 8px; padding: 0.8rem; overflow: auto; min-height: 6rem; white-space: pre-wrap; word-break: break-word; }
  #who { font-weight: 600; }
</style>
</head>
<body>
<h1>ChopList Clerk login test</h1>
<p class="muted">Signs in with Clerk, then calls the API with the real session token. Page origin: <code id="origin"></code></p>

<p id="who">Loading Clerk...</p>
<div class="row">
  <button id="signin">Sign in</button>
  <button id="signup" class="secondary">Sign up</button>
  <button id="signout" class="secondary">Sign out</button>
  <button id="claims" class="secondary">Show token claims</button>
</div>

<div class="row"><label for="api">API base</label> <input id="api" class="api"></div>

<div class="row">
  <button id="me">GET /sellers/me</button>
  <button id="put" class="secondary">PUT /sellers/me (sample shop)</button>
  <button id="menus" class="secondary">GET /menus</button>
</div>

<div class="row">
  <select id="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select>
  <input id="path" class="api" placeholder="/menus/<id>/orders">
  <button id="send" class="secondary">Send</button>
</div>
<textarea id="body" rows="4" placeholder="JSON body (for POST / PUT)"></textarea>

<pre id="out">Sign in, then try GET /sellers/me.</pre>

<script async crossorigin="anonymous"
  data-clerk-publishable-key=${JSON.stringify(publishableKey)}
  src=${JSON.stringify(`https://${clerkHost}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`)}></script>
<script>
  var DEFAULT_API = ${JSON.stringify(apiBase)};
  var $ = function (id) { return document.getElementById(id); };
  var out = $('out');
  $('origin').textContent = location.origin;
  $('api').value = DEFAULT_API;

  function show(title, text) { out.textContent = title + '\\n\\n' + text; }

  function refresh() {
    var u = window.Clerk && Clerk.user;
    $('who').textContent = u
      ? 'Signed in as ' + (u.primaryEmailAddress ? u.primaryEmailAddress.emailAddress : u.id)
      : 'Not signed in';
  }

  async function getToken() {
    if (!(window.Clerk && Clerk.session)) return null;
    return await Clerk.session.getToken();
  }

  async function call(method, path, bodyText) {
    var token = await getToken();
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    var init = { method: method, headers: headers };
    if (bodyText && bodyText.trim()) { headers['Content-Type'] = 'application/json'; init.body = bodyText; }
    var url = $('api').value.replace(/\\/$/, '') + path;
    try {
      var res = await fetch(url, init);
      var text = await res.text();
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
      show(method + ' ' + url + (token ? '' : '   (no token: not signed in)') + '\\n-> HTTP ' + res.status, text);
    } catch (e) {
      show(method + ' ' + url + '\\n-> request failed', String(e) +
        '\\n\\nIf this says "Failed to fetch": the API is not running at that address, or its ALLOWED_ORIGINS does not include ' + location.origin + '.');
    }
  }

  var SAMPLE_SHOP = JSON.stringify({
    businessName: 'Login Test Kitchen',
    phone: '0803 123 4567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Login Tester' }
  }, null, 2);

  $('signin').onclick = function () { Clerk.openSignIn({}); };
  $('signup').onclick = function () { Clerk.openSignUp({}); };
  $('signout').onclick = async function () { await Clerk.signOut(); refresh(); show('Signed out', ''); };
  $('me').onclick = function () { call('GET', '/sellers/me'); };
  $('menus').onclick = function () { call('GET', '/menus'); };
  $('put').onclick = function () {
    if (!confirm('This creates (or updates) a seller in the database the API uses. Continue?')) return;
    call('PUT', '/sellers/me', SAMPLE_SHOP);
  };
  $('send').onclick = function () { call($('method').value, $('path').value, $('body').value); };

  $('claims').onclick = async function () {
    var token = await getToken();
    if (!token) { show('No token', 'Sign in first.'); return; }
    var p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    var left = Math.round(p.exp - Date.now() / 1000);
    show('Token claims (the token itself is not shown)',
      'sub (user id): ' + p.sub + '\\n' +
      'azp (page the token was issued for): ' + p.azp + '\\n' +
      'iss (issuer): ' + p.iss + '\\n' +
      'expires in: ' + left + ' s\\n\\n' +
      'The API accepts the token only if azp is one of its ALLOWED_ORIGINS.');
  };

  window.addEventListener('load', async function () {
    if (!window.Clerk) { $('who').textContent = 'Clerk did not load (blocked, or no internet).'; return; }
    try { await Clerk.load(); } catch (e) { $('who').textContent = 'Clerk failed to load: ' + e; return; }
    refresh();
    Clerk.addListener(refresh);
  });
</script>
</body>
</html>
`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url !== '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${port} is in use (is the frontend dev server running?). Stop it, or set LOGIN_TEST_PORT and add that origin to ALLOWED_ORIGINS.`
      : err.message,
  );
  process.exit(1);
});

// 127.0.0.1 only: this is a local tool, not reachable from the network.
server.listen(port, '127.0.0.1', () => {
  console.log(`Clerk login test: http://localhost:${port}`);
  console.log(`API it will call:  ${apiBase}`);
  console.log('Press Ctrl+C to stop.');
});
