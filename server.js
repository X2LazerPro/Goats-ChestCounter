// Chest Counter lobby server + static file host.  Run: npm install && npm start
// Optional extras (set as environment variables; with none set it works exactly as before, in memory):
//   DATABASE_URL                          -> saves players in Postgres (Neon / Supabase), survives sleeping & restarts
//   DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET -> "Log in with Discord" (your counts follow your Discord account)
//   PUBLIC_URL (optional)                 -> your server's https address (Render fills this in itself)
//   KEEP_DAYS (optional, default 365, 0 = forever) -> how long inactive players are remembered
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
let Pool = null;
if (process.env.DATABASE_URL) { try { Pool = require('pg').Pool; } catch (e) { console.log('pg not installed - running without a database'); } }
const DB = Pool ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 }) : null;
const CID = process.env.DISCORD_CLIENT_ID, CSEC = process.env.DISCORD_CLIENT_SECRET, DISCORD = !!(CID && CSEC);
const KEEP_DAYS = process.env.KEEP_DAYS === undefined ? 365 : +process.env.KEEP_DAYS;
const KEEP_MS = KEEP_DAYS > 0 ? KEEP_DAYS * 864e5 : Infinity;

const lobbies = new Map();   // code -> Map(pid -> {name, counts, ws, seen, did})
const accounts = new Map();  // discord id -> {id, name, avatar}
const sessions = new Map();  // token -> discord id
const states = new Map();    // oauth state -> {mode, link, exp}
const pending = new Map();   // app link code -> {token, name, exp}
let nextId = 1;
const ZERO = () => ({ r: 0, rare: 0, s: 0 });
const clean = c => c && typeof c === 'object' ? { r: Math.max(0, +c.r | 0), rare: Math.max(0, +c.rare | 0), s: Math.max(0, +c.s | 0) } : null;
const open = v => v.ws && v.ws.readyState === 1;
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- database ----------
async function q(sql, args) { if (!DB) return null; try { return await DB.query(sql, args); } catch (e) { console.log('db error:', e.message); return null; } }
async function initDb() {
  if (!DB) return;
  await q('CREATE TABLE IF NOT EXISTS players(lobby text, pid text, name text, r int DEFAULT 0, rare int DEFAULT 0, s int DEFAULT 0, did text, seen timestamptz DEFAULT now(), PRIMARY KEY(lobby, pid))');
  await q('CREATE TABLE IF NOT EXISTS accounts(did text PRIMARY KEY, name text, avatar text)');
  await q('CREATE TABLE IF NOT EXISTS sessions(token text PRIMARY KEY, did text, created timestamptz DEFAULT now())');
  const cutoff = KEEP_MS === Infinity ? new Date(0) : new Date(Date.now() - KEEP_MS);
  let r = await q('SELECT * FROM players WHERE seen > $1', [cutoff]);
  (r ? r.rows : []).forEach(x => {
    if (!lobbies.has(x.lobby)) lobbies.set(x.lobby, new Map());
    lobbies.get(x.lobby).set(x.pid, { name: x.name, counts: { r: x.r, rare: x.rare, s: x.s }, ws: null, seen: +new Date(x.seen), did: x.did || null });
  });
  r = await q('SELECT * FROM accounts'); (r ? r.rows : []).forEach(x => accounts.set(x.did, { id: x.did, name: x.name, avatar: x.avatar || '' }));
  r = await q('SELECT * FROM sessions'); (r ? r.rows : []).forEach(x => sessions.set(x.token, x.did));
  console.log('Database ready: ' + [...lobbies.values()].reduce((n, l) => n + l.size, 0) + ' players loaded');
}
const timers = new Map();
function persist(code, pid) {
  if (!DB) return; const k = code + '|' + pid; if (timers.has(k)) return;
  timers.set(k, setTimeout(() => {
    timers.delete(k);
    const p = lobbies.get(code) && lobbies.get(code).get(pid); if (!p) return;
    q('INSERT INTO players(lobby,pid,name,r,rare,s,did,seen) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(lobby,pid) DO UPDATE SET name=$3,r=$4,rare=$5,s=$6,did=$7,seen=now()',
      [code, pid, p.name, p.counts.r, p.counts.rare, p.counts.s, p.did || null]);
  }, 1500));
}

// ---------- http ----------
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const FILES = ['index.html', 'manifest.json', 'sw.js', 'icon.svg'];
async function callback(u, res, base) {
  const stKey = u.searchParams.get('state'), st = states.get(stKey), code = u.searchParams.get('code');
  const page = msg => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;background:#121214;color:#fff;text-align:center;padding:40px"><h2>' + msg + '</h2>'); };
  if (!st || !code) return page('Login expired or cancelled. Close this tab and try again.');
  states.delete(stKey);
  try {
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CID, client_secret: CSEC, grant_type: 'authorization_code', code, redirect_uri: base + '/auth/discord/callback' }) });
    const tk = await tr.json(); if (!tk.access_token) throw new Error('no access token');
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tk.access_token } });
    const du = await ur.json(); if (!du.id) throw new Error('no user');
    const acc = { id: du.id, name: String(du.global_name || du.username || 'Player').slice(0, 16), avatar: du.avatar ? 'https://cdn.discordapp.com/avatars/' + du.id + '/' + du.avatar + '.png?size=64' : '' };
    accounts.set(du.id, acc);
    const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, du.id);
    q('INSERT INTO accounts(did,name,avatar) VALUES($1,$2,$3) ON CONFLICT(did) DO UPDATE SET name=$2,avatar=$3', [du.id, acc.name, acc.avatar]);
    q('INSERT INTO sessions(token,did) VALUES($1,$2)', [token, du.id]);
    if (st.mode === 'app' && st.link) { pending.set(st.link, { token, name: acc.name, exp: Date.now() + 5 * 60000 }); return page('Linked as ' + esc(acc.name) + '. You can close this tab and go back to Chest Counter.'); }
    res.writeHead(302, { Location: '/#token=' + token }); res.end();
  } catch (e) { console.log('discord login failed:', e.message); page('Discord login failed. Close this tab and try again.'); }
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('https://' + req.headers.host);
  const json = (o, c) => { res.writeHead(c || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  if (p === '/api/status') return json({ db: !!DB, discord: DISCORD });
  if (p === '/auth/discord') {
    if (!DISCORD) return json({ error: 'Discord login is not set up on this server' }, 503);
    const st = crypto.randomBytes(16).toString('hex');
    states.set(st, { mode: u.searchParams.get('mode') === 'app' ? 'app' : 'web', link: (u.searchParams.get('link') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16), exp: Date.now() + 10 * 60000 });
    res.writeHead(302, { Location: 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: CID, redirect_uri: base + '/auth/discord/callback', response_type: 'code', scope: 'identify', state: st }) });
    return res.end();
  }
  if (p === '/auth/discord/callback') return callback(u, res, base);
  if (p === '/auth/poll') {
    const link = (u.searchParams.get('code') || '').replace(/[^A-Za-z0-9]/g, ''), e = pending.get(link);
    if (e) { pending.delete(link); return json({ token: e.token, name: e.name }); }
    return json({});
  }
  if (p === '/auth/me') { const did = sessions.get(u.searchParams.get('token')), a = did && accounts.get(did); return json(a ? { name: a.name, avatar: a.avatar } : {}); }
  const name = path.basename(p === '/' ? '/index.html' : p);
  if (!FILES.includes(name)) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(__dirname, name), (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' }); res.end(d);
  });
});

// ---------- lobbies ----------
const wss = new WebSocketServer({ server });
function broadcast(code) {
  const l = lobbies.get(code); if (!l) return;
  const players = {};
  l.forEach((v, id) => { const a = v.did && accounts.get(v.did); players[id] = { name: v.name, counts: v.counts, online: !!open(v), avatar: a ? a.avatar : '' }; });
  const msg = JSON.stringify({ t: 'roster', players });
  l.forEach(v => open(v) && v.ws.send(msg));
}
wss.on('connection', ws => {
  const tmp = 'c' + (nextId++); let code = null, pid = null;
  ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      code = String(m.code || '').toUpperCase().slice(0, 12).replace(/[^A-Z0-9]/g, '');
      if (!code) return;
      const did = m.token && sessions.get(String(m.token)) || null, acc = did ? accounts.get(did) : null;
      pid = did ? 'd' + did : (String(m.pid || tmp).replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || tmp);
      if (!lobbies.has(code)) lobbies.set(code, new Map());
      const l = lobbies.get(code), old = l.get(pid), fresh = clean(m.counts);
      if (old && old.ws && old.ws !== ws) { try { old.ws.close(); } catch {} }
      // Discord accounts: the saved counts win. Anonymous players: the player's own device wins.
      const counts = did ? ((old && old.counts) || fresh || ZERO()) : (fresh || (old && old.counts) || ZERO());
      l.set(pid, { name: acc ? acc.name : String(m.name || 'Player').slice(0, 16), counts, ws, seen: Date.now(), did });
      const reply = { t: 'joined', id: pid, linked: !!did, badToken: !!(m.token && !did) };
      if (did) { reply.name = acc.name; reply.counts = counts; }
      ws.send(JSON.stringify(reply)); persist(code, pid); broadcast(code);
    } else if (m.t === 'state' && code && lobbies.get(code) && lobbies.get(code).has(pid)) {
      const p = lobbies.get(code).get(pid);
      p.counts = clean(m.counts) || p.counts; p.seen = Date.now();
      if (m.name && !p.did) p.name = String(m.name).slice(0, 16);
      persist(code, pid); broadcast(code);
    }
  });
  ws.on('close', () => {
    const l = lobbies.get(code), p = l && l.get(pid);
    if (p && p.ws === ws) { p.ws = null; p.seen = Date.now(); broadcast(code); }
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);
setInterval(() => {
  const now = Date.now();
  states.forEach((v, k) => v.exp < now && states.delete(k)); pending.forEach((v, k) => v.exp < now && pending.delete(k));
  lobbies.forEach((l, code) => {
    l.forEach((v, id) => { if (!open(v) && now - v.seen > KEEP_MS) l.delete(id); });
    if (!l.size) lobbies.delete(code);
  });
  if (DB && KEEP_MS !== Infinity) q('DELETE FROM players WHERE seen < $1', [new Date(now - KEEP_MS)]);
}, 600000);
initDb().then(() => server.listen(process.env.PORT || 3000, () => console.log('Chest counter on port ' + (process.env.PORT || 3000) + (DB ? ' [database on]' : '') + (DISCORD ? ' [discord on]' : ''))));
