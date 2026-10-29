// End-to-end smoke test: starts a throwaway server, then exercises the API
// and gateway with two users.   npm test
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));

const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function req(method, p, body, token, extra = {}) {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra.headers },
    body: extra.raw || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, headers: res.headers };
}

function client(token, opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, opts);
  const events = [];
  const waiters = [];
  const closed = new Promise((r) => { ws.onclose = (e) => r(e.code); });
  ws.onopen = () => ws.send(JSON.stringify(token ? { op: 'IDENTIFY', token } : { op: 'IDENTIFY' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    events.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  };
  return {
    ws, events, closed,
    send: (o) => ws.send(JSON.stringify(o)),
    wait(t, pred = () => true, ms = 3000) {
      const found = events.find((m) => m.t === t && pred(m.d));
      if (found) { events.splice(events.indexOf(found), 1); return Promise.resolve(found.d); }
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.t === t && pred(m.d), resolve: (m) => { events.splice(events.indexOf(m), 1); clearTimeout(timer); resolve(m.d); } };
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), ms);
        waiters.push(w);
      });
    },
  };
}

let passed = 0;
function ok(label) { passed++; console.log('  ✓', label); }

async function main() {
  await new Promise((r) => srv.stdout.once('data', r));

  const PW = 'velvet harbor lantern 42';
  const a = await req('POST', '/auth/register', { username: 'alice', password: PW, displayName: 'Alice', returnToken: true });
  const b = await req('POST', '/auth/register', { username: 'bob', password: PW, returnToken: true });
  assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(b.status, 200);
  assert.equal((await req('POST', '/auth/register', { username: 'ALICE', password: PW })).status, 409);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: 'wrong-pass-123' })).status, 401);
  ok('register, duplicate check, bad login rejected');

  for (const [pw, why] of [['short1', 'too short'], ['password1234', 'common'], ['Qwerty123456', 'common (any capitalization)'],
    ['carol-is-the-best', 'contains username'], ['aaaaaaaaaaaaaa', 'repetitive']]) {
    const r = await req('POST', '/auth/register', { username: 'carol', password: pw });
    assert.equal(r.status, 400, `${why} password should be rejected`);
  }
  ok('weak passwords rejected (length, common list, username, repetition)');
  const A = a.data.token; const B = b.data.token;

  const ca = client(A); const cb = client(B);
  const readyA = await ca.wait('READY');
  await cb.wait('READY');
  assert.equal(readyA.user.username, 'alice');
  ok('both clients connected over the hand-written WebSocket gateway');

  const srvRes = await req('POST', '/servers', { name: 'Test Server' }, A);
  const server = srvRes.data;
  assert.equal(server.channels.length, 2);
  await ca.wait('SERVER_CREATE', (d) => d.id === server.id);
  const general = server.channels.find((c) => c.type === 'text');
  const voiceCh = server.channels.find((c) => c.type === 'voice');
  ok('server created with default text + voice channels');

  assert.equal((await req('GET', `/channels/${general.id}/messages`, null, B)).status, 404);
  ok('non-member cannot read channel');

  const inv = (await req('POST', `/servers/${server.id}/invites`, {}, A)).data;
  assert.equal((await req('GET', `/invites/${inv.code}`)).data.server.name, 'Test Server');
  const joined = await req('POST', `/invites/${inv.code}`, null, B);
  assert.equal(joined.status, 200);
  await cb.wait('SERVER_CREATE', (d) => d.id === server.id);
  await ca.wait('MEMBER_ADD', (d) => d.member.user.username === 'bob');
  ok('invite preview + join; owner sees MEMBER_ADD live');

  const sent = await req('POST', `/channels/${general.id}/messages`, { content: 'hello **bob**' }, A);
  assert.equal(sent.status, 200);
  const got = await cb.wait('MESSAGE_CREATE', (d) => d.id === sent.data.id);
  assert.equal(got.content, 'hello **bob**');
  ok('message delivered live to the other user');

  cb.send({ op: 'TYPING', channelId: general.id });
  await ca.wait('TYPING_START', (d) => d.userId === b.data.user.id);
  ok('typing indicator');

  await req('PUT', `/messages/${sent.data.id}/reactions/${encodeURIComponent('🔥')}`, null, B);
  await ca.wait('REACTION_ADD', (d) => d.emoji === '🔥');
  const reply = await req('POST', `/channels/${general.id}/messages`, { content: 'hi', replyTo: sent.data.id }, B);
  assert.equal(reply.data.replyTo, sent.data.id);
  assert.equal((await req('PATCH', `/messages/${sent.data.id}`, { content: 'nope' }, B)).status, 403);
  assert.equal((await req('PATCH', `/messages/${sent.data.id}`, { content: 'edited' }, A)).status, 200);
  await cb.wait('MESSAGE_UPDATE', (d) => d.content === 'edited');
  ok('reactions, replies, edit (own only)');

  for (let i = 0; i < 60; i++) await req('POST', `/channels/${general.id}/messages`, { content: `bulk ${i}` }, A);
  const page1 = (await req('GET', `/channels/${general.id}/messages?limit=50`, null, B)).data;
  const page2 = (await req('GET', `/channels/${general.id}/messages?limit=50&before=${page1[0].id}`, null, B)).data;
  assert.equal(page1.length, 50); assert.equal(page2.length, 12);
  assert.equal(page1.at(-1).content, 'bulk 59');
  ok('message history pagination');

  assert.equal((await req('POST', `/servers/${server.id}/channels`, { name: 'secret' }, B)).status, 403);
  const role = (await req('POST', `/servers/${server.id}/roles`, { name: 'Mod', permissions: 1 << 5 }, A)).data;
  await req('PUT', `/servers/${server.id}/members/${b.data.user.id}/roles/${role.id}`, null, A);
  const made = await req('POST', `/servers/${server.id}/channels`, { name: 'Mod Chat' }, B);
  assert.equal(made.status, 200); assert.equal(made.data.name, 'mod-chat');
  assert.equal((await req('POST', `/servers/${server.id}/roles`, { name: 'x', permissions: 1 << 30 }, B)).status, 403);
  ok('permissions: role grants Manage Channels; cannot escalate');

  const file = Buffer.from('hello file');
  const up = await req('POST', `/channels/${general.id}/attachments`, null, B, { raw: file, headers: { 'X-Filename': 'note.txt', 'Content-Type': 'text/plain' } });
  assert.equal(up.status, 200);
  await req('POST', `/channels/${general.id}/messages`, { content: '', attachments: [up.data] }, B);
  const dl = await fetch(BASE + up.data.url, { headers: { Authorization: 'Bearer ' + A } });
  assert.equal(await dl.text(), 'hello file');
  assert.equal((await fetch(BASE + up.data.url)).status, 401);
  ok('file upload; download requires login + channel access');

  // Voice: both join, signaling is relayed point-to-point.
  ca.send({ op: 'VOICE_JOIN', channelId: voiceCh.id });
  await cb.wait('VOICE_STATE_UPDATE', (d) => d.userId === a.data.user.id && d.channelId === voiceCh.id);
  cb.send({ op: 'VOICE_JOIN', channelId: voiceCh.id });
  const bState = await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.channelId === voiceCh.id);
  ca.send({ op: 'VOICE_SIGNAL', toSession: bState.sessionId, data: { type: 'offer', sdp: 'fake' } });
  const sig = await cb.wait('VOICE_SIGNAL');
  assert.equal(sig.data.sdp, 'fake');
  cb.send({ op: 'VOICE_STATE', mute: true, video: true });
  await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.mute && d.video);
  cb.send({ op: 'VOICE_LEAVE' });
  await ca.wait('VOICE_STATE_UPDATE', (d) => d.userId === b.data.user.id && d.channelId === null);
  ok('voice join/leave, mute/video state, WebRTC signaling relay');

  const dm = await req('POST', '/dms', { username: 'bob' }, A);
  await cb.wait('DM_CREATE', (d) => d.id === dm.data.id);
  await req('POST', `/channels/${dm.data.id}/messages`, { content: 'private' }, A);
  await cb.wait('MESSAGE_CREATE', (d) => d.channelId === dm.data.id);
  ok('direct messages');

  const msgs = (await req('GET', `/channels/${general.id}/messages?limit=5`, null, A)).data;
  const bobsMsg = msgs.find((m) => m.author.username === 'bob');
  const alicesMsg = msgs.find((m) => m.author.username === 'alice');
  assert.equal((await req('DELETE', `/messages/${alicesMsg.id}`, null, B)).status, 403);
  assert.equal((await req('DELETE', `/messages/${bobsMsg.id}`, null, A)).status, 204);
  ok('delete: others blocked, owner can moderate');
  await req('PUT', `/servers/${server.id}/bans/${b.data.user.id}`, {}, A);
  await cb.wait('SERVER_DELETE', (d) => d.id === server.id);
  assert.equal((await req('POST', `/invites/${inv.code}`, null, B)).status, 403);
  ok('ban removes member live and blocks rejoining');


  // ---------------- security checks ----------------
  const { DatabaseSync } = require('node:sqlite');
  const dbr = new DatabaseSync(path.join(dataDir, 'hearth.db'), { readOnly: true });
  const aliceRow = dbr.prepare("SELECT password_hash FROM users WHERE username = 'alice'").get();
  assert.match(aliceRow.password_hash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(!aliceRow.password_hash.includes(PW));
  const sessRows = dbr.prepare('SELECT token_hash FROM auth_sessions').all();
  assert.ok(sessRows.length > 0 && sessRows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  assert.ok(!sessRows.some((r) => r.token_hash === A));
  dbr.close();
  ok('database holds only scrypt hashes and hashed session tokens');

  // Browser-style login: token only in an HttpOnly cookie.
  const web = await req('POST', '/auth/login', { username: 'alice', password: PW }, null, { headers: { Origin: BASE } });
  assert.equal(web.status, 200); assert.equal(web.data.token, undefined);
  const setCookie = web.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const cookieHdr = setCookie.split(';')[0];
  const host = new URL(BASE).host;
  const viaCookie = (method, p, body, origin) => req(method, p, body, null, { headers: { Cookie: cookieHdr, ...(origin ? { Origin: origin } : {}) } });
  assert.equal((await viaCookie('GET', '/users/@me')).status, 200);
  assert.equal((await viaCookie('POST', '/servers', { name: 'evil' }, 'https://evil.example')).status, 403);
  assert.equal((await viaCookie('POST', '/servers', { name: 'no-origin' })).status, 403);
  assert.equal((await viaCookie('POST', '/servers', { name: 'ok' }, `http://${host}`)).status, 200);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: PW }, null, { headers: { Origin: 'https://evil.example' } })).status, 403);
  ok('login cookie is HttpOnly/SameSite; cross-site requests blocked (CSRF)');

  const evilWs = client(null, { headers: { Cookie: cookieHdr, Origin: 'https://evil.example' } });
  assert.equal(await evilWs.closed, 4003);
  const goodWs = client(null, { headers: { Cookie: cookieHdr, Origin: `http://${host}` } });
  await goodWs.wait('READY');
  ok('WebSocket: cookie login works, other websites refused');

  // Upgrading an old-style hash on login.
  {
    const crypto = require('node:crypto');
    const salt = crypto.randomBytes(16);
    const oldHash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync('legacy pass phrase', salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
    await req('POST', '/auth/register', { username: 'legacy', password: 'temporary words here' });
    const w = new DatabaseSync(path.join(dataDir, 'hearth.db'));
    w.exec('PRAGMA busy_timeout = 5000');
    w.prepare("UPDATE users SET password_hash = ? WHERE username = 'legacy'").run(oldHash);
    assert.equal((await req('POST', '/auth/login', { username: 'legacy', password: 'legacy pass phrase' })).status, 200);
    assert.match(w.prepare("SELECT password_hash FROM users WHERE username = 'legacy'").get().password_hash, /^scrypt\$32768\$/);
    w.close();
  }
  ok('older password hashes upgraded automatically on login');

  // Changing password signs out other devices immediately.
  const other = await req('POST', '/auth/login', { username: 'alice', password: PW, returnToken: true });
  const otherWs = client(other.data.token);
  await otherWs.wait('READY');
  const NEWPW = 'copper meadow rocket 7';
  assert.equal((await req('POST', '/users/@me/password', { currentPassword: 'nope nope nope', newPassword: NEWPW }, A)).status, 403);
  assert.equal((await req('POST', '/users/@me/password', { currentPassword: PW, newPassword: NEWPW }, A)).status, 200);
  assert.equal(await otherWs.closed, 4004);
  assert.equal((await req('GET', '/users/@me', null, other.data.token)).status, 401);
  assert.equal((await req('GET', '/users/@me', null, A)).status, 200);
  assert.equal((await req('POST', '/auth/login', { username: 'alice', password: NEWPW })).status, 200);
  ok('password change requires current password and signs out other devices');

  const sessions = (await req('GET', '/users/@me/sessions', null, A)).data;
  assert.ok(sessions.some((x) => x.current));
  await req('POST', '/auth/logout', null, A);
  assert.equal((await req('GET', '/users/@me', null, A)).status, 401);
  ok('device list and logout');

  for (let i = 0; i < 5; i++) await req('POST', '/auth/login', { username: 'bob', password: 'wrong guess ' + i });
  const locked = await req('POST', '/auth/login', { username: 'bob', password: PW });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  ok('repeated wrong passwords lock the account temporarily');

  goodWs.ws.close();
  ca.ws.close(); cb.ws.close();
  console.log(`\nAll ${passed} checks passed.`);
}

main().then(() => { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); })
  .catch((err) => { console.error('\nFAILED:', err); srv.kill(); process.exit(1); });
