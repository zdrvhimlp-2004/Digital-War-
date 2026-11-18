#!/usr/bin/env node
/*
 * Uji beban Digital War dengan pemain virtual.
 * Pemakaian:  node tools/loadtest.js [jumlah_bot=12] [detik=30] [mode=world|duel]
 * Env:        BASE=http://localhost:3000  ADMIN_USER=admin  ADMIN_PASS=admin  ROOM=KODE (pakai room yang sudah ada)
 * Bot berlari acak, saling menyerang, menembakkan teknik, dan mengukur ping tiap 1 detik.
 * Ringkasan: pesan per detik per bot, ping rata-rata/p95/maks, dan putus koneksi.
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const N = parseInt(process.argv[2] || '12', 10), SECS = parseInt(process.argv[3] || '30', 10), MODE = process.argv[4] === 'duel' ? 'duel' : 'world';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body, tok) {
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
(async () => {
  let code = process.env.ROOM;
  if (!code) {
    const tok = (await api('/api/admin/login', { user: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin' })).token;
    if (!tok) { console.error('Login admin gagal (atur ADMIN_USER/ADMIN_PASS atau ROOM)'); process.exit(1); }
    code = (await api('/api/admin/rooms', { name: 'Uji beban', max: Math.max(N, 2), mode: MODE }, tok)).room.code;
  }
  console.log('Room', code, 'mode', MODE, '| bot', N, '| durasi', SECS, 'dtk');
  const stats = { msgs: 0, bytes: 0, rtt: [], closed: 0, errors: 0 };
  const bots = [];
  const camp = [{ x: 88, z: 0 }, { x: -90, z: 0 }, { x: 0, z: -92 }];
  for (let i = 0; i < N; i++) {
    const b = { i, x: 0, z: 0, tx: 0, tz: 0, fx: 1, fz: 0, id: 0 };
    b.ws = new WebSocket(WS);
    b.ws.onopen = () => b.ws.send(JSON.stringify({ t: 'join', code, name: 'Bot' + i, ch: i % 4, uid: 'lt' + Date.now() + '_' + i }));
    b.ws.onmessage = e => {
      stats.msgs++; stats.bytes += e.data.length;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'welcome') { b.id = m.id; b.x = m.spawn.x; b.z = m.spawn.z; b.ready = true; b.ws.send(JSON.stringify({ t: 'learn', slot: 0, code: '637' })); }
      else if (m.t === 'pong') stats.rtt.push(performance.now() - m.ts);
      else if (m.t === 'err') stats.errors++;
      else if (m.t === 'tp') { b.x = m.x; b.z = m.z; }
    };
    b.ws.onclose = () => { if (b.ready) stats.closed++; };
    bots.push(b);
    await sleep(60);
  }
  const t0 = Date.now();
  const tick = setInterval(() => {
    for (const b of bots) {
      if (!b.ready || b.ws.readyState !== 1) continue;
      if (Math.hypot(b.tx - b.x, b.tz - b.z) < 2 || Math.random() < 0.02) {
        const c = camp[b.i % 3];
        b.tx = MODE === 'duel' ? (Math.random() - 0.5) * 30 : c.x + (Math.random() - 0.5) * 50; b.tz = MODE === 'duel' ? 48 + (Math.random() - 0.5) * 30 : c.z + (Math.random() - 0.5) * 50;
      }
      const dx = b.tx - b.x, dz = b.tz - b.z, d = Math.hypot(dx, dz) || 1;
      b.fx = dx / d; b.fz = dz / d; b.x += b.fx * 0.9; b.z += b.fz * 0.9;
      b.ws.send(JSON.stringify({ t: 's', x: +b.x.toFixed(2), y: 0, z: +b.z.toFixed(2), fx: +b.fx.toFixed(2), fz: +b.fz.toFixed(2), m: 1, a: 0, sw: 0 }));
      if (Math.random() < 0.25) b.ws.send(JSON.stringify({ t: 'atk', fx: b.fx, fz: b.fz }));
      if (Math.random() < 0.06) b.ws.send(JSON.stringify({ t: 'cast', slot: 0, fx: b.fx, fy: 0, fz: b.fz }));
    }
  }, 66);
  const pinger = setInterval(() => { for (const b of bots) if (b.ready && b.ws.readyState === 1) b.ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })); }, 1000);
  const cpu0 = process.cpuUsage();
  await sleep(SECS * 1000);
  clearInterval(tick); clearInterval(pinger);
  const el = (Date.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
  const r = stats.rtt.sort((a, b) => a - b), avg = r.reduce((a, b) => a + b, 0) / (r.length || 1), p95 = r[Math.floor(r.length * 0.95)] || 0;
  console.log('--- hasil ---');
  console.log('pesan diterima  :', stats.msgs, '(' + Math.round(stats.msgs / el / N) + '/dtk per bot,', (stats.bytes / el / 1024).toFixed(0), 'KB/dtk total)');
  console.log('ping (ms)       : rata-rata', avg.toFixed(1), '| p95', p95.toFixed(1), '| maks', (r[r.length - 1] || 0).toFixed(1), '| sampel', r.length);
  console.log('koneksi putus   :', stats.closed, '| error', stats.errors);
  console.log('CPU penguji     :', ((cpu.user + cpu.system) / 1e6 / el * 100).toFixed(0) + '%');
  bots.forEach(b => { try { b.ws.close(); } catch (e) { } });
  process.exit(0);
})();
