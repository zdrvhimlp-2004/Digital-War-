#!/usr/bin/env node
/*
 * DIGITAL WAR — server satu file (tanpa dependency, cukup Node.js 18+)
 *
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js  -> ganti port
 *
 * Halaman:
 *   /            landing (masukkan kode room)
 *   /r/KODE      halaman game untuk satu room (link ini yang dibagikan ke teman)
 *   /admin       halaman admin (default: admin / admin) -> buat room, ganti password, edit buku teknik
 *
 * Data (password admin, room, buku teknik) disimpan di digital-war-data.json
 * (ubah lokasinya dengan env DATA_FILE).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'digital-war-data.json');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ====================================================================
 *  KONFIGURASI GAME
 * ==================================================================== */
const MAXHP = 100;
const TICK_MS = 33;             // simulasi server ~30 Hz
const SNAP_EVERY = 2;           // kirim posisi tiap 2 tick (~15 Hz)
const RESPAWN_MS = 3500;
const SPAWN_PROTECT_MS = 2000;
const MELEE = { dmg: 10, range: 2.9, cd: 380, knock: 7 };
const DOOR_COUNT = 8;           // 5 rumah tengah + 3 rumah jauh (sama dengan client)
const MAX_TECH_SLOTS = 5;
const ROOM_MAX_LIMIT = 100;
const CHAR_COUNT = 8;
const CHEST = { x: 3000, z: 0 };           // peti di dalam goa (koordinat interior goa)
const CHEST_RESET_MS = 60000;
const SNIPER = { ammo: 5, dmg: 45, range: 90, cd: 2200, width: 1.0 };
const SLEEP_REGEN = 6;                     // HP per detik saat tidur
const FORTS = [
  { id: 0, name: 'Benteng Fajar', x: 62, z: -52 },
  { id: 1, name: 'Benteng Senja', x: -72, z: -52 },
  { id: 2, name: 'Benteng Bayu', x: 40, z: 78 }
];
const FORT_RANGE = 7, FORT_CAPTURE_MS = 3000, FORT_AGGRO = 26, FORT_LEASH = 22;
const CAMPS = [
  { id: 0, x: 88, z: 0 },
  { id: 1, x: -90, z: 0 },
  { id: 2, x: 0, z: -92 }
];
const BANDIT_AGGRO = 17, BANDIT_LEASH = 26, BANDIT_RESPAWN_MS = 20000, BANDIT_HEAL = 12;
const BANDITS_PER_CAMP = { sword: 2, archer: 2, brute: 1 };
const BANDIT_OWNER = -1, BANDIT = { id: -1, name: 'Penyamun' };
const SOLDIER = { brute: { hp: 95, speed: 5.4, dmg: 14, range: 2.7, cd: 1150 }, sword: { hp: 45, speed: 6.5, dmg: 8, range: 2.4, cd: 1000 }, archer: { hp: 30, speed: 4.5, dmg: 7, range: 17, cd: 1800, arrow: 22 } };
const SOLDIERS_PER_FORT = { sword: 3, archer: 2 };
/* pasukan benteng: sebagian menjaga benteng, sebagian mengawal pemilik */
const FORT_ROSTER = [
  { kind: 'sword', role: 'guard' }, { kind: 'sword', role: 'guard' }, { kind: 'sword', role: 'escort' },
  { kind: 'archer', role: 'guard' }, { kind: 'archer', role: 'escort' }
];
const ESCORT_AGGRO = 18;
const MOB_HP = 40, MOUNT_HP = 70;
const CAVE_MOUTH = { x: -15, z: 87 };
const SOLDIER_RESPAWN_MS = 12000;
const CHAT_MAX = 140;
const SPAWN_RADIUS = 96;                   // titik spawn: pojok/tepi peta
const SPAWN_POINTS = Array.from({ length: 8 }, (_, k) => {
  const a = (22.5 + k * 45) * Math.PI / 180;
  return { x: Math.cos(a) * SPAWN_RADIUS, z: Math.sin(a) * SPAWN_RADIUS };
});

const TECH_VERSION = 5;
const OLD_CODE_MAP = {"6373828": "637", "3141592": "314", "8472916": "8472", "4242424": "4242", "5192837": "519", "5551234": "5551", "3735928": "3735", "2718281": "2718", "1618339": "1618", "4815162": "481", "1928374": "1928", "7294816": "7294", "9182736": "918", "9876543": "9876", "2468135": "246", "1357913": "1357", "7531946": "753"};
/* cooldown bawaan lama (v4) -> dipercepat di v5 */
const OLD_CD = { '637': 1, '314': 4, '8472': 5, '4242': 7, '519': 6, '5551': 11, '3735': 7, '2718': 9, '1618': 8, '481': 16, '1928': 24, '7294': 25, '918': 10, '9876': 14, '246': 12, '1357': 12, '753': 3 };
const DEFAULT_TECHS = [
  { code: '637', name: 'Byte Bolt',      kind: 'bolt',   emoji: '🔹', color: '#4de1ff', damage: 20, cd: 0.6, speed: 24, life: 1.4, count: 1, spread: 0 },
  { code: '314', name: 'Loop Barrage',   kind: 'bolt',   emoji: '🌀', color: '#b57bff', damage: 12, cd: 2,   speed: 22, life: 1.2, count: 3, spread: 0.22 },
  { code: '8472', name: 'Null Pointer',  kind: 'bolt',   emoji: '🎯', color: '#ff5d5d', damage: 38, cd: 2.5, speed: 38, life: 1.1, count: 1, spread: 0 },
  { code: '4242', name: 'Fork Bomb',     kind: 'bolt',   emoji: '🎆', color: '#ff9a3c', damage: 9,  cd: 3,   speed: 26, life: 1.2, count: 5, spread: 0.16 },
  { code: '858', name: 'Bola Biru',      kind: 'orb',    emoji: '🔵', color: '#2f8fff', damage: 3,  cd: 2,   speed: 11, life: 4, radius: 5.5 },
  { code: '519', name: 'Overflow Nova',  kind: 'nova',   emoji: '💥', color: '#ffd84d', damage: 30, cd: 3,   radius: 6 },
  { code: '5551', name: 'Freeze Frame',  kind: 'nova',   emoji: '❄️', color: '#aee6ff', damage: 8,  cd: 5,   radius: 5.5, stun: 2 },
  { code: '3735', name: 'Laser Beam',    kind: 'beam',   emoji: '📡', color: '#ff4de1', damage: 30, cd: 3,   range: 28 },
  { code: '2718', name: 'Stack Overflow', kind: 'slam',  emoji: '🔨', color: '#ffb84d', damage: 40, cd: 4,   radius: 5 },
  { code: '1618', name: 'Landmine',      kind: 'trap',   emoji: '💣', color: '#ff6a4d', damage: 35, cd: 3,   radius: 2.2, stun: 0.6 },
  { code: '481', name: 'Elang Digital',  kind: 'summon', emoji: '🦅', color: '#ffd9a0', damage: 9,  cd: 7,   count: 1, dur: 12, speed: 12 },
  { code: '1928', name: 'Elang Kembar',  kind: 'summon', emoji: '🦅', color: '#ffe9c0', damage: 7,  cd: 10,  count: 2, dur: 10, speed: 13 },
  { code: '7294', name: 'Elang Tunggangan', kind: 'ride', emoji: '🦅', color: '#ffe0b0', dur: 70, speed: 24, cd: 15 },
  { code: '918', name: 'Patch Heal',     kind: 'heal',   emoji: '💚', color: '#5dff9e', damage: 35, cd: 4 },
  { code: '9876', name: 'Auto Backup',   kind: 'regen',  emoji: '🔋', color: '#8affc0', damage: 40, cd: 6,   dur: 6 },
  { code: '246', name: 'Firewall',       kind: 'shield', emoji: '🛡️', color: '#6cd4ff', dur: 4,     cd: 5 },
  { code: '1357', name: 'Overclock',     kind: 'haste',  emoji: '⏩', color: '#fff27a', power: 1.6, dur: 5, cd: 5 },
  { code: '753', name: 'Lag Dash',       kind: 'dash',   emoji: '⚡', color: '#ffffff', speed: 60,  cd: 1.5 }
];
const TECH_KINDS = ['bolt', 'nova', 'heal', 'shield', 'dash', 'summon', 'slam', 'trap', 'beam', 'regen', 'haste', 'ride', 'orb'];

/* ====================================================================
 *  PENYIMPANAN
 * ==================================================================== */
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }

function freshDB() {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    admin: { user: 'admin', salt, hash: hashPw('admin', salt), changed: false },
    rooms: [],
    techniques: DEFAULT_TECHS.map(t => Object.assign({}, t)),
    techVersion: TECH_VERSION,
    settings: { showBook: true }
  };
}

let DB;
function loadDB() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!j.admin || !j.admin.hash) throw new Error('bad');
    j.rooms = Array.isArray(j.rooms) ? j.rooms : [];
    j.techniques = Array.isArray(j.techniques) ? j.techniques : DEFAULT_TECHS.map(t => Object.assign({}, t));
    j.settings = Object.assign({ showBook: true }, j.settings || {});
    const ver = j.techVersion || 1;
    if (ver < TECH_VERSION) {
      /* kode bawaan lama (7 digit) -> kode pendek 3-4 digit */
      for (const t of j.techniques) {
        const nc = OLD_CODE_MAP[t.code];
        if (nc && !j.techniques.some(x => x.code === nc)) t.code = nc;
      }
      if (ver < 5) {
        for (const d of DEFAULT_TECHS) {
          const t = j.techniques.find(x => x.code === d.code);
          if (!t) continue;
          if (OLD_CD[t.code] !== undefined && Number(t.cd) === OLD_CD[t.code]) t.cd = d.cd;
          if (t.kind === 'ride') { if (Number(t.dur) === 10) t.dur = d.dur; if (Number(t.speed) === 13) t.speed = d.speed; }
          if (t.kind === 'trap') delete t.dur;
        }
        if (!j.techniques.some(x => x.code === '858')) j.techniques.push(Object.assign({}, DEFAULT_TECHS.find(x => x.code === '858')));
      }
      if (ver < 3) for (const d of DEFAULT_TECHS) if (!j.techniques.some(t => t.code === d.code)) j.techniques.push(Object.assign({}, d));
      j.techVersion = TECH_VERSION;
      DB = j; saveDBNow();
    }
    DB = j;
  } catch (e) {
    DB = freshDB();
    saveDBNow();
  }
}
let saveTimer = null;
function saveDBNow() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Gagal menyimpan data:', e.message); }
}
function saveDB() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDBNow, 150); }

/* ====================================================================
 *  UTIL
 * ==================================================================== */
const now = () => Date.now();
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function num(v, a, b, d) { v = Number(v); if (!isFinite(v)) return d; return clampN(v, a, b); }
function cleanName(s, maxLen) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}
const r2 = v => Math.round(v * 100) / 100;

function sanitizeTech(t) {
  if (!t || typeof t !== 'object') return null;
  const code = String(t.code || '').trim();
  if (!/^[1-9]{2,12}$/.test(code)) return { error: 'Kode "' + cleanName(code, 14) + '" tidak valid (hanya angka 1-9, 2-12 digit)' };
  const kind = TECH_KINDS.includes(t.kind) ? t.kind : 'bolt';
  const out = {
    code,
    name: cleanName(t.name, 24) || 'Teknik',
    kind,
    emoji: String(t.emoji || '✨').slice(0, 4),
    color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#4de1ff',
    cd: num(t.cd, 0.2, 120, 2)
  };
  const desc = cleanName(t.desc, 80); if (desc) out.desc = desc;
  if (['bolt', 'nova', 'beam', 'trap'].includes(kind)) out.stun = num(t.stun, 0, 5, 0);
  if (kind === 'bolt') {
    out.damage = num(t.damage, 0, 100, 20); out.speed = num(t.speed, 5, 80, 24); out.life = num(t.life, 0.3, 4, 1.4);
    out.count = Math.round(num(t.count, 1, 7, 1)); out.spread = num(t.spread, 0, 1, 0);
  } else if (kind === 'nova') {
    out.damage = num(t.damage, 0, 100, 30); out.radius = num(t.radius, 2, 15, 6);
  } else if (kind === 'heal') {
    out.damage = num(t.damage, 1, MAXHP, 35);
  } else if (kind === 'shield') {
    out.dur = num(t.dur, 1, 15, 4);
  } else if (kind === 'dash') {
    out.speed = num(t.speed, 20, 120, 60);
  } else if (kind === 'summon') {
    out.damage = num(t.damage, 1, 60, 9); out.count = Math.round(num(t.count, 1, 4, 1)); out.dur = num(t.dur, 3, 30, 12); out.speed = num(t.speed, 5, 25, 12);
  } else if (kind === 'slam') {
    out.damage = num(t.damage, 0, 100, 40); out.radius = num(t.radius, 2, 12, 5);
  } else if (kind === 'trap') {
    out.damage = num(t.damage, 0, 100, 35); out.radius = num(t.radius, 1, 5, 2.2);
  } else if (kind === 'beam') {
    out.damage = num(t.damage, 0, 100, 30); out.range = num(t.range, 5, 50, 28);
  } else if (kind === 'regen') {
    out.damage = num(t.damage, 1, MAXHP, 40); out.dur = num(t.dur, 2, 20, 6);
  } else if (kind === 'ride') {
    out.dur = num(t.dur, 3, 300, 70); out.speed = num(t.speed, 6, 60, 24);
  } else if (kind === 'orb') {
    out.damage = num(t.damage, 0, 50, 3); out.speed = num(t.speed, 3, 40, 11); out.life = num(t.life, 1, 10, 4); out.radius = num(t.radius, 2, 12, 5.5);
  } else if (kind === 'haste') {
    out.power = num(t.power, 1.1, 2.5, 1.6); out.dur = num(t.dur, 1, 15, 5);
  }
  return out;
}
const techByCode = code => DB.techniques.find(t => t.code === code);
const techPublic = t => ({ code: t.code, name: t.name, kind: t.kind, emoji: t.emoji, color: t.color, cd: t.cd });
function techDesc(t) {
  if (t.desc) return t.desc;
  const st = t.stun ? ', beku ' + t.stun + ' dtk' : '';
  switch (t.kind) {
    case 'bolt': return 'Peluru ' + t.damage + ' dmg' + (t.count > 1 ? ' x' + t.count : '') + st;
    case 'nova': return 'Ledakan radius ' + t.radius + ', ' + t.damage + ' dmg' + st;
    case 'heal': return 'Pulihkan ' + t.damage + ' HP';
    case 'shield': return 'Perisai ' + t.dur + ' dtk, damage -70%';
    case 'dash': return 'Lesat ke depan, kebal sebentar';
    case 'summon': return 'Panggil ' + t.count + ' elang selama ' + t.dur + ' dtk, ' + t.damage + ' dmg/serangan';
    case 'slam': return 'Lompat tinggi lalu hantam, radius ' + t.radius + ', ' + t.damage + ' dmg';
    case 'trap': return 'Ranjau tak terlihat musuh, tidak hilang sampai meledak, ' + t.damage + ' dmg' + st;
    case 'beam': return 'Sinar tembus ' + t.range + ' m, ' + t.damage + ' dmg' + st;
    case 'regen': return 'Pulih ' + t.damage + ' HP selama ' + t.dur + ' dtk';
    case 'ride': return 'Tunggangi elang terbang ' + t.dur + ' dtk (Lompat naik, Selam turun)';
    case 'orb': return 'Bola biru raksasa radius ' + t.radius + ', ' + t.damage + ' dmg per sentuhan, bisa diarahkan ke atas, bawah, samping';
    case 'haste': return 'Lari ' + t.power + 'x lebih cepat ' + t.dur + ' dtk';
  }
  return '';
}

/* ====================================================================
 *  ROOM (runtime)
 * ==================================================================== */
const rooms = new Map(); // code -> runtime room
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRoomCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!DB.rooms.some(r => r.code === c)) return c;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
function makeRuntime(r) {
  return {
    code: r.code, name: r.name, max: r.max, created: r.created,
    players: new Map(), doors: new Array(DOOR_COUNT).fill(false), projs: [], mobs: [], traps: [], orbs: [], sols: [], forts: makeForts(), campNext: {}, later: [], chest: { open: false, reopenAt: 0 }, chatLog: [], voice: r.voice !== false,
    nextPid: 1, hour0: 9, t0: now(), tickN: 0
  };
}
function newRuntime(r) { const rt = makeRuntime(r); initBandits(rt); return rt; }
function roomHour(room) { return (room.hour0 + (now() - room.t0) / 1000 * 0.04) % 24; }

function send(ws, obj) { if (ws && !ws.closed) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.id !== exceptId && !p.ws.closed) p.ws.send(s);
}
function scoreList(room) { return [...room.players.values()].map(p => [p.id, p.k, p.d]); }

function randomSpawn() {
  const sp = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
  return { x: r2(sp.x + (Math.random() - 0.5) * 10), z: r2(sp.z + (Math.random() - 0.5) * 10) };
}

let projSeq = 1, mobSeq = 1, trapSeq = 1, orbSeq = 1, solSeq = 100000;
const GUARD_WINDOW = 3000, GUARD_MAX = 3, GUARD_BREAK_MS = 2500;
const MAX_TRAPS = 6;

/* ---- target umum: pemain + pasukan benteng ---- */
function victims(room) {
  const a = [];
  for (const p of room.players.values()) if (!p.dead) a.push(p);
  for (const s of room.sols) a.push(s);
  for (const m of room.mobs) a.push({ isMob: true, m, id: m.id, o: m.o, x: m.x, y: m.y - 0.9, z: m.z });
  return a;
}
function friendly(ownerId, v) { if (v.isMob) return v.o === ownerId; return v.id === ownerId || (v.isSol && v.owner === ownerId); }
function damageMob(room, m, dmg, attacker) {
  if (m.hp <= 0) return;
  if (attacker && attacker.id === m.o) return;
  dmg = Math.max(1, Math.round(dmg));
  m.hp = Math.max(0, m.hp - dmg);
  broadcast(room, { t: 'mh', id: m.id, hp: m.hp, dmg });
  if (m.hp <= 0) {
    const i = room.mobs.indexOf(m);
    if (i >= 0) room.mobs.splice(i, 1);
    broadcast(room, { t: 'mobx', id: m.id, dead: 1 });
  }
}
function hurt(room, v, dmg, attacker, kx, kz, opt) {
  if (v.isMob) damageMob(room, v.m, dmg, attacker);
  else if (v.isSol) damageSoldier(room, v, dmg, attacker);
  else damagePlayer(room, v, dmg, attacker, kx, kz, opt);
}
function damageSoldier(room, s, dmg, attacker) {
  if (s.dead) return;
  if (attacker && friendly(attacker.id, s)) return;
  dmg = Math.max(1, Math.round(dmg));
  s.hp = Math.max(0, s.hp - dmg);
  broadcast(room, { t: 'sh', id: s.id, hp: s.hp, dmg });
  if (s.hp <= 0) {
    s.dead = true;
    room.sols = room.sols.filter(x => x !== s);
    broadcast(room, { t: 'solx', id: s.id, dead: 1 });
    if (s.bandit) {
      if (attacker && attacker.hp !== undefined && !attacker.dead && attacker.id > 0) { attacker.hp = Math.min(MAXHP, attacker.hp + BANDIT_HEAL); broadcast(room, { t: 'hp', id: attacker.id, hp: attacker.hp }); send(attacker.ws, { t: 'bloot', heal: BANDIT_HEAL }); }
    } else {
      const f = room.forts[s.fort];
      if (f && f.nextSpawn <= now()) f.nextSpawn = now() + SOLDIER_RESPAWN_MS;
    }
  }
}

function setSleep(room, p, on) {
  on = !!on && !p.dead;
  if (p.sleeping === on) return;
  p.sleeping = on;
  broadcast(room, { t: 'sleep', id: p.id, on });
}
function setAmmo(p, n) { p.ammo = n; send(p.ws, { t: 'wpn', ammo: n }); }

/* Tameng: bisa menahan serangan dari depan. Kalau 3 serangan masuk dalam 3 detik, tameng pecah. */
function setGuard(room, p, on) {
  on = !!on;
  const t = now();
  if (on && (p.dead || t < p.gbUntil || t < p.stunUntil)) on = false;
  if (p.guarding === on) return;
  p.guarding = on; p.gh = [];
  broadcast(room, { t: 'guard', id: p.id, on });
}

/* opt: { sx, sz } arah dari korban ke sumber serangan; area: serangan area (tameng hanya kurangi 50%); stun: detik */
function damagePlayer(room, victim, dmg, attacker, kx, kz, opt) {
  opt = opt || {};
  const t = now();
  if (victim.dead || t < victim.invuln) return;
  if (victim.sleeping) setSleep(room, victim, false);
  if (victim.rideUntil && victim.mountHp > 0) {
    const d = Math.max(1, Math.round(dmg));
    victim.mountHp = Math.max(0, victim.mountHp - d);
    broadcast(room, { t: 'hit', id: victim.id, by: attacker ? attacker.id : 0, dmg: d, hp: victim.hp, kx: 0, kz: 0, mnt: 1, mhp: victim.mountHp });
    if (victim.mountHp <= 0) { victim.rideUntil = 0; broadcast(room, { t: 'fx', k: 'rideend', id: victim.id }); }
    return;
  }
  if (victim.guarding) {
    if (opt.area) dmg *= 0.5;
    else if (opt.sx !== undefined && (victim.fx * opt.sx + victim.fz * opt.sz) > 0) {
      victim.gh = victim.gh.filter(x => t - x < GUARD_WINDOW);
      victim.gh.push(t);
      if (victim.gh.length < GUARD_MAX) {
        broadcast(room, { t: 'hit', id: victim.id, by: attacker ? attacker.id : 0, dmg: 0, hp: victim.hp, kx: 0, kz: 0, blk: 1, left: GUARD_MAX - victim.gh.length });
        return;
      }
      victim.guarding = false; victim.gh = []; victim.gbUntil = t + GUARD_BREAK_MS;
      broadcast(room, { t: 'gbreak', id: victim.id });
      broadcast(room, { t: 'guard', id: victim.id, on: false });
    }
  }
  if (t < victim.shield) dmg *= 0.3;
  dmg = Math.max(1, Math.round(dmg));
  victim.hp = Math.max(0, victim.hp - dmg);
  broadcast(room, { t: 'hit', id: victim.id, by: attacker ? attacker.id : 0, dmg, hp: victim.hp, kx: r2(kx || 0), kz: r2(kz || 0) });
  if (victim.hp <= 0) {
    victim.dead = true;
    victim.respawnAt = t + RESPAWN_MS;
    victim.d++;
    if (victim.ammo) setAmmo(victim, 0);
    if (victim.guarding) { victim.guarding = false; broadcast(room, { t: 'guard', id: victim.id, on: false }); }
    if (attacker && attacker !== victim && attacker.k !== undefined) attacker.k++;
    broadcast(room, { t: 'die', id: victim.id, name: victim.name, by: attacker ? attacker.id : 0, byName: attacker ? attacker.name : '', ms: RESPAWN_MS });
    broadcast(room, { t: 'sc', s: scoreList(room) });
  } else if (opt.stun) {
    victim.stunUntil = t + opt.stun * 1000;
    if (victim.guarding) setGuard(room, victim, false);
    broadcast(room, { t: 'stun', id: victim.id, ms: Math.round(opt.stun * 1000) });
  }
}

function doMelee(room, p, fx, fz) {
  const t = now();
  if (p.dead || t - p.atkAt < MELEE.cd - 60) return;
  if (p.guarding) setGuard(room, p, false);
  if (p.sleeping) setSleep(room, p, false);
  p.atkAt = t;
  broadcast(room, { t: 'atk', id: p.id, fx, fz });
  for (const v of victims(room)) {
    if (v === p || friendly(p.id, v)) continue;
    const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
    if (d > MELEE.range || Math.abs(v.y - p.y) > 2.2) continue;
    if (d > 0.01 && (dx * fx + dz * fz) / d < -0.1) continue;
    const nx = d > 0.01 ? dx / d : fx, nz = d > 0.01 ? dz / d : fz;
    hurt(room, v, MELEE.dmg, p, nx * MELEE.knock, nz * MELEE.knock, { sx: -nx, sz: -nz });
  }
}

function areaHit(room, p, radius, dmg, kb, stun) {
  for (const v of victims(room)) {
    if (v === p || friendly(p.id, v)) continue;
    const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
    if (d > radius || Math.abs(v.y - p.y) > 3) continue;
    const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
    hurt(room, v, dmg, p, nx * kb, nz * kb, { area: true, stun });
  }
}

function doCast(room, p, slot, ax, ay, az) {
  if (p.dead || slot < 0 || slot >= MAX_TECH_SLOTS) return;
  const code = p.slots[slot];
  if (!code) return;
  const tech = techByCode(code);
  if (!tech) { p.slots[slot] = null; send(p.ws, { t: 'slotclear', slot }); return; }
  const t = now();
  if (t < p.stunUntil) return;
  if ((p.cdUntil[code] || 0) > t + 120) return;
  p.cdUntil[code] = t + tech.cd * 1000;
  if (p.guarding) setGuard(room, p, false);
  if (p.sleeping) setSleep(room, p, false);
  /* arah bidik 3D (ay = naik/turun) */
  let l = Math.hypot(ax, az);
  if (l < 0.01) { ax = 0; az = 1; l = 1; }
  ay = clampN(ay, -0.95, 0.95);
  const hl = Math.sqrt(Math.max(0.0001, 1 - ay * ay));
  const fx = ax / l, fz = az / l;                 // arah horizontal (satuan)
  const bx = fx * hl, bz = fz * hl, by = ay;      // arah 3D (satuan)
  broadcast(room, { t: 'fx', k: 'cast', id: p.id, c: tech.color, fx: r2(fx), fz: r2(fz), kind: tech.kind });
  switch (tech.kind) {
    case 'bolt': {
      const n = tech.count || 1;
      for (let i = 0; i < n; i++) {
        const ang = (i - (n - 1) / 2) * (tech.spread || 0), cs = Math.cos(ang), sn = Math.sin(ang);
        const dx = bx * cs - bz * sn, dz = bx * sn + bz * cs;
        const pr = { id: projSeq++, o: p.id, x: p.x + dx * 0.9, y: p.y + 1.0 + by * 0.9, z: p.z + dz * 0.9, dx, dy: by, dz, sp: tech.speed, life: tech.life, dmg: tech.damage, stun: tech.stun || 0, c: tech.color };
        room.projs.push(pr);
        broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(dx), dy: r2(by), dz: r2(dz), sp: pr.sp, life: pr.life, c: pr.c, sz: 1 });
      }
      break;
    }
    case 'orb': {
      const r = tech.radius || 5.5;
      const orb = { id: orbSeq++, o: p.id, x: p.x + bx * (r + 1), y: p.y + 1.2 + by * (r + 1), z: p.z + bz * (r + 1), dx: bx, dy: by, dz: bz, sp: tech.speed || 11, life: tech.life || 4, r, dmg: tech.damage, c: tech.color, hit: new Map() };
      room.orbs.push(orb);
      broadcast(room, { t: 'orb', id: orb.id, o: p.id, x: r2(orb.x), y: r2(orb.y), z: r2(orb.z), dx: r2(bx), dy: r2(by), dz: r2(bz), sp: orb.sp, life: orb.life, r, c: orb.c });
      break;
    }
    case 'nova': {
      broadcast(room, { t: 'fx', k: 'nova', id: p.id, r: tech.radius, c: tech.color });
      areaHit(room, p, tech.radius, tech.damage, 14, tech.stun || 0);
      break;
    }
    case 'slam': {
      broadcast(room, { t: 'fx', k: 'leap', id: p.id, fx: r2(fx), fz: r2(fz), c: tech.color });
      room.later.push({ at: t + 800, fn: () => {
        if (!room.players.has(p.id) || p.dead) return;
        broadcast(room, { t: 'fx', k: 'nova', id: p.id, r: tech.radius, c: tech.color });
        areaHit(room, p, tech.radius, tech.damage, 16, 0);
      } });
      break;
    }
    case 'beam': {
      const len = tech.range || 28;
      broadcast(room, { t: 'fx', k: 'beam', id: p.id, fx: r2(fx), fz: r2(fz), len, c: tech.color });
      for (const v of victims(room)) {
        if (v === p || friendly(p.id, v)) continue;
        const rx = v.x - p.x, rz = v.z - p.z, along = rx * fx + rz * fz, perp = Math.abs(rx * fz - rz * fx);
        if (along < 0 || along > len || perp > 1.3 || Math.abs(v.y + 0.9 - (p.y + 1)) > 1.6) continue;
        hurt(room, v, tech.damage, p, fx * 7, fz * 7, { sx: -fx, sz: -fz, stun: tech.stun || 0 });
      }
      break;
    }
    case 'trap': {
      /* ranjau: tidak hilang sendiri, hanya terlihat oleh pemiliknya, meledak saat musuh menginjak */
      const mine = room.traps.filter(x => x.o === p.id);
      if (mine.length >= MAX_TRAPS) {
        p.cdUntil[code] = 0;
        send(p.ws, { t: 'toast', msg: 'Batas ranjau ' + MAX_TRAPS + ' buah. Ledakkan dulu yang lama.' });
        break;
      }
      const tr = { id: trapSeq++, o: p.id, x: p.x, y: p.y, z: p.z, r: tech.radius || 2.2, dmg: tech.damage, stun: tech.stun || 0, c: tech.color, armAt: t + 800 };
      room.traps.push(tr);
      send(p.ws, { t: 'trap', id: tr.id, o: p.id, x: r2(tr.x), y: r2(tr.y), z: r2(tr.z), r: tr.r, c: tr.c });
      break;
    }
    case 'summon': {
      const n = tech.count || 1;
      let have = room.mobs.filter(m => m.o === p.id).length;
      for (let i = 0; i < n && have < 4; i++, have++) {
        const m = { id: mobSeq++, o: p.id, k: 'eagle', hp: MOB_HP, x: p.x + (i - (n - 1) / 2) * 1.6, y: p.y + 3, z: p.z, fx, fz, until: t + tech.dur * 1000, dmg: tech.damage, sp: tech.speed || 12, atkAt: 0, tgt: 0, tgtAt: 0, atkFlag: 0, c: tech.color };
        room.mobs.push(m);
        broadcast(room, { t: 'mob', id: m.id, o: p.id, k: 'eagle', hp: MOB_HP, x: r2(m.x), y: r2(m.y), z: r2(m.z), c: m.c });
      }
      break;
    }
    case 'heal': {
      p.hp = Math.min(MAXHP, p.hp + tech.damage);
      broadcast(room, { t: 'fx', k: 'heal', id: p.id, v: Math.round(tech.damage), c: tech.color });
      broadcast(room, { t: 'hp', id: p.id, hp: p.hp });
      break;
    }
    case 'regen': {
      p.regenUntil = t + tech.dur * 1000; p.regenRate = tech.damage / tech.dur; p.regenAcc = 0;
      broadcast(room, { t: 'fx', k: 'regen', id: p.id, dur: tech.dur, c: tech.color });
      break;
    }
    case 'shield': {
      p.shield = t + tech.dur * 1000;
      broadcast(room, { t: 'fx', k: 'shield', id: p.id, dur: tech.dur, c: tech.color });
      break;
    }
    case 'haste': {
      broadcast(room, { t: 'fx', k: 'haste', id: p.id, dur: tech.dur, pw: tech.power || 1.6, c: tech.color });
      break;
    }
    case 'ride': {
      p.rideUntil = t + tech.dur * 1000; p.mountHp = MOUNT_HP;
      broadcast(room, { t: 'fx', k: 'ride', id: p.id, dur: tech.dur, pw: tech.speed || 24, c: tech.color });
      break;
    }
    case 'dash': {
      p.invuln = Math.max(p.invuln, t + 350);
      broadcast(room, { t: 'fx', k: 'dash', id: p.id, fx: r2(fx), fz: r2(fz), pw: tech.speed, c: tech.color });
      break;
    }
  }
}

function doSnipe(room, p, ax, ay, az) {
  const t = now();
  if (p.dead || p.ammo <= 0 || t - p.snipeAt < SNIPER.cd - 80 || t < p.stunUntil) return;
  p.snipeAt = t;
  if (p.guarding) setGuard(room, p, false);
  if (p.sleeping) setSleep(room, p, false);
  const l = Math.hypot(ax, az) || 1, fx = ax / l, fz = az / l;
  setAmmo(p, p.ammo - 1);
  broadcast(room, { t: 'fx', k: 'snipe', id: p.id, fx: r2(fx), fz: r2(fz), len: SNIPER.range });
  let hit = null, hd = 1e9;
  for (const v of victims(room)) {
    if (v === p || friendly(p.id, v)) continue;
    const rx = v.x - p.x, rz = v.z - p.z, along = rx * fx + rz * fz, perp = Math.abs(rx * fz - rz * fx);
    if (along < 0 || along > SNIPER.range || perp > SNIPER.width || Math.abs(v.y + 0.9 - (p.y + 1)) > 1.6) continue;
    if (along < hd) { hd = along; hit = v; }
  }
  if (hit) hurt(room, hit, SNIPER.dmg, p, fx * 8, fz * 8, { sx: -fx, sz: -fz });
}

/* ---- benteng & pasukan ---- */
function makeForts() { return FORTS.map(f => ({ id: f.id, name: f.name, x: f.x, z: f.z, owner: 0, ownerName: '', ownerCh: 0, cap: null, nextSpawn: 0 })); }
function fortPublic(f) { return { id: f.id, owner: f.owner, name: f.ownerName, ch: f.ownerCh }; }
function solPublic(s) { return { id: s.id, fort: s.fort, kind: s.kind, x: r2(s.x), z: r2(s.z), hp: s.hp, max: s.max, owner: s.owner, ch: s.ch, bandit: s.bandit ? 1 : 0 }; }
function spawnBandit(room, c, kind) {
  const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 4, sp = SOLDIER[kind];
  const s = { id: solSeq++, isSol: true, bandit: true, camp: c.id, fort: -1, owner: BANDIT_OWNER, ch: 0, kind, x: c.x + Math.cos(a) * r, y: 0, z: c.z + Math.sin(a) * r, fx: 0, fz: 1, hp: sp.hp, max: sp.hp, atkAt: 0, dead: false, atkFlag: 0, hx: c.x + Math.cos(a) * r, hz: c.z + Math.sin(a) * r, alert: 0 };
  room.sols.push(s);
  broadcast(room, { t: 'sol', s: solPublic(s) });
  return s;
}
function initBandits(room) { for (const c of CAMPS) for (const kind of Object.keys(BANDITS_PER_CAMP)) for (let i = 0; i < BANDITS_PER_CAMP[kind]; i++) spawnBandit(room, c, kind); }
function stepBandits(room, dt, t) {
  for (const c of CAMPS) {
    if (t < (room.campNext[c.id] || 0)) continue;
    for (const kind of Object.keys(BANDITS_PER_CAMP)) {
      const have = room.sols.filter(s => s.bandit && s.camp === c.id && s.kind === kind).length;
      if (have < BANDITS_PER_CAMP[kind]) { spawnBandit(room, c, kind); room.campNext[c.id] = t + BANDIT_RESPAWN_MS; break; }
    }
  }
  for (const s of room.sols) {
    if (!s.bandit) continue;
    const c = CAMPS[s.camp], sp = SOLDIER[s.kind];
    let best = null, bd = 1e9;
    for (const v of room.players.values()) {
      if (v.dead || v.x > 1000 || t < v.invuln) continue;
      if (Math.hypot(v.x - c.x, v.z - c.z) > BANDIT_AGGRO) continue;
      const d = Math.hypot(v.x - s.x, v.z - s.z);
      if (d < bd) { bd = d; best = v; }
    }
    let tx = s.hx, tz = s.hz, speed = sp.speed * 0.5;
    if (best) {
      const dx = best.x - s.x, dz = best.z - s.z, d = bd || 0.01;
      s.fx = dx / d; s.fz = dz / d;
      if (!s.alert) { s.alert = 1; broadcast(room, { t: 'bshout', id: s.id }); }
      if (s.kind !== 'archer') {
        if (d > sp.range * 0.8) { tx = best.x; tz = best.z; speed = sp.speed; }
        else {
          tx = s.x; tz = s.z;
          if (t >= s.atkAt && Math.abs(best.y - s.y) < 2.6) { s.atkAt = t + sp.cd; s.atkFlag = 1; hurt(room, best, sp.dmg, BANDIT, s.fx * 5, s.fz * 5, { sx: -s.fx, sz: -s.fz }); }
        }
      } else {
        if (d > sp.range) { tx = best.x; tz = best.z; speed = sp.speed; }
        else if (d < 6) { tx = s.x - s.fx * 3; tz = s.z - s.fz * 3; speed = sp.speed; }
        else { tx = s.x; tz = s.z; }
        if (d < sp.range + 4 && t >= s.atkAt) {
          s.atkAt = t + sp.cd; s.atkFlag = 1;
          const dyy = clampN((best.y + 0.9 - 1.1) / d, -0.3, 0.3), hl = Math.sqrt(1 - dyy * dyy);
          const pr = { id: projSeq++, o: BANDIT_OWNER, x: s.x + s.fx * 0.8, y: 1.1, z: s.z + s.fz * 0.8, dx: s.fx * hl, dy: dyy, dz: s.fz * hl, sp: sp.arrow, life: 1.3, dmg: sp.dmg, stun: 0, c: '#b0764a' };
          room.projs.push(pr);
          broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(pr.dx), dy: r2(pr.dy), dz: r2(pr.dz), sp: pr.sp, life: pr.life, c: pr.c, sz: 0.55 });
        }
      }
    } else s.alert = 0;
    const ddx = tx - s.x, ddz = tz - s.z, dd = Math.hypot(ddx, ddz);
    if (dd > 0.2) {
      const step = Math.min(dd, speed * dt);
      let nx = s.x + ddx / dd * step, nz = s.z + ddz / dd * step;
      const fd = Math.hypot(nx - c.x, nz - c.z);
      if (fd > BANDIT_LEASH) { nx = c.x + (nx - c.x) / fd * BANDIT_LEASH; nz = c.z + (nz - c.z) / fd * BANDIT_LEASH; }
      s.x = nx; s.z = nz;
      if (!best) { s.fx = ddx / dd; s.fz = ddz / dd; }
    }
  }
}
function spawnSoldier(room, f, kind, role) {
  const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 3;
  const sp = SOLDIER[kind];
  const s = { id: solSeq++, isSol: true, role: role || 'guard', eo: Math.random() * 6.28, fort: f.id, owner: f.owner, ch: f.ownerCh, kind, x: f.x + Math.cos(a) * r, y: 0, z: f.z + Math.sin(a) * r, fx: 0, fz: 1, hp: sp.hp, max: sp.hp, atkAt: 0, dead: false, atkFlag: 0, hx: f.x + Math.cos(a) * r, hz: f.z + Math.sin(a) * r };
  room.sols.push(s);
  broadcast(room, { t: 'sol', s: solPublic(s) });
  return s;
}
function clearFortSoldiers(room, f) {
  room.sols = room.sols.filter(s => { if (s.fort === f.id) { broadcast(room, { t: 'solx', id: s.id }); return false; } return true; });
}
function setFortOwner(room, f, p) {
  clearFortSoldiers(room, f);
  f.owner = p ? p.id : 0; f.ownerName = p ? p.name : ''; f.ownerCh = p ? p.ch : 0; f.cap = null;
  broadcast(room, { t: 'fort', f: fortPublic(f) });
  if (p) {
    for (const e of FORT_ROSTER) spawnSoldier(room, f, e.kind, e.role);
    f.nextSpawn = now() + SOLDIER_RESPAWN_MS;
  }
}
function startCapture(room, p, fid) {
  const f = room.forts[fid];
  if (!f || p.dead || p.x > 1000 || f.owner === p.id) return;
  if (Math.hypot(p.x - f.x, p.z - f.z) > FORT_RANGE) return;
  const t = now();
  if (f.cap && f.cap.by !== p.id && t < f.cap.end) { send(p.ws, { t: 'toast', msg: 'Benteng sedang direbut orang lain' }); return; }
  if (f.cap && f.cap.by === p.id) return;
  f.cap = { by: p.id, end: t + FORT_CAPTURE_MS };
  broadcast(room, { t: 'cap', fort: f.id, by: p.id, name: p.name, ms: FORT_CAPTURE_MS });
}
function stepForts(room, dt, t) {
  for (const f of room.forts) {
    if (f.cap) {
      const p = room.players.get(f.cap.by);
      if (!p || p.dead || p.x > 1000 || Math.hypot(p.x - f.x, p.z - f.z) > FORT_RANGE + 3) {
        f.cap = null; broadcast(room, { t: 'cap', fort: f.id, cancel: 1 });
      } else if (t >= f.cap.end) {
        setFortOwner(room, f, p);
        broadcast(room, { t: 'toast', msg: p.name + ' merebut ' + f.name + '!' });
      }
    }
    if (f.owner && t >= f.nextSpawn) {
      const need = {};
      for (const e of FORT_ROSTER) need[e.kind + ':' + e.role] = (need[e.kind + ':' + e.role] || 0) + 1;
      for (const key of Object.keys(need)) {
        const [kind, role] = key.split(':');
        const have = room.sols.filter(s => s.fort === f.id && s.kind === kind && s.role === role).length;
        if (have < need[key]) { spawnSoldier(room, f, kind, role); f.nextSpawn = t + SOLDIER_RESPAWN_MS; break; }
      }
    }
  }
  const vs = victims(room);
  for (const s of room.sols) {
    if (s.bandit) continue;
    const f = room.forts[s.fort], sp = SOLDIER[s.kind], owner = room.players.get(s.owner);
    if (!f || !owner) continue;
    const escort = s.role === 'escort';
    const ax = escort ? (owner.x > 1000 ? CAVE_MOUTH.x : owner.x) : f.x, az = escort ? (owner.x > 1000 ? CAVE_MOUTH.z : owner.z) : f.z;
    if (escort && Math.hypot(ax - s.x, az - s.z) > 70) { s.x = ax + Math.cos(s.eo) * 3; s.z = az + Math.sin(s.eo) * 3; }
    /* cari musuh terdekat dekat jangkar (benteng atau pemilik) */
    let best = null, bd = 1e9;
    for (const v of vs) {
      if (friendly(s.owner, v) || (v.isSol && v.dead) || v.x > 1000) continue;
      if (Math.hypot(v.x - ax, v.z - az) > (escort ? ESCORT_AGGRO : FORT_AGGRO)) continue;
      const d = Math.hypot(v.x - s.x, v.z - s.z);
      if (d < bd) { bd = d; best = v; }
    }
    let tx, tz, speed = sp.speed * 0.6;
    if (escort) { tx = ax + Math.cos(s.eo) * 3.2; tz = az + Math.sin(s.eo) * 3.2; const dd0 = Math.hypot(tx - s.x, tz - s.z); if (dd0 < 1.2) { tx = s.x; tz = s.z; } else speed = sp.speed * (dd0 > 8 ? 1.35 : 0.9); }
    else { tx = s.hx; tz = s.hz; }
    if (best) {
      const dx = best.x - s.x, dz = best.z - s.z, d = bd || 0.01;
      s.fx = dx / d; s.fz = dz / d;
      if (s.kind === 'sword') {
        if (d > sp.range * 0.8) { tx = best.x; tz = best.z; speed = sp.speed; }
        else {
          tx = s.x; tz = s.z;
          if (t >= s.atkAt && Math.abs(best.y - s.y) < 2.6) { s.atkAt = t + sp.cd; s.atkFlag = 1; hurt(room, best, sp.dmg, owner, s.fx * 5, s.fz * 5, { sx: -s.fx, sz: -s.fz }); }
        }
      } else {
        if (d > sp.range) { tx = best.x; tz = best.z; speed = sp.speed; }
        else if (d < 6) { tx = s.x - s.fx * 3; tz = s.z - s.fz * 3; speed = sp.speed; }
        else { tx = s.x; tz = s.z; }
        if (d < sp.range + 4 && t >= s.atkAt) {
          s.atkAt = t + sp.cd; s.atkFlag = 1;
          const dyy = clampN((best.y + 0.9 - 1.1) / d, -0.3, 0.3), hl = Math.sqrt(1 - dyy * dyy);
          const pr = { id: projSeq++, o: s.owner, x: s.x + s.fx * 0.8, y: 1.1, z: s.z + s.fz * 0.8, dx: s.fx * hl, dy: dyy, dz: s.fz * hl, sp: sp.arrow, life: 1.3, dmg: sp.dmg, stun: 0, c: '#d9b27a' };
          room.projs.push(pr);
          broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(pr.dx), dy: r2(pr.dy), dz: r2(pr.dz), sp: pr.sp, life: pr.life, c: pr.c, sz: 0.55 });
        }
      }
    }
    const ddx = tx - s.x, ddz = tz - s.z, dd = Math.hypot(ddx, ddz);
    if (dd > 0.2) {
      const step = Math.min(dd, speed * dt);
      let nx = s.x + ddx / dd * step, nz = s.z + ddz / dd * step;
      if (!escort) { const fd = Math.hypot(nx - f.x, nz - f.z); if (fd > FORT_LEASH) { nx = f.x + (nx - f.x) / fd * FORT_LEASH; nz = f.z + (nz - f.z) / fd * FORT_LEASH; } }
      s.x = nx; s.z = nz;
      if (!best) { s.fx = ddx / dd; s.fz = ddz / dd; }
    }
  }
}

function stepRoom(room, dt, t) {
  /* peluru / anak panah */
  for (let i = room.projs.length - 1; i >= 0; i--) {
    const pr = room.projs[i];
    pr.x += pr.dx * pr.sp * dt; pr.y += (pr.dy || 0) * pr.sp * dt; pr.z += pr.dz * pr.sp * dt; pr.life -= dt;
    let hit = null;
    for (const v of victims(room)) {
      if (friendly(pr.o, v)) continue;
      if (Math.hypot(v.x - pr.x, v.z - pr.z) < 1.35 && Math.abs((v.y + 0.9) - pr.y) < 1.4) { hit = v; break; }
    }
    if (hit) {
      const owner = pr.o === BANDIT_OWNER ? BANDIT : (room.players.get(pr.o) || null);
      hurt(room, hit, pr.dmg, owner, pr.dx * 6, pr.dz * 6, { sx: -pr.dx, sz: -pr.dz, stun: pr.stun });
      broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z) });
      room.projs.splice(i, 1);
    } else if (pr.life <= 0) {
      room.projs.splice(i, 1);
    }
  }
  /* bola biru raksasa */
  for (let i = room.orbs.length - 1; i >= 0; i--) {
    const o = room.orbs[i], owner = room.players.get(o.o);
    o.x += o.dx * o.sp * dt; o.y += o.dy * o.sp * dt; o.z += o.dz * o.sp * dt; o.life -= dt;
    if (!owner || o.life <= 0) { room.orbs.splice(i, 1); broadcast(room, { t: 'orbx', id: o.id }); continue; }
    for (const v of victims(room)) {
      if (friendly(o.o, v)) continue;
      const dx = v.x - o.x, dy = v.y + 0.9 - o.y, dz = v.z - o.z;
      if (dx * dx + dy * dy + dz * dz > (o.r + 0.5) * (o.r + 0.5)) continue;
      if (t < (o.hit.get(v.id) || 0)) continue;
      o.hit.set(v.id, t + 450);
      hurt(room, v, o.dmg, owner, o.dx * 5, o.dz * 5, { area: true });
    }
  }
  /* mob elang */
  for (let i = room.mobs.length - 1; i >= 0; i--) {
    const m = room.mobs[i], owner = room.players.get(m.o);
    if (!owner || t > m.until) { room.mobs.splice(i, 1); broadcast(room, { t: 'mobx', id: m.id }); continue; }
    if (t >= m.tgtAt) {
      m.tgtAt = t + 400;
      let best = null, bd = 45;
      for (const v of room.players.values()) {
        if (v === owner || v.dead) continue;
        const d = Math.hypot(v.x - m.x, v.z - m.z);
        if (d < bd) { bd = d; best = v; }
      }
      m.tgt = best ? best.id : 0;
    }
    const tg = m.tgt ? room.players.get(m.tgt) : null;
    let tx, ty, tz;
    if (tg && !tg.dead) { tx = tg.x; tz = tg.z; ty = tg.y + 2.6; }
    else { const a = t / 900 + m.id; tx = owner.x + Math.cos(a) * 3.5; tz = owner.z + Math.sin(a) * 3.5; ty = owner.y + 3.2; }
    const dx = tx - m.x, dz = tz - m.z, dist = Math.hypot(dx, dz);
    const sp = m.sp * (dist > 12 ? 1.5 : 1), step = Math.min(dist, sp * dt);
    if (dist > 0.05) { m.x += dx / dist * step; m.z += dz / dist * step; }
    if (dist > 0.3) { m.fx = dx / dist; m.fz = dz / dist; }
    if (tg && !tg.dead && dist < 4) ty = tg.y + 1.0;
    m.y += (ty - m.y) * Math.min(1, 6 * dt);
    if (tg && !tg.dead && dist < 2.2 && Math.abs(m.y - (tg.y + 0.9)) < 2.4 && t >= m.atkAt) {
      m.atkAt = t + 1300; m.atkFlag = 1;
      const ddx = m.x - tg.x, ddz = m.z - tg.z, dd = Math.hypot(ddx, ddz);
      damagePlayer(room, tg, m.dmg, owner, m.fx * 5, m.fz * 5, dd > 0.3 ? { sx: ddx / dd, sz: ddz / dd } : {});
    }
  }
  /* ranjau (permanen, hanya meledak saat diinjak musuh) */
  for (let i = room.traps.length - 1; i >= 0; i--) {
    const tr = room.traps[i];
    if (t < tr.armAt) continue;
    const owner = room.players.get(tr.o) || null;
    for (const v of victims(room)) {
      if (friendly(tr.o, v)) continue;
      if (Math.hypot(v.x - tr.x, v.z - tr.z) < tr.r && Math.abs(v.y - tr.y) < 2) {
        room.traps.splice(i, 1);
        broadcast(room, { t: 'trapx', id: tr.id, x: r2(tr.x), y: r2(tr.y), z: r2(tr.z) });
        hurt(room, v, tr.dmg, owner, 0, 0, { area: true, stun: tr.stun });
        break;
      }
    }
  }
  stepForts(room, dt, t);
  stepBandits(room, dt, t);
  /* jadwal tertunda, regen, respawn */
  for (let i = room.later.length - 1; i >= 0; i--) {
    if (room.later[i].at <= t) { const f = room.later.splice(i, 1)[0]; try { f.fn(); } catch (e) { console.error(e); } }
  }
  if (room.chest.open && t >= room.chest.reopenAt) { room.chest.open = false; broadcast(room, { t: 'chest', open: false }); }
  for (const p of room.players.values()) {
    if (p.sleeping && !p.dead) {
      p.regenAcc += SLEEP_REGEN * dt;
      if (p.regenAcc >= 1) { const h = Math.floor(p.regenAcc); p.regenAcc -= h; if (p.hp < MAXHP) { p.hp = Math.min(MAXHP, p.hp + h); broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); } }
    }
    if (p.regenUntil > t && !p.dead) {
      p.regenAcc += p.regenRate * dt;
      if (p.regenAcc >= 1) { const h = Math.floor(p.regenAcc); p.regenAcc -= h; if (p.hp < MAXHP) { p.hp = Math.min(MAXHP, p.hp + h); broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); } }
    }
    if (p.rideUntil && (t >= p.rideUntil || p.dead)) { p.rideUntil = 0; broadcast(room, { t: 'fx', k: 'rideend', id: p.id }); }
    if (p.dead && t >= p.respawnAt) {
      const s = randomSpawn();
      p.dead = false; p.hp = MAXHP; p.x = s.x; p.z = s.z; p.y = 0; p.invuln = t + SPAWN_PROTECT_MS; p.shield = 0; p.regenUntil = 0; p.stunUntil = 0; p.gbUntil = 0; p.sleeping = false;
      broadcast(room, { t: 'resp', id: p.id, x: s.x, z: s.z });
    }
  }
  /* posisi */
  room.tickN++;
  if (room.tickN % SNAP_EVERY === 0) {
    if (room.players.size > 1) {
      const arr = [];
      for (const p of room.players.values()) if (!p.dead) arr.push([p.id, p.x, p.y, p.z, p.fx, p.fz, p.m, p.a, p.sw]);
      if (arr.length) broadcast(room, { t: 'ps', p: arr });
    }
    if (room.mobs.length) {
      broadcast(room, { t: 'ms', m: room.mobs.map(m => [m.id, r2(m.x), r2(m.y), r2(m.z), r2(m.fx), r2(m.fz), m.atkFlag]) });
      for (const m of room.mobs) m.atkFlag = 0;
    }
    if (room.sols.length) {
      broadcast(room, { t: 'ss', s: room.sols.map(s => [s.id, r2(s.x), r2(s.z), r2(s.fx), r2(s.fz), s.atkFlag]) });
      for (const s of room.sols) s.atkFlag = 0;
    }
  }
}

setInterval(() => {
  const t = now(), dt = TICK_MS / 1000;
  for (const room of rooms.values()) if (room.players.size) stepRoom(room, dt, t);
}, TICK_MS);

function removePlayer(room, p) {
  if (!room.players.has(p.id)) return;
  room.players.delete(p.id);
  room.projs = room.projs.filter(x => x.o !== p.id);
  room.mobs = room.mobs.filter(x => { if (x.o === p.id) { broadcast(room, { t: 'mobx', id: x.id }); return false; } return true; });
  room.traps = room.traps.filter(x => x.o !== p.id);
  room.orbs = room.orbs.filter(x => { if (x.o === p.id) { broadcast(room, { t: 'orbx', id: x.id }); return false; } return true; });
  for (const f of room.forts) { if (f.owner === p.id) setFortOwner(room, f, null); if (f.cap && f.cap.by === p.id) { f.cap = null; broadcast(room, { t: 'cap', fort: f.id, cancel: 1 }); } }
  broadcast(room, { t: 'pl', id: p.id });
  broadcast(room, { t: 'sc', s: scoreList(room) });
}

function onJoin(ws, m) {
  if (ws.player) return;
  const code = String(m.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: 'Room tidak ditemukan' });
  const name = cleanName(m.name, 14);
  if (!name) return send(ws, { t: 'err', msg: 'Nama tidak boleh kosong' });
  const uid = String(m.uid || '').slice(0, 40) || crypto.randomBytes(6).toString('hex');
  const ch = clampN(Math.floor(Number(m.ch)) || 0, 0, CHAR_COUNT - 1);

  /* sesi lama dari orang yang sama (refresh halaman) -> gantikan */
  for (const p of room.players.values()) {
    if (p.uid === uid) { try { send(p.ws, { t: 'err', msg: 'Kamu masuk dari tab lain' }); } catch (e) { } removePlayer(room, p); p.ws.terminate(); }
  }
  const lower = name.toLowerCase();
  for (const p of room.players.values()) {
    if (p.name.toLowerCase() === lower) return send(ws, { t: 'err', msg: 'Nama "' + name + '" sudah dipakai di room ini. Pakai nama lain.' });
  }
  if (room.players.size >= room.max) return send(ws, { t: 'err', msg: 'Room penuh (' + room.max + ' pemain)' });

  const s = randomSpawn();
  const p = {
    id: room.nextPid++, uid, name, ch, ws, room,
    x: s.x, y: 0, z: s.z, fx: 0, fz: 1, m: 0, a: 0, sw: 0,
    hp: MAXHP, k: 0, d: 0, dead: false, respawnAt: 0,
    invuln: now() + SPAWN_PROTECT_MS, shield: 0, atkAt: 0,
    slots: new Array(MAX_TECH_SLOTS).fill(null), cdUntil: {},
    guarding: false, gh: [], gbUntil: 0, stunUntil: 0, regenUntil: 0, regenRate: 0, regenAcc: 0, rideUntil: 0, sleeping: false, ammo: 0, snipeAt: 0
  };
  room.players.set(p.id, p);
  ws.player = p;
  send(ws, {
    t: 'welcome', id: p.id, room: { name: room.name, max: room.max, voice: room.voice }, hour: roomHour(room), hp: p.hp,
    forts: room.forts.map(f => Object.assign(fortPublic(f), { name2: f.name, x: f.x, z: f.z })), sols: room.sols.map(solPublic), chat: room.chatLog.slice(-20),
    spawn: s, doors: room.doors, book: !!DB.settings.showBook, chest: room.chest.open,
    players: [...room.players.values()].map(q => ({ id: q.id, name: q.name, ch: q.ch, hp: q.hp, k: q.k, d: q.d, x: q.x, y: q.y, z: q.z, dead: q.dead, sl: q.sleeping }))
  });
  broadcast(room, { t: 'pj', p: { id: p.id, name: p.name, ch: p.ch, hp: p.hp, k: 0, d: 0, x: p.x, y: 0, z: p.z } }, p.id);
  broadcast(room, { t: 'sc', s: scoreList(room) });
}

function onMessage(ws, text) {
  /* batas laju pesan */
  const t = now();
  if (t - ws.rateT > 1000) { ws.rateT = t; ws.rateN = 0; }
  if (++ws.rateN > 150) return;
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'join') return onJoin(ws, m);
  const p = ws.player;
  if (!p) return;
  const room = p.room;
  switch (m.t) {
    case 's': {
      if (p.dead) break;
      const x = num(m.x, -200, 3100, null), y = num(m.y, -12, 80, null), z = num(m.z, -200, 200, null);
      if (x === null || y === null || z === null) break;
      p.x = x; p.y = y; p.z = z;
      p.fx = num(m.fx, -1, 1, p.fx); p.fz = num(m.fz, -1, 1, p.fz);
      p.m = clampN(m.m | 0, 0, 2); p.a = clampN(m.a | 0, 0, 2); p.sw = clampN(m.sw | 0, 0, 2);
      break;
    }
    case 'atk': {
      let fx = num(m.fx, -1, 1, 0), fz = num(m.fz, -1, 1, 1); const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
      doMelee(room, p, r2(fx), r2(fz));
      break;
    }
    case 'cast': {
      doCast(room, p, m.slot | 0, num(m.fx, -1, 1, 0), num(m.fy, -1, 1, 0), num(m.fz, -1, 1, 1));
      break;
    }
    case 'learn': {
      const slot = m.slot | 0;
      if (slot < 0 || slot >= MAX_TECH_SLOTS) break;
      const code = String(m.code || '');
      const tech = /^[1-9]{2,12}$/.test(code) ? techByCode(code) : null;
      if (!tech) { send(ws, { t: 'learnerr', msg: 'Kode salah, teknik tidak ditemukan' }); break; }
      for (let i = 0; i < MAX_TECH_SLOTS; i++) if (i !== slot && p.slots[i] === code) { send(ws, { t: 'learnerr', msg: 'Teknik itu sudah ada di slot lain' }); return; }
      p.slots[slot] = code;
      send(ws, { t: 'learned', slot, tech: techPublic(tech) });
      break;
    }
    case 'clear': {
      const slot = m.slot | 0;
      if (slot >= 0 && slot < MAX_TECH_SLOTS) p.slots[slot] = null;
      break;
    }
    case 'sleep': {
      setSleep(room, p, !!m.on);
      break;
    }
    case 'chest': {
      if (p.dead || p.x < 1000 || Math.hypot(p.x - CHEST.x, p.z - CHEST.z) > 5) break;
      if (room.chest.open) { send(ws, { t: 'toast', msg: 'Peti sudah kosong, isi ulang sebentar lagi' }); break; }
      room.chest.open = true; room.chest.reopenAt = now() + CHEST_RESET_MS;
      broadcast(room, { t: 'chest', open: true });
      setAmmo(p, SNIPER.ammo);
      break;
    }
    case 'snipe': {
      doSnipe(room, p, num(m.fx, -1, 1, 0), 0, num(m.fz, -1, 1, 1));
      break;
    }
    case 'cap': {
      startCapture(room, p, m.fort | 0);
      break;
    }
    case 'chat': {
      const t = now();
      if (t - (p.chatAt || 0) < 600) break;
      const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!text) break;
      p.chatAt = t;
      const msg = { t: 'chat', id: p.id, name: p.name, text };
      room.chatLog.push({ name: p.name, text, id: p.id });
      if (room.chatLog.length > 60) room.chatLog.shift();
      broadcast(room, msg);
      break;
    }
    case 'rtc': {
      if (!room.voice) break;
      const to = room.players.get(m.to | 0);
      if (!to || to === p) break;
      const d = m.d;
      if (!d || typeof d !== 'object') break;
      if (JSON.stringify(d).length > 12000) break;
      send(to.ws, { t: 'rtc', from: p.id, d });
      break;
    }
    case 'guard': {
      setGuard(room, p, !!m.on);
      break;
    }
    case 'door': {
      const i = m.i | 0;
      if (i < 0 || i >= DOOR_COUNT) break;
      room.doors[i] = !room.doors[i];
      broadcast(room, { t: 'door', i, open: room.doors[i] });
      break;
    }
  }
}

function onClose(ws) {
  const p = ws.player;
  if (p) { ws.player = null; removePlayer(p.room, p); }
}

function closeRoom(room) {
  for (const p of [...room.players.values()]) {
    try { send(p.ws, { t: 'closed' }); } catch (e) { }
    p.ws.player = null;
    setTimeout(() => p.ws.terminate(), 200);
  }
  room.players.clear();
  rooms.delete(room.code);
}

/* ====================================================================
 *  WEBSOCKET (implementasi minimal, RFC 6455)
 * ==================================================================== */
const WS_MAX_PAYLOAD = 64 * 1024;
function wsFrame(op, payload) {
  const len = payload.length;
  let h;
  if (len < 126) { h = Buffer.from([0x80 | op, len]); }
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
  return Buffer.concat([h, payload]);
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const ws = {
    socket, closed: false, alive: true, player: null, rateT: 0, rateN: 0,
    buf: Buffer.alloc(0), frag: [], fragOp: 0,
    send(str) {
      if (ws.closed) return;
      if (socket.writableLength > 2 * 1024 * 1024) { ws.terminate(); return; }
      socket.write(wsFrame(1, Buffer.from(str)));
    },
    terminate() {
      if (ws.closed) return;
      ws.closed = true;
      try { socket.destroy(); } catch (e) { }
      onClose(ws);
    },
    close() {
      if (ws.closed) return;
      try { socket.write(wsFrame(8, Buffer.alloc(0))); socket.end(); } catch (e) { }
      ws.closed = true;
      onClose(ws);
    }
  };
  socket.on('data', chunk => {
    ws.buf = ws.buf.length ? Buffer.concat([ws.buf, chunk]) : chunk;
    if (ws.buf.length > WS_MAX_PAYLOAD * 4) return ws.terminate();
    for (;;) {
      const b = ws.buf;
      if (b.length < 2) break;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; if (b.readUInt32BE(2) !== 0) return ws.terminate(); len = b.readUInt32BE(6); off = 10; }
      if (len > WS_MAX_PAYLOAD || !masked) return ws.terminate();
      if (b.length < off + 4 + len) break;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      ws.buf = b.subarray(off + 4 + len);
      if (op === 8) { ws.close(); return; }
      if (op === 9) { if (!ws.closed) socket.write(wsFrame(10, payload)); continue; }
      if (op === 10) { ws.alive = true; continue; }
      if (op === 1 || op === 2) { ws.fragOp = op; ws.frag = [payload]; }
      else if (op === 0) { ws.frag.push(payload); }
      else continue;
      if (fin) {
        const full = Buffer.concat(ws.frag); ws.frag = [];
        if (ws.fragOp === 1) { try { onMessage(ws, full.toString('utf8')); } catch (e) { console.error('msg error:', e); } }
      }
    }
  });
  socket.on('close', () => { ws.closed = true; onClose(ws); });
  socket.on('error', () => { });
  allSockets.add(ws);
  socket.on('close', () => allSockets.delete(ws));
}
const allSockets = new Set();
setInterval(() => {
  for (const ws of allSockets) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.socket.write(wsFrame(9, Buffer.alloc(0))); } catch (e) { }
  }
}, 20000);

/* ====================================================================
 *  ADMIN: sesi & rate limit
 * ==================================================================== */
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600 * 1000;
const loginFails = new Map(); // ip -> {n, until}

function newSession() {
  const tok = crypto.randomBytes(24).toString('hex');
  sessions.set(tok, now() + SESSION_MS);
  return tok;
}
function authOf(req) {
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const exp = sessions.get(tok);
  if (!exp) return null;
  if (exp < now()) { sessions.delete(tok); return null; }
  return tok;
}
setInterval(() => { const t = now(); for (const [k, v] of sessions) if (v < t) sessions.delete(k); for (const [k, v] of loginFails) if (v.until < t) loginFails.delete(k); }, 60000);

function clientIp(req) { return String(req.socket.remoteAddress || '?'); }

/* ====================================================================
 *  HTTP
 * ==================================================================== */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function html(res, body, code) {
  res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > (limit || 32768)) { reject(new Error('Body terlalu besar')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON tidak valid')); } });
    req.on('error', reject);
  });
}
function roomView(r) {
  const rt = rooms.get(r.code);
  return { code: r.code, name: r.name, max: r.max, voice: r.voice !== false, created: r.created, count: rt ? rt.players.size : 0, players: rt ? [...rt.players.values()].map(p => p.name) : [] };
}

async function handleAdmin(req, res, pathname) {
  const method = req.method;
  if (pathname === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(req), f = loginFails.get(ip);
    if (f && f.n >= 6 && f.until > now()) return json(res, 429, { error: 'Terlalu banyak percobaan. Tunggu semenit.' });
    const b = await readBody(req);
    const okUser = safeEq(String(b.user || ''), DB.admin.user);
    const okPw = safeEq(hashPw(String(b.password || ''), DB.admin.salt), DB.admin.hash);
    if (!(okUser && okPw)) {
      const cur = loginFails.get(ip) || { n: 0, until: 0 };
      cur.n++; cur.until = now() + 60000; loginFails.set(ip, cur);
      return json(res, 401, { error: 'Username atau password salah' });
    }
    loginFails.delete(ip);
    return json(res, 200, { token: newSession() });
  }
  const tok = authOf(req);
  if (!tok) return json(res, 401, { error: 'Belum login' });

  if (pathname === '/api/admin/me' && method === 'GET') return json(res, 200, { user: DB.admin.user, changed: !!DB.admin.changed });
  if (pathname === '/api/admin/logout' && method === 'POST') { sessions.delete(tok); return json(res, 200, { ok: true }); }

  if (pathname === '/api/admin/password' && method === 'POST') {
    const b = await readBody(req);
    if (!safeEq(hashPw(String(b.current || ''), DB.admin.salt), DB.admin.hash)) return json(res, 400, { error: 'Password sekarang salah' });
    const next = String(b.next || '');
    if (next.length < 4) return json(res, 400, { error: 'Password baru minimal 4 karakter' });
    if (next.length > 100) return json(res, 400, { error: 'Password terlalu panjang' });
    const salt = crypto.randomBytes(16).toString('hex');
    DB.admin.salt = salt; DB.admin.hash = hashPw(next, salt); DB.admin.changed = true;
    saveDBNow();
    for (const k of [...sessions.keys()]) if (k !== tok) sessions.delete(k);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/rooms' && method === 'GET') return json(res, 200, { rooms: DB.rooms.map(roomView).reverse() });
  if (pathname === '/api/admin/rooms' && method === 'POST') {
    const b = await readBody(req);
    const name = cleanName(b.name, 30) || 'Room ' + (DB.rooms.length + 1);
    const max = Math.round(Number(b.max));
    if (!isFinite(max) || max < 2 || max > ROOM_MAX_LIMIT) return json(res, 400, { error: 'Maksimal pemain harus angka 2-' + ROOM_MAX_LIMIT });
    if (DB.rooms.length >= 200) return json(res, 400, { error: 'Terlalu banyak room, hapus yang lama dulu' });
    const r = { code: newRoomCode(), name, max, created: now(), voice: b.voice !== false };
    DB.rooms.push(r); rooms.set(r.code, newRuntime(r)); saveDBNow();
    return json(res, 200, { room: roomView(r) });
  }
  let mm = /^\/api\/admin\/rooms\/([A-Z0-9]{4,10})$/.exec(pathname);
  if (mm) {
    const r = DB.rooms.find(x => x.code === mm[1]);
    if (!r) return json(res, 404, { error: 'Room tidak ada' });
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.name !== undefined) r.name = cleanName(b.name, 30) || r.name;
      if (b.voice !== undefined) r.voice = !!b.voice;
      if (b.max !== undefined) { const mx = Math.round(Number(b.max)); if (!isFinite(mx) || mx < 2 || mx > ROOM_MAX_LIMIT) return json(res, 400, { error: 'Maksimal pemain harus angka 2-' + ROOM_MAX_LIMIT }); r.max = mx; }
      const rt = rooms.get(r.code); if (rt) { rt.name = r.name; rt.max = r.max; rt.voice = r.voice !== false; }
      saveDBNow();
      return json(res, 200, { room: roomView(r) });
    }
    if (method === 'DELETE') {
      const rt = rooms.get(r.code); if (rt) closeRoom(rt);
      DB.rooms = DB.rooms.filter(x => x !== r); saveDBNow();
      return json(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/settings' && method === 'GET') return json(res, 200, { showBook: !!DB.settings.showBook });
  if (pathname === '/api/admin/settings' && method === 'PUT') {
    const b = await readBody(req);
    if (b.showBook !== undefined) DB.settings.showBook = !!b.showBook;
    saveDBNow();
    return json(res, 200, { showBook: !!DB.settings.showBook });
  }
  if (pathname === '/api/admin/techniques' && method === 'GET') return json(res, 200, { techniques: DB.techniques });
  if (pathname === '/api/admin/techniques' && method === 'PUT') {
    const b = await readBody(req, 128 * 1024);
    if (!Array.isArray(b.techniques)) return json(res, 400, { error: 'Format salah' });
    if (b.techniques.length > 100) return json(res, 400, { error: 'Maksimal 100 teknik' });
    const out = [], seen = new Set();
    for (const t of b.techniques) {
      const s = sanitizeTech(t);
      if (!s || s.error) return json(res, 400, { error: s ? s.error : 'Teknik tidak valid' });
      if (seen.has(s.code)) return json(res, 400, { error: 'Kode ' + s.code + ' dipakai dua kali' });
      seen.add(s.code); out.push(s);
    }
    DB.techniques = out; saveDBNow();
    return json(res, 200, { techniques: DB.techniques });
  }
  if (pathname === '/api/admin/techniques/reset' && method === 'POST') {
    DB.techniques = DEFAULT_TECHS.map(t => Object.assign({}, t)); saveDBNow();
    return json(res, 200, { techniques: DB.techniques });
  }
  return json(res, 404, { error: 'Tidak ditemukan' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method tidak diizinkan' });
    let mm = /^\/api\/room\/([A-Za-z0-9]{4,10})$/.exec(pathname);
    if (mm) {
      const r = DB.rooms.find(x => x.code === mm[1].toUpperCase());
      if (!r) return json(res, 404, { error: 'Room tidak ditemukan' });
      const v = roomView(r);
      return json(res, 200, { name: v.name, max: v.max, count: v.count, voice: v.voice });
    }
    if (pathname === '/api/book') {
      if (!DB.settings.showBook) return json(res, 200, { enabled: false, techniques: [] });
      return json(res, 200, { enabled: true, techniques: DB.techniques.map(t => Object.assign(techPublic(t), { desc: techDesc(t) })) });
    }
    if (pathname === '/') return html(res, LANDING_HTML);
    if (pathname === '/admin') return html(res, ADMIN_HTML);
    if (/^\/r\/[A-Za-z0-9]{4,10}$/.test(pathname)) return html(res, GAME_HTML);
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (pathname === '/healthz') return json(res, 200, { ok: true });
    html(res, '<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:sans-serif;background:#0b1020;color:#fff;text-align:center;padding:60px"><h1>404</h1><p>Halaman tidak ada.</p><a style="color:#4de1ff" href="/">Kembali</a>', 404);
  } catch (e) {
    if (!res.headersSent) json(res, e && /besar|JSON/.test(e.message) ? 400 : 500, { error: e && /besar|JSON/.test(e.message) ? e.message : 'Kesalahan server' });
    else res.end();
  }
});
server.on('upgrade', (req, socket) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname !== '/ws') { socket.destroy(); return; }
  acceptWebSocket(req, socket);
});
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) { } });

/* ====================================================================
 *  START
 * ==================================================================== */
loadDB();
for (const r of DB.rooms) rooms.set(r.code, newRuntime(r));
process.on('uncaughtException', e => console.error('uncaught:', e));
process.on('unhandledRejection', e => console.error('unhandled:', e));
function shutdown() { saveDBNow(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log('');
  console.log('  DIGITAL WAR berjalan di  http://localhost:' + PORT);
  console.log('  Admin                    http://localhost:' + PORT + '/admin   (default: admin / admin)');
  if (!DB.admin.changed) console.log('  ! Password admin masih default, ganti lewat halaman admin.');
  console.log('');
});

/* ====================================================================
 *  HALAMAN (HTML tertanam)
 * ==================================================================== */
const LANDING_HTML = String.raw`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>Digital War</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 10%,#0d2347,#03060c 65%);color:#f2f8ff;font-family:"Poppins","Segoe UI","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:min(94vw,420px);background:rgba(5,10,22,.95);border:2px solid #4db8ff44;border-radius:24px;padding:28px 22px;text-align:center;box-shadow:0 10px 50px rgba(0,0,0,.5),0 0 60px #4db8ff22}
h1{margin:0;font-size:46px;letter-spacing:3px;color:#fff;text-shadow:0 2px 0 #4db8ff,0 4px 0 #1e6fff,0 6px 0 #0a2a66,0 10px 18px rgba(30,111,255,.55);font-weight:700}
p{opacity:.75;font-size:14px;line-height:1.55}
input{width:100%;margin-top:6px;background:#050a14;border:2px solid #1c3a66;border-radius:12px;color:#fff;font-size:22px;letter-spacing:6px;text-align:center;padding:10px;font-family:ui-monospace,Menlo,Consolas,monospace;text-transform:uppercase;outline:none}
input:focus{border-color:#4db8ff}
button{margin-top:14px;border:0;border-radius:999px;background:linear-gradient(90deg,#1e6fff,#4db8ff);color:#fff;font-size:17px;font-weight:800;padding:12px 32px;cursor:pointer;box-shadow:0 5px 0 #0a3d99;font-family:inherit}
a{color:#6fa8e8;font-size:12px;display:inline-block;margin-top:18px;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <h1>Digital War</h1>
  <p>Pertarungan antar teman di dunia kode. Minta link room ke admin, atau masukkan kode room di bawah.</p>
  <input id="code" maxlength="10" placeholder="KODE ROOM" autocomplete="off">
  <br><button id="go">Masuk room</button><br>
  <a href="/admin">Halaman admin</a>
</div>
<script>
(function(){
var i=document.getElementById('code');
function go(){var c=i.value.trim().toUpperCase();if(c)location.href='/r/'+encodeURIComponent(c);}
document.getElementById('go').onclick=go;i.onkeydown=function(e){if(e.key==='Enter')go();};
})();
</script>
</body>
</html>
`;
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>Digital War · Admin</title>
<style>
:root{--bg:#05070d;--card:#0a1424;--line:#1c3a66;--tx:#f2f8ff;--mut:#8fb4e0;--ac:#4db8ff;--ok:#1fa05a;--bad:#d63a4a}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 50% 0,#0d2347,var(--bg) 60%);color:var(--tx);font-family:"Poppins","Segoe UI","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
h1{margin:0;font-size:28px;letter-spacing:2px;color:#fff;text-shadow:0 2px 0 #4db8ff,0 4px 0 #1e6fff,0 6px 0 #0a2a66,0 10px 18px rgba(30,111,255,.55);font-weight:700}
h1 small{font-size:14px;color:#4db8ff;text-shadow:none;letter-spacing:1px;margin-left:6px;font-weight:600}
.wrap{max-width:860px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
.card h2{margin:0 0 10px;font-size:16px;color:var(--ac)}
label{display:block;font-size:12px;font-weight:700;color:var(--mut);margin:10px 0 4px}
input,select{width:100%;background:#050a14;border:2px solid var(--line);border-radius:10px;color:var(--tx);font-size:15px;padding:9px 11px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--ac)}
input[type=color]{padding:2px;height:40px}
button{border:0;border-radius:10px;background:#12408a;color:#fff;font-weight:700;font-size:14px;padding:10px 14px;cursor:pointer;font-family:inherit}
button:hover{filter:brightness(1.15)}
button.pri{background:linear-gradient(90deg,#1e6fff,#4db8ff)}
button.ok{background:var(--ok)}
button.bad{background:var(--bad)}
button:disabled{opacity:.5}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.row>*{flex:1;min-width:120px}
.row>button{flex:0 0 auto}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tabs button{background:#0f2a54}
.tabs button.on{background:linear-gradient(90deg,#1e6fff,#4db8ff)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.chip{background:#0f2a54;border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:13px;font-weight:700;cursor:pointer}
.chip.on{background:var(--ac);color:#04121c;border-color:var(--ac)}
.room{border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px;background:#08101f}
.room h3{margin:0;font-size:16px}
.room .meta{font-size:12px;color:var(--mut);margin:2px 0 8px}
.link{display:flex;gap:6px;margin:6px 0}
.link input{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.pl{font-size:12px;color:var(--mut);margin-top:6px}
.pl b{color:var(--tx);background:#0f2a54;border-radius:8px;padding:2px 8px;margin:2px 3px 0 0;display:inline-block}
.msg{padding:9px 12px;border-radius:10px;font-size:13px;font-weight:700;margin:8px 0}
.msg.err{background:#4a1a22;color:#ff9aa6}.msg.ok{background:#12402a;color:#8affc0}.msg.warn{background:#4a3a12;color:#ffd77a}
.tech{border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px;background:#08101f}
.tech .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.tech .g label{margin:0 0 3px}
.tech .hd{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.tech .hd .em{width:56px;flex:0 0 56px;text-align:center}
.tech .hd .nm{flex:1}
.tech .code{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:2px}
.hint{font-size:12px;color:var(--mut);margin:0 0 10px;line-height:1.5}
#login{max-width:360px;margin:12vh auto 0}
.hidden{display:none!important}
.chk{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--tx);margin-top:12px;cursor:pointer}
.chk input{width:20px;height:20px;flex:0 0 20px;accent-color:#1e6fff;padding:0}
#rcreate,#pgo{display:block;margin-left:auto}
#techAdd,#techSave,#techReset{flex:1 1 auto}
@media (max-width:520px){
.room .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.room .row>*{min-width:0;width:100%}
.room .row>input{grid-column:1 / -1}
.wrap{padding:14px}
}
}
</style>
</head>
<body>
<div class="wrap">
<div id="login" class="card hidden">
  <h1>Digital War</h1>
  <p class="hint" style="margin-top:4px">Halaman admin</p>
  <label>Username</label><input id="lu" value="admin" autocomplete="username">
  <label>Password</label><input id="lp" type="password" autocomplete="current-password">
  <div id="lmsg"></div>
  <button class="pri" id="lgo" style="width:100%;margin-top:12px">Masuk</button>
</div>

<div id="app" class="hidden">
  <div class="top"><h1>Digital War <small>Admin</small></h1><button id="logout">Keluar</button></div>
  <div id="warnPw" class="msg warn hidden">⚠️ Password masih default (admin). Ganti di tab Akun supaya tidak sembarang orang bisa membuat room.</div>
  <div class="tabs">
    <button data-tab="rooms" class="on">Room</button>
    <button data-tab="tech">Buku Teknik</button>
    <button data-tab="acc">Akun</button>
  </div>

  <div id="tab-rooms">
    <div class="card">
      <h2>Buat room baru</h2>
      <label>Nama room</label><input id="rname" maxlength="30" placeholder="Misal: Duel Sabtu Malam">
      <label>Maksimal pemain</label>
      <div class="chips" id="presets"></div>
      <input id="rmax" type="number" min="2" max="100" value="10" style="margin-top:8px">
      <label class="chk"><input type="checkbox" id="rvoice" checked> Voice chat: pemain bisa bicara (mikrofon) dan mendengar suara</label>
      <div id="rmsg"></div>
      <button class="pri" id="rcreate" style="margin-top:12px">Buat room</button>
    </div>
    <div id="roomList"></div>
  </div>

  <div id="tab-tech" class="hidden">
    <div class="card">
      <h2>Buku teknik digital</h2>
      <p class="hint">Setiap teknik punya kode angka (hanya 1-9, 2-12 digit). Pemain menulis kode itu di tombol teknik untuk memasangnya. Kalau "Tampilkan buku di dalam game" dimatikan, pemain harus menghafal kode dari bukumu sendiri. Perubahan langsung berlaku ke semua room.</p>
      <label style="display:flex;gap:8px;align-items:center;margin:0 0 12px;font-size:13px;color:var(--tx)"><input type="checkbox" id="showBook" style="width:auto"> Tampilkan buku di dalam game (tombol buku dan ketuk minimap)</label>
      <div id="techList"></div>
      <div class="row" style="margin-top:8px"><button id="techAdd">+ Tambah teknik</button><button class="pri" id="techSave">Simpan buku</button><button id="techReset" class="bad">Kembalikan default</button></div>
      <div id="tmsg"></div>
    </div>
  </div>

  <div id="tab-acc" class="hidden">
    <div class="card">
      <h2>Ganti password</h2>
      <label>Password sekarang</label><input id="pcur" type="password" autocomplete="current-password">
      <label>Password baru (min. 4 karakter)</label><input id="pnew" type="password" autocomplete="new-password">
      <label>Ulangi password baru</label><input id="pnew2" type="password" autocomplete="new-password">
      <div id="pmsg"></div>
      <button class="pri" id="pgo" style="margin-top:12px">Simpan password</button>
    </div>
  </div>
</div>
</div>

<script>
(function(){
const $=id=>document.getElementById(id);
let token=null;try{token=localStorage.getItem('dw_admin')}catch(e){}
let techs=[],pollT=null;
const KINDS={bolt:'Peluru (bolt)',orb:'Bola biru raksasa (orb)',nova:'Ledakan area (nova)',beam:'Sinar tembus (beam)',slam:'Lompat & hantam (slam)',trap:'Ranjau (trap)',summon:'Panggil elang (summon)',ride:'Tunggang elang (ride)',heal:'Penyembuh (heal)',regen:'Pulih bertahap (regen)',shield:'Perisai (shield)',haste:'Percepat lari (haste)',dash:'Lesat (dash)'};
const FIELDS={ // kind -> [field,label]
  bolt:[['damage','Damage'],['cd','Cooldown (dtk)'],['speed','Kecepatan'],['life','Jarak (dtk terbang)'],['count','Jumlah peluru'],['spread','Sebaran (rad)'],['stun','Beku (dtk)']],
  orb:[['damage','Damage per sentuhan'],['cd','Cooldown (dtk)'],['speed','Kecepatan'],['life','Lama melaju (dtk)'],['radius','Radius bola']],
  nova:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius'],['stun','Beku (dtk)']],
  beam:[['damage','Damage'],['cd','Cooldown (dtk)'],['range','Panjang sinar'],['stun','Beku (dtk)']],
  slam:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius']],
  trap:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius pemicu'],['stun','Beku (dtk)']],
  summon:[['damage','Damage per serangan'],['cd','Cooldown (dtk)'],['count','Jumlah elang (maks 4)'],['dur','Durasi (dtk)'],['speed','Kecepatan terbang']],
  ride:[['dur','Durasi terbang (dtk, maks 300)'],['speed','Kecepatan terbang'],['cd','Cooldown (dtk)']],
  heal:[['damage','Jumlah HP pulih'],['cd','Cooldown (dtk)']],
  regen:[['damage','Total HP pulih'],['cd','Cooldown (dtk)'],['dur','Durasi (dtk)']],
  shield:[['dur','Durasi (dtk)'],['cd','Cooldown (dtk)']],
  haste:[['power','Pengali kecepatan'],['cd','Cooldown (dtk)'],['dur','Durasi (dtk)']],
  dash:[['speed','Daya lesat'],['cd','Cooldown (dtk)']]
};
async function api(path,opt){
  opt=opt||{};const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;
  const r=await fetch('/api/admin'+path,{method:opt.method||'GET',headers:h,body:opt.body?JSON.stringify(opt.body):undefined});
  let j={};try{j=await r.json();}catch(e){}
  if(r.status===401&&path!=='/login'){showLogin();throw new Error('Sesi habis, login lagi');}
  if(!r.ok)throw new Error(j.error||('Error '+r.status));
  return j;
}
function msg(el,txt,cls){el.innerHTML='';if(!txt)return;const d=document.createElement('div');d.className='msg '+(cls||'err');d.textContent=txt;el.appendChild(d);}
function showLogin(){token=null;try{localStorage.removeItem('dw_admin')}catch(e){}clearInterval(pollT);$('app').classList.add('hidden');$('login').classList.remove('hidden');}
async function showApp(){
  const me=await api('/me');
  $('login').classList.add('hidden');$('app').classList.remove('hidden');
  $('warnPw').classList.toggle('hidden',me.changed);
  loadRooms();loadTech();clearInterval(pollT);pollT=setInterval(loadRooms,5000);
}
$('lgo').addEventListener('click',async()=>{
  try{const j=await api('/login',{method:'POST',body:{user:$('lu').value,password:$('lp').value}});token=j.token;try{localStorage.setItem('dw_admin',token)}catch(e){}$('lp').value='';msg($('lmsg'),'');await showApp();}
  catch(e){msg($('lmsg'),e.message);}
});
$('lp').addEventListener('keydown',e=>{if(e.key==='Enter')$('lgo').click();});
$('logout').addEventListener('click',async()=>{try{await api('/logout',{method:'POST'});}catch(e){}showLogin();});
document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  ['rooms','tech','acc'].forEach(t=>$('tab-'+t).classList.toggle('hidden',t!==b.dataset.tab));
}));

/* rooms */
[5,10,15,20,30].forEach(n=>{const c=document.createElement('div');c.className='chip'+(n===10?' on':'');c.textContent=n+' pemain';c.addEventListener('click',()=>{$('rmax').value=n;mark();});$('presets').appendChild(c);});
function mark(){document.querySelectorAll('#presets .chip').forEach(c=>c.classList.toggle('on',parseInt(c.textContent,10)===parseInt($('rmax').value,10)));}
$('rmax').addEventListener('input',mark);
$('rcreate').addEventListener('click',async()=>{
  try{await api('/rooms',{method:'POST',body:{name:$('rname').value,max:parseInt($('rmax').value,10),voice:$('rvoice').checked}});$('rname').value='';msg($('rmsg'),'Room dibuat!','ok');loadRooms();}
  catch(e){msg($('rmsg'),e.message);}
});
function roomLink(code){return location.origin+'/r/'+code;}
async function loadRooms(){
  let j;try{j=await api('/rooms');}catch(e){return;}
  const box=$('roomList');
  if(document.activeElement&&box.contains(document.activeElement)&&document.activeElement.tagName==='INPUT'&&document.activeElement.dataset.edit)return;
  box.innerHTML='';
  if(!j.rooms.length){const p=document.createElement('p');p.className='hint';p.textContent='Belum ada room. Buat satu di atas.';box.appendChild(p);return;}
  j.rooms.forEach(r=>{
    const d=document.createElement('div');d.className='room';
    const h=document.createElement('h3');h.textContent=r.name+'  ('+r.count+'/'+r.max+')';d.appendChild(h);
    const m=document.createElement('div');m.className='meta';m.textContent='Kode '+r.code+(r.voice!==false?' · voice aktif':' · voice mati')+' · dibuat '+new Date(r.created).toLocaleString();d.appendChild(m);
    const l=document.createElement('div');l.className='link';
    const i=document.createElement('input');i.readOnly=true;i.value=roomLink(r.code);i.addEventListener('focus',()=>i.select());
    const cp=document.createElement('button');cp.className='ok';cp.textContent='Salin';
    cp.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(i.value);}catch(e){i.select();document.execCommand('copy');}cp.textContent='Tersalin ✓';setTimeout(()=>cp.textContent='Salin',1500);});
    l.appendChild(i);l.appendChild(cp);d.appendChild(l);
    const row=document.createElement('div');row.className='row';
    const nm=document.createElement('input');nm.value=r.name;nm.maxLength=30;nm.dataset.edit=1;
    const mx=document.createElement('input');mx.type='number';mx.min=2;mx.max=100;mx.value=r.max;mx.dataset.edit=1;mx.style.maxWidth='110px';
    const vl=document.createElement('label');vl.className='chk';vl.style.gridColumn='1 / -1';vl.style.margin='0';const vc=document.createElement('input');vc.type='checkbox';vc.checked=r.voice!==false;vc.dataset.edit=1;vl.appendChild(vc);vl.appendChild(document.createTextNode('Voice chat aktif'));
    const sv=document.createElement('button');sv.textContent='Ubah';
    sv.addEventListener('click',async()=>{try{await api('/rooms/'+r.code,{method:'PATCH',body:{name:nm.value,max:parseInt(mx.value,10),voice:vc.checked}});sv.textContent='Tersimpan ✓';setTimeout(loadRooms,800);}catch(e){alert(e.message);}});
    const dl=document.createElement('button');dl.className='bad';dl.textContent='Hapus';
    dl.addEventListener('click',async()=>{if(!confirm('Hapus room "'+r.name+'"? Semua pemain akan dikeluarkan.'))return;try{await api('/rooms/'+r.code,{method:'DELETE'});loadRooms();}catch(e){alert(e.message);}});
    row.appendChild(nm);row.appendChild(mx);row.appendChild(vl);row.appendChild(sv);row.appendChild(dl);d.appendChild(row);
    if(r.players.length){const p=document.createElement('div');p.className='pl';p.appendChild(document.createTextNode('Online: '));r.players.forEach(n=>{const b=document.createElement('b');b.textContent=n;p.appendChild(b);});d.appendChild(p);}
    box.appendChild(d);
  });
}

/* techniques */
async function loadTech(){const j=await api('/techniques');techs=j.techniques;renderTech();const st=await api('/settings');$('showBook').checked=!!st.showBook;}
$('showBook').addEventListener('change',async()=>{try{await api('/settings',{method:'PUT',body:{showBook:$('showBook').checked}});msg($('tmsg'),$('showBook').checked?'Buku tampil di game':'Buku disembunyikan dari game','ok');}catch(e){msg($('tmsg'),e.message);}});
function renderTech(){
  const box=$('techList');box.innerHTML='';
  techs.forEach((t,idx)=>{
    const d=document.createElement('div');d.className='tech';
    const hd=document.createElement('div');hd.className='hd';
    const em=document.createElement('input');em.className='em';em.value=t.emoji||'✨';em.maxLength=4;em.addEventListener('input',()=>t.emoji=em.value);
    const nm=document.createElement('input');nm.className='nm';nm.value=t.name;nm.maxLength=24;nm.placeholder='Nama teknik';nm.addEventListener('input',()=>t.name=nm.value);
    const rm=document.createElement('button');rm.className='bad';rm.textContent='✕';rm.addEventListener('click',()=>{techs.splice(idx,1);renderTech();});
    hd.appendChild(em);hd.appendChild(nm);hd.appendChild(rm);d.appendChild(hd);
    const g=document.createElement('div');g.className='g';
    function field(label,el){const w=document.createElement('div');const l=document.createElement('label');l.textContent=label;w.appendChild(l);w.appendChild(el);g.appendChild(w);}
    const code=document.createElement('input');code.className='code';code.value=t.code;code.maxLength=12;code.inputMode='numeric';code.addEventListener('input',()=>{code.value=code.value.replace(/[^1-9]/g,'');t.code=code.value;});field('Kode (1-9)',code);
    const kind=document.createElement('select');Object.keys(KINDS).forEach(k=>{const o=document.createElement('option');o.value=k;o.textContent=KINDS[k];if(k===t.kind)o.selected=true;kind.appendChild(o);});
    kind.addEventListener('change',()=>{t.kind=kind.value;renderTech();});field('Jenis',kind);
    const col=document.createElement('input');col.type='color';col.value=/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#4db8ff';col.addEventListener('input',()=>t.color=col.value);field('Warna',col);
    const ds=document.createElement('input');ds.value=t.desc||'';ds.maxLength=80;ds.placeholder='(otomatis)';ds.addEventListener('input',()=>t.desc=ds.value);field('Deskripsi di buku',ds);
    (FIELDS[t.kind]||[]).forEach(f=>{const n=document.createElement('input');n.type='number';n.step='any';n.value=t[f[0]]==null?'':t[f[0]];n.addEventListener('input',()=>t[f[0]]=parseFloat(n.value));field(f[1],n);});
    d.appendChild(g);box.appendChild(d);
  });
}
$('techAdd').addEventListener('click',()=>{techs.push({code:'',name:'Teknik baru',kind:'bolt',emoji:'✨',color:'#4db8ff',damage:20,cd:2,speed:24,life:1.4,count:1,spread:0});renderTech();});
$('techSave').addEventListener('click',async()=>{try{const j=await api('/techniques',{method:'PUT',body:{techniques:techs}});techs=j.techniques;renderTech();msg($('tmsg'),'Buku tersimpan ('+techs.length+' teknik)','ok');}catch(e){msg($('tmsg'),e.message);}});
$('techReset').addEventListener('click',async()=>{if(!confirm('Kembalikan semua teknik ke default?'))return;try{const j=await api('/techniques/reset',{method:'POST'});techs=j.techniques;renderTech();msg($('tmsg'),'Dikembalikan ke default','ok');}catch(e){msg($('tmsg'),e.message);}});

/* account */
$('pgo').addEventListener('click',async()=>{
  if($('pnew').value!==$('pnew2').value){msg($('pmsg'),'Password baru tidak sama');return;}
  try{await api('/password',{method:'POST',body:{current:$('pcur').value,next:$('pnew').value}});$('pcur').value=$('pnew').value=$('pnew2').value='';msg($('pmsg'),'Password diganti. Sesi lain dikeluarkan.','ok');$('warnPw').classList.add('hidden');}
  catch(e){msg($('pmsg'),e.message);}
});

if(token){showApp().catch(showLogin);}else showLogin();
})();
</script>
</body>
</html>
`;
const GAME_HTML = String.raw`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b1020">
<title>Digital War</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--s:clamp(46px,8vh,60px)}
html,body{margin:0;height:100%;overflow:hidden;background:#0b1020;color:#fff;font-family:"Poppins","Segoe UI","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none;touch-action:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
canvas#c{display:block;width:100%;height:100%;touch-action:none;outline:none}
.hud{display:none!important}
body.playing .hud{display:block!important}
body.playing button.btn.hud{display:flex!important}
body.playing #btnDive.hud:not(.on),body.playing #btnAct.hud:not(.on),body.playing #btnSnipe.hud:not(.on){display:none!important}
body.playing #board.hud:not(.show){display:none!important}
body.playing .hud.off{display:none!important}
body.playing #sbBtn.hud,body.playing #fsBtn.hud,body.playing #bookBtn.hud{display:flex!important}
body.playing #fsBtn.hud.off,body.playing #bookBtn.hud.off{display:none!important}
body.playing .hudf{display:flex}
.pill{position:fixed;background:rgba(10,16,32,.55);color:#fff;border-radius:999px;padding:6px 12px;font-weight:700;font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none;z-index:3}
#hpBox{position:fixed;left:max(10px,env(safe-area-inset-left));top:max(10px,env(safe-area-inset-top));width:190px;z-index:3;pointer-events:none}
#hpName{font-weight:800;font-size:14px;text-shadow:0 1px 3px #000;display:flex;justify-content:space-between;gap:8px}
.bar{height:12px;border-radius:7px;background:rgba(10,16,32,.7);border:2px solid rgba(255,255,255,.55);overflow:hidden;margin-top:3px}
.bar i{display:block;height:100%;width:100%;background:linear-gradient(#6dff96,#2fc45f);transition:width .15s}
#oxyBox{position:fixed;left:50%;top:max(46px,calc(env(safe-area-inset-top) + 40px));transform:translateX(-50%);width:160px;z-index:3;pointer-events:none;opacity:0;transition:opacity .2s}
#oxyBox .bar i{background:linear-gradient(#9fe3ff,#3aa7e8)}
#oxyBox small{display:block;text-align:center;font-size:11px;font-weight:700;text-shadow:0 1px 3px #000}
#mini{cursor:pointer;position:fixed;left:max(10px,env(safe-area-inset-left));top:calc(max(10px,env(safe-area-inset-top)) + 52px);width:96px;height:96px;border-radius:50%;border:2px solid rgba(255,255,255,.65);box-shadow:0 2px 10px rgba(0,0,0,.3);pointer-events:auto;z-index:3}
#roomTag{top:max(10px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);font-size:12px;padding:4px 12px;white-space:nowrap}
#clock{top:max(10px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right));font-size:12px;padding:4px 10px;right:calc(max(10px,env(safe-area-inset-right)) + 122px)}
#sbBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right));width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:16px;z-index:4;cursor:pointer;padding:0}
#fsBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:calc(max(10px,env(safe-area-inset-right)) + 40px);width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:17px;z-index:4;cursor:pointer;padding:0;line-height:1}
#bookBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:calc(max(10px,env(safe-area-inset-right)) + 80px);width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:16px;z-index:4;cursor:pointer;padding:0;line-height:1}
#board{position:fixed;top:calc(max(8px,env(safe-area-inset-top)) + 38px);right:max(10px,env(safe-area-inset-right));min-width:170px;max-width:240px;background:rgba(10,16,32,.78);border-radius:12px;padding:8px 10px;font-size:13px;z-index:4;display:none;pointer-events:none}
#board.show{display:block}
#board h4{margin:0 0 4px;font-size:12px;opacity:.7;letter-spacing:1px}
#board div{display:flex;gap:8px;padding:2px 0}
#board div b{flex:1;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#board div.me b{color:#ffd84d}
#board div span{opacity:.85;font-variant-numeric:tabular-nums}
#feed{position:fixed;top:calc(max(10px,env(safe-area-inset-top)) + 32px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:4px;z-index:3;pointer-events:none;width:80vw}
#feed div{background:rgba(10,16,32,.6);padding:3px 12px;border-radius:999px;font-size:13px;font-weight:700;animation:fd 5s forwards;text-align:center}
@keyframes fd{0%{opacity:0;transform:translateY(-6px)}6%{opacity:1;transform:none}85%{opacity:1}100%{opacity:0}}
#toast{left:50%;top:34%;transform:translate(-50%,-10px);opacity:0;transition:opacity .3s,transform .3s;text-align:center;font-size:16px}
#toast.show{opacity:1;transform:translate(-50%,0)}
#prompt{left:50%;bottom:120px;transform:translate(-50%,20px);opacity:0;transition:opacity .2s,transform .2s;white-space:nowrap}
#prompt.show{opacity:1;transform:translate(-50%,0)}
.key{display:inline-block;background:#fff;color:#234;border-radius:6px;padding:1px 8px;margin-right:6px;font-size:13px}
#hint{left:12px;bottom:10px;font-size:11px;font-weight:600;opacity:.8;max-width:60vw;white-space:normal;border-radius:12px}
#uw{position:fixed;inset:0;background:rgba(20,100,170,.5);opacity:0;transition:opacity .15s;pointer-events:none;z-index:2}
#hurt{position:fixed;inset:0;box-shadow:inset 0 0 120px 30px rgba(255,40,40,.75);opacity:0;pointer-events:none;z-index:2;transition:opacity .35s}
#ko{position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(40,0,10,.45);z-index:5;text-align:center;pointer-events:none}
#ko h2{font-size:44px;margin:0;letter-spacing:4px;text-shadow:0 4px 18px #000}
#ko p{margin:6px 0 0;font-size:16px;font-weight:700}
#joyBase,#joyKnob{position:fixed;border-radius:50%;pointer-events:none;display:none;transform:translate(-50%,-50%);z-index:3}
#joyBase{width:120px;height:120px;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.45)}
#joyKnob{width:52px;height:52px;background:rgba(255,255,255,.6);box-shadow:0 2px 8px rgba(0,0,0,.25)}
.btn{position:fixed;border-radius:50%;border:2px solid rgba(255,255,255,.7);background:rgba(10,16,32,.5);color:#fff;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center;flex-direction:column;touch-action:none;cursor:pointer;z-index:3;font-family:inherit;padding:0;line-height:1}
.btn small{font-size:10px;font-weight:700;opacity:.85;margin-top:2px}
.btn.down{transform:scale(.92);background:rgba(255,255,255,.35)}
#btnJump{width:62px;height:62px;right:calc(var(--s) + 18px);bottom:max(16px,env(safe-area-inset-bottom));font-size:20px}
#btnAtk{width:54px;height:54px;right:calc(var(--s) + 88px);bottom:max(20px,env(safe-area-inset-bottom));background:rgba(180,40,50,.55);font-size:19px}
#btnGuard{width:58px;height:58px;right:calc(var(--s) + 86px);bottom:calc(max(20px,env(safe-area-inset-bottom)) + 62px);background:rgba(40,90,170,.6);font-size:18px}
#btnGuard.on{background:rgba(110,200,255,.85);box-shadow:0 0 18px rgba(120,210,255,.9);color:#04223a}
#btnGuard.broken{opacity:.45}
#btnAct{width:44px;height:44px;right:calc(var(--s) + 150px);bottom:calc(max(20px,env(safe-area-inset-bottom)) + 10px);display:none;font-size:18px}
#btnAct.on{display:flex;background:rgba(255,200,60,.85);color:#3a2a00;box-shadow:0 0 22px rgba(255,210,80,.9)}
#btnDive{width:58px;height:58px;right:calc(var(--s) + 20px);bottom:calc(max(16px,env(safe-area-inset-bottom)) + 70px);display:none;background:rgba(30,120,200,.6);font-size:18px}
#btnDive.on{display:flex}
#btnSnipe{width:58px;height:58px;right:calc(var(--s) + 156px);bottom:calc(max(20px,env(safe-area-inset-bottom)) + 66px);display:none;background:rgba(150,105,15,.7);font-size:18px}
#btnSnipe.on{display:flex}
#btnSnipe i{width:24px;height:24px}
#btnSnipe.broken{opacity:.45}
#night{position:fixed;inset:0;background:rgba(8,16,44,.55);opacity:0;transition:opacity .9s;pointer-events:none;z-index:2}
#fade{position:fixed;inset:0;background:#000;opacity:0;transition:opacity .45s linear;pointer-events:none;z-index:9}
.btn small{font-size:10px;font-weight:600;white-space:nowrap}
#btnGuard i,#btnDive i{width:24px;height:24px}
.btn i{display:block;width:26px;height:26px;font-style:normal}
.btn.big i{width:30px;height:30px}
.svgi{width:100%;height:100%;display:block}
.inl{display:inline-block;width:18px;height:18px;vertical-align:-3px;margin-left:6px}
#fsBtn,#bookBtn,#sbBtn{display:flex;align-items:center;justify-content:center}
#fsBtn svg,#bookBtn svg,#sbBtn svg{width:20px;height:20px}
.slot .ic{display:flex;align-items:center;justify-content:center}
.slot .ic svg{width:calc(var(--s)*.46);height:calc(var(--s)*.46)}
.te .ic svg{width:26px;height:26px}
.bkb svg{width:18px;height:18px}
#bkX svg{width:16px;height:16px}
.kdi{width:13px;height:13px;vertical-align:-2px}
.bki{width:20px;height:20px;vertical-align:-4px;margin-right:6px;display:inline-block}
.mi{display:inline-block;width:18px;height:18px;vertical-align:-4px;margin-right:5px}
.mi svg{width:100%;height:100%}
.clki{width:14px;height:14px;vertical-align:-2px}
@media (orientation:portrait){
#btnJump{right:12px;bottom:max(22px,env(safe-area-inset-bottom))}
#btnAtk{right:82px;bottom:max(26px,env(safe-area-inset-bottom))}
#btnGuard{right:80px;bottom:calc(max(22px,env(safe-area-inset-bottom)) + 84px)}
#btnDive{right:14px;bottom:calc(max(22px,env(safe-area-inset-bottom)) + 88px)}
#btnSnipe{right:146px;bottom:calc(max(22px,env(safe-area-inset-bottom)) + 88px)}
#btnAct{right:146px;bottom:calc(max(22px,env(safe-area-inset-bottom)) + 30px)}
body #slots{top:42%}
}
#slots{position:fixed;right:max(8px,env(safe-area-inset-right));top:50%;transform:translateY(-46%);display:none;flex-direction:column;gap:6px;z-index:3}
body.playing #slots{display:flex}
.slot{position:relative;width:var(--s);height:var(--s);border-radius:14px;border:2px solid rgba(255,255,255,.6);background:rgba(10,16,32,.55);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;touch-action:none;font-family:inherit;padding:0}
.slot .k{position:absolute;left:4px;top:1px;font-size:10px;font-weight:800;opacity:.75}
.slot .ic{font-size:calc(var(--s)*.42);line-height:1}
.slot .nm{font-size:8.5px;font-weight:700;max-width:96%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9;margin-top:1px}
.slot.empty .ic{opacity:.55;font-weight:300}
.slot.filled{border-color:var(--c,#fff);box-shadow:0 0 12px var(--c,#fff) inset}
.slot .cd{position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(0,0,0,.65);pointer-events:none}
.slot.down{transform:scale(.93)}
.slot.ready{animation:rd .5s}
@keyframes rd{0%{filter:brightness(2)}100%{filter:none}}
#book{position:fixed;inset:0;background:rgba(0,0,10,.68);display:none;align-items:center;justify-content:center;z-index:25;touch-action:manipulation}
#book.show{display:flex}
#bk{position:relative;width:min(96vw,780px);height:min(88vh,560px);background:linear-gradient(#6b4528,#46301a);border-radius:14px;padding:12px 12px 16px;box-shadow:0 20px 60px rgba(0,0,0,.75),inset 0 0 0 2px #8a5e38}
#bkPages{display:flex;height:100%;border-radius:4px;overflow:hidden;box-shadow:0 3px 0 #d3c08c,0 6px 0 #bda877,0 9px 0 #a8935f,0 14px 18px rgba(0,0,0,.55)}
.pg{flex:1;min-width:0;padding:14px 16px 28px;color:#3a2a14;font-family:Georgia,"Times New Roman",serif;overflow:hidden;position:relative}
.pg.left{background:linear-gradient(to right,#f8edd2 0%,#f2e3c0 78%,#d6c192 100%)}
.pg.right{background:linear-gradient(to left,#f8edd2 0%,#f2e3c0 78%,#d6c192 100%)}
.spine{width:5px;background:linear-gradient(to right,#a89462,#6f5c36,#a89462)}
.pg h3{margin:0 0 6px;min-height:42px;display:flex;align-items:center;justify-content:center;font-size:15px;text-align:center;color:#6a3a14;border-bottom:2px double #a88a52;padding-bottom:5px;letter-spacing:.5px}
.te{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed #bda070}
.te .ic{font-size:24px;width:30px;text-align:center;flex:0 0 30px}
.te b{font-size:14px;display:block}
.te .cd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;letter-spacing:2px;color:#8a1f1f;font-weight:700}
.te small{display:block;font-size:11px;color:#5b4524;line-height:1.3;font-style:italic}
.pn{position:absolute;bottom:7px;left:0;right:0;text-align:center;font-size:11px;opacity:.6}
.bkb{position:absolute;top:50%;transform:translateY(-50%);width:30px;height:56px;border:0;border-radius:8px;background:rgba(40,25,10,.75);color:#f3e2b8;font-size:16px;cursor:pointer;padding:0;z-index:2}
#bkPrev{left:-4px}#bkNext{right:-4px}
#bkX{position:absolute;top:-10px;right:-8px;width:32px;height:32px;border-radius:50%;border:2px solid #f3e2b8;background:#46301a;color:#f3e2b8;font-size:14px;cursor:pointer;padding:0;z-index:3}
#lcol{position:fixed;left:max(10px,env(safe-area-inset-left));top:calc(max(10px,env(safe-area-inset-top)) + 168px);display:flex;flex-direction:column;gap:6px;z-index:4}
body.playing #lcol.hud{display:flex!important}
#lcol button{position:relative;width:36px;height:34px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
#lcol button svg{width:20px;height:20px}
#lcol button.active{background:rgba(30,111,255,.85)}
#lcol .vo.off{display:none}
.badge{position:absolute;top:-4px;right:-4px;background:#ff4d4d;color:#fff;font-size:10px;font-weight:700;border-radius:8px;padding:1px 5px;display:none;font-style:normal}
#chatFeed{position:fixed;left:max(10px,env(safe-area-inset-left));bottom:84px;max-width:min(62vw,420px);z-index:3;pointer-events:none;display:none;flex-direction:column;gap:2px;font-size:13px}
body.playing #chatFeed.hud{display:flex!important}
#chatFeed div{background:rgba(5,10,22,.55);padding:3px 10px;border-radius:10px;animation:fd 9s forwards;text-shadow:0 1px 2px #000}
#chatFeed b,#chatList b{color:#4db8ff}
#chatPanel{position:fixed;left:max(10px,env(safe-area-inset-left));bottom:70px;width:min(92vw,360px);max-height:52vh;display:none;flex-direction:column;background:rgba(5,10,22,.94);border:2px solid #1c3a66;border-radius:16px;z-index:12;touch-action:manipulation;-webkit-user-select:text;user-select:text}
#chatPanel.show{display:flex}
#chatList{overflow-y:auto;padding:10px 12px;font-size:13px;line-height:1.45;min-height:120px;max-height:36vh;word-break:break-word}
#chatList div{margin-bottom:3px}
#chatForm{display:flex;gap:6px;padding:8px;border-top:1px solid #1c3a66}
#chatIn{flex:1;min-width:0;background:#050a14;border:2px solid #1c3a66;border-radius:10px;color:#fff;font-size:14px;padding:8px 10px;font-family:inherit;outline:none;-webkit-user-select:text;user-select:text}
#chatIn:focus{border-color:#4db8ff}
#chatForm button{width:42px;border:0;border-radius:10px;background:linear-gradient(90deg,#1e6fff,#4db8ff);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
#chatForm button svg{width:18px;height:18px}
#xhair{position:fixed;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);pointer-events:none;z-index:3;display:none}
#xhair.show{display:block}
#xhair:before,#xhair:after{content:'';position:absolute;background:#fff;box-shadow:0 0 3px #000}
#xhair:before{left:10px;top:0;width:2px;height:22px}#xhair:after{top:10px;left:0;height:2px;width:22px}
#aimbar{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);display:none;gap:10px;z-index:6}
#aimbar.show{display:flex}
#aimbar button{border:0;border-radius:999px;padding:12px 24px;font-weight:700;font-size:16px;font-family:inherit;color:#fff;cursor:pointer;touch-action:manipulation}
#aimFire{background:linear-gradient(90deg,#d63a3a,#ff7a4d);box-shadow:0 4px 0 #8a1f1f}
#aimCancel{background:rgba(10,16,32,.75);border:2px solid rgba(255,255,255,.6)!important}
#capBox{position:fixed;left:50%;top:calc(max(10px,env(safe-area-inset-top)) + 96px);transform:translateX(-50%);width:210px;z-index:3;display:none;text-align:center;pointer-events:none}
#capBox.show{display:block}
#capBox small{display:block;font-size:12px;font-weight:600;text-shadow:0 1px 3px #000;margin-bottom:2px}
#capBox .bar i{background:linear-gradient(#ffe27a,#f0a020)}
.slot.aiming{border-color:#ff5d5d;box-shadow:0 0 14px #ff5d5d,inset 0 0 12px #ff5d5d}
#modal{position:fixed;inset:0;background:rgba(0,0,10,.6);display:none;align-items:center;justify-content:center;z-index:20;touch-action:manipulation}
#modal.show{display:flex}
#mcard{width:min(92vw,320px);background:#141b34;border:2px solid #4de1ff55;border-radius:22px;padding:16px;box-shadow:0 12px 50px rgba(0,0,0,.6),0 0 40px #4de1ff33;text-align:center}
#mcard h3{margin:0 0 2px;font-size:17px;color:#4de1ff;letter-spacing:1px}
#mcard p{margin:0 0 8px;font-size:12px;opacity:.7}
#codeBox{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;letter-spacing:5px;min-height:44px;line-height:44px;background:#0a0f20;border-radius:12px;border:2px solid #2a3560;margin-bottom:6px;color:#fff;overflow:hidden}
#codeBox.err{border-color:#ff5d5d;animation:shk .3s}
@keyframes shk{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
#codeErr{min-height:18px;font-size:12px;color:#ff8a8a;font-weight:700;margin-bottom:4px}
#pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
#pad button,.mbtn{border:0;border-radius:14px;background:#222c50;color:#fff;font-size:24px;font-weight:800;height:clamp(44px,8.5vh,58px);cursor:pointer;touch-action:manipulation;font-family:inherit}
#pad button:active,.mbtn:active{background:#3a4a8a}
#mrow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px}
.mbtn{font-size:14px;height:44px}
.mbtn.ok{background:#1fa05a}
.mbtn.ok:disabled{opacity:.5}
.mbtn.del{background:#8a2a34}
#dc{position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(0,0,10,.85);z-index:30;text-align:center;padding:20px}
#dc button{margin-top:14px}
/* start screen */
#start{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 20%,rgba(14,50,120,.78),rgba(2,4,10,.94));z-index:10;overflow:auto;touch-action:pan-y}
#start.hide{display:none}
#card{background:rgba(5,10,22,.95);border:2px solid #4db8ff66;border-radius:24px;padding:24px 22px;width:min(92vw,460px);text-align:center;box-shadow:0 10px 50px rgba(0,0,0,.5),0 0 60px #4de1ff22;margin:auto}
#card h1{margin:0;font-size:40px;letter-spacing:3px;color:#fff;text-shadow:0 2px 0 #4db8ff,0 4px 0 #1e6fff,0 6px 0 #0a2a66,0 10px 18px rgba(30,111,255,.55);font-weight:700}
#card .sub{font-size:12px;opacity:.65;margin:2px 0 12px}
#lore{font-size:15px;line-height:1.6;min-height:150px;text-align:left;color:#d8e6ff;white-space:pre-wrap}
.cbtn{margin-top:14px;border:0;border-radius:999px;background:linear-gradient(90deg,#1e6fff,#4db8ff);color:#fff;font-size:18px;font-weight:700;padding:12px 30px;cursor:pointer;box-shadow:0 5px 0 #0a3d99;touch-action:manipulation;font-family:inherit}
.cbtn:active{transform:translateY(3px);box-shadow:0 2px 0 #0a3d99}
.cbtn:disabled{opacity:.5}
#form{display:none;text-align:left}
#form label{display:block;font-size:12px;font-weight:700;opacity:.75;margin:10px 0 4px}
#nameIn{width:100%;box-sizing:border-box;border:2px solid #2a3560;border-radius:12px;background:#0a0f20;color:#fff;font-size:18px;padding:10px 12px;font-family:inherit;outline:none;-webkit-user-select:text;user-select:text}
#nameIn:focus{border-color:#4de1ff}
#chars{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.chr{border:2px solid #2a3560;border-radius:12px;background:#0a0f20;padding:6px 2px 4px;cursor:pointer;text-align:center;color:#fff;font-family:inherit;touch-action:manipulation}
.chr canvas{width:46px;height:66px;image-rendering:pixelated;display:block;margin:0 auto}
.chr span{font-size:11px;font-weight:700;opacity:.85}
.chr.sel{border-color:#4de1ff;background:#13224a;box-shadow:0 0 14px #4de1ff66}
#roomInfo{font-size:13px;font-weight:700;color:#ffd84d;margin-bottom:2px;text-align:center}
#ferr{min-height:18px;color:#ff8a8a;font-size:13px;font-weight:700;text-align:center;margin-top:8px}
#form .cbtn{display:block;margin:6px auto 0}
@media (max-height:520px){#card{padding:14px 16px}#card h1{font-size:26px}#lore{min-height:110px;font-size:13px}.chr canvas{width:34px;height:49px}#chars{grid-template-columns:repeat(8,1fr)}}
@media (max-width:700px) and (orientation:landscape){#hint{display:none}}
@media (max-width:700px){body.playing #hint.hud{display:none!important}#roomTag{top:calc(max(10px,env(safe-area-inset-top)) + 74px);left:auto;right:max(10px,env(safe-area-inset-right));transform:none}#clock{top:calc(max(10px,env(safe-area-inset-top)) + 40px);right:max(10px,env(safe-area-inset-right))}}
@media (pointer:coarse){body.playing #hint.hud{display:none!important}.key{display:none}#prompt{bottom:auto;top:40%}}
</style>
</head>
<body>
<canvas id="c" tabindex="0"></canvas>
<div id="uw"></div>
<div id="night"></div>
<div id="fade"></div>
<div id="lcol" class="hud">
  <button id="camBtn" data-ico="eye" title="Kamera FPS (C)" aria-label="Kamera FPS"></button>
  <button id="chatBtn" title="Chat (Enter)" aria-label="Chat"><span data-ico="chat" style="display:flex;width:20px;height:20px"></span><i class="badge" id="chatBadge"></i></button>
  <button id="micBtn" class="vo off" data-ico="micoff" title="Mikrofon" aria-label="Mikrofon"></button>
  <button id="spkBtn" class="vo off active" data-ico="spk" title="Suara room" aria-label="Suara room"></button>
</div>
<div id="chatFeed" class="hud"></div>
<div id="chatPanel"><div id="chatList"></div><form id="chatForm"><input id="chatIn" maxlength="140" placeholder="Tulis pesan..." autocomplete="off"><button type="submit" data-ico="send" aria-label="Kirim"></button></form></div>
<div id="xhair"></div>
<div id="aimbar"><button id="aimFire">Tembak</button><button id="aimCancel">Batal</button></div>
<div id="capBox"><small id="capTxt"></small><div class="bar"><i id="capFill"></i></div></div>
<div id="hurt"></div>

<div id="hpBox" class="hud"><div id="hpName"><span id="myName"></span><span id="kd"></span></div><div class="bar"><i id="hpFill"></i></div></div>
<div id="oxyBox" class="hud"><small>🫧 Napas</small><div class="bar"><i id="oxyFill"></i></div></div>
<canvas id="mini" class="hud" width="192" height="192"></canvas>
<div id="roomTag" class="pill hud"></div>
<div id="clock" class="pill hud">☀️ 09:00</div>
<button id="bookBtn" class="hud off" aria-label="Buku teknik" title="Buku teknik (B)" data-ico="book"></button>
<button id="fsBtn" class="hud" aria-label="Layar penuh" title="Layar penuh" data-ico="fs"></button>
<button id="sbBtn" class="hud" aria-label="Papan skor" data-ico="trophy"></button>
<div id="board" class="hud"></div>
<div id="feed" class="hud"></div>
<div id="toast" class="pill"></div>
<div id="prompt" class="pill"><span class="key">E</span><span id="ptxt">Buka pintu</span></div>
<div id="hint" class="pill hud">WASD gerak · Shift lari · Spasi lompat/naik · V selam · J serang · K tahan · 1-5 teknik (bidik dulu) · B buku · C FPS · Enter chat · E aksi · Tab skor</div>
<div id="joyBase"></div><div id="joyKnob"></div>
<div id="ko"><h2>KO!</h2><p id="koTxt"></p></div>

<div id="slots">
  <button class="slot empty" data-i="0"><span class="k">1</span><span class="ic" data-ico="plus"></span><span class="nm"></span><i class="cd"></i></button>
  <button class="slot empty" data-i="1"><span class="k">2</span><span class="ic" data-ico="plus"></span><span class="nm"></span><i class="cd"></i></button>
  <button class="slot empty" data-i="2"><span class="k">3</span><span class="ic" data-ico="plus"></span><span class="nm"></span><i class="cd"></i></button>
  <button class="slot empty" data-i="3"><span class="k">4</span><span class="ic" data-ico="plus"></span><span class="nm"></span><i class="cd"></i></button>
  <button class="slot empty" data-i="4"><span class="k">5</span><span class="ic" data-ico="plus"></span><span class="nm"></span><i class="cd"></i></button>
</div>
<button id="btnAtk" class="btn hud"><i data-ico="sword"></i><small>Serang</small></button>
<button id="btnGuard" class="btn hud"><i data-ico="shield"></i><small>Tahan</small></button>
<button id="btnJump" class="btn hud"><i data-ico="jump"></i><small>Lompat</small></button>
<button id="btnAct" class="btn hud"><i data-ico="hand"></i><small>Aksi</small></button>
<button id="btnSnipe" class="btn hud"><i data-ico="scope"></i><small>Sniper</small></button>
<button id="btnDive" class="btn hud"><i data-ico="dive"></i><small>Selam</small></button>

<div id="modal"><div id="mcard">
  <h3 id="mTitle">TEKNIK DIGITAL</h3>
  <p id="mSub">Masukkan kode angka 1-9 dari buku</p>
  <div id="codeBox"></div>
  <div id="codeErr"></div>
  <div id="pad">
    <button data-d="1">1</button><button data-d="2">2</button><button data-d="3">3</button>
    <button data-d="4">4</button><button data-d="5">5</button><button data-d="6">6</button>
    <button data-d="7">7</button><button data-d="8">8</button><button data-d="9">9</button>
  </div>
  <div id="mrow"><button class="mbtn" id="mCancel">Batal</button><button class="mbtn" id="mBack"><span class="mi" data-ico="back"></span>Hapus</button><button class="mbtn ok" id="mOk">Pasang</button></div>
  <div id="mrow2" style="margin-top:8px;display:none"><button class="mbtn del" id="mClear" style="width:100%">Kosongkan slot ini</button></div>
</div></div>

<div id="book"><div id="bk">
  <button id="bkX" aria-label="Tutup" data-ico="close"></button>
  <div id="bkPages"><div class="pg left" id="pgL"></div><div class="spine"></div><div class="pg right" id="pgR"></div></div>
  <button class="bkb" id="bkPrev" data-ico="chevl"></button><button class="bkb" id="bkNext" data-ico="chevr"></button>
</div></div>

<div id="dc"><h2 id="dcT">Terputus</h2><p id="dcP"></p><button class="cbtn" onclick="location.reload()">Muat ulang</button></div>

<div id="start"><div id="card">
  <h1>Digital War</h1>
  <div class="sub">Pertarungan di dunia kode</div>
  <div id="step1">
    <div id="lore"></div>
    <button class="cbtn" id="loreGo">Lanjut<i class="inl" data-ico="chevr"></i></button>
  </div>
  <div id="form">
    <div id="roomInfo">Memuat room…</div>
    <label for="nameIn">Namamu</label>
    <input id="nameIn" maxlength="14" autocomplete="off" placeholder="Tulis namamu">
    <label>Pilih karakter</label>
    <div id="chars"></div>
    <div id="ferr"></div>
    <button class="cbtn" id="go">Masuk<i class="inl" data-ico="sword"></i></button>
  </div>
</div></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
(function(){
if(typeof THREE==='undefined'){document.body.innerHTML='<p style="padding:24px;font-size:16px">Three.js gagal dimuat (butuh internet). Coba muat ulang halaman.</p>';return;}
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const sstep=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t)};
const damp=(k,dt)=>1-Math.exp(-k*dt);
const LS={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const ROOM=(location.pathname.split('/')[2]||'').toUpperCase();
const MAXHP=100;
/* ---------- ikon SVG buatan sendiri ---------- */
const ICO={
 book:'<path d="M2.5 5.5c3.2-1.6 6.3-1.4 9.5 1v13c-3.200-2.400-6.300-2.600-9.500-1z"/><path d="M21.500 5.500c-3.200-1.600-6.300-1.400-9.500 1v13c3.200-2.400 6.300-2.600 9.500-1z"/>',
 fs:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
 fsx:'<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
 trophy:'<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 20h8"/>',
 orb:'<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/><path d="M12 4a8 8 0 0 1 0 16M12 4a8 8 0 0 0 0 16"/>',
 chat:'<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.500h8M8 12.500h5"/>',
 eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
 micoff:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6M3 3l18 18"/>',
 spk:'<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.500a5 5 0 0 1 0 7M18.500 6a8.500 8.500 0 0 1 0 12"/>',
 spkoff:'<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>',
 send:'<path d="M3 11l18-8-8 18-2-8z"/>',
 scope:'<circle cx="12" cy="12" r="6.500"/><path d="M12 2.500v5M12 16.500v5M2.500 12h5M16.500 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
 back:'<path d="M20 5H9l-6 7 6 7h11z"/><path d="M13 9.500l4 5M17 9.500l-4 5"/>',
 sword:'<path d="M20 4L9 15M6.5 12.5l5 5M9 15l-4.5 4.5M4 4l11 11M12.5 17.5l5-5M15 15l4.500 4.500"/><circle cx="4" cy="20" r="1" fill="currentColor"/><circle cx="20" cy="20" r="1" fill="currentColor"/>',
 shield:'<path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z"/><path d="M9 12l2.200 2.200L15.500 10"/>',
 jump:'<path d="M12 19V6M6 12l6-6 6 6M6 21.500h12"/>',
 dive:'<path d="M12 3.500v11M6.500 9.500l5.500 5.500 5.500-5.500M3 20c2-1.500 4-1.500 6 0s4 1.500 6 0 4-1.500 6 0"/>',
 hand:'<path d="M8 13V6.500a1.500 1.500 0 0 1 3 0V11M11 11V4.500a1.500 1.500 0 0 1 3 0V11M14 11V6.500a1.500 1.500 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.500 1.500 0 0 1 2.500-1.500L8 15"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 close:'<path d="M6 6l12 12M18 6L6 18"/>',
 chevl:'<path d="M15 5l-7 7 7 7"/>',
 chevr:'<path d="M9 5l7 7-7 7"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.500v2.500M12 19v2.500M2.500 12H5M19 12h2.500M5.300 5.300l1.800 1.800M16.900 16.900l1.800 1.800M18.700 5.300l-1.800 1.800M7.100 16.900l-1.800 1.800"/>',
 moon:'<path d="M20 14.500A8 8 0 1 1 9.500 4a6.500 6.500 0 0 0 10.500 10.500z"/>',
 dead:'<circle cx="12" cy="12" r="8.500"/><path d="M8.500 8.500l7 7M15.500 8.500l-7 7"/>',
 /* jenis teknik */
 bolt:'<path d="M2.500 8h7M1.500 12h8M2.500 16h7"/><circle cx="16.500" cy="12" r="4.500" fill="currentColor" fill-opacity=".25"/>',
 nova:'<circle cx="12" cy="12" r="3.200" fill="currentColor" fill-opacity=".25"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.800 2.800M16.200 16.200L19 19M19 5l-2.800 2.800M7.800 16.200L5 19"/>',
 beam:'<path d="M2.500 12h19M6.500 7.500L4 12l2.500 4.500M19.500 8.500v7"/>',
 slam:'<path d="M13.500 3.500l7 7-4 4-7-7z"/><path d="M11.500 12.500L3.500 20.500"/>',
 trap:'<circle cx="12" cy="12" r="5" fill="currentColor" fill-opacity=".25"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2 2M16.700 16.700l2 2M18.700 5.300l-2 2M7.300 16.700l-2 2"/>',
 summon:'<path d="M1.500 9.500c4-1.200 7.500 0 10.500 4.500 3-4.500 6.500-5.700 10.500-4.500-2 3.200-4.200 4.500-6.500 4.500L12 20.500l-4-6c-2.300 0-4.500-1.300-6.500-5z"/>',
 ride:'<path d="M1.500 12.500c4-1.200 7.500 0 10.500 4.500 3-4.500 6.500-5.700 10.500-4.500-2 3.200-4.200 4.500-6.500 4.500L12 23l-4-6c-2.300 0-4.500-1.300-6.500-4.500z"/><circle cx="12" cy="6" r="2.500"/><path d="M12 8.500v3"/>',
 heal:'<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor" fill-opacity=".2"/>',
 regen:'<path d="M20 12a8 8 0 1 1-2.700-6"/><path d="M20 3.500v4.500h-4.500"/><path d="M12 9v6M9 12h6"/>',
 haste:'<path d="M4.500 5l7 7-7 7M12.500 5l7 7-7 7"/>',
 dash:'<path d="M13.500 2L4.500 14h7l-1 8 9-12h-7z" fill="currentColor" fill-opacity=".2"/>',
 spark:'<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'
};
function svg(name,color,cls){return '<svg class="'+(cls||'svgi')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'+(color?' style="color:'+color+'"':'')+'>'+(ICO[name]||ICO.spark)+'</svg>';}
function kdHtml(k,d){return svg('sword',null,'kdi')+' '+k+'&nbsp;&nbsp;'+svg('dead',null,'kdi')+' '+d;}


/* ---------- renderer / scene ---------- */
const canvas=$('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
const scene=new THREE.Scene();
scene.fog=new THREE.Fog(0xcfe9f4,50,175);
const skyCv=document.createElement('canvas');skyCv.width=2;skyCv.height=256;const skyTex=new THREE.CanvasTexture(skyCv);scene.background=skyTex;
function paintSky(t,m,bo){const x=skyCv.getContext('2d'),g=x.createLinearGradient(0,0,0,256);g.addColorStop(0,'#'+t.getHexString());g.addColorStop(.5,'#'+m.getHexString());g.addColorStop(.8,'#'+bo.getHexString());g.addColorStop(1,'#'+bo.getHexString());x.fillStyle=g;x.fillRect(0,0,2,256);skyTex.needsUpdate=true;}
const camera=new THREE.PerspectiveCamera(50,1,0.1,400);
const hemi=new THREE.HemisphereLight(0xdff1ff,0x7a9a62,0.7);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xfff0d0,0.6);sun.position.set(-40,70,30);scene.add(sun);
const mat=(color,extra)=>new THREE.MeshPhongMaterial(Object.assign({color,flatShading:true,shininess:0,specular:0x000000},extra||{}));

/* ---------- noise ---------- */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function hash2(x,y){let h=Math.imul(x,374761393)+Math.imul(y,668265263)|0;h=Math.imul(h^(h>>>13),1274126177);h^=h>>>16;return(h>>>0)/4294967296}
function vnoise(x,y){const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);const a=hash2(xi,yi),b=hash2(xi+1,yi),c=hash2(xi,yi+1),d=hash2(xi+1,yi+1);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v}
function fbm(x,y){return vnoise(x,y)*0.6+vnoise(x*2.1+7.3,y*2.1+1.7)*0.28+vnoise(x*4.3+3.1,y*4.3+9.4)*0.12}
const rand=mulberry32(20241);

/* ---------- world layout ---------- */
const LAKE={x:0,z:-48,R:11},WATER_Y=-0.5,SURF_Y=-1.65;
const CAVE={x:-15,z:87},CX=3000,CZ=0,CAVE_R=32;
const FORT_DEFS=[{id:0,name:'Benteng Fajar',x:62,z:-52},{id:1,name:'Benteng Senja',x:-72,z:-52},{id:2,name:'Benteng Bayu',x:40,z:78}];
const FORT_RANGE=7;
const CAMP_DEFS=[{id:0,x:88,z:0},{id:1,x:-90,z:0},{id:2,x:0,z:-92}];
const flats=[{x:0,z:0,r:22,b:14},{x:LAKE.x,z:LAKE.z,r:16,b:10},{x:CAVE.x,z:CAVE.z,r:9,b:9}].concat(FORT_DEFS.map(f=>({x:f.x,z:f.z,r:15,b:9}))).concat(CAMP_DEFS.map(c=>({x:c.x,z:c.z,r:16,b:8})));
const houseSpecs=[];
for(let i=0;i<5;i++){const th=i/5*Math.PI*2+0.5,x=Math.cos(th)*14.5,z=Math.sin(th)*14.5;houseSpecs.push({x,z,rot:Math.atan2(-Math.cos(th),-Math.sin(th))});}
[[62,34],[-70,-22],[18,-82]].forEach(([x,z],i)=>{houseSpecs.push({x,z,rot:i*Math.PI/2+0.4,far:true});flats.push({x,z,r:8,b:10});});
const towerSpecs=[{x:36,z:-28,n:6},{x:-48,z:46,n:8}];
towerSpecs.forEach(t=>flats.push({x:t.x,z:t.z,r:9,b:10}));
function lakeDist(x,z){return Math.hypot(x-LAKE.x,z-LAKE.z);}
function lakeDepth(x,z){return 5.5*(1-sstep(LAKE.R-5,LAKE.R+0.5,lakeDist(x,z)));}
function waterDepthAt(x,z){return lakeDist(x,z)<LAKE.R+1.5?Math.max(0,WATER_Y-terrainH(x,z)):0;}
function terrainH(x,z){
  if(x>1000)return 0;
  let m=1;
  for(const f of flats){const d=Math.hypot(x-f.x,z-f.z);if(d<f.r+f.b){const t=d<=f.r?0:(d-f.r)/f.b;const s=t*t*(3-2*t);if(s<m)m=s;}}
  const hills=(fbm(x*0.018,z*0.018)-0.5)*22+(fbm(x*0.06+50,z*0.06+50)-0.5)*3;
  const e=clamp((Math.hypot(x,z)-100)/42,0,1);
  return hills*m+e*e*(3-2*e)*38-lakeDepth(x,z);
}
function nearFlat(x,z,pad){for(const f of flats)if(Math.hypot(x-f.x,z-f.z)<f.r+pad)return true;return false}
const pathSegs=[];
houseSpecs.forEach(h=>{
  const fx=h.x+Math.sin(h.rot)*5.2,fz=h.z+Math.cos(h.rot)*5.2;
  if(h.far)pathSegs.push([fx,fz,h.x+Math.sin(h.rot)*10,h.z+Math.cos(h.rot)*10]);
  else pathSegs.push([fx,fz,0,0]);
});
function distSeg(px,pz,ax,az,bx,bz){const dx=bx-ax,dz=bz-az;let t=((px-ax)*dx+(pz-az)*dz)/(dx*dx+dz*dz);t=clamp(t,0,1);return Math.hypot(px-(ax+dx*t),pz-(az+dz*t));}

/* ---------- terrain mesh ---------- */
const SIZE=300,SEG=150;
(function(){
  const g=new THREE.PlaneGeometry(SIZE,SIZE,SEG,SEG);g.rotateX(-Math.PI/2);
  const pos=g.attributes.position,cols=new Float32Array(pos.count*3);
  const gA=new THREE.Color('#7fcf62'),gB=new THREE.Color('#52a24c'),rock=new THREE.Color('#8f8c86'),snow=new THREE.Color('#f3f7fa'),path=new THREE.Color('#cdb787'),plaza=new THREE.Color('#bfb08c'),sand=new THREE.Color('#d9c894'),deep=new THREE.Color('#3b5a6e'),c=new THREE.Color();
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i),z=pos.getZ(i),h=terrainH(x,z);pos.setY(i,h);
    const n=fbm(x*0.08+100,z*0.08+100);c.copy(gA).lerp(gB,clamp((n-0.3)/0.4,0,1));
    c.lerp(rock,sstep(8,17,h));c.lerp(snow,sstep(22,30,h));
    const r=Math.hypot(x,z);
    if(h<1.5){
      let k=0;for(const s of pathSegs){k=Math.max(k,1-sstep(1.0,1.9,distSeg(x,z,s[0],s[1],s[2],s[3])));}
      c.lerp(path,k*0.9);c.lerp(plaza,1-sstep(7,9,r));
    }
    const ld=lakeDepth(x,z);
    if(ld>0.05){c.lerp(sand,sstep(0.05,1.0,ld)*0.9);c.lerp(deep,sstep(2.5,5.5,ld));}
    cols[i*3]=c.r;cols[i*3+1]=c.g;cols[i*3+2]=c.b;
  }
  g.setAttribute('color',new THREE.BufferAttribute(cols,3));g.computeVertexNormals();
  scene.add(new THREE.Mesh(g,new THREE.MeshPhongMaterial({vertexColors:true,flatShading:true,shininess:0,specular:0})));
})();
/* lake water */
const lakeMat=new THREE.MeshPhongMaterial({color:0x2a82cc,emissive:0x0a2f58,transparent:true,opacity:0.74,shininess:10,specular:0x335577,flatShading:true,side:THREE.DoubleSide,depthWrite:false});
const lakeMesh=new THREE.Mesh(new THREE.CircleGeometry(LAKE.R+2.5,48).rotateX(-Math.PI/2),lakeMat);lakeMesh.position.set(LAKE.x,WATER_Y,LAKE.z);lakeMesh.renderOrder=3;scene.add(lakeMesh);

/* ---------- colliders ---------- */
const circles=[],platforms=[],obbs=[];
const PR=0.4;
function groundAt(x,z,y){let g=terrainH(x,z);for(const p of platforms){const dx=x-p.x,dz=z-p.z;if(dx*dx+dz*dz<(p.r+0.15)*(p.r+0.15)&&y>=p.top-0.35&&p.top>g)g=p.top;}return g;}

/* ---------- textures ---------- */
function radialTex(stops,size){size=size||64;const c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d');const g=x.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);stops.forEach(s=>g.addColorStop(s[0],s[1]));x.fillStyle=g;x.fillRect(0,0,size,size);return new THREE.CanvasTexture(c);}
const dotTex=radialTex([[0,'rgba(255,255,255,1)'],[0.5,'rgba(255,255,255,.55)'],[1,'rgba(255,255,255,0)']]);
const blobTex=radialTex([[0,'rgba(0,0,0,.5)'],[0.6,'rgba(0,0,0,.28)'],[1,'rgba(0,0,0,0)']]);

/* ---------- instanced props ---------- */
const dummy=new THREE.Object3D();
function inst(geo,m,arr,setter){
  if(!arr.length)return null;
  const im=new THREE.InstancedMesh(geo,m,arr.length);
  arr.forEach((it,i)=>{dummy.position.set(0,0,0);dummy.rotation.set(0,0,0);dummy.scale.set(1,1,1);setter(it,dummy,im,i);dummy.updateMatrix();im.setMatrixAt(i,dummy.matrix);});
  im.instanceMatrix.needsUpdate=true;if(im.instanceColor)im.instanceColor.needsUpdate=true;scene.add(im);return im;
}
const tmpC=new THREE.Color();
const trees=[];
for(let i=0;i<5000&&trees.length<400;i++){
  const a=rand()*Math.PI*2,r=Math.sqrt(rand())*110,x=Math.cos(a)*r,z=Math.sin(a)*r;
  if(nearFlat(x,z,3))continue;
  if(fbm(x*0.035+9,z*0.035+9)<0.47&&rand()<0.85)continue;
  const h=terrainH(x,z);if(h>11||Math.abs(terrainH(x+1.5,z)-h)>1.5||Math.abs(terrainH(x,z+1.5)-h)>1.5)continue;
  trees.push({x,z,h,s:0.8+rand()*0.8,type:rand()<0.6?0:1,v:rand(),ry:rand()*6.28});
}
trees.forEach(t=>circles.push({x:t.x,z:t.z,r:0.5*t.s}));
const trunkG=new THREE.CylinderGeometry(0.18,0.28,1.6,6).translate(0,0.8,0);
const coneG1=new THREE.ConeGeometry(1.5,2.6,7).translate(0,2.6,0),coneG2=new THREE.ConeGeometry(1.1,2.2,7).translate(0,3.9,0),roundG=new THREE.IcosahedronGeometry(1.6,0).translate(0,3.0,0);
const treeMat=mat(0xffffff);
inst(trunkG,mat('#7a5233'),trees,(t,d)=>{d.position.set(t.x,t.h,t.z);d.scale.setScalar(t.s);d.rotation.y=t.ry;});
const pines=trees.filter(t=>t.type===0),rounds=trees.filter(t=>t.type===1);
const pineCol=(t,d,im,i)=>{d.position.set(t.x,t.h,t.z);d.scale.setScalar(t.s);d.rotation.y=t.ry;im.setColorAt(i,tmpC.setHSL(0.36+t.v*0.05,0.45,0.26+t.v*0.1));};
inst(coneG1,treeMat,pines,pineCol);inst(coneG2,treeMat,pines,pineCol);
inst(roundG,treeMat,rounds,(t,d,im,i)=>{d.position.set(t.x,t.h,t.z);d.scale.set(t.s,t.s*0.9,t.s);d.rotation.y=t.ry;im.setColorAt(i,tmpC.setHSL(0.27+t.v*0.07,0.5,0.38+t.v*0.1));});
const shGeo=new THREE.CircleGeometry(1,14).rotateX(-Math.PI/2);
const shMat=new THREE.MeshBasicMaterial({map:blobTex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
inst(shGeo,shMat,trees,(t,d)=>{d.position.set(t.x+0.4,t.h+0.12,t.z+0.3);d.scale.setScalar(t.s*(t.type?1.9:1.7));});

const rocks=[];
for(let i=0;i<3000&&rocks.length<75;i++){
  const a=rand()*Math.PI*2,r=Math.sqrt(rand())*112,x=Math.cos(a)*r,z=Math.sin(a)*r;
  if(nearFlat(x,z,2))continue;const h=terrainH(x,z);if(h>14)continue;
  rocks.push({x,z,h,s:0.5+rand()*1.6,ry:rand()*6.28});
}
rocks.forEach(k=>{if(k.s>=1.1)platforms.push({x:k.x,z:k.z,r:0.9*k.s,top:k.h+0.2*k.s+0.55*k.s});else if(k.s>0.8)circles.push({x:k.x,z:k.z,r:0.7*k.s});});
inst(new THREE.DodecahedronGeometry(1,0),mat('#9b9a95'),rocks,(k,d,im,i)=>{d.position.set(k.x,k.h+0.2*k.s,k.z);d.scale.set(k.s,k.s*0.7,k.s);d.rotation.y=k.ry;im.setColorAt(i,tmpC.setHSL(0.1,0.04,0.5+rand()*0.15));});

const flowers=[];
for(let i=0;i<5000&&flowers.length<650;i++){
  const a=rand()*Math.PI*2,r=Math.sqrt(rand())*100,x=Math.cos(a)*r,z=Math.sin(a)*r;
  if(r<10)continue;
  if(lakeDist(x,z)<LAKE.R+3)continue;
  if(Math.hypot(x-CAVE.x,z-CAVE.z)<12)continue;
  if(FORT_DEFS.some(f=>Math.hypot(x-f.x,z-f.z)<14))continue;
  if(CAMP_DEFS.some(c=>Math.hypot(x-c.x,z-c.z)<18))continue;
  let bad=false;for(const h of houseSpecs)if(Math.hypot(x-h.x,z-h.z)<7.5){bad=true;break;}if(bad)continue;
  for(const t of towerSpecs)if(Math.hypot(x-t.x,z-t.z)<7){bad=true;break;}if(bad)continue;
  const h=terrainH(x,z);if(h>9)continue;
  flowers.push({x,z,h,c:rand(),s:0.7+rand()*0.7});
}
const FC=['#ff6f91','#ffd84d','#ffffff','#b38bff','#ff9a3c','#6cd4ff'];
inst(new THREE.ConeGeometry(0.1,0.5,4).translate(0,0.25,0),mat('#3f8f3f'),flowers,(f,d)=>{d.position.set(f.x,f.h,f.z);d.scale.setScalar(f.s);});
inst(new THREE.IcosahedronGeometry(0.17,0).translate(0,0.55,0),mat(0xffffff),flowers,(f,d,im,i)=>{d.position.set(f.x,f.h,f.z);d.scale.setScalar(f.s);im.setColorAt(i,tmpC.set(FC[Math.floor(f.c*FC.length)]));});

/* lake decor: lily pads + reeds */
{
  const lp=[];for(let i=0;i<9;i++){const a=rand()*6.28,r=3+rand()*5.5;lp.push({x:LAKE.x+Math.cos(a)*r,z:LAKE.z+Math.sin(a)*r,s:0.6+rand()*0.5});}
  inst(new THREE.CircleGeometry(0.8,8).rotateX(-Math.PI/2),mat('#3f9a4f'),lp,(p,d)=>{d.position.set(p.x,WATER_Y+0.04,p.z);d.scale.setScalar(p.s);});
  const rd=[];for(let i=0;i<26;i++){const a=rand()*6.28,r=LAKE.R+0.2+rand()*1.6;rd.push({x:LAKE.x+Math.cos(a)*r,z:LAKE.z+Math.sin(a)*r,s:0.8+rand()*0.8});}
  inst(new THREE.ConeGeometry(0.08,1.4,4).translate(0,0.7,0),mat('#5a9a3f'),rd,(p,d)=>{d.position.set(p.x,terrainH(p.x,p.z),p.z);d.scale.setScalar(p.s);});
}

/* ---------- boxes helper ---------- */
function box(parent,w,h,d,m,x,y,z){const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);b.position.set(x,y,z);parent.add(b);return b;}

/* ---------- houses ---------- */
const WALLH=3.4;
const wallPal=['#f3e3c3','#ead2aa','#d9e4ec','#f2d6d6','#e1ebc9','#f0e0b8','#d8d3ea','#f6dcc2'];
const roofPal=['#c8553d','#3e6fa8','#7a5a9a','#2f8f7a','#d08a2e','#b84a6a','#4a7f4a','#8a5a3a'];
const houses=[],doors=[],winMats=[];
function addOBB(h,lx,lz,hx,hz,enabled){
  const o={cx:h.x+lx*h.c+lz*h.s,cz:h.z-lx*h.s+lz*h.c,c:h.c,s:h.s,hx,hz,enabled:enabled!==false};obbs.push(o);return o;
}
function l2w(h,lx,lz){return {x:h.x+lx*h.c+lz*h.s,z:h.z-lx*h.s+lz*h.c};}
houseSpecs.forEach((sp,idx)=>{
  const h={x:sp.x,z:sp.z,rot:sp.rot,c:Math.cos(sp.rot),s:Math.sin(sp.rot),roofMats:[],wallMats:[],roofOp:1,wallOp:1};
  const g=new THREE.Group();g.position.set(sp.x,0,sp.z);g.rotation.y=sp.rot;scene.add(g);h.g=g;
  const wm=mat(wallPal[idx%wallPal.length]),stone=mat('#a59d8f'),wood=mat('#8a5a3a'),dark=mat('#6e4528');h.wallMats.push(wm,stone,wood,dark);
  const walls=[[0,-3.5,4,0.15],[-4,0,0.15,3.5],[4,0,0.15,3.5],[-2.5,3.5,1.5,0.15],[2.5,3.5,1.5,0.15]];
  walls.forEach(w=>{box(g,w[2]*2,WALLH,w[3]*2,wm,w[0],WALLH/2,w[1]);box(g,w[2]*2+0.12,0.4,w[3]*2+0.12,stone,w[0],0.2,w[1]);addOBB(h,w[0],w[1],w[2],w[3]);});
  box(g,2.2,0.79,0.34,wm,0,2.995,3.5);
  box(g,0.16,2.56,0.38,dark,-1.06,1.28,3.5);box(g,0.16,2.56,0.38,dark,1.06,1.28,3.5);box(g,2.28,0.16,0.4,dark,0,2.68,3.5);
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(7.7,6.7).rotateX(-Math.PI/2),mat('#b98a5a',{polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));fl.position.set(0,0.02,0);g.add(fl);
  const rug=new THREE.Mesh(new THREE.CircleGeometry(1.5,24).rotateX(-Math.PI/2),mat(roofPal[(idx+3)%8],{polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));rug.position.set(0.2,0.025,-0.9);g.add(rug);
  const mt=new THREE.Mesh(new THREE.PlaneGeometry(1.5,0.9).rotateX(-Math.PI/2),mat('#9a4a3a',{polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));mt.position.set(0,0.03,4.2);g.add(mt);
  box(g,2.0,0.5,1.6,wood,-2.6,0.3,-2.5);box(g,2.0,0.25,1.6,mat('#e8e0d0'),-2.6,0.62,-2.5);box(g,0.7,0.15,0.5,mat('#e06a6a'),-3.2,0.82,-2.5);addOBB(h,-2.6,-2.5,1.0,0.8);
  box(g,1.8,0.1,1.1,wood,2.4,0.9,-1.7);box(g,0.3,0.9,0.3,dark,2.4,0.45,-1.7);box(g,1.0,0.08,0.7,dark,2.4,0.04,-1.7);addOBB(h,2.4,-1.7,0.9,0.55);
  const lan=new THREE.Mesh(new THREE.SphereGeometry(0.16,8,6),new THREE.MeshBasicMaterial({color:0xffd27a}));lan.position.set(2.4,1.12,-1.7);g.add(lan);
  box(g,0.5,0.4,0.5,mat('#b5683f'),3.2,0.2,2.6);const pl=new THREE.Mesh(new THREE.IcosahedronGeometry(0.4,0),mat('#3f9a4f'));pl.position.set(3.2,0.75,2.6);g.add(pl);addOBB(h,3.2,2.6,0.28,0.28);
  const gl=new THREE.MeshBasicMaterial({color:0xa9dcf5});winMats.push(gl);
  [[-4.18,-0.2,0],[4.18,-0.2,0]].forEach(w=>{box(g,0.08,1.2,1.5,dark,w[0],1.8,w[1]);box(g,0.1,1.0,1.3,gl,w[0],1.8,w[1]);});
  box(g,1.5,1.2,0.08,dark,0,1.8,-3.68);box(g,1.3,1.0,0.1,gl,0,1.8,-3.68);
  const rm=mat(roofPal[idx%roofPal.length],{transparent:true}),cm=mat('#8a8278',{transparent:true});h.roofMats.push(rm,cm);
  const rg=new THREE.ConeGeometry(1,1,4,1);rg.rotateY(Math.PI/4);
  const roof=new THREE.Mesh(rg,rm);roof.scale.set(8/1.414*1.2,2.7,7/1.414*1.2);roof.position.set(0,WALLH+1.35,0);g.add(roof);
  const chim=box(g,0.8,1.8,0.8,cm,2.2,WALLH+1.4,-1.2);h.roofParts=[roof,chim];
  const pivot=new THREE.Group();pivot.position.set(-1,0,3.5);g.add(pivot);
  box(pivot,2,2.6,0.12,wood,1,1.3,0);box(pivot,0.12,2.2,0.14,dark,1,1.3,0);
  const kn=new THREE.Mesh(new THREE.SphereGeometry(0.09,8,6),new THREE.MeshBasicMaterial({color:0xffd04a}));kn.position.set(1.7,1.2,0.1);pivot.add(kn);
  const dc=addOBB(h,0,3.5,1,0.15,true);
  const wp=l2w(h,0,3.5);
  doors.push({pivot,h,ang:0,vel:0,target:0,open:false,col:dc,wx:wp.x,wz:wp.z});
  const sh=new THREE.Mesh(new THREE.PlaneGeometry(14,13).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:blobTex,transparent:true,depthWrite:false,opacity:.8,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));sh.position.set(0.6,0.06,0.5);g.add(sh);
  houses.push(h);
});

/* ---------- fountain + towers ---------- */
function addPillar(x,z,r,top,moss){
  const g=new THREE.Group();g.position.set(x,0,z);scene.add(g);
  const hgt=top+3;const p=new THREE.Mesh(new THREE.CylinderGeometry(r,r*1.06,hgt,10),mat('#b9b2a3'));p.position.y=top-0.14-hgt/2;g.add(p);
  const cap=new THREE.Mesh(new THREE.CylinderGeometry(r*1.02,r*1.02,0.14,10),mat(moss||'#86c46f'));cap.position.y=top-0.07;g.add(cap);
  platforms.push({x,z,r,top});
}
towerSpecs.forEach(t=>{
  for(let i=0;i<t.n;i++){const a=i*0.78+0.3;addPillar(t.x+Math.cos(a)*4.2,t.z+Math.sin(a)*4.2,1.35,0.9*(i+1));}
  addPillar(t.x,t.z,2.1,0.9*(t.n+1),'#ffd84d');
});
/* dock on the lake */
{
  const dk=new THREE.Group();dk.position.set(LAKE.x,0,LAKE.z+LAKE.R+0.3);scene.add(dk);
  const wd=mat('#9a6a44');
  for(let i=0;i<6;i++)box(dk,3,0.18,0.9,wd,0,0.05,-i*1.0);
  [[-1.4,0],[1.4,0],[-1.4,-5],[1.4,-5]].forEach(p=>box(dk,0.25,1.6,0.25,mat('#6e4528'),p[0],-0.5,p[1]));
}

/* ---------- benteng (bisa direbut) ---------- */
function fortColor(ch){const p=CHARS[clamp(ch|0,0,CHARS.length-1)].pal;return p.tunic||PAL_PLAYER.tunic;}
const forts=FORT_DEFS.map(def=>{
  const f=Object.assign({owner:0,ownerName:'',ownerCh:0,capEnd:0,capBy:0},def);
  const rot=Math.atan2(-f.x,-f.z),c=Math.cos(rot),s=Math.sin(rot);
  const g=new THREE.Group();g.position.set(f.x,0,f.z);g.rotation.y=rot;scene.add(g);
  const stone=mat('#bdb6a6'),stoneD=mat('#8e877a'),roofM=mat('#8a4a3a'),wood=mat('#7a5233');
  const H=3.2,hh={x:f.x,z:f.z,c,s};
  const wall=(lx,lz,hx,hz)=>{
    box(g,hx*2,H,hz*2,stone,lx,H/2,lz);box(g,hx*2+0.25,0.35,hz*2+0.25,stoneD,lx,H+0.17,lz);
    const horiz=hx>hz,n=Math.max(2,Math.floor((horiz?hx:hz)*2/1.4));
    for(let i=0;i<n;i++){const t=(i+0.5)/n*2-1;box(g,horiz?0.7:hx*2+0.2,0.7,horiz?hz*2+0.2:0.7,stoneD,horiz?lx+t*hx:lx,H+0.7,horiz?lz:lz+t*hz);}
    addOBB(hh,lx,lz,hx,hz);
  };
  wall(0,-8,8.6,0.6);wall(-8,0,0.6,8.6);wall(8,0,0.6,8.6);wall(-5.3,8,3,0.6);wall(5.3,8,3,0.6);
  box(g,5.2,0.9,1.3,stoneD,0,H+0.45,8);                                /* ambang gerbang */
  [[-8,-8],[8,-8],[-8,8],[8,8]].forEach(q=>{
    const tw=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.9,5.6,10),stone);tw.position.set(q[0],2.8,q[1]);g.add(tw);
    const rf=new THREE.Mesh(new THREE.ConeGeometry(2.3,1.8,10),roofM);rf.position.set(q[0],6.5,q[1]);g.add(rf);
    const w=l2w(hh,q[0],q[1]);circles.push({x:w.x,z:w.z,r:1.9});
  });
  box(g,5.2,5.2,5.2,stone,0,2.6,-3.6);box(g,5.8,0.5,5.8,stoneD,0,5.45,-3.6);addOBB(hh,0,-3.6,2.6,2.6);
  const kr=new THREE.Mesh(new THREE.ConeGeometry(4.4,2.2,4),roofM);kr.rotation.y=Math.PI/4;kr.position.set(0,6.7,-3.6);g.add(kr);
  box(g,1.3,2.2,0.25,wood,0,1.1,-0.95);                                /* pintu keep */
  const fl=new THREE.Mesh(new THREE.BoxGeometry(15.6,0.3,15.6),mat('#a89f88'));fl.position.y=0.02;g.add(fl);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.12,4,6),wood);pole.position.set(0,8.8,-3.6);g.add(pole);
  const flagMat=new THREE.MeshBasicMaterial({color:0x7f8794,side:THREE.DoubleSide,fog:false});
  const flag=new THREE.Mesh(new THREE.PlaneGeometry(2.4,1.4).translate(1.2,0,0),flagMat);flag.position.set(0.1,10.2,-3.6);g.add(flag);
  const cv=document.createElement('canvas');cv.width=320;cv.height=96;const tex=new THREE.CanvasTexture(cv);
  const lab=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));lab.scale.set(8,2.4,1);lab.renderOrder=19;
  const lw=l2w(hh,0,-3.6);lab.position.set(lw.x,12.6,lw.z);scene.add(lab);
  Object.assign(f,{g,flagMat,flag,lab,cv,tex,hh});
  return f;
});
function drawFortLabel(f){
  const c=f.cv.getContext('2d');c.clearRect(0,0,320,96);
  c.textAlign='center';c.textBaseline='middle';
  c.font='600 22px Poppins,sans-serif';c.lineWidth=5;c.strokeStyle='rgba(8,12,30,.9)';c.fillStyle='#ffd84d';
  c.strokeText(f.name,160,20);c.fillText(f.name,160,20);
  const nm=f.owner?f.ownerName:'Kosong - rebut dengan Aksi';
  c.font='700 36px Poppins,sans-serif';let fs=36;while(c.measureText(nm).width>300&&fs>16){fs--;c.font='700 '+fs+'px Poppins,sans-serif';}
  c.strokeText(nm,160,62);c.fillStyle=f.owner?'#ffffff':'#c8d4e8';c.fillText(nm,160,62);
  f.tex.needsUpdate=true;
}
function setFortState(inf){
  const f=forts[inf.id];if(!f)return;
  f.owner=inf.owner||0;f.ownerName=inf.name||'';f.ownerCh=inf.ch||0;
  f.flagMat.color.set(f.owner?fortColor(f.ownerCh):'#7f8794');
  drawFortLabel(f);
}
forts.forEach(drawFortLabel);
function stepKind(){
  if(insideHouse)return 'wood';if(inCave)return 'stone';
  if(waterDepthAt(pos.x,pos.z)>0.2)return 'water';
  for(const f of forts)if(Math.abs(f.x-pos.x)<8&&Math.abs(f.z-pos.z)<8)return 'stone';
  if(Math.hypot(pos.x,pos.z)<9||pos.y>0.6)return 'stone';
  if(lakeDist(pos.x,pos.z)<LAKE.R+3)return 'sand';
  return 'grass';
}
function nearestFort(){let best=null,bd=FORT_RANGE-0.5;for(const f of forts){const d=Math.hypot(f.x-pos.x,f.z-pos.z);if(d<bd){bd=d;best=f;}}return best;}
function updForts(dt){
  for(const f of forts){
    f.flag.rotation.y=Math.sin(tAll*3+f.id)*0.25;
    const d=Math.hypot(f.x-pos.x,f.z-pos.z);f.lab.visible=d<150&&!inCave;
  }
}

/* ---------- kamp penyamun ---------- */
const campFx=[];
CAMP_DEFS.forEach(cp=>{
  const g=new THREE.Group();g.position.set(cp.x,0,cp.z);scene.add(g);
  const clothA=mat('#6a3a2a',{side:THREE.DoubleSide}),clothB=mat('#4a3f35',{side:THREE.DoubleSide}),wood=mat('#6a4a2a'),dk=mat('#3a2a1c');
  [[-6,-3,clothA],[6,-4,clothB],[0,7,clothA]].forEach((t,i)=>{
    const tent=new THREE.Mesh(new THREE.ConeGeometry(3.2,3.4,6),t[2]);tent.position.set(t[0],1.7,t[1]);tent.rotation.y=i;g.add(tent);
    const door=new THREE.Mesh(new THREE.PlaneGeometry(1.3,2).translate(0,1,0),mat('#150e08',{side:THREE.DoubleSide}));door.position.set(t[0],0.02,t[1]+2.15);door.rotation.y=0;g.add(door);
    circles.push({x:cp.x+t[0],z:cp.z+t[1],r:2.6});
  });
  /* pagar kayu runcing */
  for(let k=0;k<22;k++){const a=k/22*6.283;if(Math.abs(Math.sin(a*1+0.3))<0.18)continue;const r=13;const st=new THREE.Mesh(new THREE.ConeGeometry(0.28,2.4,5),wood);st.position.set(Math.cos(a)*r,1.2,Math.sin(a)*r);st.rotation.set((Math.random()-0.5)*0.18,0,(Math.random()-0.5)*0.18);g.add(st);circles.push({x:cp.x+Math.cos(a)*r,z:cp.z+Math.sin(a)*r,r:0.45});}
  /* api unggun */
  for(let k=0;k<8;k++){const a=k/8*6.283;const sn=new THREE.Mesh(new THREE.DodecahedronGeometry(0.34,0),mat('#8a8680'));sn.position.set(Math.cos(a)*1.1,0.2,Math.sin(a)*1.1);g.add(sn);}
  for(let k=0;k<4;k++){const lg=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,1.5,6),dk);lg.position.set(0,0.2,0);lg.rotation.set(Math.PI/2,k*0.8,0.3);g.add(lg);}
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xff8a2a,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.7,fog:false}));glow.scale.set(6,6,1);glow.position.y=1.2;g.add(glow);
  circles.push({x:cp.x,z:cp.z,r:1.4});
  /* bendera pedang bersilang */
  const cv=document.createElement('canvas');cv.width=64;cv.height=64;const x=cv.getContext('2d');x.fillStyle='#4a1418';x.fillRect(0,0,64,64);x.strokeStyle='#e8e0d0';x.lineWidth=5;x.lineCap='round';x.beginPath();x.moveTo(14,12);x.lineTo(50,48);x.moveTo(50,12);x.lineTo(14,48);x.stroke();x.lineWidth=4;x.beginPath();x.moveTo(8,40);x.lineTo(22,30);x.moveTo(42,30);x.lineTo(56,40);x.stroke();x.fillStyle='#d6ad2b';x.fillRect(8,54,48,4);
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(2.2,2.2),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(cv),side:THREE.DoubleSide,fog:false}));fl.position.set(1.2,8.6,-9);
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.13,10,6),wood);pole.position.set(0,5,-9);g.add(pole);g.add(fl);
  campFx.push({x:cp.x,z:cp.z,glow,fl});
});
function updCamps(dt){
  for(const c of campFx){
    const d=Math.hypot(c.x-pos.x,c.z-pos.z);if(inCave||d>90)continue;
    c.glow.material.opacity=0.55+0.25*Math.sin(tAll*11+c.x)+Math.random()*0.1;c.fl.rotation.y=Math.sin(tAll*2+c.x)*0.3;
    if(Math.random()<dt*14)emit(c.x+(Math.random()-0.5)*0.7,0.5,c.z+(Math.random()-0.5)*0.7,(Math.random()-0.5)*0.4,2+Math.random()*1.5,(Math.random()-0.5)*0.4,0.8,0.6,Math.random()<0.5?'#ff9a2a':'#ffd24a',0,0.9,-0.5);
  }
}

/* ---------- air mancur desa ---------- */
const fountain={water:null,t:0};
(function(){
  const g=new THREE.Group();scene.add(g);
  const stone=mat('#d4cdbd',{side:THREE.DoubleSide}),stoneD=mat('#a79f8e',{side:THREE.DoubleSide});
  const V=a=>a.map(p=>new THREE.Vector2(p[0],p[1]));
  /* kolam batu bundar */
  g.add(new THREE.Mesh(new THREE.LatheGeometry(V([[0.01,0],[3.5,0],[3.5,0.55],[3.2,0.95],[2.75,0.95],[2.75,0.4],[0.01,0.4]]),28),stone));
  const rim=new THREE.Mesh(new THREE.TorusGeometry(2.98,0.13,6,28).rotateX(Math.PI/2),stoneD);rim.position.y=0.96;g.add(rim);
  const step=new THREE.Mesh(new THREE.CylinderGeometry(3.9,4.0,0.22,28),stoneD);step.position.y=0.11;g.add(step);
  /* air */
  const wm=new THREE.MeshPhongMaterial({color:0x3fb2f2,emissive:0x0b3a66,transparent:true,opacity:0.85,shininess:40,specular:0xaaddff,flatShading:true});
  const w=new THREE.Mesh(new THREE.CircleGeometry(2.78,28).rotateX(-Math.PI/2),wm);w.position.y=0.74;g.add(w);fountain.water=wm;
  /* tiang tengah + dua mangkuk bertingkat */
  const col=new THREE.Mesh(new THREE.CylinderGeometry(0.38,0.58,1.2,10),stone);col.position.y=1.0;g.add(col);
  const b1=new THREE.Mesh(new THREE.LatheGeometry(V([[0.01,0],[1.65,0.18],[1.65,0.42],[1.35,0.42],[0.01,0.24]]),22),stone);b1.position.y=1.5;g.add(b1);
  const w1=new THREE.Mesh(new THREE.CircleGeometry(1.34,20).rotateX(-Math.PI/2),wm);w1.position.y=1.86;g.add(w1);
  const col2=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.32,0.85,8),stone);col2.position.y=2.05;g.add(col2);
  const b2=new THREE.Mesh(new THREE.LatheGeometry(V([[0.01,0],[0.95,0.12],[0.95,0.32],[0.72,0.32],[0.01,0.18]]),18),stone);b2.position.y=2.5;g.add(b2);
  const w2=new THREE.Mesh(new THREE.CircleGeometry(0.71,16).rotateX(-Math.PI/2),wm);w2.position.y=2.78;g.add(w2);
  const orb=new THREE.Mesh(new THREE.SphereGeometry(0.26,10,8),mat('#eaf8ff',{emissive:'#7fd0ff',emissiveIntensity:0.7}));orb.position.y=3.05;g.add(orb);
  /* bunga di tepi kolam */
  for(let i=0;i<10;i++){const a=i/10*6.283;const bm=new THREE.Mesh(new THREE.IcosahedronGeometry(0.16,0),mat(FC[i%FC.length]));bm.position.set(Math.cos(a)*4.3,0.32,Math.sin(a)*4.3);g.add(bm);}
  circles.push({x:0,z:0,r:4.0});
})();

/* ---------- goa kelelawar ---------- */
const CAVE_ROT=Math.atan2(-CAVE.x,-CAVE.z),CC=Math.cos(CAVE_ROT),CS=Math.sin(CAVE_ROT);
function cavePt(lx,lz){return {x:CAVE.x+lx*CC+lz*CS,z:CAVE.z-lx*CS+lz*CC};}
const CAVE_TRIG=cavePt(0,-1.2);
const crystals=[],bats=[];let chest=null;
(function buildCave(){
  /* mulut goa di dunia luar */
  {
    const g=new THREE.Group();g.position.set(CAVE.x,0,CAVE.z);g.rotation.y=CAVE_ROT;scene.add(g);
    const rockM=mat('#8a8683'),rockD=mat('#605d5d'),rockDD=mat('#4c4a4b');
    const dod=new THREE.DodecahedronGeometry(1,0);
    const rk=(m,sx_,sy_,sz_,x,y,z,ry)=>{const p=new THREE.Mesh(dod,m);p.scale.set(sx_,sy_,sz_);p.position.set(x,y,z);p.rotation.y=ry||0;g.add(p);return p;};
    rk(rockM,1.7,3.8,1.8,-3.5,3.2,0.2,0.4);rk(rockM,1.7,3.8,1.8,3.5,3.2,0.2,-0.3);rk(rockM,4.9,1.3,1.9,0,6.4,0,0);
    rk(rockD,8,6,7,0,2.8,-6.5,0.2);rk(rockD,5,4.2,5,-6.5,2,-3,0.5);rk(rockD,5,4.2,5,6.5,2,-3,-0.4);rk(rockDD,4,3,4,-9,1.5,-8,0.3);rk(rockDD,4,3,4,9,1.5,-8,0.1);
    const portal=new THREE.Mesh(new THREE.PlaneGeometry(5.4,5.6),new THREE.MeshBasicMaterial({color:0x040508}));portal.position.set(0,2.8,-0.7);g.add(portal);
    [-3.5,3.5].forEach(x=>{const cr=new THREE.Mesh(new THREE.OctahedronGeometry(0.5,0),mat('#7de0ff',{emissive:'#7de0ff',emissiveIntensity:0.9}));cr.scale.y=2;cr.position.set(x,7.2,0.9);g.add(cr);
      const gl=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0x7de0ff,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.7,fog:false}));gl.scale.set(5,5,1);gl.position.set(x,7.2,1);g.add(gl);});
    const mg=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0x5ab8e8,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.35,fog:false}));mg.scale.set(9,9,1);mg.position.set(0,2.6,1.4);g.add(mg);
    [[-3.5,0,1.5],[3.5,0,1.5],[0,-5.5,3.6],[-6.5,-3,3],[6.5,-3,3],[-9,-8,3],[9,-8,3]].forEach(c=>{const p=cavePt(c[0],c[1]);circles.push({x:p.x,z:p.z,r:c[2]});});
  }
  /* ruang dalam goa (jauh dari dunia luar, x ~ 3000) */
  const root=new THREE.Group();root.position.set(CX,0,CZ);scene.add(root);
  const floor=new THREE.Mesh(new THREE.CircleGeometry(CAVE_R,48).rotateX(-Math.PI/2),mat('#4d4960'));root.add(floor);
  const wall=new THREE.Mesh(new THREE.CylinderGeometry(CAVE_R,CAVE_R,14,40,1,true),mat('#2f2c3d',{side:THREE.BackSide}));wall.position.y=7;root.add(wall);
  const ceil=new THREE.Mesh(new THREE.CircleGeometry(CAVE_R,40).rotateX(Math.PI/2),mat('#1a1826'));ceil.position.y=14;root.add(ceil);
  const dais=new THREE.Mesh(new THREE.CylinderGeometry(2.6,2.9,0.3,24),mat('#6a6580'));dais.position.y=0.15;root.add(dais);
  const daisTop=new THREE.Mesh(new THREE.CircleGeometry(2.6,24).rotateX(-Math.PI/2),mat('#8a85a0'));daisTop.position.y=0.31;root.add(daisTop);
  const spawn={x:CX,z:CZ+19},exitP={x:CX,z:CZ+CAVE_R-1.8};
  for(let i=0;i<18;i++){
    const a=rand()*6.283,r=7+rand()*21,x=CX+Math.cos(a)*r,z=CZ+Math.sin(a)*r;
    if(Math.hypot(x-spawn.x,z-spawn.z)<5||Math.hypot(x-exitP.x,z-exitP.z)<5)continue;
    const rad=0.7+rand()*0.8,h=2+rand()*3.2;
    const st=new THREE.Mesh(new THREE.ConeGeometry(rad,h,6),mat('#5d5870'));st.position.set(x,h/2,z);scene.add(st);
    circles.push({x,z,r:rad*0.85});
  }
  for(let i=0;i<28;i++){
    const a=rand()*6.283,r=Math.sqrt(rand())*(CAVE_R-1),h=2+rand()*4,rad=0.5+rand()*0.9;
    const st=new THREE.Mesh(new THREE.ConeGeometry(rad,h,6),mat('#3a3650'));st.rotation.x=Math.PI;st.position.set(CX+Math.cos(a)*r,14-h/2,CZ+Math.sin(a)*r);scene.add(st);
  }
  const PAL=['#58c8ff','#b57bff','#4dffb0','#ff7ad1'];
  for(let k=0;k<9;k++){
    const a=k*0.7+0.1;if(Math.abs(Math.atan2(Math.sin(a),Math.cos(a))-Math.PI/2)<0.45)continue;
    const col=PAL[k%PAL.length],cm=mat(col,{emissive:col,emissiveIntensity:0.9});
    const r=CAVE_R-3,cx=CX+Math.cos(a)*r,cz=CZ+Math.sin(a)*r;
    for(let j=0;j<3;j++){const c=new THREE.Mesh(new THREE.OctahedronGeometry(0.7,0),cm);c.scale.set(1,2.2+rand()*1.6,1);c.position.set(cx+(rand()-0.5)*1.6,1.4+rand()*0.8,cz+(rand()-0.5)*1.6);c.rotation.set((rand()-0.5)*0.5,rand()*3,(rand()-0.5)*0.5);scene.add(c);}
    const gl=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:new THREE.Color(col),blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.6,fog:false}));gl.scale.set(11,11,1);gl.position.set(cx,2,cz);scene.add(gl);
    crystals.push({mat:cm,glow:gl,ph:rand()*6});
  }
  const ex=new THREE.Mesh(new THREE.PlaneGeometry(5,6.5),new THREE.MeshBasicMaterial({color:0xcfeaff,transparent:true,opacity:0.9,side:THREE.DoubleSide}));ex.position.set(CX,3.3,CZ+CAVE_R-0.4);ex.rotation.y=Math.PI;scene.add(ex);
  const exg=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xcfeaff,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.8,fog:false}));exg.scale.set(14,14,1);exg.position.set(CX,3.3,CZ+CAVE_R-2);scene.add(exg);
  /* peti berisi senjata sniper */
  {
    const g=new THREE.Group();g.position.set(CX,0.3,CZ);scene.add(g);
    const wood=mat('#8a5a3a'),lidM=mat('#a06a40'),gold=mat('#e8c04a',{emissive:'#6a4a00',emissiveIntensity:0.5});
    box(g,1.5,0.75,1.0,wood,0,0.375,0);box(g,0.15,0.8,1.06,gold,-0.5,0.4,0);box(g,0.15,0.8,1.06,gold,0.5,0.4,0);
    const pivot=new THREE.Group();pivot.position.set(0,0.75,-0.5);g.add(pivot);
    box(pivot,1.5,0.3,1.0,lidM,0,0.15,0.5);box(pivot,0.15,0.34,1.06,gold,-0.5,0.15,0.5);box(pivot,0.15,0.34,1.06,gold,0.5,0.15,0.5);box(pivot,0.22,0.26,0.1,gold,0,0.0,1.02);
    const gl=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xffd86a,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.6,fog:false}));gl.scale.set(5,5,1);gl.position.set(0,1.0,0.3);g.add(gl);
    chest={x:CX,z:CZ,pivot,ang:0,vel:0,target:0,open:false,glow:gl};circles.push({x:CX,z:CZ,r:0.95});
  }
  /* kelelawar (hanya kelelawar, tanpa slime) */
  {
    const cv=document.createElement('canvas');cv.width=32;cv.height=10;const bx=cv.getContext('2d');
    const BR=(ox,x,y,w,h,c)=>{bx.fillStyle=c;bx.fillRect(ox+x,y,w,h);};
    [0,16].forEach((ox,f)=>{const b='#3a2d4a',w='#5a4673';BR(ox,6,3,4,5,b);BR(ox,6,1,1,2,b);BR(ox,9,1,1,2,b);
      if(f===0){BR(ox,1,1,5,3,w);BR(ox,2,4,3,1,w);BR(ox,10,1,5,3,w);BR(ox,11,4,3,1,w);}else{BR(ox,1,5,5,3,w);BR(ox,2,4,3,1,w);BR(ox,10,5,5,3,w);BR(ox,11,4,3,1,w);}});
    outlineCv(cv,16,10);
    const base=new THREE.CanvasTexture(cv);base.magFilter=base.minFilter=THREE.NearestFilter;base.generateMipmaps=false;
    const geo=new THREE.PlaneGeometry(16*0.12,10*0.12);
    for(let i=0;i<9;i++){const tex=base.clone();tex.needsUpdate=true;tex.repeat.set(0.5,1);
      const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide}));mesh.rotation.order='YXZ';scene.add(mesh);
      bats.push({mesh,tex,a:rand()*6.28,R:5+rand()*20,h:5+rand()*5,sp:(0.35+rand()*0.4)*(rand()<0.5?-1:1),ph:rand()*6});}
  }
})();
function updBats(dt,rgt){
  for(const b of bats){
    b.a+=b.sp*dt/Math.max(1,b.R*0.12);
    const x=CX+Math.cos(b.a)*b.R,z=CZ+Math.sin(b.a)*b.R,y=b.h+Math.sin(tAll*2+b.ph)*0.8;
    const sg=b.sp<0?-1:1,tx=-Math.sin(b.a)*sg,tz=Math.cos(b.a)*sg;
    b.mesh.position.set(x,y,z);b.mesh.rotation.y=cam.yaw;b.mesh.rotation.x=-cam.pitch*0.55;
    b.mesh.scale.x=(tx*rgt.x+tz*rgt.z)<0?-1:1;
    b.tex.offset.set(Math.floor(tAll*8+b.ph)%2*0.5,0);
  }
}

/* ---------- clouds / motes / sky ---------- */
const clouds=[];
{const cm=new THREE.MeshBasicMaterial({color:0xffffff,fog:false});
for(let i=0;i<14;i++){const g=new THREE.Group();const n=4+Math.floor(rand()*3);for(let j=0;j<n;j++){const s=new THREE.Mesh(new THREE.SphereGeometry(4+rand()*4,8,6),cm);s.position.set(j*5-n*2.5,rand()*2,rand()*3);s.scale.y=0.6;g.add(s);}
g.position.set((rand()-0.5)*340,55+rand()*25,(rand()-0.5)*340);scene.add(g);clouds.push(g);}}
const MOTES=70;const motePos=new Float32Array(MOTES*3);const moteBase=[];
for(let i=0;i<MOTES;i++){moteBase.push({x:(rand()-0.5)*40,y:rand()*9,z:(rand()-0.5)*40,sp:0.2+rand()*0.4,ph:rand()*6});}
const moteGeo=new THREE.BufferGeometry();moteGeo.setAttribute('position',new THREE.BufferAttribute(motePos,3));
const motes=new THREE.Points(moteGeo,new THREE.PointsMaterial({map:dotTex,color:0xfff3b0,size:0.22,transparent:true,opacity:0.7,depthWrite:false,blending:THREE.AdditiveBlending}));
motes.frustumCulled=false;scene.add(motes);

/* ---------- character sprites (procedural pixel art) ---------- */
const CW=18,CH=26,NF=8,PX=0.075,NROW=6;
const PAL_PLAYER={skin:'#f4cfa4',hair:'#6a3d2a',hairL:'#8f5a3a',scarf:'#e5473b',scarfD:'#b8342c',tunic:'#3f9a73',tunicD:'#2f7a59',belt:'#7a4a2a',pants:'#3d4b8f',boot:'#5a3a26',eye:'#231b2b',blade:'#e3eaf2',hilt:'#c9a227',blanket:'#d9604f'};
const CHARS=[
 {name:'Ravi',pal:{}},
 {name:'Luna',pal:{skin:'#f1cfae',hair:'#2b2a6e',hairL:'#4a49a0',scarf:'#4fb6e8',scarfD:'#2f8cb8',tunic:'#7a4fc0',tunicD:'#5d3a98',pants:'#2b2f5a',blade:'#c9a8ff'}},
 {name:'Blaze',pal:{skin:'#e8b88a',hair:'#c4622d',hairL:'#e08a50',scarf:'#f0c248',scarfD:'#c79a2a',tunic:'#d9442f',tunicD:'#a83222',pants:'#3a2a2a',blade:'#ffb36b'}},
 {name:'Mint',pal:{skin:'#f2c59a',hair:'#e8e0f0',hairL:'#ffffff',scarf:'#ffffff',scarfD:'#cfd6dd',tunic:'#2fb5a0',tunicD:'#228a7a',pants:'#3a5a6a',blade:'#9ff5e0'}},
 {name:'Shadow',pal:{skin:'#c98f66',hair:'#1f1a16',hairL:'#3a322a',scarf:'#b3262a',scarfD:'#7d1a1d',tunic:'#2f3140',tunicD:'#22242f',belt:'#c9a227',pants:'#1f2128',boot:'#101014',blade:'#ff6a6a'}},
 {name:'Sakura',pal:{skin:'#f6d3b8',hair:'#ff9ec4',hairL:'#ffc4dc',scarf:'#ffffff',scarfD:'#e0c0cc',tunic:'#ef7fa0',tunicD:'#c75a7c',pants:'#4d6bb8',blade:'#ffd0e4'}},
 {name:'Aurum',pal:{skin:'#d9a37a',hair:'#f0d060',hairL:'#fff0a0',scarf:'#8d3bd8',scarfD:'#6a22a8',tunic:'#e0a020',tunicD:'#b07a10',pants:'#5a3a26',blade:'#fff0a0'}},
 {name:'Frost',pal:{skin:'#f1d9c5',hair:'#d9e8ff',hairL:'#ffffff',scarf:'#4fb6e8',scarfD:'#2f8cb8',tunic:'#4a7fc0',tunicD:'#3a639a',pants:'#44506a',blade:'#bfe6ff'}}
];
let C=PAL_PLAYER,sx=null,OX=0,OY=0;
function R(x,y,w,h,c){sx.fillStyle=c;sx.fillRect(OX+x,OY+y,w,h);}
function leg(x,w,lift,by,bw){const top=19+by,bot=24-lift;R(x,top,w,bot-top,C.pants);R(x,bot-2,bw,2,C.boot);}
function drawSide(p){
  const by=p.by;
  R(4,12+by,3,3,C.scarfD);
  leg(7+p.bdx,3,p.bl,by,4);leg(9+p.fdx,3,p.fl,by,4);
  R(6,13+by,7,6,C.tunic);R(6,17+by,7,1,C.belt);
  if(p.up){R(6,9+by,2,5,C.tunicD);R(6,8+by,2,2,C.skin);}else{R(7-p.ad,14+by,2,4,C.tunicD);R(7-p.ad,18+by,2,1,C.skin);}
  R(5,4+by,3,6,C.hair);R(7,6+by,5,5,C.skin);R(6,3+by,7,3,C.hair);R(11,5+by,2,1,C.hair);R(12,8+by,1,1,C.skin);
  R(6,11+by,7,2,C.scarf);
  if(p.up){R(10,9+by,2,5,C.tunic);R(10,8+by,2,2,C.skin);}else{R(8+p.ad,14+by,3,4,C.tunic);R(8+p.ad,18+by,3,1,C.skin);}
}
function drawFrontBack(p,back){
  const by=p.by;
  leg(6,3,p.l,by,3);leg(9,3,p.r,by,3);
  R(5,13+by,8,6,C.tunic);R(5,17+by,8,1,C.belt);
  const arm=(x,a)=>{if(p.up){R(x,9+by,2,5,C.tunic);R(x,8+by,2,2,C.skin);}else{R(x,14+by+a,2,4,C.tunic);R(x,18+by+a,2,1,C.skin);}};
  arm(3,p.aL);arm(13,p.aR);
  if(back){R(4,3+by,10,8,C.hair);R(6,5+by,3,1,C.hairL);R(9,7+by,3,1,C.hairL);}
  else{R(4,3+by,10,3,C.hair);R(4,6+by,1,4,C.hair);R(13,6+by,1,4,C.hair);R(5,6+by,8,1,C.hair);R(5,7+by,8,4,C.skin);}
  R(5,11+by,8,2,C.scarf);
  if(back)R(8,13+by,2,4,C.scarfD);else R(9,13+by,2,3,C.scarfD);
}
function drawThreeQ(p,back){
  const by=p.by;
  leg(6,3,p.l,by,3);leg(8,3,p.r,by,4);
  R(6,13+by,7,6,C.tunic);R(7,17+by,6,1,C.belt);
  if(p.up){R(5,9+by,2,5,C.tunicD);R(5,8+by,2,2,C.skin);}else{R(5,14+by+p.aL,2,4,C.tunicD);R(5,18+by+p.aL,2,1,C.skin);}
  if(back){R(5,3+by,7,8,C.hair);R(7,5+by,3,1,C.hairL);R(12,6+by,1,4,C.skin);}
  else{R(5,3+by,8,3,C.hair);R(5,6+by,2,4,C.hair);R(7,6+by,6,5,C.skin);R(7,6+by,6,1,C.hair);}
  R(6,11+by,7,2,C.scarf);R(5,12+by,2,4,C.scarfD);
  if(p.up){R(12,9+by,2,5,C.tunic);R(12,8+by,2,2,C.skin);}else{R(12,14+by+p.aR,2,4,C.tunic);R(12,18+by+p.aR,2,1,C.skin);}
}
const sidePoses=[
 {by:0,fdx:0,fl:0,bdx:0,bl:0,ad:0},{by:1,fdx:0,fl:0,bdx:0,bl:0,ad:0},
 {by:1,fdx:2,fl:0,bdx:-2,bl:1,ad:-2},{by:0,fdx:0,fl:0,bdx:0,bl:2,ad:0},{by:1,fdx:-2,fl:1,bdx:2,bl:0,ad:2},{by:0,fdx:0,fl:2,bdx:0,bl:0,ad:0},
 {by:0,fdx:2,fl:2,bdx:-1,bl:1,up:true,ad:0},{by:0,fdx:1,fl:0,bdx:-1,bl:0,ad:1}];
const fbPoses=[
 {by:0,l:0,r:0,aL:0,aR:0},{by:1,l:0,r:0,aL:0,aR:0},
 {by:1,l:1,r:0,aL:1,aR:-1},{by:0,l:0,r:0,aL:0,aR:0},{by:1,l:0,r:1,aL:-1,aR:1},{by:0,l:0,r:0,aL:0,aR:0},
 {by:0,l:2,r:1,aL:0,aR:0,up:true},{by:0,l:0,r:0,aL:-1,aR:-1}];
function drawKO(){R(5,18,10,6,C.tunic);R(15,19,3,5,C.pants);R(16,22,2,2,C.boot);R(0,18,5,5,C.skin);R(0,17,5,2,C.hair);R(5,18,1,3,C.scarf);}
function drawSleep(){R(5,17,11,7,C.blanket);R(5,20,11,1,'#f0a090');R(16,19,2,4,C.boot);R(0,18,5,5,C.skin);R(0,17,5,2,C.hair);R(0,18,1,3,C.hair);R(5,18,1,3,C.scarf);}
function drawAtk(st){
  if(st===1){leg(7,3,0,0,4);leg(9,3,0,0,4);}else{leg(6,3,0,0,4);leg(10,3,0,0,4);}
  R(6,13,7,6,C.tunic);R(6,17,7,1,C.belt);
  R(5,4,3,6,C.hair);R(7,6,5,5,C.skin);R(6,3,7,3,C.hair);R(11,5,2,1,C.hair);R(12,8,1,1,C.skin);
  R(6,11,7,2,C.scarf);R(4,12,3,3,C.scarfD);
  if(st===1){R(5,10,3,4,C.tunic);R(4,9,3,2,C.skin);R(3,1,2,9,C.blade);R(2,10,4,1,C.hilt);}
  else{R(9,14,5,3,C.tunic);R(14,14,2,3,C.skin);R(15,6,2,9,C.blade);R(14,15,4,1,C.hilt);}
}
function buildCharSheet(pal){
  C=pal;const cv=document.createElement('canvas');cv.width=CW*NF;cv.height=CH*NROW;sx=cv.getContext('2d');
  for(let f=0;f<NF;f++){
    OX=f*CW;OY=0;drawSide(sidePoses[f]);
    OX=f*CW;OY=CH;drawFrontBack(fbPoses[f],false);
    OX=f*CW;OY=CH*2;drawFrontBack(fbPoses[f],true);
    OX=f*CW;OY=CH*3;drawThreeQ(fbPoses[f],false);
    OX=f*CW;OY=CH*4;drawThreeQ(fbPoses[f],true);
  }
  OY=CH*5;
  OX=CW*3;drawKO();OX=CW*6;drawSleep();OX=CW*4;drawAtk(1);OX=CW*5;drawAtk(2);
  const W=cv.width,H=cv.height,im=sx.getImageData(0,0,W,H),d=im.data,out=new Uint8ClampedArray(d);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4;if(d[i+3]>0)continue;
    const cx=x%CW,cy=y%CH;let near=false;
    if(cx>0&&d[i-4+3]>0)near=true;if(cx<CW-1&&d[i+4+3]>0)near=true;if(cy>0&&d[i-W*4+3]>0)near=true;if(cy<CH-1&&d[i+W*4+3]>0)near=true;
    if(near){out[i]=43;out[i+1]=34;out[i+2]=51;out[i+3]=255;}
  }
  im.data.set(out);sx.putImageData(im,0,0);return cv;
}
const sheetCache={};
function sheetFor(ci){
  ci=clamp(ci|0,0,CHARS.length-1);
  if(!sheetCache[ci]){const cv=buildCharSheet(Object.assign({},PAL_PLAYER,CHARS[ci].pal));const tex=new THREE.CanvasTexture(cv);tex.magFilter=THREE.NearestFilter;tex.minFilter=THREE.NearestFilter;tex.generateMipmaps=false;tex.repeat.set(1/NF,1/NROW);sheetCache[ci]={cv,tex};}
  return sheetCache[ci];
}
function cloneTex(ci){const t=sheetFor(ci).tex.clone();t.needsUpdate=true;t.repeat.set(1/NF,1/NROW);return t;}
const ROWMAP=[1,3,0,4,2,4,0,3];
function pickView(fx,fz,rgt,fwd,k){
  const fr=fx*rgt.x+fz*rgt.z,ff=fx*fwd.x+fz*fwd.z,phi=Math.atan2(fr,-ff);
  let dk=phi-k*Math.PI/4;dk=Math.atan2(Math.sin(dk),Math.cos(dk));
  if(Math.abs(dk)>Math.PI/8+0.12)k=((Math.round(phi/(Math.PI/4))%8)+8)%8;
  return k;
}
function setTexFrame(tex,col,row){tex.offset.set(col/NF,1-(row+1)/NROW);}
const spriteGeo=new THREE.PlaneGeometry(CW*PX,CH*PX).translate(0,CH*PX/2-2*PX,0);
const aShGeo=new THREE.CircleGeometry(0.6,14).rotateX(-Math.PI/2);
const aShMat=new THREE.MeshBasicMaterial({map:blobTex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-6,polygonOffsetUnits:-6});

/* local player sprite */
let myTex=cloneTex(0);
const spriteMesh=new THREE.Mesh(spriteGeo,new THREE.MeshBasicMaterial({map:myTex,alphaTest:0.5,side:THREE.DoubleSide}));
spriteMesh.rotation.order='YXZ';
const ghost=new THREE.Mesh(spriteGeo,new THREE.MeshBasicMaterial({map:myTex,transparent:true,opacity:0.5,alphaTest:0.5,color:0x8fd3ff,depthFunc:THREE.GreaterDepth,depthWrite:false,side:THREE.DoubleSide,fog:false}));
ghost.renderOrder=5;spriteMesh.add(ghost);
const playerRoot=new THREE.Group();playerRoot.add(spriteMesh);playerRoot.visible=false;scene.add(playerRoot);
const pShadow=new THREE.Mesh(new THREE.CircleGeometry(0.6,16).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:blobTex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-6,polygonOffsetUnits:-6}));
pShadow.visible=false;scene.add(pShadow);
function setMyChar(ci){myTex=cloneTex(ci);spriteMesh.material.map=myTex;ghost.material.map=myTex;spriteMesh.material.needsUpdate=true;ghost.material.needsUpdate=true;}

/* ---------- particles ---------- */
const P=[];for(let i=0;i<320;i++){const m=new THREE.SpriteMaterial({map:dotTex,transparent:true,depthWrite:false,fog:false});const s=new THREE.Sprite(m);s.visible=false;scene.add(s);P.push({s,m,life:0,max:1,vx:0,vy:0,vz:0,g:0,sz:1,grow:0,op:1});}
let pIdx=0;
function emit(x,y,z,vx,vy,vz,life,sz,color,g,op,grow,tex){const p=P[pIdx++%P.length];p.m.map=tex||dotTex;p.s.position.set(x,y,z);p.vx=vx;p.vy=vy;p.vz=vz;p.life=p.max=life;p.sz=sz;p.g=g||0;p.op=op==null?0.8:op;p.grow=grow||0;p.m.color.set(color);p.s.visible=true;}
function updParts(dt){for(const p of P){if(p.life<=0)continue;p.life-=dt;if(p.life<=0){p.s.visible=false;continue;}p.vy-=p.g*dt;p.s.position.x+=p.vx*dt;p.s.position.y+=p.vy*dt;p.s.position.z+=p.vz*dt;const k=p.life/p.max;p.m.opacity=p.op*k;const sc=p.sz*(1+p.grow*(1-k));p.s.scale.set(sc,sc,1);}}
function burst(x,y,z,col,n,spd){for(let i=0;i<n;i++){const a=Math.random()*6.28;emit(x,y,z,Math.cos(a)*spd*(0.4+Math.random()),(Math.random()-0.2)*spd,Math.sin(a)*spd*(0.4+Math.random()),0.5+Math.random()*0.3,0.35+Math.random()*0.3,col,5,0.95,0.3);}}

/* rings (nova) */
const ringGeo=new THREE.RingGeometry(0.88,1,48).rotateX(-Math.PI/2);
const rings=[];
function ringFx(x,y,z,r,col){
  const m=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.9,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const mesh=new THREE.Mesh(ringGeo,m);mesh.position.set(x,y,z);mesh.scale.setScalar(0.3);scene.add(mesh);rings.push({mesh,m,t:0,r});
}
function updRings(dt){
  for(let i=rings.length-1;i>=0;i--){const q=rings[i];q.t+=dt;const k=q.t/0.5;
    if(k>=1){scene.remove(q.mesh);q.m.dispose();rings.splice(i,1);continue;}
    q.mesh.scale.setScalar(0.3+q.r*(1-Math.pow(1-k,3)));q.m.opacity=0.9*(1-k);}
}
/* floating text */
const floats=[];
function floatText(x,y,z,txt,col){
  const cv=document.createElement('canvas');cv.width=128;cv.height=48;const c=cv.getContext('2d');
  c.font='bold 34px sans-serif';c.textAlign='center';c.textBaseline='middle';c.lineWidth=6;c.strokeStyle='rgba(10,10,30,.9)';c.strokeText(txt,64,24);c.fillStyle=col;c.fillText(txt,64,24);
  const tex=new THREE.CanvasTexture(cv);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));
  sp.scale.set(2,0.75,1);sp.renderOrder=22;sp.position.set(x,y,z);scene.add(sp);floats.push({sp,tex,t:0});
}
function updFloats(dt){
  for(let i=floats.length-1;i>=0;i--){const f=floats[i];f.t+=dt;f.sp.position.y+=dt*1.7;f.sp.material.opacity=clamp(1.2-f.t,0,1);
    if(f.t>1.2){scene.remove(f.sp);f.sp.material.dispose();f.tex.dispose();floats.splice(i,1);}}
}

/* ---------- audio ---------- */
let AC=null,master=null,noiseBuf=null,muted=false;
function initAudio(){
  if(AC){if(AC.state==='suspended')AC.resume();return;}
  try{
    AC=new (window.AudioContext||window.webkitAudioContext)();master=AC.createGain();master.gain.value=muted?0:0.55;master.connect(AC.destination);
    noiseBuf=AC.createBuffer(1,AC.sampleRate*2,AC.sampleRate);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
  }catch(e){AC=null;}
}
let SV=1;
const rnd=(a,b)=>a+Math.random()*(b-a),pick=a=>a[Math.floor(Math.random()*a.length)];
function tone(f0,f1,dur,type,vol,delay){if(!AC||SV<0.03)return;const j=1+(Math.random()-0.5)*0.08,t=AC.currentTime+(delay||0),o=AC.createOscillator(),g=AC.createGain();o.type=type||'sine';o.frequency.setValueAtTime(f0*j,t);if(f1!==f0)o.frequency.exponentialRampToValueAtTime(Math.max(20,f1*j),t+dur);g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(Math.max(0.0002,vol*SV),t+Math.min(0.012,dur/3));g.gain.exponentialRampToValueAtTime(0.0001,t+dur);o.connect(g);g.connect(master);o.start(t);o.stop(t+dur+0.03);}
function noiseHit(dur,vol,freq,delay,type,q){if(!AC||SV<0.03)return;const t=AC.currentTime+(delay||0),s=AC.createBufferSource();s.buffer=noiseBuf;const f=AC.createBiquadFilter();f.type=type||'lowpass';f.frequency.value=freq*(1+(Math.random()-0.5)*0.15);if(q)f.Q.value=q;const g=AC.createGain();g.gain.setValueAtTime(Math.max(0.0002,vol*SV),t);g.gain.exponentialRampToValueAtTime(0.0001,t+dur);s.connect(f);f.connect(g);g.connect(master);s.start(t,Math.random(),dur+0.05);}
const SFX_RANGE=55,VOICE_RANGE=40;
function distVol(d,R){return d>=R?0:Math.pow(1-d/R,1.6);}
function sfxAt(name,x,z){if(!AC||!sfx[name])return;const d=Math.hypot(x-pos.x,z-pos.z);const v=distVol(d,SFX_RANGE);if(v<0.02)return;SV=v;const a=Array.prototype.slice.call(arguments,3);try{sfx[name].apply(null,a);}catch(e){}SV=1;}
const sfx={
  /* langkah */
  step(k){
    if(k==='wood'){noiseHit(0.06,0.11,520,0);tone(rnd(95,135),60,0.07,'triangle',0.1);}
    else if(k==='stone'){noiseHit(0.04,0.1,2600,0,'highpass');tone(rnd(180,260),120,0.05,'square',0.04);}
    else if(k==='water'){noiseHit(0.14,0.13,rnd(900,1500),0,'bandpass',1.2);tone(rnd(500,700),rnd(250,350),0.08,'sine',0.05);}
    else if(k==='sand'){noiseHit(0.09,0.08,rnd(1500,2200),0,'highpass');}
    else{noiseHit(0.07,0.09,rnd(650,1050),0);if(Math.random()<0.4)tone(rnd(900,1300),600,0.03,'sine',0.015);}
  },
  stroke(){noiseHit(0.22,0.09,rnd(700,1100),0,'bandpass',0.9);tone(rnd(300,420),rnd(150,200),0.12,'sine',0.03);},
  jump(){pick([()=>tone(260,560,0.14,'sine',0.14),()=>{tone(330,700,0.12,'triangle',0.1);noiseHit(0.05,0.05,2000,0,'highpass');},()=>{tone(220,480,0.16,'square',0.04);tone(440,880,0.1,'sine',0.07);}])();},
  land(h){const f=clamp((h||6)/14,0.5,1.4);noiseHit(0.12,0.2*f,350,0);tone(110,50,0.14,'sine',0.18*f);if(f>0.9)noiseHit(0.2,0.1,200,0.02);},
  splash(){noiseHit(0.35,0.3,1400,0);tone(500,150,0.25,'sine',0.1);noiseHit(0.5,0.1,700,0.05,'bandpass',0.7);},
  /* pintu, ui */
  doorOpen(){tone(150,95,0.55,'sawtooth',0.05);tone(155,100,0.55,'square',0.025);noiseHit(0.08,0.12,1800,0,'highpass');},
  doorClose(){tone(110,70,0.35,'sawtooth',0.04);noiseHit(0.18,0.3,260,0.3);tone(70,50,0.15,'sine',0.12,0.3);},
  plop(){tone(200,120,0.12,'sine',0.14);},
  click(){tone(rnd(900,1100),700,0.04,'square',0.04);},
  pop(){tone(rnd(600,760),rnd(900,1100),0.09,'sine',0.09);tone(1400,1700,0.05,'triangle',0.04,0.05);},
  aim(){tone(300,620,0.12,'triangle',0.08);tone(900,1300,0.06,'sine',0.04,0.08);},
  lock(){tone(1400,1400,0.05,'square',0.05);tone(1800,1800,0.06,'square',0.05,0.07);},
  mic(on){tone(on?500:700,on?900:400,0.08,'sine',0.08);},
  learn(){[659,880,1175].forEach((f,i)=>tone(f,f,0.18,'triangle',0.12,i*0.08));},
  bad(){tone(180,120,0.2,'square',0.08);tone(150,90,0.2,'square',0.06,0.12);},
  /* pertarungan */
  swing(){pick([()=>{noiseHit(0.12,0.18,2400,0,'highpass');tone(500,200,0.1,'sawtooth',0.04);},()=>{noiseHit(0.1,0.16,3000,0,'highpass');tone(650,260,0.09,'triangle',0.05);},()=>{noiseHit(0.14,0.15,1800,0,'bandpass',0.8);tone(420,160,0.12,'sawtooth',0.035);}])();},
  hit(){pick([()=>{noiseHit(0.1,0.3,900,0);tone(180,70,0.14,'square',0.12);},()=>{noiseHit(0.12,0.28,700,0);tone(140,55,0.16,'sine',0.2);},()=>{noiseHit(0.08,0.3,1200,0);tone(240,90,0.1,'square',0.1);tone(90,50,0.14,'sine',0.14);}])();},
  clang(){tone(rnd(850,1250),rnd(500,700),0.22,'square',0.06);tone(rnd(1700,2300),rnd(1200,1500),0.18,'triangle',0.05);noiseHit(0.06,0.18,4200,0,'highpass');},
  hurt(){pick([()=>{tone(300,120,0.25,'sawtooth',0.12);noiseHit(0.15,0.2,500,0);},()=>{tone(380,150,0.22,'square',0.08);tone(260,100,0.28,'sawtooth',0.07);},()=>{tone(220,90,0.3,'sawtooth',0.1);noiseHit(0.2,0.18,400,0);tone(520,260,0.12,'triangle',0.05);}])();},
  block(){noiseHit(0.08,0.25,2000,0,'highpass');tone(700,500,0.1,'square',0.08);tone(rnd(1100,1500),900,0.16,'triangle',0.05);},
  gbreak(){tone(400,80,0.35,'sawtooth',0.12);noiseHit(0.3,0.3,700,0);tone(1500,300,0.25,'triangle',0.06);},
  shield(){tone(300,700,0.3,'sine',0.1);tone(450,900,0.3,'triangle',0.06);tone(150,150,0.2,'square',0.02);},
  twang(){tone(rnd(320,430),rnd(140,190),0.16,'triangle',0.09);noiseHit(0.1,0.08,3500,0.02,'highpass');},
  arrowHit(){noiseHit(0.05,0.2,1500,0);tone(rnd(500,700),300,0.07,'square',0.05);},
  /* teknik */
  zap(){pick([()=>{tone(900,300,0.18,'square',0.06);tone(1400,500,0.14,'sawtooth',0.03);},()=>{tone(1200,400,0.2,'sawtooth',0.05);noiseHit(0.1,0.06,5000,0,'highpass');},()=>{tone(700,1500,0.12,'triangle',0.07);tone(1500,300,0.16,'square',0.04,0.1);}])();},
  beam(){tone(200,2200,0.35,'sawtooth',0.07);tone(2200,600,0.3,'square',0.04,0.1);noiseHit(0.4,0.1,5000,0,'highpass');},
  boom(){noiseHit(0.5,0.35,500,0);tone(120,40,0.4,'sine',0.25);noiseHit(0.8,0.12,200,0.1);},
  slam(){tone(260,60,0.3,'sawtooth',0.1);noiseHit(0.25,0.3,300,0.5);tone(80,35,0.5,'sine',0.3,0.5);noiseHit(0.7,0.14,150,0.55);},
  trapset(){tone(900,900,0.03,'square',0.05);tone(700,700,0.04,'square',0.05,0.09);noiseHit(0.1,0.06,2500,0.15,'highpass');},
  heal(){[523,659,784,1047].forEach((f,i)=>tone(f,f,0.22,'triangle',0.1,i*0.07));tone(2093,2093,0.35,'sine',0.03,0.28);},
  regen(){[392,494,587].forEach((f,i)=>tone(f,f*1.01,0.5,'sine',0.06,i*0.15));},
  dash(){noiseHit(0.3,0.25,1500,0,'highpass');tone(200,900,0.2,'sawtooth',0.05);},
  haste(){tone(300,1200,0.3,'sawtooth',0.05);tone(450,1800,0.3,'triangle',0.04,0.06);noiseHit(0.25,0.12,2500,0,'highpass');},
  orb(){tone(120,260,0.9,'sine',0.14);tone(180,90,0.9,'sawtooth',0.05);noiseHit(0.5,0.18,600,0);tone(60,60,1,'sine',0.12);},
  orbHum(){tone(rnd(95,110),rnd(95,110),0.7,'sine',0.07);tone(rnd(190,220),rnd(190,220),0.6,'triangle',0.03);},
  eagle(){tone(1200,700,0.3,'sawtooth',0.04);tone(900,1400,0.25,'triangle',0.04,0.1);tone(rnd(1500,1900),rnd(900,1100),0.35,'sawtooth',0.035,0.22);},
  snipe(){noiseHit(0.3,0.5,3200,0,'highpass');tone(1600,160,0.3,'sawtooth',0.12);tone(90,40,0.25,'sine',0.2);noiseHit(0.8,0.08,300,0.1);},
  /* dunia */
  horn(){tone(147,147,0.7,'sawtooth',0.07);tone(220,220,0.7,'sawtooth',0.05);tone(147,175,0.5,'sawtooth',0.06,0.7);tone(220,262,0.5,'sawtooth',0.04,0.7);},
  fanfare(){[392,523,659,784,1047].forEach((f,i)=>{tone(f,f,0.3,'triangle',0.13,i*0.1);tone(f/2,f/2,0.3,'sawtooth',0.04,i*0.1);});},
  capTick(){tone(500,500,0.05,'square',0.03);},
  chestOpen(){tone(90,150,0.5,'sawtooth',0.06);noiseHit(0.5,0.08,500,0,'bandpass',2);[784,988,1175,1568].forEach((f,i)=>tone(f,f,0.3,'triangle',0.09,0.45+i*0.07));},
  sleep(){tone(120,90,0.7,'sine',0.06);tone(100,70,0.8,'sine',0.05,0.9);},
  wake(){tone(300,500,0.2,'sine',0.08);},
  loot(){[880,1175,1568].forEach((f,i)=>tone(f,f,0.14,'triangle',0.1,i*0.05));},
  soldierDie(){tone(300,70,0.35,'sawtooth',0.09);noiseHit(0.2,0.18,600,0);tone(110,50,0.3,'sine',0.12,0.1);},
  bandit(){tone(rnd(105,140),rnd(65,85),0.45,'sawtooth',0.09);tone(rnd(150,200),rnd(90,120),0.4,'square',0.04,0.03);noiseHit(0.3,0.07,900,0.02,'bandpass',1.5);},
  banditLaugh(){for(let i=0;i<4;i++)tone(rnd(160,210),rnd(110,140),0.09,'sawtooth',0.07,i*0.13);},
  kill(){[523,659,784].forEach((f,i)=>tone(f,f,0.2,'triangle',0.13,i*0.07));tone(1047,1047,0.4,'sine',0.1,0.22);},
  respawn(){tone(220,880,0.4,'sine',0.1);tone(440,1320,0.4,'triangle',0.06,0.05);},
  ko(){tone(400,60,0.8,'sawtooth',0.12);noiseHit(0.6,0.15,300,0.1);},
  heartbeat(){tone(62,48,0.12,'sine',0.22);tone(58,44,0.14,'sine',0.18,0.17);},
  whoosh(){noiseHit(0.55,0.22,700,0);tone(220,70,0.5,'sine',0.08);},
  chime(){[523,659,784].forEach((f,i)=>tone(f,f,0.3,'triangle',0.1,i*0.08));},
  /* suasana */
  bird(){const b=rnd(2200,3600),n=Math.random()<0.5?2:3;for(let i=0;i<n;i++){tone(b,b*rnd(1.25,1.6),0.09,'sine',0.035,i*0.13);tone(b*1.5,b*1.1,0.05,'sine',0.015,i*0.13+0.05);}},
  owl(){tone(330,300,0.35,'sine',0.05);tone(300,260,0.5,'sine',0.045,0.5);},
  cricket(){for(let i=0;i<5;i++)tone(4300,4300,0.04,'sine',0.012,i*0.07);},
  wind(){noiseHit(rnd(1.5,2.6),0.05,rnd(250,420),0,'lowpass');},
  lap(){noiseHit(rnd(0.7,1.2),0.045,rnd(500,800),0,'bandpass',0.8);},
  drip(){tone(1300,800,0.09,'sine',0.045);tone(2000,1200,0.05,'sine',0.015,0.04);},
  bat(){noiseHit(0.09,0.05,700,0);noiseHit(0.09,0.04,900,0.12);tone(rnd(3500,5000),rnd(2500,3000),0.04,'sine',0.012,0.05);},
  fire(){noiseHit(0.25,0.05,rnd(1800,3200),0,'highpass');if(Math.random()<0.5)tone(rnd(2500,4000),rnd(1500,2500),0.02,'square',0.012);},
  fountain(){noiseHit(0.5,0.04,rnd(1800,2600),0,'bandpass',0.6);}
};

$('btnJump').addEventListener('contextmenu',e=>e.preventDefault());

/* ---------- state ---------- */
const pos=new THREE.Vector3(0,0,6),vel=new THREE.Vector3();
let vy=0,grounded=true,coyote=0,jumpBuf=0,jumping=false,started=false,tAll=0;
const cam={yaw:0,yawT:0,pitch:0.55,pitchT:0.55,dist:14,distT:14,tx:pos.x,ty:0,tz:pos.z,fov:50};
let faceX=0,faceZ=1,viewK=0,walkT=0,idleT=0,lastStepIdx=-1;
const sq={y:1,v:0};
let insideHouse=null;
let attackT=0,atkCool=0,hurtFlash=0,invuln=0,shake=0;
const kb={x:0,z:0};
let oxy=1,wasSwim=false,swimNow=false,rippleT=0;
const keys=new Set();
let jumpBtnHeld=false,diveBtnHeld=false;
let me={id:0,name:'',ch:0,hp:MAXHP,k:0,d:0},dead=false,deadT=0,myShieldT=0;
let ws=null,joined=false,hourBase=9,hourAt=0,netT=0,netIdle=0;
const others=new Map();
const projs=[];
const slots=[null,null,null,null,null],slotCd=[0,0,0,0,0],slotCdMax=[1,1,1,1,1];
let modalSlot=-1,typed='',modalOpen=false,pendingLearn=false;
let boardRows=[];
let strokeT=0,ambT=3,hbT=0,humT=0,inCave=false,fade=null,sleeping=false,sleepHouse=null,sleepPos=null,ammo=0,snipeCd=0,chestOpen=false,zT=0,fountT=0;
const zTex=(function(){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.font='bold 48px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillStyle='#fff';x.fillText('Z',32,34);return new THREE.CanvasTexture(c);})();
let guarding=false,guardPips=3,guardPipT=0,gbT=0,stunT=0,hasteT=0,hastePw=1.6,myRegenT=0,bookOpen=false,bookEnabled=false,bookData=[],bookPage=0,guardLbl='',rideT=0,ridePw=13,myMount=null;

/* ---------- UI helpers ---------- */
let toastT=0;
function toast(msg,secs){const t=$('toast');t.textContent=msg;t.classList.add('show');toastT=secs||2.2;}
function feed(txt){const f=$('feed'),d=document.createElement('div');d.textContent=txt;f.appendChild(d);while(f.children.length>4)f.removeChild(f.firstChild);setTimeout(()=>{if(d.parentNode)d.parentNode.removeChild(d);},5000);}
function nearestDoor(){let best=null,bd=3.1,bi=-1;doors.forEach((d,i)=>{const dist=Math.hypot(d.wx-pos.x,d.wz-pos.z);if(dist<bd&&Math.abs(pos.y)<3){bd=dist;best=d;bi=i;}});return best?{d:best,i:bi}:null;}
function netSend(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function nearestBed(){if(!insideHouse||sleeping)return null;const b=l2w(insideHouse,-2.6,-2.5);return Math.hypot(pos.x-b.x,pos.z-b.z)<2.8?{h:insideHouse,x:b.x,z:b.z}:null;}
function pickAction(){
  if(!started||dead||modalOpen||bookOpen||stunT>0||fade)return null;
  if(sleeping)return {type:'wake',text:'Bangun'};
  if(rideT>0)return null;
  const bed=nearestBed();if(bed)return {type:'bed',bed,text:'Tidur (darah bertambah)'};
  if(inCave&&chest&&!chestOpen&&Math.hypot(chest.x-pos.x,chest.z-pos.z)<3.2)return {type:'chest',text:'Buka peti'};
  if(!inCave){const nf=nearestFort();if(nf&&nf.owner!==me.id&&!(capState&&capState.fort===nf.id))return {type:'cap',fort:nf.id,text:nf.owner?('Rebut '+nf.name+' dari '+nf.ownerName):('Rebut '+nf.name)};}
  if(!inCave){const nd=nearestDoor();if(nd)return {type:'door',i:nd.i,d:nd.d,text:nd.d.open?'Tutup pintu':'Buka pintu'};}
  return null;
}
function startSleep(bed){
  sleeping=true;sleepPos={x:bed.x,z:bed.z};sleepHouse=bed.h;vel.set(0,0,0);kb.x=kb.z=0;vy=0;zT=0;
  setGuard(false);$('night').style.opacity=1;sfx.plop();netSend({t:'sleep',on:true});sfx.sleep();toast('Zzz... darahmu bertambah',2);
}
function wakeUp(fromServer){
  if(!sleeping)return;sleeping=false;sfx.wake();$('night').style.opacity=0;
  if(sleepHouse){const p=l2w(sleepHouse,-2.6,-1.0);pos.x=p.x;pos.z=p.z;}
  pos.y=0;vy=0;grounded=true;sq.y=1.2;
  if(!fromServer)netSend({t:'sleep',on:false});
}
function aimFar(){
  let best=null,bs=-9;
  for(const o of others.values()){
    if(o.dead||(o.x>1000)!==inCave)continue;
    const dx=o.x-pos.x,dz=o.z-pos.z,d=Math.hypot(dx,dz);if(d<0.5||d>85)continue;
    const dot=(dx*faceX+dz*faceZ)/d;
    if(dot>0.93){const sc=dot-d*0.002;if(sc>bs){bs=sc;best=[dx/d,dz/d];}}
  }
  return best?{x:best[0],z:best[1]}:{x:faceX,z:faceZ};
}
function fireSniper(){
  if(!started||dead||modalOpen||bookOpen||stunT>0||fade||ammo<=0||snipeCd>0||rideT>0)return;
  if(sleeping)wakeUp();
  if(guarding)setGuard(false);
  const a=aimFar();faceX=a.x;faceZ=a.z;snipeCd=2.2;attackT=Math.max(attackT,0.3);
  netSend({t:'snipe',fx:a.x,fz:a.z});
}
function spotFree(x,z){
  if(lakeDist(x,z)<LAKE.R+2)return false;
  const h=terrainH(x,z);if(h>7||h<-0.5)return false;
  if(Math.abs(terrainH(x+1.5,z)-h)>1.0||Math.abs(terrainH(x,z+1.5)-h)>1.0)return false;
  for(const c of circles)if(c.x<1000&&Math.hypot(x-c.x,z-c.z)<c.r+PR+0.4)return false;
  for(const p of platforms)if(Math.hypot(x-p.x,z-p.z)<p.r+PR+0.4)return false;
  for(const o of houses)if(Math.hypot(x-o.x,z-o.z)<6)return false;
  for(const t of towerSpecs)if(Math.hypot(x-t.x,z-t.z)<8)return false;
  if(Math.hypot(x-CAVE.x,z-CAVE.z)<13)return false;
  if(FORT_DEFS.some(f=>Math.hypot(x-f.x,z-f.z)<17))return false;
  if(CAMP_DEFS.some(c=>Math.hypot(x-c.x,z-c.z)<20))return false;
  return true;
}
function findFree(x,z){for(let k=0;k<90;k++){const a=k*2.4,r=k===0?0:1.9*Math.sqrt(k);const cx=x+Math.cos(a)*r,cz=z+Math.sin(a)*r;if(spotFree(cx,cz))return {x:cx,z:cz};}return {x,z};}
function startTransition(toCave){if(fade)return;fade={t:0,toCave,phase:0};$('fade').style.opacity=1;sfx.whoosh();}
function doSwitch(toCave){
  vel.set(0,0,0);vy=0;kb.x=kb.z=0;grounded=true;
  if(toCave){pos.set(CX,0,CZ+19);cam.yaw=cam.yawT=0;faceX=0;faceZ=-1;toast('Goa Kelelawar',2.4);}
  else{const p=cavePt(0,3.4);pos.set(p.x,0,p.z);cam.yaw=cam.yawT=CAVE_ROT+Math.PI;faceX=Math.sin(CAVE_ROT);faceZ=Math.cos(CAVE_ROT);}
  cam.tx=pos.x;cam.tz=pos.z;cam.ty=pos.y;
}
function interact(){
  if(!started||dead||modalOpen||bookOpen||stunT>0||fade)return;
  const a=pickAction();if(!a)return;
  if(a.type==='wake')wakeUp();
  else if(a.type==='bed')startSleep(a.bed);
  else if(a.type==='chest')netSend({t:'chest'});
  else if(a.type==='cap')netSend({t:'cap',fort:a.fort});
  else netSend({t:'door',i:a.i});
}
function aim(){
  let fx=faceX,fz=faceZ,best=null,bs=-9;
  for(const o of others.values()){
    if(o.dead)continue;const dx=o.x-pos.x,dz=o.z-pos.z,d=Math.hypot(dx,dz);if(d<0.5||d>28)continue;
    const dot=(dx*faceX+dz*faceZ)/d;
    if(dot>0.74){const sc=dot-d*0.004;if(sc>bs){bs=sc;best=[dx/d,dz/d];}}
  }
  return best?{x:best[0],z:best[1]}:{x:fx,z:fz};
}
function doAttack(){
  if(!started||dead||modalOpen||bookOpen||stunT>0||fade||attackT>0||atkCool>0)return;
  if(sleeping)wakeUp();
  if(guarding)setGuard(false);
  const a=aim();faceX=a.x;faceZ=a.z;
  attackT=0.32;atkCool=0.42;sfx.swing();
  netSend({t:'atk',fx:a.x,fz:a.z});
}
function updSlotUI(i){
  const el=document.querySelector('.slot[data-i="'+i+'"]'),s=slots[i];
  el.classList.toggle('empty',!s);el.classList.toggle('filled',!!s);
  el.querySelector('.ic').innerHTML=s?svg(s.kind,s.color):svg('plus');
  el.querySelector('.nm').textContent=s?s.name:'';
  if(s)el.style.setProperty('--c',s.color);else el.style.removeProperty('--c');
}
function castSlot(i){
  if(!started||dead||modalOpen||bookOpen||chatOpen||stunT>0||fade)return;
  if(sleeping)wakeUp();
  const s=slots[i];if(!s){cancelAim();openModal(i);return;}
  if(aiming===i){fireAim();return;}
  if(slotCd[i]>0)return;
  if(AIM_KINDS[s.kind]){enterAim(i);return;}
  if(aiming>=0)cancelAim();
  if(guarding)setGuard(false);
  const a=aim();faceX=a.x;faceZ=a.z;
  slotCd[i]=slotCdMax[i]=s.cd;
  attackT=Math.max(attackT,0.32);
  netSend({t:'cast',slot:i,fx:a.x,fy:0,fz:a.z});
}

/* ---------- code modal ---------- */
function renderCode(){$('codeBox').textContent=typed||'· · · · · ·';$('mOk').disabled=typed.length<2||pendingLearn;}
function openModal(i){
  modalSlot=i;typed='';modalOpen=true;pendingLearn=false;$('codeErr').textContent='';$('codeBox').classList.remove('err');
  $('mTitle').textContent='TEKNIK DIGITAL, SLOT '+(i+1);
  $('mSub').textContent=slots[i]?'Slot ini berisi: '+slots[i].name+'. Ketik kode baru untuk mengganti.':'Masukkan kode angka 1-9 dari buku';
  $('mrow2').style.display=slots[i]?'block':'none';
  $('modal').classList.add('show');renderCode();
  keys.clear();jumpBtnHeld=false;diveBtnHeld=false;
}
function closeModal(){modalOpen=false;modalSlot=-1;$('modal').classList.remove('show');}
function typeDigit(d){if(typed.length>=12)return;typed+=d;$('codeErr').textContent='';renderCode();sfx.plop();}
function modalErr(msg){$('codeErr').textContent=msg;const b=$('codeBox');b.classList.remove('err');void b.offsetWidth;b.classList.add('err');sfx.bad();pendingLearn=false;renderCode();}
function submitCode(){
  if(typed.length<2||pendingLearn)return;
  if(slots.some((s,i)=>s&&s.code===typed&&i!==modalSlot)){modalErr('Teknik itu sudah ada di slot lain');return;}
  pendingLearn=true;renderCode();netSend({t:'learn',slot:modalSlot,code:typed});
}
document.querySelectorAll('#pad button').forEach(b=>b.addEventListener('click',()=>typeDigit(b.dataset.d)));
$('mBack').addEventListener('click',()=>{typed=typed.slice(0,-1);renderCode();});
$('mCancel').addEventListener('click',closeModal);
$('mOk').addEventListener('click',submitCode);
$('mClear').addEventListener('click',()=>{const i=modalSlot;slots[i]=null;slotCd[i]=0;updSlotUI(i);netSend({t:'clear',slot:i});closeModal();});
$('modal').addEventListener('pointerdown',e=>{if(e.target===$('modal'))closeModal();});
document.querySelectorAll('.slot').forEach(el=>{
  const i=+el.dataset.i;let timer=null,longDone=false;
  el.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();initAudio();el.classList.add('down');longDone=false;
    clearTimeout(timer);timer=setTimeout(()=>{if(slots[i]){longDone=true;openModal(i);}},550);});
  const up=()=>{clearTimeout(timer);el.classList.remove('down');};
  el.addEventListener('pointerup',e=>{const was=el.classList.contains('down');up();if(was&&!longDone&&!modalOpen)castSlot(i);});
  el.addEventListener('pointerleave',up);el.addEventListener('pointercancel',up);
  el.addEventListener('contextmenu',e=>{e.preventDefault();if(started&&!modalOpen)openModal(i);});
});

/* ---------- input ---------- */
window.addEventListener('keydown',e=>{
  if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.code)&&document.activeElement!==$('nameIn')&&document.activeElement!==$('chatIn'))e.preventDefault();
  if(!started)return;
  if(chatOpen)return;
  if(bookOpen){
    if(e.code==='Escape'||e.code==='KeyB')closeBook();else if(e.code==='ArrowLeft')bookGo(-1);else if(e.code==='ArrowRight')bookGo(1);
    return;
  }
  if(modalOpen){
    if(/^Digit[1-9]$/.test(e.code)||/^Numpad[1-9]$/.test(e.code))typeDigit(e.code.slice(-1));
    else if(e.code==='Backspace'){typed=typed.slice(0,-1);renderCode();}
    else if(e.code==='Enter'||e.code==='NumpadEnter')submitCode();
    else if(e.code==='Escape')closeModal();
    return;
  }
  if(e.repeat)return;
  keys.add(e.code);
  if(e.code==='KeyK'||e.code==='KeyG')setGuard(true);
  if(e.code==='KeyB'){openBook();return;}
  if(e.code==='KeyH')fireSniper();
  if(e.code==='Space')jumpBuf=0.13;
  if(e.code==='KeyE')interact();
  if(e.code==='Enter')openChat();
  if(e.code==='KeyC')setFps(!fps);
  if(e.code==='Escape'&&aiming>=0)cancelAim();
  if(e.code==='KeyJ'||e.code==='KeyX'||e.code==='KeyF')doAttack();
  if(e.code==='Tab')$('board').classList.add('show');
  const m=/^Digit([1-5])$/.exec(e.code);if(m)castSlot(+m[1]-1);
});
window.addEventListener('keyup',e=>{keys.delete(e.code);if(e.code==='KeyK'||e.code==='KeyG')setGuard(false);if(e.code==='Tab'&&!sbOn)$('board').classList.remove('show');});
window.addEventListener('blur',()=>{keys.clear();jumpBtnHeld=false;diveBtnHeld=false;});
let sbOn=false;
$('sbBtn').addEventListener('click',()=>{sbOn=!sbOn;$('board').classList.toggle('show',sbOn);});
const joy={id:null,cx:0,cy:0,x:0,y:0},look={id:null,lx:0,ly:0};
canvas.addEventListener('pointerdown',e=>{
  if(!started)return;initAudio();
  if(e.pointerType==='mouse'){look.id=e.pointerId;look.lx=e.clientX;look.ly=e.clientY;look.sx=e.clientX;look.sy=e.clientY;}
  else if(e.clientX<innerWidth*0.5&&joy.id===null){joy.id=e.pointerId;joy.cx=e.clientX;joy.cy=e.clientY;joy.x=joy.y=0;const b=$('joyBase'),k=$('joyKnob');b.style.display=k.style.display='block';b.style.left=k.style.left=e.clientX+'px';b.style.top=k.style.top=e.clientY+'px';}
  else if(look.id===null){look.id=e.pointerId;look.lx=e.clientX;look.ly=e.clientY;}
  try{canvas.setPointerCapture(e.pointerId);}catch(_){}
});
window.addEventListener('pointermove',e=>{
  if(e.pointerId===joy.id){
    let dx=e.clientX-joy.cx,dy=e.clientY-joy.cy;const Rr=55,m=Math.hypot(dx,dy);if(m>Rr){dx=dx/m*Rr;dy=dy/m*Rr;}
    joy.x=dx/Rr;joy.y=-dy/Rr;$('joyKnob').style.left=(joy.cx+dx)+'px';$('joyKnob').style.top=(joy.cy+dy)+'px';
  }else if(e.pointerId===look.id){
    cam.yawT-=(e.clientX-look.lx)*0.0065;if(fps)fpsPitch=clamp(fpsPitch-(e.clientY-look.ly)*0.004,-1.3,1.3);else cam.pitchT=clamp(cam.pitchT+(e.clientY-look.ly)*0.004,0.22,1.1);look.lx=e.clientX;look.ly=e.clientY;
  }
});
function endPtr(e){
  if(e.pointerId===joy.id){joy.id=null;joy.x=joy.y=0;$('joyBase').style.display=$('joyKnob').style.display='none';}
  if(e.pointerId===look.id){if(aiming>=0&&e.pointerType==='mouse'&&Math.hypot(e.clientX-look.sx,e.clientY-look.sy)<6)fireAim();look.id=null;}
}
window.addEventListener('pointerup',endPtr);window.addEventListener('pointercancel',endPtr);
canvas.addEventListener('wheel',e=>{cam.distT=clamp(cam.distT+e.deltaY*0.01,7,24);e.preventDefault();},{passive:false});
function bindBtn(el,down,up){
  el.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();initAudio();el.classList.add('down');try{el.setPointerCapture(e.pointerId);}catch(_){}if(started)down();});
  const rel=e=>{el.classList.remove('down');up&&up();};
  el.addEventListener('pointerup',rel);el.addEventListener('pointercancel',rel);
}
bindBtn($('btnJump'),()=>{jumpBtnHeld=true;jumpBuf=0.13;},()=>{jumpBtnHeld=false;});
bindBtn($('btnDive'),()=>{diveBtnHeld=true;},()=>{diveBtnHeld=false;});
bindBtn($('btnAct'),()=>interact());
bindBtn($('btnAtk'),()=>doAttack());
bindBtn($('btnGuard'),()=>setGuard(true),()=>setGuard(false));
bindBtn($('btnSnipe'),()=>fireSniper());

/* ---------- fullscreen ---------- */
(function(){
  const el=document.documentElement,btn=$('fsBtn');
  const req=el.requestFullscreen||el.webkitRequestFullscreen,exit=document.exitFullscreen||document.webkitExitFullscreen;
  if(!req){btn.classList.add('off');return;}
  const isFs=()=>!!(document.fullscreenElement||document.webkitFullscreenElement);
  const sync=()=>{btn.innerHTML=svg(isFs()?'fsx':'fs');setTimeout(resize,150);};
  document.addEventListener('fullscreenchange',sync);document.addEventListener('webkitfullscreenchange',sync);
  btn.addEventListener('pointerdown',e=>e.stopPropagation());
  btn.addEventListener('click',()=>{
    try{
      if(isFs()){exit.call(document);}
      else{const r=req.call(el);if(r&&r.catch)r.catch(()=>{});
        try{if(screen.orientation&&screen.orientation.lock&&innerWidth<innerHeight)screen.orientation.lock('landscape').catch(()=>{});}catch(_){}}
    }catch(_){}
    canvas.focus();
  });
})();

/* ---------- tameng, buku, elang, ranjau, sinar ---------- */
function emojiTex(ch){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.font='44px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(ch,32,34);return new THREE.CanvasTexture(c);}
const guardMat=new THREE.SpriteMaterial({map:emojiTex('🛡️'),depthTest:false,transparent:true,fog:false});
let myGuardSp=null;
function setGuard(on){
  if(on&&!(started&&!dead&&!modalOpen&&!bookOpen&&stunT<=0&&gbT<=0&&rideT<=0&&!sleeping&&!swimNow))on=false;
  if(guarding===on)return;
  guarding=on;$('btnGuard').classList.toggle('on',on);netSend({t:'guard',on});if(on)sfx.shield();
}
/* buku */
function bookPer(){return innerHeight<500?3:(innerWidth<520?4:5);}
function renderBook(){
  const per=bookPer(),spreads=Math.max(1,Math.ceil(bookData.length/(per*2)));
  bookPage=clamp(bookPage,0,spreads-1);
  const fill=(el,items,no,title)=>{
    el.innerHTML='';const h=document.createElement('h3');h.innerHTML=title;el.appendChild(h);
    items.forEach(t=>{const d=document.createElement('div');d.className='te';
      const ic=document.createElement('div');ic.className='ic';ic.innerHTML=svg(t.kind,'#7a3a14');
      const bx=document.createElement('div');const b=document.createElement('b');b.textContent=t.name;
      const cd=document.createElement('div');cd.className='cd';cd.textContent=t.code;
      const sm=document.createElement('small');sm.textContent=t.desc+'. Cooldown '+t.cd+' dtk';
      bx.appendChild(b);bx.appendChild(cd);bx.appendChild(sm);d.appendChild(ic);d.appendChild(bx);el.appendChild(d);});
    const n=document.createElement('div');n.className='pn';n.textContent=no;el.appendChild(n);
  };
  const base=bookPage*per*2;
  fill($('pgL'),bookData.slice(base,base+per),bookPage*2+1,svg('book',null,'bki')+'Buku Teknik Digital');
  fill($('pgR'),bookData.slice(base+per,base+per*2),bookPage*2+2,'Kode dan kekuatan');
  $('bkPrev').style.visibility=bookPage>0?'visible':'hidden';$('bkNext').style.visibility=bookPage<spreads-1?'visible':'hidden';
}
function openBook(){
  if(!started||bookOpen||modalOpen||!bookEnabled)return;
  fetch('/api/book').then(r=>r.json()).then(j=>{
    if(!j.enabled){toast('Buku tidak tersedia',2);return;}
    bookData=j.techniques;bookPage=0;bookOpen=true;keys.clear();jumpBtnHeld=false;diveBtnHeld=false;setGuard(false);
    $('book').classList.add('show');renderBook();sfx.plop();
  }).catch(()=>toast('Gagal memuat buku',2));
}
function closeBook(){bookOpen=false;$('book').classList.remove('show');}
function bookGo(d){bookPage+=d;renderBook();sfx.plop();}
$('bookBtn').addEventListener('click',()=>{if(bookOpen)closeBook();else openBook();});
$('bookBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('mini').addEventListener('click',()=>{if(!bookOpen)openBook();});
$('mini').addEventListener('pointerdown',e=>e.stopPropagation());
$('bkX').addEventListener('click',closeBook);
$('bkPrev').addEventListener('click',()=>bookGo(-1));$('bkNext').addEventListener('click',()=>bookGo(1));
$('book').addEventListener('pointerdown',e=>{if(e.target===$('book'))closeBook();});
/* elang */
function outlineCv(cv,cw,ch){
  const ctx=cv.getContext('2d'),W=cv.width,H=cv.height,im=ctx.getImageData(0,0,W,H),d=im.data,out=new Uint8ClampedArray(d);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=(y*W+x)*4;if(d[i+3]>0)continue;const cx=x%cw,cy=y%ch;let near=false;
    if(cx>0&&d[i-4+3]>0)near=true;if(cx<cw-1&&d[i+4+3]>0)near=true;if(cy>0&&d[i-W*4+3]>0)near=true;if(cy<ch-1&&d[i+W*4+3]>0)near=true;
    if(near){out[i]=43;out[i+1]=34;out[i+2]=51;out[i+3]=255;}
  }
  im.data.set(out);ctx.putImageData(im,0,0);
}
const EW=28,EH=18;
const eagleCv=document.createElement('canvas');eagleCv.width=EW*2;eagleCv.height=EH*5;
(function(){
  const x=eagleCv.getContext('2d');
  const body='#7a5230',dk='#4a321c',wh='#f4f0e6',bk='#f0b030',bl='#d8c9a0';
  function draw(row,f){
    const ox=f*EW,oy=row*EH;
    const E=(a,b,w,h,c)=>{x.fillStyle=c;x.fillRect(ox+a,oy+b,w,h);};
    const wingsFB=()=>{ /* sayap terentang kiri-kanan (tampak depan/belakang) */
      if(f===0){E(2,2,3,5,dk);E(4,4,3,5,dk);E(6,6,5,5,dk);E(23,2,3,5,dk);E(21,4,3,5,dk);E(17,6,5,5,dk);}
      else{E(2,11,3,5,dk);E(4,10,3,5,dk);E(6,8,5,5,dk);E(23,11,3,5,dk);E(21,10,3,5,dk);E(17,8,5,5,dk);}
    };
    const wingsQ=()=>{ /* sayap tampak 3/4 */
      if(f===0){E(6,0,4,5,dk);E(8,2,5,6,dk);E(12,4,4,4,dk);E(18,2,3,4,dk);}
      else{E(6,13,4,5,dk);E(8,11,5,5,dk);E(12,10,4,4,dk);E(18,11,3,4,dk);}
    };
    if(row===0){ /* samping, menghadap kanan */
      E(7,7,12,5,body);E(3,8,5,3,dk);E(1,9,3,2,dk);
      E(18,5,5,5,wh);E(23,7,3,2,bk);E(10,11,6,1,bl);
      if(f===0){E(9,1,7,6,dk);E(7,1,3,3,dk);E(15,2,4,4,dk);}
      else{E(9,12,7,5,dk);E(7,14,3,3,dk);E(15,12,4,4,dk);}
    }else if(row===1){ /* depan */
      wingsFB();E(11,9,6,8,body);E(12,11,4,4,bl);E(11,4,6,5,wh);E(12,3,4,1,wh);E(13,8,2,2,bk);E(11,17,2,1,bk);E(15,17,2,1,bk);
    }else if(row===2){ /* belakang */
      wingsFB();E(11,9,6,7,body);E(10,15,8,3,dk);E(12,17,4,1,body);E(11,4,6,5,wh);E(12,8,4,1,wh);
    }else if(row===3){ /* 3/4 depan, menghadap kanan */
      wingsQ();E(2,10,6,3,dk);E(7,8,10,6,body);E(9,12,6,2,bl);E(15,4,6,6,wh);E(21,7,3,2,bk);E(21,9,2,1,bk);E(10,14,2,1,bk);E(14,14,2,1,bk);
    }else{ /* 3/4 belakang, menghadap kanan */
      wingsQ();E(2,9,6,4,dk);E(3,12,4,2,body);E(7,8,10,6,body);E(15,4,6,6,wh);E(21,7,1,2,bk);
    }
  }
  for(let r=0;r<5;r++)for(let f=0;f<2;f++)draw(r,f);
  outlineCv(eagleCv,EW,EH);
})();
const eagleBase=new THREE.CanvasTexture(eagleCv);eagleBase.magFilter=eagleBase.minFilter=THREE.NearestFilter;eagleBase.generateMipmaps=false;
const eagleGeo=new THREE.PlaneGeometry(2.8,1.8);
/* 8 arah: pakai pemetaan baris yang sama dengan karakter (ROWMAP) */
function eagleTex(){const t=eagleBase.clone();t.needsUpdate=true;t.repeat.set(0.5,0.2);return t;}
function eagleSet(o,fx,fz,rgt,fwd,frame){
  o.vk=pickView(fx,fz,rgt,fwd,o.vk||0);
  o.tex.offset.set(frame*0.5,1-(ROWMAP[o.vk]+1)/5);
  return o.vk>4;
}
const mobs=new Map();
function addMob(m){
  if(mobs.has(m.id))return;
  const tex=eagleTex();
  const mesh=new THREE.Mesh(eagleGeo,new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide}));mesh.rotation.order='YXZ';scene.add(mesh);
  const sh=new THREE.Mesh(aShGeo,aShMat);scene.add(sh);
  mobs.set(m.id,{hp:m.hp||40,flash:0,id:m.id,o:m.o,mesh,tex,sh,x:m.x,y:m.y,z:m.z,tx:m.x,ty:m.y,tz:m.z,fx:1,fz:0,atkT:0});
  burst(m.x,m.y,m.z,m.c||'#ffd9a0',10,4);sfxAt('eagle',m.x,m.z);
}
function removeMob(id,quiet){
  const o=mobs.get(id);if(!o)return;
  if(!quiet)burst(o.x,o.y,o.z,'#ffd9a0',10,4);
  scene.remove(o.mesh);scene.remove(o.sh);o.mesh.material.dispose();o.tex.dispose();mobs.delete(id);
}
function updMobs(dt,rgt,fwd){
  for(const m of mobs.values()){
    const k=damp(10,dt);m.x+=(m.tx-m.x)*k;m.y+=(m.ty-m.y)*k;m.z+=(m.tz-m.z)*k;m.atkT=Math.max(0,m.atkT-dt);
    const sc=1+(m.atkT>0?0.35:0);
    m.mesh.position.set(m.x,m.y,m.z);m.mesh.rotation.y=cam.yaw;m.mesh.rotation.x=-cam.pitch*0.55;
    const fl=eagleSet(m,m.fx,m.fz,rgt,fwd,Math.floor(tAll*10+m.id)%2);
    m.flash=Math.max(0,m.flash-dt);m.mesh.material.color.setHex(m.flash>0?0xff7a7a:0xffffff);m.mesh.scale.set(fl?-sc:sc,sc,1);
    const gy=Math.max(groundAt(m.x,m.z,m.y),WATER_Y);
    m.sh.position.set(m.x,gy+0.07,m.z);m.sh.scale.setScalar(clamp(1-(m.y-gy)*0.1,0.3,1)*1.2);
  }
}
/* tunggangan elang */
function mountMake(){const tex=eagleTex();const mesh=new THREE.Mesh(eagleGeo,new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide}));mesh.rotation.order='YXZ';scene.add(mesh);return {mesh,tex};}
function mountPlace(m,x,y,z,fx,fz,rgt,fwd,id){
  const fl=eagleSet(m,fx,fz,rgt,fwd,Math.floor(tAll*7+id)%2);
  const rw=ROWMAP[m.vk],off=(rw===1||rw===3)?0.4:-0.15;
  m.mesh.position.set(x+Math.sin(cam.yaw)*off,y+0.4,z+Math.cos(cam.yaw)*off);m.mesh.rotation.y=cam.yaw;m.mesh.rotation.x=-cam.pitch*0.55;
  m.mesh.scale.set(fl?-1.6:1.6,1.6,1);
}
function mountDrop(m){scene.remove(m.mesh);m.mesh.material.dispose();m.tex.dispose();}
/* ranjau */
const traps=new Map();
function addTrap(m){
  const mm=new THREE.MeshBasicMaterial({color:m.c,transparent:true,opacity:0.7,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const ring=new THREE.Mesh(ringGeo,mm);ring.position.set(m.x,m.y+0.12,m.z);ring.scale.setScalar(m.r);scene.add(ring);
  const core=new THREE.Mesh(new THREE.CircleGeometry(0.35,10).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({color:m.c,transparent:true,opacity:0.9,fog:false}));core.position.set(m.x,m.y+0.13,m.z);scene.add(core);
  traps.set(m.id,{ring,mm,core,t:0});
}
function removeTrap(id,hit){
  const t=traps.get(id);
  if(t){scene.remove(t.ring);scene.remove(t.core);t.mm.dispose();t.core.material.dispose();t.core.geometry.dispose();traps.delete(id);}
  if(hit){ringFx(hit.x,hit.y+0.3,hit.z,3,'#ff9a4d');burst(hit.x,hit.y+0.5,hit.z,'#ffb84d',20,6);sfxAt('boom',hit.x,hit.z);}
}
function updTraps(dt){for(const t of traps.values()){t.t+=dt;t.mm.opacity=0.45+0.3*Math.sin(t.t*5);}}
/* sinar */
const beams=[];
function beamFx(x,y,z,fx,fz,len,col,th){
  th=th||0.2;const g=new THREE.BoxGeometry(len,th,th);g.translate(len/2,0,0);
  const m=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.95,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const mesh=new THREE.Mesh(g,m);mesh.position.set(x+fx*0.8,y,z+fz*0.8);mesh.rotation.y=-Math.atan2(fz,fx);scene.add(mesh);beams.push({mesh,m,g,t:0});
}
function updBeams(dt){
  for(let i=beams.length-1;i>=0;i--){const b=beams[i];b.t+=dt;const k=b.t/0.3;
    if(k>=1){scene.remove(b.mesh);b.m.dispose();b.g.dispose();beams.splice(i,1);continue;}
    b.m.opacity=0.95*(1-k);b.mesh.scale.y=b.mesh.scale.z=1-k*0.7;}
}

/* ---------- perisai 3D besar ---------- */
function makeShield3D(ch){
  const pal=Object.assign({},PAL_PLAYER,CHARS[clamp(ch|0,0,CHARS.length-1)].pal);
  const g=new THREE.Group();
  const disc=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,0.09,24).rotateX(Math.PI/2),mat(pal.tunic,{shininess:25,specular:0x444444}));g.add(disc);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(0.5,0.045,8,28),mat(pal.tunicD||pal.tunic));rim.position.z=0.045;g.add(rim);
  g.visible=false;scene.add(g);return g;
}
function makeGuardSp(ch){return makeShield3D(ch);}
function placeShield(sh,x,y,z,fx,fz,t){
  sh.position.set(x+fx*0.62,y+0.95,z+fz*0.62);
  sh.rotation.set(0,Math.atan2(fx,fz),0);
}

/* ---------- bola biru raksasa 3D ---------- */
const orbs=new Map();
function addOrb(m){
  const r=m.r,g=new THREE.Group();
  const core=new THREE.Mesh(new THREE.IcosahedronGeometry(r*0.92,2),new THREE.MeshPhongMaterial({color:0x2f8fff,emissive:0x0a3a9a,transparent:true,opacity:0.5,flatShading:true,shininess:70,specular:0x99ccff,depthWrite:false}));
  const wire=new THREE.Mesh(new THREE.IcosahedronGeometry(r,2),new THREE.MeshBasicMaterial({color:0x9fd4ff,wireframe:true,transparent:true,opacity:0.85,fog:false}));
  const inner=new THREE.Mesh(new THREE.IcosahedronGeometry(r*0.4,1),new THREE.MeshBasicMaterial({color:0xdff2ff,transparent:true,opacity:0.95,fog:false}));
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0x3a9fff,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.75,fog:false}));glow.scale.setScalar(r*4);
  const rg=new THREE.Group();
  for(let k=0;k<3;k++){const ring=new THREE.Mesh(new THREE.TorusGeometry(r*1.1,r*0.035,6,56),new THREE.MeshBasicMaterial({color:0x6fc8ff,transparent:true,opacity:0.8,fog:false}));ring.rotation.x=k*1.05;ring.rotation.y=k*0.6;rg.add(ring);}
  g.add(core,wire,inner,glow,rg);g.position.set(m.x,m.y,m.z);scene.add(g);
  orbs.set(m.id,{id:m.id,g,core,wire,inner,glow,rg,x:m.x,y:m.y,z:m.z,dx:m.dx,dy:m.dy||0,dz:m.dz,sp:m.sp,life:m.life,r});
  sfxAt('orb',m.x,m.z);
}
function removeOrb(id,quiet){
  const o=orbs.get(id);if(!o)return;
  if(!quiet)burst(o.x,o.y,o.z,'#6fc2ff',24,10);
  scene.remove(o.g);o.g.traverse(c=>{if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});orbs.delete(id);
}
function updOrbs(dt){
  for(const o of orbs.values()){
    o.life-=dt;if(o.life<=0){removeOrb(o.id);continue;}
    o.x+=o.dx*o.sp*dt;o.y+=o.dy*o.sp*dt;o.z+=o.dz*o.sp*dt;o.g.position.set(o.x,o.y,o.z);
    o.wire.rotation.y+=dt*9;o.wire.rotation.x+=dt*5.5;o.core.rotation.y-=dt*7;o.core.rotation.z+=dt*4;
    o.rg.rotation.y+=dt*11;o.rg.rotation.z+=dt*5;o.inner.rotation.x+=dt*14;
    const pu=1+0.035*Math.sin(tAll*12);o.core.scale.setScalar(pu);
    o.glow.material.opacity=0.6+0.2*Math.sin(tAll*9);
    if(Math.random()<dt*40){const a=Math.random()*6.28,b=Math.acos(Math.random()*2-1);emit(o.x+Math.sin(b)*Math.cos(a)*o.r,o.y+Math.cos(b)*o.r,o.z+Math.sin(b)*Math.sin(a)*o.r,0,0.5,0,0.5,0.6,'#9fd4ff',0,0.8,0.4);}
  }
}

/* ---------- pasukan benteng ---------- */
const sols=new Map(),solSheets={};
function solBase(kind,ch){
  const key=(ch<0?'bandit':'')+kind+ch;
  if(!solSheets[key]){
    const ot=fortColor(ch);
    const bd=key.indexOf('bandit')===0;
    const pal=bd?Object.assign({},PAL_PLAYER,{skin:'#c99a72',hair:'#16100c',hairL:'#2a1f18',scarf:'#b3262a',scarfD:'#7d1a1d',tunic:kind==='brute'?'#4a2f2a':(kind==='archer'?'#3f4a2e':'#3a3a42'),tunicD:'#22201e',belt:'#8a5a2a',pants:'#2a2420',boot:'#120d0a',blade:kind==='archer'?'#a07a4a':'#9aa0a8',hilt:'#6a4a1a'}):Object.assign({},PAL_PLAYER,{skin:'#e3b48a',hair:'#2a2018',hairL:'#44362a',scarf:ot,scarfD:ot,tunic:kind==='sword'?'#98a0ac':'#4f8a4a',tunicD:kind==='sword'?'#6f7783':'#386b34',belt:'#5a3a1a',pants:'#3a3a48',boot:'#2a2018',blade:kind==='sword'?'#eef3fb':'#c9a46a'});
    const cv=buildCharSheet(pal),tex=new THREE.CanvasTexture(cv);tex.magFilter=tex.minFilter=THREE.NearestFilter;tex.generateMipmaps=false;tex.repeat.set(1/NF,1/NROW);
    solSheets[key]=tex;
  }
  const t=solSheets[key].clone();t.needsUpdate=true;t.repeat.set(1/NF,1/NROW);return t;
}
function addSol(info){
  if(sols.has(info.id))return;
  const tex=solBase(info.kind,info.bandit?-1:info.ch);
  const m=new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(spriteGeo,m);mesh.rotation.order='YXZ';scene.add(mesh);
  const sh=new THREE.Mesh(aShGeo,aShMat);scene.add(sh);
  const owner=info.owner===me.id?me.name:((others.get(info.owner)||{}).name||'Pasukan');
  const bnm={sword:'Penyamun Pedang',archer:'Penyamun Panah',brute:'Penyamun Brute'}[info.kind];
  const o={id:info.id,isSol:true,kind:info.kind,fort:info.fort,owner:info.owner,x:info.x,z:info.z,tx:info.x,tz:info.z,fx:0,fz:1,hp:info.hp,max:info.max,name:info.bandit?bnm:((info.kind==='sword'?'Pedang ':'Panah ')+owner),bandit:!!info.bandit,sc:info.kind==='brute'?1.3:1,shieldT:0,
    mesh,tex,mat:m,sh,lab:makeLabel(),viewK:0,wt:Math.random()*4,atkT:0,flash:0,moving:false};
  o.hpv=o.hp/o.max*MAXHP;
  drawSolLabel(o);sols.set(o.id,o);
}
function drawSolLabel(o){const fake={name:o.name,hp:o.hp/o.max*MAXHP,shieldT:0,lab:o.lab};drawLabel(fake);}
function removeSol(id,dead){
  const o=sols.get(id);if(!o)return;
  if(dead)burst(o.x,groundAt(o.x,o.z,5)+1,o.z,'#ffffff',14,5);
  scene.remove(o.mesh);scene.remove(o.sh);scene.remove(o.lab.sp);o.mat.dispose();o.tex.dispose();o.lab.sp.material.dispose();o.lab.tex.dispose();sols.delete(id);
}
function updSols(dt,rgt,fwd){
  const k=damp(10,dt);
  for(const o of sols.values()){
    const px=o.x,pz=o.z;o.x+=(o.tx-o.x)*k;o.z+=(o.tz-o.z)*k;
    const mv=Math.hypot(o.x-px,o.z-pz)/Math.max(dt,0.001);o.moving=mv>0.6;
    o.flash=Math.max(0,o.flash-dt);o.atkT=Math.max(0,o.atkT-dt);
    const gy=terrainH(o.x,o.z),dp=Math.hypot(o.x-pos.x,o.z-pos.z);
    o.viewK=pickView(o.fx,o.fz,rgt,fwd,o.viewK);
    let row=ROWMAP[o.viewK],col,flip=o.viewK>4;
    if(o.atkT>0){row=5;col=(0.3-o.atkT)<0.1?4:5;flip=(o.fx*rgt.x+o.fz*rgt.z)<0;if(o.kind==='archer')col=4;}
    else if(o.moving){o.wt+=dt*(2.4+mv*0.7);col=2+(Math.floor(o.wt)%4);}
    else col=Math.floor(tAll/0.6+o.id)%2;
    setTexFrame(o.tex,col,row);
    o.mesh.position.set(o.x,gy,o.z);o.mesh.rotation.y=cam.yaw;o.mesh.rotation.x=-cam.pitch*0.55;o.mesh.scale.set(flip?-o.sc:o.sc,o.sc,1);
    o.mat.color.setHex(o.flash>0?0xff7a7a:0xffffff);
    o.sh.position.set(o.x,gy+0.07,o.z);o.sh.scale.setScalar(1.25*o.sc);
    const vis=dp<120&&!(o.x>1000)&&!inCave;
    o.mesh.visible=o.sh.visible=vis;o.lab.sp.visible=vis&&dp<55;o.lab.sp.position.set(o.x,gy+2.35*o.sc,o.z);
    if(o.stepT===undefined)o.stepT=0;if(o.moving&&dp<30){o.stepT-=dt;if(o.stepT<=0){o.stepT=o.kind==='brute'?0.5:0.38;sfxAt('step',o.x,o.z,'grass');}}
  }
}

/* ---------- bidik dulu (aim mode) ---------- */
let aiming=-1,fps=false,fpsPitch=0;
const AIM_KINDS={bolt:1,beam:1,orb:1,dash:1,slam:1};
const retC=document.createElement('canvas');retC.width=retC.height=64;
(function(){const x=retC.getContext('2d');x.strokeStyle='#fff';x.lineWidth=5;x.beginPath();x.arc(32,32,22,0,6.2832);x.stroke();x.lineWidth=4;x.beginPath();x.moveTo(32,4);x.lineTo(32,18);x.moveTo(32,46);x.lineTo(32,60);x.moveTo(4,32);x.lineTo(18,32);x.moveTo(46,32);x.lineTo(60,32);x.stroke();})();
const aimRet=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(retC),depthTest:false,transparent:true,fog:false,opacity:0.95}));aimRet.renderOrder=25;aimRet.visible=false;scene.add(aimRet);
const aimLine=new THREE.Mesh(new THREE.BoxGeometry(1,0.07,0.07).translate(0.5,0,0),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.55,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));aimLine.visible=false;scene.add(aimLine);
const _v1=new THREE.Vector3(1,0,0),_v2=new THREE.Vector3();
function camFwd(){return {x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)};}
function aimPitchVal(){return fps?Math.sin(fpsPitch):clamp((0.55-cam.pitchT)*1.6,-0.9,0.9);}
function aimVec(){
  const f=camFwd();let ax=f.x,az=f.z,ay=aimPitchVal(),lock=null,bd=1e9;
  const cand=[];others.forEach(o=>{if(!o.dead&&(o.x>1000)===inCave)cand.push({x:o.x,y:o.y+0.9,z:o.z});});
  sols.forEach(s=>{if(s.owner!==me.id&&!inCave)cand.push({x:s.x,y:terrainH(s.x,s.z)+0.9,z:s.z});});
  for(const c of cand){
    const dx=c.x-pos.x,dz=c.z-pos.z,dy=c.y-(pos.y+1.0),dh=Math.hypot(dx,dz),d=Math.hypot(dh,dy);
    if(d<1.5||d>75||dh<0.01)continue;
    const dot=(dx*f.x+dz*f.z)/dh;
    if(dot>0.95&&d<bd){bd=d;lock={x:c.x,y:c.y,z:c.z,d,dx:dx/dh,dz:dz/dh,dy:dy/d};}
  }
  if(lock){ax=lock.dx;az=lock.dz;ay=clamp(lock.dy,-0.9,0.9);}
  return {x:ax,y:ay,z:az,lock};
}
function enterAim(i){
  sfx.aim();aiming=i;const el=document.querySelector('.slot[data-i="'+i+'"]');
  document.querySelectorAll('.slot').forEach(x=>x.classList.remove('aiming'));el.classList.add('aiming');
  $('aimbar').classList.add('show');toast('Bidik dulu: geser kamera, lalu Tembak',1.8);sfx.plop();
}
function cancelAim(){aiming=-1;document.querySelectorAll('.slot').forEach(x=>x.classList.remove('aiming'));$('aimbar').classList.remove('show');aimRet.visible=false;aimLine.visible=false;}
function fireAim(){
  if(aiming<0)return;const i=aiming,s=slots[i];
  if(!s||slotCd[i]>0||!started||dead||modalOpen||bookOpen||stunT>0||fade){cancelAim();return;}
  const v=aimVec(),hl=Math.hypot(v.x,v.z)||1;
  faceX=v.x/hl;faceZ=v.z/hl;
  if(guarding)setGuard(false);if(sleeping)wakeUp();
  slotCd[i]=slotCdMax[i]=s.cd;attackT=Math.max(attackT,0.32);
  if(v.lock)sfx.lock();
  netSend({t:'cast',slot:i,fx:+v.x.toFixed(3),fy:+v.y.toFixed(3),fz:+v.z.toFixed(3)});
  cancelAim();
}
function updAim(){
  if(aiming<0){return;}
  if(dead||stunT>0||modalOpen||bookOpen||fade||!slots[aiming]){cancelAim();return;}
  const v=aimVec(),hl=Math.hypot(v.x,v.z)||1;
  faceX=v.x/hl;faceZ=v.z/hl;
  const s=slots[aiming],col=v.lock?'#ff5d5d':s.color,L=v.lock?v.lock.d:20;
  const dx=v.x/hl*Math.sqrt(Math.max(0.0001,1-v.y*v.y)),dz=v.z/hl*Math.sqrt(Math.max(0.0001,1-v.y*v.y));
  _v2.set(dx,v.y,dz).normalize();
  aimLine.visible=true;aimLine.position.set(pos.x,pos.y+1.0,pos.z);aimLine.quaternion.setFromUnitVectors(_v1,_v2);aimLine.scale.x=L;aimLine.material.color.set(col);aimLine.material.opacity=0.4+0.2*Math.sin(tAll*10);
  aimRet.visible=true;aimRet.position.set(pos.x+_v2.x*L,pos.y+1.0+_v2.y*L,pos.z+_v2.z*L);aimRet.material.color.set(col);const rs=v.lock?2.2+0.3*Math.sin(tAll*12):1.4;aimRet.scale.set(rs,rs,1);
}

/* ---------- chat ---------- */
let chatOpen=false,chatUnread=0;
function addChatLine(m,live){
  const d=document.createElement('div');const b=document.createElement('b');b.textContent=m.name+': ';const sp=document.createElement('span');sp.textContent=m.text;d.appendChild(b);d.appendChild(sp);
  const lst=$('chatList');lst.appendChild(d);while(lst.children.length>80)lst.removeChild(lst.firstChild);lst.scrollTop=lst.scrollHeight;
  if(live){
    const f=document.createElement('div');f.innerHTML=d.innerHTML;$('chatFeed').appendChild(f);while($('chatFeed').children.length>5)$('chatFeed').removeChild($('chatFeed').firstChild);setTimeout(()=>{if(f.parentNode)f.parentNode.removeChild(f);},9000);
    if(!chatOpen){chatUnread++;$('chatBadge').textContent=chatUnread>9?'9+':chatUnread;$('chatBadge').style.display='block';}
  }
}
function openChat(){if(!started||modalOpen||bookOpen||chatOpen)return;chatOpen=true;chatUnread=0;$('chatBadge').style.display='none';$('chatPanel').classList.add('show');keys.clear();jumpBtnHeld=false;diveBtnHeld=false;setGuard(false);setTimeout(()=>$('chatIn').focus(),30);$('chatList').scrollTop=$('chatList').scrollHeight;}
function closeChat(){chatOpen=false;$('chatPanel').classList.remove('show');$('chatIn').blur();canvas.focus();}
$('chatBtn').addEventListener('click',()=>{if(chatOpen)closeChat();else openChat();});
$('chatBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('chatForm').addEventListener('submit',e=>{e.preventDefault();const t=$('chatIn').value.trim();if(t)netSend({t:'chat',text:t});sfx.click();$('chatIn').value='';});
$('chatIn').addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')closeChat();});
$('chatIn').addEventListener('keyup',e=>e.stopPropagation());

/* ---------- suara (WebRTC mesh lewat server) ---------- */
const peers=new Map();let localStream=null,micOn=false,spkOn=true;
const RTC_CFG={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
function voiceEnabled(){return !!(roomInfo&&roomInfo.voice)&&typeof RTCPeerConnection!=='undefined';}
function ensurePeer(id){
  if(!voiceEnabled())return null;
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection(RTC_CFG),el=new Audio();el.autoplay=true;el.playsInline=true;el.muted=!spkOn;
  const peer={id,pc,el,polite:me.id>id,making:false,ignore:false,snd:null};peers.set(id,peer);
  pc.onicecandidate=e=>{if(e.candidate)netSend({t:'rtc',to:id,d:{c:e.candidate}});};
  pc.ontrack=e=>{el.srcObject=e.streams[0]||new MediaStream([e.track]);el.muted=!spkOn;const pr=el.play();if(pr&&pr.catch)pr.catch(()=>{});};
  pc.onnegotiationneeded=async()=>{try{peer.making=true;await pc.setLocalDescription();netSend({t:'rtc',to:id,d:{sdp:pc.localDescription}});}catch(e){}finally{peer.making=false;}};
  const tr=pc.addTransceiver('audio',{direction:'sendrecv'});peer.snd=tr.sender;
  if(localStream&&micOn)tr.sender.replaceTrack(localStream.getAudioTracks()[0]).catch(()=>{});
  return peer;
}
async function onRtc(from,d){
  const peer=ensurePeer(from);if(!peer)return;const pc=peer.pc;
  try{
    if(d.sdp){
      const collision=d.sdp.type==='offer'&&(peer.making||pc.signalingState!=='stable');
      peer.ignore=!peer.polite&&collision;if(peer.ignore)return;
      await pc.setRemoteDescription(d.sdp);
      if(d.sdp.type==='offer'){await pc.setLocalDescription();netSend({t:'rtc',to:from,d:{sdp:pc.localDescription}});}
    }else if(d.c){try{await pc.addIceCandidate(d.c);}catch(e){if(!peer.ignore)throw e;}}
  }catch(e){}
}
function closePeer(id){const p=peers.get(id);if(!p)return;try{p.pc.close();}catch(e){}p.el.srcObject=null;peers.delete(id);}
function closeAllPeers(){[...peers.keys()].forEach(closePeer);}
function setMicUI(){const b=$('micBtn');b.innerHTML=svg(micOn?'mic':'micoff');b.classList.toggle('active',micOn);}
function setSpkUI(){const b=$('spkBtn');b.innerHTML=svg(spkOn?'spk':'spkoff');b.classList.toggle('active',spkOn);peers.forEach(p=>{p.el.muted=!spkOn;});}
async function toggleMic(){
  if(!voiceEnabled())return;
  sfx.mic(!micOn);
  if(micOn){micOn=false;if(localStream)localStream.getAudioTracks().forEach(t=>{t.enabled=false;});peers.forEach(p=>{if(p.snd)p.snd.replaceTrack(null).catch(()=>{});});setMicUI();toast('Mikrofon mati',1.2);return;}
  try{
    if(!localStream)localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    const tk=localStream.getAudioTracks()[0];tk.enabled=true;micOn=true;
    peers.forEach(p=>{if(p.snd)p.snd.replaceTrack(tk).catch(()=>{});});setMicUI();toast('Mikrofon nyala, kamu bisa bicara',1.6);
  }catch(e){toast('Mikrofon tidak bisa dipakai (izinkan mikrofon, butuh HTTPS)',3);}
}
$('micBtn').addEventListener('click',toggleMic);
$('spkBtn').addEventListener('click',()=>{spkOn=!spkOn;setSpkUI();toast(spkOn?'Suara room nyala':'Suara room dimatikan',1.2);});
$('micBtn').addEventListener('pointerdown',e=>e.stopPropagation());$('spkBtn').addEventListener('pointerdown',e=>e.stopPropagation());

/* ---------- kamera FPS ---------- */
function setFps(on){
  fps=!!on;$('camBtn').classList.toggle('active',fps);$('xhair').classList.toggle('show',fps&&started);
  toast(fps?'Kamera FPS (tekan C untuk kembali)':'Kamera orang ketiga',1.4);
}
$('camBtn').addEventListener('click',()=>setFps(!fps));$('camBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('aimFire').addEventListener('click',fireAim);$('aimCancel').addEventListener('click',cancelAim);
$('aimFire').addEventListener('pointerdown',e=>e.stopPropagation());$('aimCancel').addEventListener('pointerdown',e=>e.stopPropagation());
let capState=null;
function onCap(m){
  const f=forts[m.fort];if(!f)return;
  if(m.cancel){if(capState&&capState.fort===m.fort){capState=null;$('capBox').classList.remove('show');toast('Perebutan benteng gagal',1.6);}f.capBy=0;return;}
  f.capBy=m.by;
  if(m.by===me.id){capState={fort:m.fort,end:performance.now()+m.ms,ms:m.ms};$('capBox').classList.add('show');$('capTxt').textContent='Merebut '+f.name+'...';}
  else toast(m.name+' sedang merebut '+f.name,2);
  sfxAt('horn',f.x,f.z);
}

/* ---------- remote players ---------- */
function makeLabel(){
  const cv=document.createElement('canvas');cv.width=192;cv.height=44;const tex=new THREE.CanvasTexture(cv);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));sp.scale.set(2.4,0.55,1);sp.renderOrder=20;scene.add(sp);return {cv,tex,sp};
}
function drawLabel(o){
  const c=o.lab.cv.getContext('2d');c.clearRect(0,0,192,44);
  c.font='bold 22px sans-serif';c.textAlign='center';c.textBaseline='middle';
  let fs=22;while(c.measureText(o.name).width>180&&fs>12){fs--;c.font='bold '+fs+'px sans-serif';}
  c.lineWidth=5;c.strokeStyle='rgba(20,20,40,.85)';c.strokeText(o.name,96,13);c.fillStyle='#fff';c.fillText(o.name,96,13);
  c.fillStyle='#2b2233';c.fillRect(26,28,140,11);c.fillStyle='#5a1f26';c.fillRect(28,30,136,7);
  c.fillStyle=o.shieldT>0?'#6cd4ff':(o.hp>35?'#4de27a':'#ff5d5d');c.fillRect(28,30,Math.round(136*clamp(o.hp/MAXHP,0,1)),7);
  o.lab.tex.needsUpdate=true;
}
const shieldTex=radialTex([[0,'rgba(120,210,255,.05)'],[0.7,'rgba(120,210,255,.25)'],[0.92,'rgba(190,240,255,.8)'],[1,'rgba(190,240,255,0)']]);
function makeShield(){const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:shieldTex,transparent:true,depthWrite:false,fog:false,blending:THREE.AdditiveBlending}));sp.scale.set(3.4,3.4,1);sp.visible=false;scene.add(sp);return sp;}
const myShield=makeShield();
function addOther(info){
  if(others.has(info.id))removeOther(info.id);
  const tex=cloneTex(info.ch);
  const m=new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(spriteGeo,m);mesh.rotation.order='YXZ';scene.add(mesh);
  const sh=new THREE.Mesh(aShGeo,aShMat);scene.add(sh);
  const o={id:info.id,name:info.name,ch:info.ch,hp:info.hp==null?MAXHP:info.hp,k:info.k||0,d:info.d||0,dead:!!info.dead,
    x:info.x||0,y:info.y||0,z:info.z||0,tx:info.x||0,ty:info.y||0,tz:info.z||0,fx:0,fz:1,m:0,a:0,sw:0,
    mesh,tex,mat:m,sh,lab:makeLabel(),shield:makeShield(),shieldT:0,ride:false,sleep:!!info.sl,mount:null,guard:false,gsp:null,stunT:0,regenT:0,hasteT:0,viewK:0,wt:Math.random()*4,atkT:0,flash:0};
  drawLabel(o);others.set(o.id,o);return o;
}
function removeOther(id){
  const o=others.get(id);if(!o)return;
  scene.remove(o.mesh);scene.remove(o.sh);scene.remove(o.lab.sp);scene.remove(o.shield);if(o.gsp)scene.remove(o.gsp);if(o.mount)mountDrop(o.mount);
  o.mat.dispose();o.tex.dispose();o.lab.sp.material.dispose();o.lab.tex.dispose();o.shield.material.dispose();
  others.delete(id);
}
function updOthers(dt,rgt,fwd){
  const k=damp(13,dt);
  for(const o of others.values()){
    o.x+=(o.tx-o.x)*k;o.y+=(o.ty-o.y)*k;o.z+=(o.tz-o.z)*k;
    if(o.shieldT>0){o.shieldT-=dt;if(o.shieldT<=0)drawLabel(o);}
    o.flash=Math.max(0,o.flash-dt);o.atkT=Math.max(0,o.atkT-dt);if(o.stunT>0)o.stunT-=dt;if(o.regenT>0)o.regenT-=dt;if(o.hasteT>0)o.hasteT-=dt;
    const dp=Math.hypot(o.x-pos.x,o.z-pos.z);
    if(o.pa===undefined){o.pa=o.a;o.psw=o.sw;o.snT=rnd(1,3);}
    if(o.a===1&&o.pa!==1&&!o.sw)sfxAt('jump',o.x,o.z);
    if(o.pa>0&&o.a===0&&!o.sw&&!o.dead)sfxAt('land',o.x,o.z,6);
    if(o.sw>0&&o.psw===0)sfxAt('splash',o.x,o.z);
    if(o.sw>0&&o.m>0){o.stT=(o.stT||0)-dt;if(o.stT<=0){o.stT=0.6;sfxAt('stroke',o.x,o.z);}}
    if(o.sleep&&!o.dead){o.snT-=dt;if(o.snT<=0){o.snT=rnd(3,5);sfxAt('sleep',o.x,o.z);}}
    o.pa=o.a;o.psw=o.sw;
    o.viewK=pickView(o.fx,o.fz,rgt,fwd,o.viewK);
    let row=ROWMAP[o.viewK],col,flip=o.viewK>4;
    const wet=o.sw>0;
    if(o.dead){row=5;col=3;flip=false;}
    else if(o.sleep){row=5;col=6;flip=false;}
    else if(o.atkT>0){row=5;col=(0.32-o.atkT)<0.1?4:5;flip=(o.fx*rgt.x+o.fz*rgt.z)<0;}
    else if(o.ride)col=Math.floor(tAll/0.35+o.id)%2;
    else if(o.a>0&&!wet)col=o.a===1?6:7;
    else if(o.m>0){o.wt+=dt*(2.2+(o.m===2?10:6.5)*0.9);col=2+(Math.floor(o.wt)%4);{const sx2=Math.floor(o.wt)%2;if(sx2!==o.lastS&&!o.sw){o.lastS=sx2;sfxAt('step',o.x,o.z,(o.x>1000)?'stone':'grass');}}}
    else col=Math.floor(tAll/0.55+o.id)%2;
    setTexFrame(o.tex,col,row);
    const bob=wet?Math.sin(tAll*3+o.id)*0.06:0;
    const lift=o.ride?((o.mount&&(ROWMAP[o.mount.vk]===1||ROWMAP[o.mount.vk]===3))?1.2:0.8):0;
    o.mesh.position.set(o.x,o.y+bob+lift,o.z);
    if(o.ride&&!o.dead){if(!o.mount)o.mount=mountMake();o.mount.mesh.visible=true;mountPlace(o.mount,o.x,o.y,o.z,o.fx,o.fz,rgt,fwd,o.id);}else if(o.mount)o.mount.mesh.visible=false;o.mesh.rotation.y=cam.yaw;o.mesh.rotation.x=-cam.pitch*0.55;
    o.mesh.scale.set(flip?-1:1,1,1);
    o.mat.color.setHex(o.flash>0?0xff7a7a:(o.stunT>0?0xaee6ff:0xffffff));
    const gy=groundAt(o.x,o.z,o.y-0.5);
    o.sh.position.set(o.x,Math.max(gy,wet?WATER_Y:-99)+0.07,o.z);o.sh.scale.setScalar(clamp(1-(o.y-gy)*0.1,0.35,1)*1.25);
    const vis=dp<110;
    o.mesh.visible=o.sh.visible=vis;
    o.lab.sp.visible=vis&&!o.dead&&dp<60;o.lab.sp.position.set(o.x,o.y+2.35+bob+lift,o.z);
    if(o.guard&&!o.dead){if(!o.gsp)o.gsp=makeShield3D(o.ch);o.gsp.visible=vis;placeShield(o.gsp,o.x,o.y+bob,o.z,o.fx,o.fz,tAll);}else if(o.gsp)o.gsp.visible=false;
    if(vis&&o.sleep&&!o.dead&&Math.random()<dt*1.1)emit(o.x,o.y+1.1,o.z,0.25,0.6,0,1.8,0.8,'#d9ecff',0,0.95,0.5,zTex);
    if(vis&&!o.dead&&Math.random()<dt*9){if(o.regenT>0)emit(o.x+(Math.random()-0.5)*1.2,o.y+0.3,o.z+(Math.random()-0.5)*1.2,0,1.4,0,0.9,0.4,'#7dffae',0,0.9,0.2);if(o.hasteT>0)emit(o.x,o.y+0.8,o.z,-o.fx*2,0.3,-o.fz*2,0.4,0.6,'#fff27a',0,0.8,0.5);if(o.stunT>0)emit(o.x+Math.cos(tAll*8)*0.5,o.y+2.0,o.z+Math.sin(tAll*8)*0.5,0,0,0,0.5,0.3,'#fff6a0',0,1,0);}
    o.shield.visible=vis&&o.shieldT>0&&!o.dead;if(o.shield.visible){o.shield.position.set(o.x,o.y+0.95,o.z);const sc=3.2+Math.sin(tAll*8)*0.15;o.shield.scale.set(sc,sc,1);}
    if(wet&&o.m>0&&Math.random()<dt*8&&o.y>WATER_Y-2)emit(o.x+(Math.random()-0.5),WATER_Y+0.05,o.z+(Math.random()-0.5),0,0.2,0,0.6,0.45,'#dff3ff',0,0.55,2);
  }
}
/* projectiles */
function addProj(m){
  const g=new THREE.Group();
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:m.c,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false,opacity:0.9}));glow.scale.setScalar(1.8*(m.sz||1));g.add(glow);
  const core=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xffffff,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false}));core.scale.setScalar(0.8*(m.sz||1));g.add(core);
  g.position.set(m.x,m.y,m.z);scene.add(g);
  projs.push({sm:m.sz===0.55,id:m.id,g,x:m.x,y:m.y,z:m.z,dx:m.dx,dy:m.dy||0,dz:m.dz,sp:m.sp,life:m.life,c:m.c,tr:0});
}
function removeProj(id,hit){
  const i=projs.findIndex(p=>p.id===id);if(i<0)return;
  const p=projs[i];if(hit)burst(hit.x,hit.y,hit.z,p.c,12,5);
  scene.remove(p.g);p.g.children.forEach(c=>c.material.dispose());projs.splice(i,1);
}
function updProjs(dt){
  for(let i=projs.length-1;i>=0;i--){
    const p=projs[i];p.life-=dt;
    if(p.life<=0){scene.remove(p.g);p.g.children.forEach(c=>c.material.dispose());projs.splice(i,1);continue;}
    p.x+=p.dx*p.sp*dt;p.y+=p.dy*p.sp*dt;p.z+=p.dz*p.sp*dt;p.g.position.set(p.x,p.y,p.z);
    p.tr-=dt;if(p.tr<=0){p.tr=0.025;emit(p.x,p.y,p.z,(Math.random()-0.5)*0.6,(Math.random()-0.5)*0.6,(Math.random()-0.5)*0.6,0.35,0.5,p.c,0,0.7,-0.6);}
  }
}

/* ---------- network ---------- */
function addBoardRow(){}
function renderBoard(){
  const rows=[{id:me.id,name:me.name,k:me.k,d:me.d,me:true}].concat([...others.values()].map(o=>({id:o.id,name:o.name,k:o.k,d:o.d})));
  rows.sort((a,b)=>b.k-a.k||a.d-b.d);
  const bd=$('board');bd.innerHTML='<h4>PAPAN SKOR</h4>';
  rows.forEach((r,i)=>{const d=document.createElement('div');if(r.me)d.className='me';const b=document.createElement('b');b.textContent=(i+1)+'. '+r.name;const s=document.createElement('span');s.innerHTML=kdHtml(r.k,r.d);d.appendChild(b);d.appendChild(s);bd.appendChild(d);});
  $('kd').innerHTML=kdHtml(me.k,me.d);
  $('roomTag').textContent=(roomInfo.name||'Room')+' '+rows.length+'/'+(roomInfo.max||'?');
}
let roomInfo={name:'',max:0};
function setHp(v){me.hp=clamp(v,0,MAXHP);$('hpFill').style.width=(me.hp/MAXHP*100)+'%';$('hpFill').style.background=me.hp>35?'':'linear-gradient(#ff8080,#d63a3a)';}
function applyDoor(i,open,silent){const d=doors[i];if(!d)return;if(d.open===open)return;d.open=open;d.target=open?1.65:0;if(!silent)sfxAt(open?'doorOpen':'doorClose',d.wx,d.wz);}
function onMsg(m){
  switch(m.t){
    case 'welcome':{
      me.id=m.id;roomInfo=m.room;hourBase=m.hour;hourAt=performance.now();
      setHp(m.hp==null?MAXHP:m.hp);me.k=0;me.d=0;
      {const f=findFree(m.spawn.x,m.spawn.z);pos.set(f.x,0,f.z);}vel.set(0,0,0);vy=0;grounded=true;cam.tx=pos.x;cam.tz=pos.z;cam.ty=0;
      chestOpen=!!m.chest;if(chest){chest.open=chestOpen;chest.target=chest.ang=chestOpen?1.25:0;}ammo=0;sleeping=false;$('night').style.opacity=0;fade=null;$('fade').style.opacity=0;
      cam.yaw=cam.yawT=0;
      others.forEach((o,id)=>removeOther(id));mobs.forEach((_,id)=>removeMob(id,true));traps.forEach((_,id)=>removeTrap(id));
      bookEnabled=!!m.book;$('bookBtn').classList.toggle('off',!bookEnabled);
      m.players.forEach(p=>{if(p.id!==me.id)addOther(p);});
      m.doors.forEach((o,i)=>applyDoor(i,!!o,true));
      forts.forEach(f=>setFortState({id:f.id,owner:0,name:'',ch:0}));(m.forts||[]).forEach(setFortState);
      sols.forEach((_,id)=>removeSol(id));orbs.forEach((_,id)=>removeOrb(id,true));(m.sols||[]).forEach(addSol);
      $('chatList').innerHTML='';(m.chat||[]).forEach(c=>addChatLine(c,false));
      closeAllPeers();{const vo=voiceEnabled();document.querySelectorAll('.vo').forEach(b=>b.classList.toggle('off',!vo));micOn=false;spkOn=true;setMicUI();setSpkUI();if(vo)m.players.forEach(pl=>{if(pl.id!==me.id)ensurePeer(pl.id);});}
      joined=true;started=true;
      document.body.classList.add('playing');$('start').classList.add('hide');canvas.focus();
      playerRoot.visible=true;pShadow.visible=true;
      toast('Siapkan teknikmu! Tekan ＋ di kanan untuk menulis kode',3.4);
      renderBoard();break;}
    case 'err':{$('ferr').textContent=m.msg;$('go').disabled=false;if(joined)toast(m.msg,2.5);break;}
    case 'pj':{if(m.p.id!==me.id){addOther(m.p);ensurePeer(m.p.id);feed('➕ '+m.p.name+' bergabung');renderBoard();}break;}
    case 'pl':{closePeer(m.id);const o=others.get(m.id);if(o){feed('➖ '+o.name+' keluar');removeOther(m.id);renderBoard();}break;}
    case 'sc':{m.s.forEach(r=>{if(r[0]===me.id){me.k=r[1];me.d=r[2];}else{const o=others.get(r[0]);if(o){o.k=r[1];o.d=r[2];}}});renderBoard();break;}
    case 'ps':{
      m.p.forEach(r=>{const o=others.get(r[0]);if(!o)return;
        o.tx=r[1];o.ty=r[2];o.tz=r[3];
        if(Math.hypot(r[4],r[5])>0.1){o.fx=r[4];o.fz=r[5];}
        o.m=r[6];o.a=r[7];o.sw=r[8];
        if(o.fresh===undefined){o.x=o.tx;o.y=o.ty;o.z=o.tz;o.fresh=false;}
      });break;}
    case 'atk':{const o=others.get(m.id);if(o){o.atkT=0.32;o.fx=m.fx;o.fz=m.fz;sfxAt('swing',o.x,o.z);}break;}
    case 'door':applyDoor(m.i,!!m.open);break;
    case 'learned':{
      const i=m.slot;slots[i]=m.tech;slotCd[i]=0;slotCdMax[i]=m.tech.cd;updSlotUI(i);pendingLearn=false;closeModal();sfx.learn();toast(m.tech.emoji+' '+m.tech.name+' siap dipakai!',2);break;}
    case 'learnerr':modalErr(m.msg||'Kode salah');break;
    case 'slotclear':{slots[m.slot]=null;updSlotUI(m.slot);toast('Teknik itu sudah tidak tersedia',2);break;}
    case 'pr':addProj(m);if(m.sz===0.55)sfxAt('twang',m.x,m.z);else sfxAt('zap',m.x,m.z);break;
    case 'px':{const pj=projs.find(q=>q.id===m.id);if(pj&&pj.sm)sfxAt('arrowHit',m.x,m.z);removeProj(m.id,m);break;}
    case 'fx':onFx(m);break;
    case 'hit':onHit(m);break;
    case 'hp':{if(m.id===me.id)setHp(m.hp);else{const o=others.get(m.id);if(o){o.hp=m.hp;drawLabel(o);}}break;}
    case 'die':onDie(m);break;
    case 'resp':{
      if(m.id===me.id){dead=false;$('ko').style.display='none';setHp(MAXHP);{const f=findFree(m.x,m.z);pos.set(f.x,0,f.z);}vel.set(0,0,0);kb.x=kb.z=0;vy=0;grounded=true;cam.tx=pos.x;cam.tz=pos.z;invuln=2;stunT=0;gbT=0;myRegenT=0;hasteT=0;sfx.respawn();toast('Kembali bertarung!',1.6);}
      else{const o=others.get(m.id);if(o){o.dead=false;o.hp=MAXHP;o.tx=o.x=m.x;o.tz=o.z=m.z;o.ty=o.y=0;drawLabel(o);}}break;}
    case 'guard':{if(m.id===me.id){guarding=!!m.on;$('btnGuard').classList.toggle('on',!!m.on);}else{const o=others.get(m.id);if(o){o.guard=!!m.on;if(m.on)sfxAt('shield',o.x,o.z);}}break;}
    case 'gbreak':{if(m.id===me.id){gbT=2.5;guarding=false;$('btnGuard').classList.remove('on');toast('Tameng pecah! 💥',1.6);sfx.gbreak();shake=Math.max(shake,0.3);}else{const o=others.get(m.id);if(o){o.guard=false;floatText(o.x,o.y+2.4,o.z,'PECAH!','#ffb84d');sfxAt('gbreak',o.x,o.z);}}break;}
    case 'stun':{if(m.id===me.id){stunT=m.ms/1000;setGuard(false);toast('Kamu membeku! ❄️',1.4);}else{const o=others.get(m.id);if(o)o.stunT=m.ms/1000;}break;}
    case 'mob':addMob(m);break;
    case 'mobx':{const o=mobs.get(m.id);if(o&&m.dead){floatText(o.x,o.y+1.2,o.z,'KO','#ffd84d');sfxAt('soldierDie',o.x,o.z);}removeMob(m.id);break;}
    case 'mh':{const o=mobs.get(m.id);if(o){o.hp=m.hp;o.flash=0.2;floatText(o.x,o.y+1.4,o.z,'-'+m.dmg,'#ffd84d');sfxAt('hit',o.x,o.z);burst(o.x,o.y,o.z,'#ffe9c0',6,3);}break;}
    case 'ms':m.m.forEach(r=>{const o=mobs.get(r[0]);if(!o)return;o.tx=r[1];o.ty=r[2];o.tz=r[3];o.fx=r[4];o.fz=r[5];if(r[6])o.atkT=0.3;});break;
    case 'trap':addTrap(m);break;
    case 'trapx':removeTrap(m.id,m.quiet?null:m);break;
    case 'sleep':{if(m.id===me.id){if(!m.on&&sleeping)wakeUp(true);}else{const o=others.get(m.id);if(o)o.sleep=!!m.on;}break;}
    case 'chest':{chestOpen=!!m.open;if(chest){chest.open=chestOpen;chest.target=chestOpen?1.25:0;}if(m.open)sfxAt('chestOpen',CX,CZ);break;}
    case 'wpn':{const had=ammo;ammo=m.ammo|0;if(ammo>0&&had===0)toast('Sniper didapat! Peluru '+ammo+' (tombol Sniper / H)',3.2);else if(ammo===0&&had>0)toast('Peluru sniper habis',1.8);break;}
    case 'toast':toast(m.msg,2.4);break;
    case 'fort':{setFortState(m.f);{const ff=forts[m.f.id];if(ff&&m.f.owner)sfxAt('fanfare',ff.x,ff.z);}if(capState&&capState.fort===m.f.id){capState=null;$('capBox').classList.remove('show');}break;}
    case 'sol':addSol(m.s);break;
    case 'solx':{const o=sols.get(m.id);if(o&&m.dead)sfxAt('soldierDie',o.x,o.z);removeSol(m.id,!!m.dead);break;}
    case 'bshout':{const o=sols.get(m.id);if(o){sfxAt(Math.random()<0.3?'banditLaugh':'bandit',o.x,o.z);}break;}
    case 'bloot':{sfx.loot();toast('Penyamun kalah! +'+m.heal+' HP',1.6);break;}
    case 'ss':m.s.forEach(r=>{const o=sols.get(r[0]);if(!o)return;o.tx=r[1];o.tz=r[2];o.fx=r[3];o.fz=r[4];if(r[5]){o.atkT=0.3;if(o.kind==='archer')sfxAt('twang',o.x,o.z);else sfxAt(o.bandit?'swing':'swing',o.x,o.z);}});break;
    case 'sh':{const o=sols.get(m.id);if(o){o.hp=m.hp;o.flash=0.18;drawSolLabel(o);sfxAt(Math.random()<0.5?'clang':'hit',o.x,o.z);floatText(o.x,terrainH(o.x,o.z)+2.1,o.z,'-'+m.dmg,'#ffd84d');}break;}
    case 'cap':onCap(m);break;
    case 'orb':addOrb(m);break;
    case 'orbx':removeOrb(m.id);break;
    case 'chat':addChatLine(m,true);if(m.id!==me.id)sfx.pop();break;
    case 'rtc':onRtc(m.from,m.d);break;
    case 'closed':{ws.onclose=null;showDc('Room ditutup','Admin menutup room ini.');break;}
  }
}
function entPos(id){if(id===me.id)return {x:pos.x,y:pos.y,z:pos.z};const o=others.get(id);return o?{x:o.x,y:o.y,z:o.z}:null;}
function onFx(m){
  const p=entPos(m.id);if(!p)return;const near=Math.hypot(p.x-pos.x,p.z-pos.z)<45;
  const col=m.c||'#ffffff';
  if(m.k==='cast'){if(m.id!==me.id){const o=others.get(m.id);if(o){o.atkT=0.32;if(m.fx!=null){o.fx=m.fx;o.fz=m.fz;}}}burst(p.x,p.y+1.1,p.z,col,8,3);{const kk=m.kind;const mp={bolt:'zap',beam:'beam',summon:'eagle',ride:'eagle',orb:'orb',slam:'slam',dash:null,nova:null,heal:null,regen:null,shield:null,haste:null,trap:null};const nm=mp[kk];if(nm)sfxAt(nm,p.x,p.z);if(kk==='trap'&&m.id===me.id)sfx.trapset();}}
  else if(m.k==='nova'){ringFx(p.x,p.y+0.2,p.z,m.r,col);burst(p.x,p.y+0.8,p.z,col,22,7);sfxAt('boom',p.x,p.z);if(m.id===me.id)shake=Math.max(shake,0.3);}
  else if(m.k==='heal'){for(let i=0;i<14;i++)emit(p.x+(Math.random()-0.5)*1.2,p.y+0.2,p.z+(Math.random()-0.5)*1.2,0,1.5+Math.random()*2,0,1,0.45,i%2?'#7dffae':'#ffffff',0,0.9,0.2);floatText(p.x,p.y+2.2,p.z,'+'+(m.v||''),'#6dff96');sfxAt('heal',p.x,p.z);}
  else if(m.k==='shield'){if(m.id===me.id)myShieldT=m.dur;else{const o=others.get(m.id);if(o){o.shieldT=m.dur;drawLabel(o);}}burst(p.x,p.y+1,p.z,col,10,3);sfxAt('shield',p.x,p.z);}
  else if(m.k==='ride'){if(m.id===me.id){rideT=m.dur;ridePw=m.pw;setGuard(false);toast('Naik elang! Lompat = naik, Selam = turun \uD83E\uDD85',2.6);sfx.eagle();}else{const o=others.get(m.id);if(o)o.ride=true;sfxAt('eagle',p.x,p.z);}burst(p.x,p.y+1,p.z,col,14,4);}
  else if(m.k==='rideend'){if(m.id===me.id){rideT=0;}else{const o=others.get(m.id);if(o)o.ride=false;}}
  else if(m.k==='snipe'){beamFx(p.x,p.y+1.0,p.z,m.fx,m.fz,m.len,'#ffffff',0.07);burst(p.x+m.fx,p.y+1,p.z+m.fz,'#fff6a0',6,3);sfxAt('snipe',p.x,p.z);}
  else if(m.k==='beam'){beamFx(p.x,p.y+1.0,p.z,m.fx,m.fz,m.len,col);burst(p.x+m.fx,p.y+1,p.z+m.fz,col,8,4);sfxAt('beam',p.x,p.z);}
  else if(m.k==='leap'){if(m.id===me.id){vy=15.5;grounded=false;jumping=false;kb.x+=m.fx*9;kb.z+=m.fz*9;sq.y=1.3;sfx.jump();}burst(p.x,p.y+0.3,p.z,col,12,4);}
  else if(m.k==='regen'){if(m.id===me.id)myRegenT=m.dur;else{const o=others.get(m.id);if(o)o.regenT=m.dur;}sfxAt('regen',p.x,p.z);}
  else if(m.k==='haste'){if(m.id===me.id){hasteT=m.dur;hastePw=m.pw;}else{const o=others.get(m.id);if(o)o.hasteT=m.dur;}burst(p.x,p.y+0.8,p.z,col,10,3);sfxAt('haste',p.x,p.z);}
  else if(m.k==='dash'){
    if(m.id===me.id){kb.x+=m.fx*m.pw;kb.z+=m.fz*m.pw;invuln=Math.max(invuln,0.35);}
    for(let i=0;i<10;i++)emit(p.x-m.fx*i*0.35,p.y+0.9,p.z-m.fz*i*0.35,0,0.2,0,0.5,0.7,col,0,0.8,0.5);
    sfxAt('dash',p.x,p.z);}
}
function onHit(m){
  const v=entPos(m.id);if(!v)return;
  if(m.mnt){floatText(v.x,v.y+2.3,v.z,'-'+m.dmg,'#ffb84d');burst(v.x,v.y+0.6,v.z,'#ffe0b0',8,3);sfxAt('hit',v.x,v.z);if(m.id===me.id){hurtFlash=0.15;shake=Math.max(shake,0.15);toast('Elangmu diserang! Sisa '+m.mhp,1.2);}return;}
  if(m.blk){floatText(v.x,v.y+2.1,v.z,'TAHAN!','#9fe3ff');burst(v.x,v.y+1,v.z,'#bfe9ff',8,4);sfxAt('block',v.x,v.z);if(m.id===me.id){guardPips=m.left;guardPipT=3;shake=Math.max(shake,0.12);}return;}
  floatText(v.x,v.y+2.1,v.z,'-'+m.dmg,m.id===me.id?'#ff6a6a':'#ffd84d');
  burst(v.x,v.y+1,v.z,'#fff6a0',6,3);
  if(m.id===me.id){
    setHp(m.hp);hurtFlash=0.25;shake=Math.max(shake,0.35);sfx.hurt();$('hurt').style.opacity=1;setTimeout(()=>{$('hurt').style.opacity=0;},120);
    if(m.kx||m.kz){kb.x+=m.kx;kb.z+=m.kz;if(grounded&&!swimNow){vy=Math.max(vy,4);grounded=false;}}
    if(attackT>0&&m.dmg>0)attackT=0;
  }else{const o=others.get(m.id);if(o){o.hp=m.hp;o.flash=0.18;drawLabel(o);}sfxAt('hit',v.x,v.z);}
}
function onDie(m){
  feed('✖ '+m.name+(m.by&&m.by!==m.id?' dikalahkan '+m.byName:' kalah sendiri'));
  if(m.by===me.id&&m.id!==me.id)sfx.kill();
  if(m.id===me.id){dead=true;deadT=m.ms/1000;$('ko').style.display='flex';$('koTxt').textContent=m.by&&m.by!==m.id?'Dikalahkan oleh '+m.byName:'Kamu kalah';sfx.ko();attackT=0;rideT=0;if(sleeping){sleeping=false;$('night').style.opacity=0;}setHp(0);}
  else{const o=others.get(m.id);if(o){o.ride=false;o.dead=true;o.hp=0;drawLabel(o);burst(o.x,o.y+1,o.z,'#ffffff',16,5);}}
}
function showDc(t,p){$('dcT').textContent=t;$('dcP').textContent=p;$('dc').style.display='flex';}
function connect(){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(proto+'//'+location.host+'/ws');
  ws.onopen=()=>{netSend({t:'join',code:ROOM,name:me.name,ch:me.ch,uid:uid});};
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch(_){return;}onMsg(m);};
  ws.onclose=()=>{if(joined)showDc('Terputus','Koneksi ke server hilang.');else{$('ferr').textContent='Gagal terhubung ke server.';$('go').disabled=false;}};
  ws.onerror=()=>{};
}

/* ---------- start screen ---------- */
let uid=LS.get('dw_uid');if(!uid){uid=Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b=>b.toString(16).padStart(2,'0')).join('');LS.set('dw_uid',uid);}
const LORE='Ini adalah dunia digital yang dibuat menggunakan kode-kode bukan asli. Di dunia ini kamu bisa mengeluarkan dan membuat hal-hal yang telah ditetapkan di buku. Jadi kamu hafalkan dan praktekkan untuk beradaptasi dan menyerang lawan.';
let selChar=clamp(parseInt(LS.get('dw_char')||'0',10)||0,0,CHARS.length-1);
let loreTimer=null,loreI=0;
function showForm(){clearInterval(loreTimer);$('step1').style.display='none';$('form').style.display='block';LS.set('dw_lore','1');setTimeout(()=>{if(!$('nameIn').value)$('nameIn').focus();},50);}
function typeLore(){
  loreI=0;$('lore').textContent='';
  loreTimer=setInterval(()=>{loreI+=2;$('lore').textContent=LORE.slice(0,loreI);if(loreI>=LORE.length)clearInterval(loreTimer);},28);
}
$('lore').addEventListener('click',()=>{clearInterval(loreTimer);$('lore').textContent=LORE;});
$('loreGo').addEventListener('click',()=>{initAudio();if(loreI<LORE.length){clearInterval(loreTimer);loreI=LORE.length;$('lore').textContent=LORE;$('loreGo').textContent='Lanjut ▶';return;}showForm();});
function buildChars(){
  const box=$('chars');box.innerHTML='';
  CHARS.forEach((c,i)=>{
    const b=document.createElement('button');b.className='chr'+(i===selChar?' sel':'');
    const cv=document.createElement('canvas');cv.width=CW;cv.height=CH;
    cv.getContext('2d').drawImage(sheetFor(i).cv,0,CH,CW,CH,0,0,CW,CH);
    const s=document.createElement('span');s.textContent=c.name;
    b.appendChild(cv);b.appendChild(s);
    b.addEventListener('click',()=>{selChar=i;LS.set('dw_char',String(i));box.querySelectorAll('.chr').forEach((x,j)=>x.classList.toggle('sel',j===i));});
    box.appendChild(b);
  });
}
buildChars();
$('nameIn').value=LS.get('dw_name')||'';
$('nameIn').addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')$('go').click();});
$('nameIn').addEventListener('keyup',e=>e.stopPropagation());
let roomOk=false;
fetch('/api/room/'+encodeURIComponent(ROOM)).then(r=>r.ok?r.json():Promise.reject()).then(j=>{
  roomOk=true;roomInfo=j;$('roomInfo').textContent='Room: '+j.name+' ('+j.count+'/'+j.max+' pemain)';
}).catch(()=>{$('roomInfo').textContent='Room tidak ditemukan. Minta link baru ke admin.';$('roomInfo').style.color='#ff8a8a';$('go').disabled=true;});
$('go').addEventListener('click',()=>{
  initAudio();
  const nm=$('nameIn').value.replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,14);
  if(!nm){$('ferr').textContent='Tulis namamu dulu';return;}
  if(!roomOk){$('ferr').textContent='Room tidak valid';return;}
  LS.set('dw_name',nm);LS.set('dw_char',String(selChar));
  me.name=nm;me.ch=selChar;$('myName').textContent=nm;setMyChar(selChar);
  $('ferr').textContent='';$('go').disabled=true;connect();
});
if(LS.get('dw_lore')==='1'&&LS.get('dw_name')){showForm();}else typeLore();

/* ---------- resize ---------- */
function resize(){
  const w=innerWidth,h=innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;
  cam.baseFov=w/h<1.3?Math.min(78,50+(1.3-w/h)*34):50;camera.updateProjectionMatrix();
}
window.addEventListener('resize',resize);resize();

/* ---------- day / night ---------- */
const mkK=(h,top,mid,bot,fog,hi,hc,hg,si,sc,nf)=>({h,top:new THREE.Color(top),mid:new THREE.Color(mid),bot:new THREE.Color(bot),fog:new THREE.Color(fog),hi,hc:new THREE.Color(hc),hg:new THREE.Color(hg),si,sc:new THREE.Color(sc),nf});
const KN=['#0a1030','#1a2a5a','#2b3f78','#1c2850',0.62,'#9fb4ff','#2c3652',0.38,'#a8bcff',1];
const KD=['#4f9fe0','#9fd3f0','#cfe9f4','#cfe9f4',0.7,'#dff1ff','#7a9a62',0.6,'#fff0d0',0];
const KEYS=[mkK(0,...KN),mkK(5,...KN),mkK(6.5,'#3b4f8c','#e89a7a','#f7cf9a','#e6b79a',0.55,'#ffd9b8','#7a6a62',0.35,'#ffb27a',0.5),mkK(8,...KD),mkK(16,...KD),
  mkK(17.5,'#5c86c8','#f0b68a','#f7d8a0','#efc9a0',0.6,'#ffe3c0','#8a7a5a',0.5,'#ffb870',0.1),mkK(19,'#1e2a5a','#c0607a','#f09a7a','#b87a82',0.4,'#c9a0b8','#4a3a4a',0.2,'#ff9a8a',0.6),mkK(20.5,...KN),mkK(24,...KN)];
const envC={top:new THREE.Color(),mid:new THREE.Color(),bot:new THREE.Color(),fog:new THREE.Color(),hc:new THREE.Color(),hg:new THREE.Color(),sc:new THREE.Color(),hi:0.7,si:0.6,nf:0};
function sampleEnv(h){
  let i=0;while(i<KEYS.length-2&&h>=KEYS[i+1].h)i++;
  const a=KEYS[i],b=KEYS[i+1],t=clamp((h-a.h)/(b.h-a.h),0,1);
  envC.top.copy(a.top).lerp(b.top,t);envC.mid.copy(a.mid).lerp(b.mid,t);envC.bot.copy(a.bot).lerp(b.bot,t);envC.fog.copy(a.fog).lerp(b.fog,t);
  envC.hc.copy(a.hc).lerp(b.hc,t);envC.hg.copy(a.hg).lerp(b.hg,t);envC.sc.copy(a.sc).lerp(b.sc,t);
  envC.hi=lerp(a.hi,b.hi,t);envC.si=lerp(a.si,b.si,t);envC.nf=lerp(a.nf,b.nf,t);
}
paintSky(KEYS[3].top,KEYS[3].mid,KEYS[3].bot);
const starPos=new Float32Array(500*3);
for(let i=0;i<500;i++){const u=rand()*6.283,v=Math.acos(rand()*0.95+0.05);starPos[i*3]=Math.sin(v)*Math.cos(u)*250;starPos[i*3+1]=Math.cos(v)*250;starPos[i*3+2]=Math.sin(v)*Math.sin(u)*250;}
const starGeo=new THREE.BufferGeometry();starGeo.setAttribute('position',new THREE.BufferAttribute(starPos,3));
const stars=new THREE.Points(starGeo,new THREE.PointsMaterial({color:0xffffff,size:2,sizeAttenuation:false,transparent:true,opacity:0,depthWrite:false,fog:false}));stars.frustumCulled=false;scene.add(stars);
const sunSp=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xfff0b0,transparent:true,depthWrite:false,fog:false,blending:THREE.AdditiveBlending}));sunSp.scale.set(70,70,1);scene.add(sunSp);
const moonSp=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xdfe8ff,transparent:true,depthWrite:false,fog:false,blending:THREE.AdditiveBlending}));moonSp.scale.set(34,34,1);scene.add(moonSp);
const caveBg=new THREE.Color(0x0a0c18);
const winDay=new THREE.Color(0xa9dcf5),winNight=new THREE.Color(0xffd27a),uwBg=new THREE.Color(0x14507f);
let skyT=0,gameHour=9,underwater=false;
function applyEnv(dt){
  if(inCave){scene.background=caveBg;scene.fog.color.copy(caveBg);scene.fog.near=10;scene.fog.far=58;hemi.color.setHex(0x9ab0ff);hemi.groundColor.setHex(0x2a2438);hemi.intensity=0.55;sun.color.setHex(0x8fb0ff);sun.intensity=0.3;sun.position.set(-20,60,20);stars.visible=sunSp.visible=moonSp.visible=false;return;}
  stars.visible=true;
  sampleEnv(gameHour);
  skyT-=dt;if(skyT<=0){skyT=0.25;paintSky(envC.top,envC.mid,envC.bot);}
  if(underwater){scene.background=uwBg;scene.fog.color.copy(uwBg);scene.fog.near=1;scene.fog.far=26;}
  else{scene.background=skyTex;scene.fog.color.copy(envC.fog);scene.fog.near=50;scene.fog.far=175;}
  hemi.color.copy(envC.hc);hemi.groundColor.copy(envC.hg);hemi.intensity=envC.hi;sun.color.copy(envC.sc);sun.intensity=envC.si;
  const a=(gameHour-6)/12*Math.PI,sa=Math.sin(a);
  sun.position.set(-Math.cos(a)*60,Math.max(22,sa*70+12),30);
  stars.position.copy(camera.position);stars.material.opacity=clamp(envC.nf*1.2-0.1,0,1);
  const dx=-Math.cos(a)*0.9,dy=sa,dz=-0.45,l=Math.hypot(dx,dy,dz);
  sunSp.visible=sa>-0.15;sunSp.material.opacity=clamp(sa*4+0.3,0,1)*0.9;sunSp.position.set(camera.position.x+dx/l*240,camera.position.y+dy/l*240,camera.position.z+dz/l*240);
  moonSp.visible=sa<0.15;moonSp.material.opacity=clamp(-sa*3+0.3,0,1);moonSp.position.set(camera.position.x-dx/l*240,camera.position.y-dy/l*240,camera.position.z-dz/l*240+60);
  winMats.forEach(m=>m.color.copy(winDay).lerp(winNight,envC.nf));
  motes.material.opacity=0.55+0.4*envC.nf;motes.material.size=0.22+0.12*envC.nf;
}

/* ---------- minimap ---------- */
let miniT=0;
function drawMini(){
  const c=$('mini').getContext('2d'),S=192,H=96;c.clearRect(0,0,S,S);c.save();c.beginPath();c.arc(H,H,H-2,0,6.2832);c.clip();
  const ox=inCave?CX:0,oz=inCave?CZ:0,sc=(H-4)/(inCave?CAVE_R:140),mx=x=>H+(x-ox)*sc,mz=z=>H+(z-oz)*sc;
  const dot=(x,y,r,col)=>{c.fillStyle=col;c.beginPath();c.arc(x,y,r,0,6.2832);c.fill();};
  if(inCave){
    c.fillStyle='#1d1a2b';c.fillRect(0,0,S,S);dot(mx(CX),mz(CZ),CAVE_R*sc,'#2a2740');
    if(!chestOpen)dot(mx(CX),mz(CZ),4,'#ffd84d');
    dot(mx(CX),mz(CZ+CAVE_R-1.8),5,'#cfeaff');
  }else{
    c.fillStyle='#5d9c5a';c.fillRect(0,0,S,S);
    dot(mx(0),mz(0),22*sc,'#cdbf9a');
    dot(mx(LAKE.x),mz(LAKE.z),(LAKE.R)*sc,'#2f8fd8');
    c.fillStyle='#d85b3d';houseSpecs.forEach(h=>c.fillRect(mx(h.x)-4,mz(h.z)-4,8,8));
    c.fillStyle='#b9b2a3';towerSpecs.forEach(t=>c.fillRect(mx(t.x)-3,mz(t.z)-3,6,6));
    dot(mx(CAVE.x),mz(CAVE.z),7,'#15131c');dot(mx(CAVE.x),mz(CAVE.z),3,'#7de0ff');
    CAMP_DEFS.forEach(cp=>{c.fillStyle='#7a1f24';c.beginPath();c.arc(mx(cp.x),mz(cp.z),5,0,6.2832);c.fill();c.strokeStyle='#e8e0d0';c.lineWidth=1.5;c.stroke();});
    forts.forEach(f=>{c.fillStyle=f.owner?fortColor(f.ownerCh):'#9aa3b2';c.fillRect(mx(f.x)-4,mz(f.z)-4,8,8);c.strokeStyle='#ffd84d';c.lineWidth=1.5;c.strokeRect(mx(f.x)-4,mz(f.z)-4,8,8);});
  }
  others.forEach(o=>{if(!o.dead&&(o.x>1000)===inCave)dot(mx(o.x),mz(o.z),3.5,'#ff9a3c');});
  c.translate(mx(pos.x),mz(pos.z));c.rotate(Math.atan2(faceZ,faceX)+Math.PI/2);
  c.fillStyle='#fff';c.strokeStyle='#2b2233';c.lineWidth=2;c.beginPath();c.moveTo(0,-8);c.lineTo(6,6);c.lineTo(-6,6);c.closePath();c.fill();c.stroke();
  c.restore();
  c.strokeStyle='rgba(0,0,0,.25)';c.lineWidth=3;c.beginPath();c.arc(H,H,H-2,0,6.2832);c.stroke();
}

/* ---------- physics ---------- */
const SPEED_WALK=6.5,SPEED_RUN=10,GRAV=30,JUMPV=15.56; /* lompat 2x lebih tinggi (v^2 x2) */
function canMove(nx,nz,step,swim){
  const g=groundAt(nx,nz,pos.y);const rise=g-pos.y;
  const maxRise=swim?1.6:(grounded?0.9*step+0.03:0.45);
  return rise<=maxRise;
}
function resolve(){
  for(const c of circles){const dx=pos.x-c.x,dz=pos.z-c.z,rr=c.r+PR,d2=dx*dx+dz*dz;if(d2<rr*rr){const d=Math.sqrt(d2)||0.001;pos.x=c.x+dx/d*rr;pos.z=c.z+dz/d*rr;}}
  for(const p of platforms){if(pos.y>=p.top-0.35)continue;const dx=pos.x-p.x,dz=pos.z-p.z,rr=p.r+PR,d2=dx*dx+dz*dz;if(d2<rr*rr){const d=Math.sqrt(d2)||0.001;pos.x=p.x+dx/d*rr;pos.z=p.z+dz/d*rr;}}
  for(const o of obbs){
    if(!o.enabled)continue;
    const dx=pos.x-o.cx,dz=pos.z-o.cz,lx=dx*o.c-dz*o.s,lz=dx*o.s+dz*o.c;
    const qx=clamp(lx,-o.hx,o.hx),qz=clamp(lz,-o.hz,o.hz),ddx=lx-qx,ddz=lz-qz,d2=ddx*ddx+ddz*ddz;
    if(d2<PR*PR){
      let nx,nz;
      if(d2>1e-8){const d=Math.sqrt(d2);nx=qx+ddx/d*PR;nz=qz+ddz/d*PR;}
      else{const px=o.hx-Math.abs(lx),pz=o.hz-Math.abs(lz);if(px<pz){nx=(lx<0?-1:1)*(o.hx+PR);nz=lz;}else{nz=(lz<0?-1:1)*(o.hz+PR);nx=lx;}}
      pos.x=o.cx+nx*o.c+nz*o.s;pos.z=o.cz-nx*o.s+nz*o.c;
    }
  }
}
function dust(n,spread,up,col){for(let i=0;i<n;i++){const a=Math.random()*6.28;emit(pos.x+Math.cos(a)*0.3,pos.y+0.08,pos.z+Math.sin(a)*0.3,Math.cos(a)*spread*(0.4+Math.random()),up*(0.5+Math.random()),Math.sin(a)*spread*(0.4+Math.random()),0.45+Math.random()*0.3,0.35+Math.random()*0.25,col||'#e8dcb8',-1.5,0.6,1.3);}}
function terrainBelow(){return groundAt(pos.x,pos.z,pos.y-0.01);}
function occludes(h){
  const ax=camera.position.x,ay=camera.position.y,az=camera.position.z,bx=pos.x,by=pos.y+1,bz=pos.z;
  for(let i=0;i<=14;i++){const t=i/15;const x=ax+(bx-ax)*t,y=ay+(by-ay)*t,z=az+(bz-az)*t;if(y>WALLH+2.8)continue;
    const dx=x-h.x,dz=z-h.z,lx=dx*h.c-dz*h.s,lz=dx*h.s+dz*h.c;if(Math.abs(lx)<4.7&&Math.abs(lz)<4.2)return true;}
  return false;
}

function update(dt){
  tAll+=dt;
  gameHour=(hourBase+(performance.now()-hourAt)/1000*0.04)%24;
  inCave=pos.x>1000;
  const fwd={x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)},rgt={x:Math.cos(cam.yaw),z:-Math.sin(cam.yaw)};
  const live=started&&!dead&&!modalOpen&&!bookOpen&&!chatOpen&&stunT<=0&&!fade;
  let ix=0,iy=0,run=false,diveHeld=diveBtnHeld;
  if(live){
    if(keys.has('KeyA')||keys.has('ArrowLeft'))ix-=1;if(keys.has('KeyD')||keys.has('ArrowRight'))ix+=1;
    if(keys.has('KeyW')||keys.has('ArrowUp'))iy+=1;if(keys.has('KeyS')||keys.has('ArrowDown'))iy-=1;
    if(keys.has('KeyQ'))cam.yawT+=1.9*dt;if(keys.has('KeyR'))cam.yawT-=1.9*dt;
    run=keys.has('ShiftLeft')||keys.has('ShiftRight');
    if(keys.has('KeyV')||keys.has('ControlLeft')||keys.has('KeyZ'))diveHeld=true;
    if(joy.id!==null){ix+=joy.x;iy+=joy.y;}
  }
  let mag=Math.hypot(ix,iy);if(mag>1){ix/=mag;iy/=mag;mag=1;}
  if(!live)jumpBuf=0;
  if(sleeping&&(mag>0.3||jumpBuf>0)){wakeUp();jumpBuf=0;}
  const riding=rideT>0&&!dead;
  const wd=waterDepthAt(pos.x,pos.z);
  let swim=wd>0.5&&pos.y<WATER_Y-0.1&&!dead&&!riding;
  const jumpHeld=live&&(keys.has('Space')||jumpBtnHeld);
  if(swim&&jumpBuf>0&&pos.y>SURF_Y-0.45){vy=JUMPV*0.82;jumpBuf=0;jumping=true;swim=false;grounded=false;sfx.jump();}
  swimNow=swim;
  if(swim&&!wasSwim){sfx.splash();for(let i=0;i<14;i++)emit(pos.x,WATER_Y+0.1,pos.z,(Math.random()-0.5)*4,2+Math.random()*3,(Math.random()-0.5)*4,0.7,0.45,'#cfeeff',8,0.9,0.3);}
  if(!swim&&wasSwim&&vy>0){}
  wasSwim=swim;
  let speed;
  if(joy.id!==null&&mag>0.02)speed=mag>=0.9?SPEED_RUN:SPEED_WALK*mag/0.9;
  else speed=run?SPEED_RUN:SPEED_WALK;
  if(swim)speed*=0.55;
  if(guarding)speed*=0.5;
  if(hasteT>0)speed*=hastePw;
  if(riding)speed=(joy.id!==null&&mag>0.02?ridePw*Math.min(1,mag/0.9):ridePw);
  if(attackT>0)speed*=0.55;
  if(!live||sleeping)speed=0;
  const tx=(rgt.x*ix+fwd.x*iy)*speed,tz=(rgt.z*ix+fwd.z*iy)*speed;
  const k=swim?6:(grounded?(mag>0.02?14:20):5);
  vel.x+=(tx-vel.x)*damp(k,dt);vel.z+=(tz-vel.z)*damp(k,dt);

  if(riding){
    grounded=false;jumping=false;coyote=0;jumpBuf=0;
    let want=0;if(jumpHeld)want=10;else if(diveHeld)want=-10;
    vy+=(want-vy)*damp(6,dt);if(pos.y>26&&vy>0)vy=0;
  }else if(swim){
    grounded=false;jumping=false;coyote=0;
    let want;
    if(oxy<=0.001)want=3.4;
    else if(diveHeld)want=-3.8;
    else if(jumpHeld&&pos.y<SURF_Y+0.25)want=3.8;
    else want=clamp((SURF_Y-pos.y)*3,-2.5,2.5);
    vy+=(want-vy)*damp(7,dt);
  }else{
    if(grounded)coyote=0.1;else coyote-=dt;
    jumpBuf-=dt;
    if(jumpBuf>0&&coyote>0&&live){vy=JUMPV;grounded=false;coyote=0;jumpBuf=0;jumping=true;sq.y=1.28;sq.v=0;sfx.jump();dust(6,2.2,0.6);}
    if(jumping&&!jumpHeld&&vy>0){vy*=0.5;jumping=false;}
    if(!grounded)vy-=GRAV*dt;
  }
  if(swim)jumpBuf-=dt;

  if(sleeping&&sleepPos){
    vel.set(0,0,0);vy=0;grounded=true;pos.x+=(sleepPos.x-pos.x)*damp(6,dt);pos.z+=(sleepPos.z-pos.z)*damp(6,dt);pos.y+=(0.75-pos.y)*damp(6,dt);
    zT-=dt;if(zT<=0){zT=0.9;emit(pos.x,pos.y+1.1,pos.z,0.25,0.6,0,1.8,0.8,'#d9ecff',0,0.95,0.5,zTex);}
  }else
  {
    pos.y+=vy*dt;
    const nSub=Math.max(1,Math.ceil(Math.hypot(vel.x+kb.x,vel.z+kb.z)*dt/0.4)),sdt=dt/nSub;
    for(let si=0;si<nSub;si++){
      const stepX=Math.abs((vel.x+kb.x)*sdt),stepZ=Math.abs((vel.z+kb.z)*sdt);
      let nx=pos.x+(vel.x+kb.x)*sdt;if(canMove(nx,pos.z,stepX,swim||riding))pos.x=nx;else{vel.x*=0.2;kb.x=0;}
      let nz=pos.z+(vel.z+kb.z)*sdt;if(canMove(pos.x,nz,stepZ,swim||riding))pos.z=nz;else{vel.z*=0.2;kb.z=0;}
      if(!(riding&&pos.y>7.5))resolve();
    }
    if(inCave){const ddx=pos.x-CX,ddz=pos.z-CZ,r0=Math.hypot(ddx,ddz);if(r0>CAVE_R-1.2){const k0=(CAVE_R-1.2)/r0;pos.x=CX+ddx*k0;pos.z=CZ+ddz*k0;}if(pos.y>12)pos.y=12;}
    else{const rr=Math.hypot(pos.x,pos.z);if(rr>134){pos.x*=134/rr;pos.z*=134/rr;}}
    const g=groundAt(pos.x,pos.z,pos.y);
    if(riding){if(pos.y<g){pos.y=g;if(vy<0)vy=0;}grounded=false;}
    else if(swim){if(pos.y<g){pos.y=g;if(vy<0)vy=0;}grounded=false;if(pos.y>SURF_Y+0.9&&vy>0&&!jumping)vy=Math.min(vy,0);}
    else if(grounded&&vy<=0&&pos.y-g<0.35){pos.y=g;}
    else if(pos.y<=g){
      if(vy<-4){sq.y=0.68;sq.v=0;sfx.land(-vy);dust(10,3,0.8);}
      pos.y=g;vy=0;grounded=true;jumping=false;
    }else grounded=false;
  }
  /* oxygen */
  const headUnder=swim&&pos.y+1.5<WATER_Y;
  oxy=headUnder?Math.max(0,oxy-dt/14):Math.min(1,oxy+dt*0.7);
  $('oxyBox').style.opacity=(oxy<0.999||headUnder)?1:0;$('oxyFill').style.width=(oxy*100)+'%';
  if(swim){
    strokeT-=dt;if(strokeT<=0&&Math.hypot(vel.x,vel.z)>0.8){strokeT=0.55;sfx.stroke();}
    rippleT-=dt;
    if(rippleT<=0&&(Math.hypot(vel.x,vel.z)>0.8||Math.abs(vy)>1)){rippleT=0.18;if(headUnder)emit(pos.x+(Math.random()-0.5)*0.5,pos.y+1.4,pos.z+(Math.random()-0.5)*0.5,0,1.2,0,1.2,0.3,'#dff3ff',0,0.7,0.2);else emit(pos.x,WATER_Y+0.05,pos.z,0,0.1,0,0.8,0.7,'#e6f6ff',0,0.55,2.5);}
  }

  for(const d of doors){
    const acc=-80*(d.ang-d.target)-10.5*d.vel;d.vel+=acc*dt;d.ang+=d.vel*dt;
    d.pivot.rotation.y=d.ang;d.col.enabled=d.ang<0.7;
  }
  insideHouse=null;
  for(const h of houses){const dx=pos.x-h.x,dz=pos.z-h.z,lx=dx*h.c-dz*h.s,lz=dx*h.s+dz*h.c;if(Math.abs(lx)<3.9&&Math.abs(lz)<3.4&&pos.y<2.6){insideHouse=h;break;}}
  for(const h of houses){
    const occ=h!==insideHouse&&occludes(h);
    const rt=h===insideHouse?0:(occ?0.18:1),wt=(occ||h===insideHouse)?0.3:1;
    h.roofOp+=(rt-h.roofOp)*damp(9,dt);h.wallOp+=(wt-h.wallOp)*damp(9,dt);
    const vis=h.roofOp>0.03;h.roofParts.forEach(m=>m.visible=vis);
    h.roofMats.forEach(m=>{m.opacity=h.roofOp;m.transparent=h.roofOp<0.99;});
    h.wallMats.forEach(m=>{m.opacity=h.wallOp;m.transparent=h.wallOp<0.99;m.depthWrite=h.wallOp>0.99;});
  }

  atkCool=Math.max(0,atkCool-dt);invuln=Math.max(0,invuln-dt);hurtFlash=Math.max(0,hurtFlash-dt);shake=Math.max(0,shake-dt*2);
  if(myShieldT>0)myShieldT-=dt;
  if(rideT>0)rideT-=dt;
  if(stunT>0){stunT-=dt;if(Math.random()<dt*10)emit(pos.x+Math.cos(tAll*8)*0.5,pos.y+2.0,pos.z+Math.sin(tAll*8)*0.5,0,0,0,0.5,0.3,'#fff6a0',0,1,0);}
  if(gbT>0)gbT-=dt;
  if(hasteT>0&&Math.random()<dt*9)emit(pos.x,pos.y+0.8,pos.z,-faceX*2,0.3,-faceZ*2,0.4,0.6,'#fff27a',0,0.8,0.5);
  if(hasteT>0)hasteT-=dt;
  if(myRegenT>0){myRegenT-=dt;if(Math.random()<dt*9)emit(pos.x+(Math.random()-0.5)*1.2,pos.y+0.3,pos.z+(Math.random()-0.5)*1.2,0,1.4,0,0.9,0.4,'#7dffae',0,0.9,0.2);}
  if(guardPipT>0){guardPipT-=dt;if(guardPipT<=0)guardPips=3;}
  if(guarding&&(!live||gbT>0||swim||riding))setGuard(false);
  kb.x*=Math.exp(-9*dt);kb.z*=Math.exp(-9*dt);
  if(attackT>0)attackT-=dt;
  if(dead){deadT-=dt;$('koTxt').dataset.t=Math.max(0,Math.ceil(deadT));}
  /* slot cooldown ui */
  for(let i=0;i<5;i++){
    if(slotCd[i]>0){slotCd[i]=Math.max(0,slotCd[i]-dt);const el=document.querySelector('.slot[data-i="'+i+'"] .cd');el.style.height=(slotCd[i]/slotCdMax[i]*100)+'%';if(slotCd[i]===0)document.querySelector('.slot[data-i="'+i+'"]').classList.add('ready');}
    else{const sl=document.querySelector('.slot[data-i="'+i+'"]');if(sl.classList.contains('ready'))setTimeout(()=>sl.classList.remove('ready'),500);}
  }

  /* sprite animation */
  const sp=Math.hypot(vel.x,vel.z);
  const vr=vel.x*rgt.x+vel.z*rgt.z;
  if(sp>0.7&&attackT<=0&&!dead){faceX=vel.x/sp;faceZ=vel.z/sp;}
  if(fps&&started){const cf=camFwd();faceX=cf.x;faceZ=cf.z;}
  {const fr=faceX*rgt.x+faceZ*rgt.z,ff=faceX*fwd.x+faceZ*fwd.z;
    const phi=Math.atan2(fr,-ff);let dk=phi-viewK*Math.PI/4;dk=Math.atan2(Math.sin(dk),Math.cos(dk));
    if(Math.abs(dk)>Math.PI/8+0.12){viewK=((Math.round(phi/(Math.PI/4))%8)+8)%8;}}
  let frame;
  if(riding){idleT+=dt;frame=Math.floor(idleT/0.35)%2;}
  else if(!grounded&&!swim)frame=vy>0?6:7;
  else if(sp>0.9){
    walkT+=dt*(2.2+sp*0.9);const idx=Math.floor(walkT)%4;frame=2+idx;
    if(!swim&&idx!==lastStepIdx&&(idx===0||idx===2)){sfx.step(stepKind());if(sp>7.5)dust(2,1.2,0.5);else if(Math.random()<0.5)dust(1,0.8,0.4);}
    lastStepIdx=idx;
  }else{idleT+=dt;frame=Math.floor(idleT/0.55)%2;lastStepIdx=-1;}
  let row=ROWMAP[viewK],flip=viewK>4;
  if(dead){row=5;frame=3;flip=false;}
  else if(sleeping){row=5;frame=6;flip=false;}
  else if(attackT>0){row=5;frame=(0.32-attackT)<0.1?4:5;flip=(faceX*rgt.x+faceZ*rgt.z)<0;}
  setTexFrame(myTex,frame,row);
  sq.v+=(-140*(sq.y-1)-13*sq.v)*dt;sq.y+=sq.v*dt;
  const syy=clamp(sq.y,0.5,1.5),sxx=1/Math.pow(syy,0.6);
  spriteMesh.scale.set(sxx*(flip?-1:1),syy,1);
  spriteMesh.rotation.y=cam.yaw;spriteMesh.rotation.x=-cam.pitch*0.55;
  spriteMesh.material.color.setHex(hurtFlash>0?0xff7a7a:(stunT>0?0xaee6ff:0xffffff));spriteMesh.visible=!fps&&!(invuln>0.25&&Math.floor(tAll*16)%2===0&&!dead);
  playerRoot.position.copy(pos);
  if(swim)playerRoot.position.y+=Math.sin(tAll*3)*0.05;
  if(riding)playerRoot.position.y+=(myMount&&(ROWMAP[myMount.vk]===1||ROWMAP[myMount.vk]===3))?1.2:0.8;
  if(riding){if(!myMount)myMount=mountMake();myMount.mesh.visible=!fps;mountPlace(myMount,pos.x,pos.y,pos.z,faceX,faceZ,rgt,fwd,0);}else if(myMount)myMount.mesh.visible=false;
  const hAbove=pos.y-terrainBelow();
  pShadow.position.set(pos.x,Math.max(groundAt(pos.x,pos.z,pos.y-0.5)+0.07,swim?WATER_Y+0.03:-999),pos.z);
  const sc=clamp(1-hAbove*0.12,0.35,1);pShadow.scale.setScalar(sc*1.25);pShadow.material.opacity=clamp(1-hAbove*0.1,0.35,1);
  myShield.visible=myShieldT>0&&!dead;if(myShield.visible){myShield.position.set(pos.x,pos.y+0.95,pos.z);const s2=3.2+Math.sin(tAll*8)*0.15;myShield.scale.set(s2,s2,1);}

  if(guarding&&!dead){if(!myGuardSp)myGuardSp=makeShield3D(me.ch);myGuardSp.visible=true;placeShield(myGuardSp,pos.x,pos.y,pos.z,faceX,faceZ,tAll);}else if(myGuardSp)myGuardSp.visible=false;
  if(AC&&!muted&&started){
    ambT-=dt;
    if(ambT<=0){
      ambT=rnd(2.5,6);const nf=envC.nf;
      if(inCave){pick([()=>sfx.drip(),()=>sfx.drip(),()=>sfx.bat(),()=>sfx.wind()])();}
      else{
        const dl=lakeDist(pos.x,pos.z);let cf=null,cfd=99;for(const c of campFx){const d=Math.hypot(c.x-pos.x,c.z-pos.z);if(d<35&&d<cfd){cf=c;cfd=d;}}
        const opts=[];
        if(nf<0.4){opts.push(()=>{SV=0.7;sfx.bird();SV=1;},()=>{SV=0.5;sfx.bird();SV=1;});}else{opts.push(()=>{SV=0.5;sfx.cricket();SV=1;},()=>{SV=0.6;sfx.owl();SV=1;});}
        opts.push(()=>sfx.wind());
        if(dl<LAKE.R+22){const lv=distVol(Math.max(0,dl-LAKE.R),24);opts.push(()=>{SV=lv;sfx.lap();SV=1;},()=>{SV=lv;sfx.lap();SV=1;});}
        if(Math.hypot(pos.x,pos.z)<27)opts.push(()=>{SV=distVol(Math.hypot(pos.x,pos.z),28);sfx.fountain();SV=1;});
        if(cf){opts.push(()=>{SV=distVol(cfd,36)*0.9;sfx.fire();SV=1;},()=>{SV=distVol(cfd,36)*0.9;sfx.fire();SV=1;});ambT=rnd(0.8,2);}
        pick(opts)();
      }
    }
    if(me.hp<28&&me.hp>0&&!dead){hbT-=dt;if(hbT<=0){hbT=0.85;sfx.heartbeat();}}
    humT-=dt;if(humT<=0){humT=0.75;let nd=1e9;orbs.forEach(o=>{nd=Math.min(nd,Math.hypot(o.x-pos.x,o.y-pos.y,o.z-pos.z));});if(nd<SFX_RANGE){SV=distVol(nd,SFX_RANGE);sfx.orbHum();SV=1;}}
  }
  if(peers.size){peers.forEach((pe,id)=>{const o=others.get(id);let v=0;if(o&&!o.dead&&((o.x>1000)===inCave)){v=distVol(Math.hypot(o.x-pos.x,(o.y-pos.y)*0.5,o.z-pos.z),VOICE_RANGE);}pe.el.volume=clamp(v,0,1);});}
  updOthers(dt,rgt,fwd);updMobs(dt,rgt,fwd);updTraps(dt);updBeams(dt);updSols(dt,rgt,fwd);updOrbs(dt);updForts(dt);updCamps(dt);updAim();
  if(capState){const kk=clamp(1-(capState.end-performance.now())/capState.ms,0,1);$('capFill').style.width=(kk*100)+'%';}
  if(chest){chest.vel+=(-70*(chest.ang-chest.target)-9*chest.vel)*dt;chest.ang+=chest.vel*dt;chest.pivot.rotation.x=-chest.ang;chest.glow.material.opacity=chestOpen?0.15:0.5+0.15*Math.sin(tAll*3);}
  if(inCave){updBats(dt,rgt);for(const c of crystals){c.mat.emissiveIntensity=0.75+0.35*Math.sin(tAll*1.6+c.ph);c.glow.material.opacity=0.5+0.2*Math.sin(tAll*1.6+c.ph);}}
  else if(Math.hypot(pos.x,pos.z)<75){
    fountT+=dt*46;
    while(fountT>=1){fountT-=1;const a=Math.random()*6.28,r=Math.random()*0.12;emit(Math.cos(a)*r,3.25,Math.sin(a)*r,Math.cos(a)*1.1,3.6+Math.random()*0.9,Math.sin(a)*1.1,1.3,0.3,'#d5f0ff',9,0.9,0.3);}
    if(Math.random()<dt*16){const a=Math.random()*6.28;emit(Math.cos(a)*1.55,1.9,Math.sin(a)*1.55,Math.cos(a)*0.8,0.2,Math.sin(a)*0.8,0.7,0.25,'#bfe6ff',9,0.8,0.2);}
    if(Math.random()<dt*10){const a=Math.random()*6.28;emit(Math.cos(a)*0.9,2.88,Math.sin(a)*0.9,Math.cos(a)*0.6,0.2,Math.sin(a)*0.6,0.6,0.22,'#d5f0ff',9,0.8,0.2);}
    fountain.water.opacity=0.82+0.05*Math.sin(tAll*2);
  }
  if(snipeCd>0)snipeCd-=dt;
  if(fade){
    fade.t+=dt;
    if(fade.phase===0&&fade.t>=0.5){doSwitch(fade.toCave);fade.phase=1;fade.t=0;$('fade').style.opacity=0;}
    else if(fade.phase===1&&fade.t>=0.5)fade=null;
  }else if(started&&live&&!sleeping){
    if(!inCave){if(Math.hypot(pos.x-CAVE_TRIG.x,pos.z-CAVE_TRIG.z)<1.3&&pos.y<1.5)startTransition(true);}
    else if(Math.hypot(pos.x-CX,pos.z-(CZ+CAVE_R-1.8))<2.6)startTransition(false);
  }

  updProjs(dt);updRings(dt);updFloats(dt);

  /* net: send my state */
  if(joined){
    netT-=dt;netIdle+=dt;
    if(netT<=0){netT=0.066;
      const m=sp<0.9?0:(sp>7.5?2:1),a=grounded||swim||riding?0:(vy>0?1:2),sw=swim?(headUnder?2:1):0;
      netSend({t:'s',x:+pos.x.toFixed(2),y:+pos.y.toFixed(2),z:+pos.z.toFixed(2),fx:+faceX.toFixed(2),fz:+faceZ.toFixed(2),m,a,sw});}
  }

  /* prompt */
  const act=pickAction();
  $('prompt').classList.toggle('show',!!act&&started);$('btnAct').classList.toggle('on',!!act&&started);
  if(act)$('ptxt').textContent=act.text;
  {const sn=$('btnSnipe');sn.classList.toggle('on',ammo>0&&started);sn.classList.toggle('broken',snipeCd>0);const sl='Sniper '+ammo;if(sn.dataset.l!==sl){sn.dataset.l=sl;sn.querySelector('small').textContent=sl;}}
  $('btnDive').classList.toggle('on',(swim||riding)&&started);
  {const gl=gbT>0?'Pecah':(guardPips<3?'●'.repeat(guardPips)+'○'.repeat(3-guardPips):'Tahan');if(gl!==guardLbl){guardLbl=gl;$('btnGuard').querySelector('small').textContent=gl;}$('btnGuard').classList.toggle('broken',gbT>0);}
  if(toastT>0){toastT-=dt;if(toastT<=0)$('toast').classList.remove('show');}
  if(dead)$('ko').querySelector('h2').textContent='KO!  '+Math.max(0,Math.ceil(deadT));

  for(const c of clouds){c.position.x+=dt*1.2;if(c.position.x>190)c.position.x=-190;}
  for(let i=0;i<MOTES;i++){const b=moteBase[i];b.y+=b.sp*dt;if(b.y>9)b.y-=9;
    let mx=((b.x-pos.x+20)%40+40)%40-20,mz=((b.z-pos.z+20)%40+40)%40-20;
    motePos[i*3]=pos.x+mx+Math.sin(tAll*0.5+b.ph)*0.6;motePos[i*3+1]=Math.max(terrainH(pos.x+mx,pos.z+mz),WATER_Y)+0.6+b.y;motePos[i*3+2]=pos.z+mz;}
  moteGeo.attributes.position.needsUpdate=true;motes.visible=!insideHouse;
  lakeMat.opacity=0.7+0.04*Math.sin(tAll*1.5);

  updParts(dt);

  /* clock + minimap */
  if(((tAll*1.25)|0)!==(((tAll-dt)*1.25)|0)){const h=Math.floor(gameHour),mm=Math.floor((gameHour-h)*6)*10;$('clock').innerHTML=svg(envC.nf>0.5?'moon':'sun',null,'clki')+' '+String(h).padStart(2,'0')+':'+String(mm).padStart(2,'0');}
  miniT++;if(started&&miniT%5===0)drawMini();

  /* camera */
  if(!started)cam.yawT+=dt*0.12;
  cam.yaw+=(cam.yawT-cam.yaw)*damp(10,dt);
  const pitchGoal=insideHouse?Math.max(cam.pitchT,0.95):cam.pitchT;
  const distGoal=insideHouse?Math.min(cam.distT,10):cam.distT;
  cam.pitch+=(pitchGoal-cam.pitch)*damp(4,dt);cam.dist+=(distGoal-cam.dist)*damp(4,dt);
  cam.tx+=(pos.x-cam.tx)*damp(9,dt);cam.tz+=(pos.z-cam.tz)*damp(9,dt);cam.ty+=(Math.max(pos.y,SURF_Y)-cam.ty)*damp(5,dt);
  const cosP=Math.cos(cam.pitch);
  let cx=cam.tx+Math.sin(cam.yaw)*cosP*cam.dist,cz=cam.tz+Math.cos(cam.yaw)*cosP*cam.dist,cy=cam.ty+1.2+Math.sin(cam.pitch)*cam.dist;
  cy=Math.max(cy,Math.max(terrainH(cx,cz),WATER_Y-0.0)+1.5-(swim?0.0:0));
  if(inCave){const ddx=cx-CX,ddz=cz-CZ,r0=Math.hypot(ddx,ddz);if(r0>CAVE_R-2){const k0=(CAVE_R-2)/r0;cx=CX+ddx*k0;cz=CZ+ddz*k0;}cy=clamp(cy,1.5,13);}
  if(!started){/* menu orbit above the village */cx=Math.sin(cam.yaw)*38;cz=Math.cos(cam.yaw)*38+10;cy=terrainH(cx,cz)+16;}
  camera.position.set(cx,cy,cz);camera.lookAt(started?cam.tx:0,started?cam.ty+1.0:2,started?cam.tz:0);
  if(fps&&started){const ey=pos.y+(swim?0.9:1.6)+(riding?0.8:0),cp=Math.cos(fpsPitch);camera.position.set(pos.x,ey,pos.z);camera.lookAt(pos.x-Math.sin(cam.yaw)*cp,ey+Math.sin(fpsPitch),pos.z-Math.cos(cam.yaw)*cp);}
  if(shake>0){camera.position.x+=(Math.random()-0.5)*shake*0.5;camera.position.y+=(Math.random()-0.5)*shake*0.5;}
  const fovGoal=(cam.baseFov||50)+(sp>8.5?6:0)+(fps?12:0);cam.fov+=(fovGoal-cam.fov)*damp(4,dt);
  if(Math.abs(camera.fov-cam.fov)>0.02){camera.fov=cam.fov;camera.updateProjectionMatrix();}
  underwater=camera.position.y<WATER_Y&&lakeDist(camera.position.x,camera.position.z)<LAKE.R+1;
  $('uw').style.opacity=underwater?1:0;
  applyEnv(dt);
}

/* ---------- loop ---------- */
let last=performance.now();
function frame(now){
  let dt=Math.min(0.05,(now-last)/1000);last=now;
  update(dt);renderer.render(scene,camera);requestAnimationFrame(frame);
}
document.querySelectorAll('[data-ico]').forEach(el=>{el.innerHTML=svg(el.dataset.ico);});
cam.fov=cam.baseFov||50;camera.fov=cam.fov;
window.__dw={mobs:()=>mobs,sfx,aiming:()=>aiming,fps:()=>fps,forts,sols,orbs,houses,inCave:()=>inCave,chest:()=>chest,ammo:()=>ammo,sleeping:()=>sleeping,eagleCv,pos,others,slots,me:()=>me,castSlot,doAttack,cam};
requestAnimationFrame(frame);
})();
</script>
</body>
</html>
`;
