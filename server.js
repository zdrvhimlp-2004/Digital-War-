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
/* ---- PENYETELAN: semua angka utama ada di sini (server + dikirim ke browser) ---- */
const TUNING = {
  maxHp: 300,                 // darah pemain
  walk: 4.6, run: 7,          // kecepatan jalan / lari
  jump: 19.5,                 // daya lompat biasa
  meleeDmg: 50, meleeRange: 3.3, meleeCd: 333,   // pedang (penutup kombo 1.6x)
  waveDmg: 25,                // tebasan angin
  ballSpeed: 10,              // kecepatan semua bola (bolt & orb), 2x dari 5
  eagleSpeedMul: 0.275,       // pengali kecepatan elang (panggilan & tunggangan)
  dashMinCd: 3,               // cooldown minimum dash (dtk)
  sleepRegen: 18              // HP per detik saat tidur
};
const MAXHP = TUNING.maxHp;
const TICK_MS = 33;             // simulasi server ~30 Hz
const SNAP_EVERY = 2;           // kirim posisi tiap 2 tick (~15 Hz)
const RESPAWN_MS = 3500;
const SPAWN_PROTECT_MS = 2000;
const CLASH_MS = 350;
const MELEE = { dmg: TUNING.meleeDmg, range: TUNING.meleeRange, cd: TUNING.meleeCd, knock: 28 };
const KNOCK_MULT = 2;   /* pengali semua dorongan (tebasan, bola, ledakan, nova, sinar, dll.) */
const DOOR_COUNT = 8;           // 5 rumah tengah + 3 rumah jauh (sama dengan client)
const MAX_TECH_SLOTS = 5;
const ROOM_MAX_LIMIT = 100;
const CHAR_COUNT = 8;
const CHEST = { x: 3000, z: 0 };           // peti di dalam goa (koordinat interior goa)
const CHEST_RESET_MS = 60000;
const SNIPER = { ammo: 5, dmg: 45, range: 90, cd: 2200, width: 1.0 };
const SLEEP_REGEN = TUNING.sleepRegen;                     // HP per detik saat tidur
const FORTS = [
  { id: 0, name: 'Benteng Fajar', x: 62, z: -52 },
  { id: 1, name: 'Benteng Senja', x: -72, z: -52 },
  { id: 2, name: 'Benteng Bayu', x: 40, z: 78 }
];
const FORT_RANGE = 7, FORT_CAPTURE_MS = 3000, FORT_AGGRO = 40, FORT_LEASH = 36;
const CAMPS = [
  { id: 0, x: 88, z: 0 },
  { id: 1, x: -90, z: 0 },
  { id: 2, x: 0, z: -92 }
];
const BANDIT_AGGRO = 34, BANDIT_SEE = 32, BANDIT_LEASH = 56, BANDIT_RESPAWN_MS = 20000, BANDIT_HEAL = 12;
const BANDITS_PER_CAMP = { sword: 2, archer: 2, brute: 1 };
const BANDIT_OWNER = -1, BANDIT = { id: -1, name: 'Penyamun' };
const SOLDIER = { brute: { hp: 95, speed: 5.4, dmg: 14, range: 2.7, cd: 1150 }, sword: { hp: 45, speed: 6.5, dmg: 8, range: 2.4, cd: 1000 }, archer: { hp: 30, speed: 4.5, dmg: 7, range: 17, cd: 1800, arrow: 22 } };
const SOLDIERS_PER_FORT = { sword: 3, archer: 2 };
/* pasukan benteng: sebagian menjaga benteng, sebagian mengawal pemilik */
const FORT_ROSTER = [
  { kind: 'sword', role: 'guard' }, { kind: 'sword', role: 'guard' }, { kind: 'sword', role: 'escort' },
  { kind: 'archer', role: 'guard' }, { kind: 'archer', role: 'escort' }
];
const ESCORT_AGGRO = 30;
const MOB_HP = 40, MOUNT_HP = 70;
const CAVE_MOUTH = { x: -15, z: 87 };
const SOLDIER_RESPAWN_MS = 12000;
const CHAT_MAX = 140;
const EMOTE_COUNT = 8;      /* jumlah emote (indeks 0..7, ikon digambar di klien) */
const EMOTE_CD_MS = 2800;
const SPAWN_RADIUS = 96;                   // titik spawn: pojok/tepi peta
const SPAWN_POINTS = Array.from({ length: 8 }, (_, k) => {
  const a = (22.5 + k * 45) * Math.PI / 180;
  return { x: Math.cos(a) * SPAWN_RADIUS, z: Math.sin(a) * SPAWN_RADIUS };
});

const TECH_VERSION = 13;
const OLD_CODE_MAP = {"6373828": "637", "3141592": "314", "8472916": "8472", "4242424": "4242", "5192837": "519", "5551234": "5551", "3735928": "3735", "2718281": "2718", "1618339": "1618", "4815162": "481", "1928374": "1928", "7294816": "7294", "9182736": "918", "9876543": "9876", "2468135": "246", "1357913": "1357", "7531946": "753"};
/* cooldown bawaan lama (v4) -> dipercepat di v5 */
const OLD_CD = { '637': 1, '314': 4, '8472': 5, '4242': 7, '519': 6, '5551': 11, '3735': 7, '2718': 9, '1618': 8, '481': 16, '1928': 24, '7294': 25, '918': 10, '9876': 14, '246': 12, '1357': 12, '753': 3 };
const DEFAULT_TECHS = [
  { code: '637', name: 'Byte Bolt',      kind: 'bolt',   color: '#4de1ff', damage: 30, cd: 2.4, speed: 24, life: 1.6, count: 1, spread: 0, size: 1.7, boom: 3.2 },
  { code: '314', name: 'Loop Barrage',   kind: 'bolt',   color: '#b57bff', damage: 18, cd: 8,   speed: 22, life: 1.5, count: 3, spread: 0.22, size: 1.2, boom: 2.6 },
  { code: '8472', name: 'Null Pointer',  kind: 'bolt',   color: '#ff5d5d', damage: 57, cd: 10, speed: 38, life: 1.4, count: 1, spread: 0, size: 2.1, boom: 3.8 },
  { code: '4242', name: 'Fork Bomb',     kind: 'bolt',   color: '#ff9a3c', damage: 14, cd: 12,   speed: 26, life: 1.4, count: 5, spread: 0.16, size: 1.0, boom: 2.2 },
  { code: '858', name: 'Bola Biru',      kind: 'orb',    color: '#2f8fff', damage: 150, cd: 20,   speed: 11, life: 4, radius: 5.5 },
  { code: '519', name: 'Overflow Nova',  kind: 'nova',   color: '#ffd84d', damage: 30, cd: 12,   radius: 6 },
  { code: '5551', name: 'Freeze Frame',  kind: 'nova',   color: '#aee6ff', damage: 8,  cd: 20,   radius: 5.5, stun: 2 },
  { code: '3735', name: 'Laser Beam',    kind: 'beam',   color: '#ff4de1', damage: 30, cd: 12,   range: 28 },
  { code: '2718', name: 'Stack Overflow', kind: 'slam',  color: '#ffb84d', damage: 40, cd: 16,   radius: 5 },
  { code: '1618', name: 'Landmine',      kind: 'trap',   color: '#ff6a4d', damage: 35, cd: 12,   radius: 2.2, stun: 0.6 },
  { code: '481', name: 'Elang Digital',  kind: 'summon', color: '#ffd9a0', damage: 9,  cd: 28,   count: 1, dur: 12, speed: 12 },
  { code: '1928', name: 'Elang Kembar',  kind: 'summon', color: '#ffe9c0', damage: 7,  cd: 40,  count: 2, dur: 10, speed: 13 },
  { code: '7294', name: 'Elang Tunggangan', kind: 'ride', color: '#ffe0b0', dur: 10, speed: 24, cd: 60 },
  { code: '918', name: 'Patch Heal',     kind: 'heal',   color: '#5dff9e', damage: 105, cd: 16 },
  { code: '9876', name: 'Auto Backup',   kind: 'regen',  color: '#8affc0', damage: 120, cd: 24,   dur: 6 },
  { code: '246', name: 'Firewall',       kind: 'shield', color: '#6cd4ff', dur: 4,     cd: 20 },
  { code: '1357', name: 'Overclock',     kind: 'haste',  color: '#fff27a', power: 1.6, dur: 5, cd: 20 },
  { code: '777', name: 'Tembok Kode', kind: 'wall', color: '#b8a27a', hp: 120, dur: 6, len: 8, cd: 20 },
  { code: '8181', name: 'Loncat Tinggi', kind: 'jump', color: '#9dffb0', power: 30, cd: 12 },
  { code: '2929', name: 'Kedip Teleport', kind: 'blink', color: '#c79bff', range: 14, cd: 16 },
  { code: '6464', name: 'Bola Pengejar', kind: 'homing', color: '#ff7ad9', damage: 30, cd: 10, count: 2, life: 7, size: 1.3, boom: 2.6, turn: 2.5 },
  { code: '8182', name: 'Loncat Super', kind: 'jump', color: '#7dffb2', power: 60, cd: 10 },
  { code: '4141', name: 'Kunci Lawan', kind: 'face', color: '#ffe066', range: 60, cd: 0 },
  { code: '4343', name: 'Singa Rimba', kind: 'lion', color: '#f0b45a', damage: 25, cd: 24, count: 1, dur: 15, speed: 7, hp: 90 },
  { code: '6193', name: 'Meteor Drop',   kind: 'meteor', color: '#ff8a3c', damage: 45, cd: 16, speed: 34, count: 3, size: 1.5, boom: 3 },
  { code: '4827', name: 'Pedang Berputar', kind: 'spin', color: '#bfe9ff', damage: 28, cd: 20, dur: 2, radius: 3.6 },
  { code: '5316', name: 'Cungkil', kind: 'launch', color: '#ffd24d', damage: 40, cd: 16, range: 4.2, lift: 34 },
  { code: '2159', name: 'Tembok Pelindung', kind: 'ring', color: '#9fb4d0', cd: 24, dur: 5, radius: 4, hp: 100 },
  { code: '753', name: 'Lag Dash',       kind: 'dash',   color: '#ffffff', speed: 60,  cd: 6 }
];
const TECH_KINDS = ['bolt', 'nova', 'heal', 'shield', 'dash', 'summon', 'slam', 'trap', 'beam', 'regen', 'haste', 'ride', 'orb', 'wall', 'jump', 'blink', 'homing', 'lion', 'face', 'meteor', 'spin', 'launch', 'ring'];

/* ---- tinggi tanah (salinan fungsi di client, untuk ledakan peluru di tanah) ---- */
function hash2(x, y) { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function vnoise(x, y) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
function fbm(x, y) { return vnoise(x, y) * 0.6 + vnoise(x * 2.1 + 7.3, y * 2.1 + 1.7) * 0.28 + vnoise(x * 4.3 + 3.1, y * 4.3 + 9.4) * 0.12; }
function sstep(a, b, v) { const t = clampN((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const LAKE = { x: 0, z: -48, R: 11 };
const ARENA = { x: 5000, z: 0, ringR: 38, side: 22, height: 72, standR: 10 };   /* scene stadion terpisah (koordinat interior x>1000, seperti goa) */
const TERRAIN_FLATS = [{ x: 0, z: 0, r: 22, b: 14 }, { x: LAKE.x, z: LAKE.z, r: 16, b: 10 }, { x: -15, z: 87, r: 9, b: 9 },
  { x: 62, z: 34, r: 8, b: 10 }, { x: -70, z: -22, r: 8, b: 10 }, { x: 18, z: -82, r: 8, b: 10 }, { x: 36, z: -28, r: 9, b: 10 }, { x: -48, z: 46, r: 9, b: 10 },
  { x: 62, z: -52, r: 15, b: 9 }, { x: -72, z: -52, r: 15, b: 9 }, { x: 40, z: 78, r: 15, b: 9 },
  { x: 88, z: 0, r: 16, b: 8 }, { x: -90, z: 0, r: 16, b: 8 }, { x: 0, z: -92, r: 16, b: 8 }];
function terrainH(x, z) {
  if (x > 1000) return 0;
  let m = 1;
  for (const f of TERRAIN_FLATS) { const d = Math.hypot(x - f.x, z - f.z); if (d < f.r + f.b) { const t = d <= f.r ? 0 : (d - f.r) / f.b; const s2 = t * t * (3 - 2 * t); if (s2 < m) m = s2; } }
  const hills = (fbm(x * 0.018, z * 0.018) - 0.5) * 22 + (fbm(x * 0.06 + 50, z * 0.06 + 50) - 0.5) * 3;
  const e = clampN((Math.hypot(x, z) - 100) / 42, 0, 1);
  const ld = 5.5 * (1 - sstep(LAKE.R - 5, LAKE.R + 0.5, Math.hypot(x - LAKE.x, z - LAKE.z)));
  const da = Math.hypot(x - ARENA.x, z - ARENA.z), fa = ARENA.ringR + 8; let ma = 1;   /* lantai arena tidak ikut terangkat oleh pegunungan tepi peta */
  if (da < fa + 12) { const t = da <= fa ? 0 : (da - fa) / 12; ma = t * t * (3 - 2 * t); }
  return hills * m + e * e * (3 - 2 * e) * 38 * ma - ld;
}
const BALL_SPEED = TUNING.ballSpeed;   /* semua bola (bolt & orb) melaju 10; jarak jangkau tetap (life disesuaikan) */
const BOLT_GRAVITY = 0.08;

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
      if (ver < 6) {   /* elang tunggangan: 10 detik, cooldown 4x lebih lama */
        for (const t of j.techniques) if (t.kind === 'ride') { if (Number(t.dur) === 70) t.dur = 10; if (Number(t.cd) === 15) t.cd = 60; }
      }
      if (ver < 7) {   /* semua cooldown teknik 4x lebih lama (kecuali elang tunggangan yang sudah dinaikkan) */
        for (const t of j.techniques) {
          if (t.kind === 'ride') continue;
          const d = DEFAULT_TECHS.find(x => x.code === t.code);
          if (d && Number(t.cd) === d.cd) continue;   /* sudah bernilai baru */
          t.cd = Math.min(120, Math.round(Number(t.cd) * 4 * 10) / 10);
        }
      }
      if (ver < 8) for (const d of DEFAULT_TECHS) if (['777', '8181', '2929'].includes(d.code) && !j.techniques.some(t => t.code === d.code)) j.techniques.push(Object.assign({}, d));
      if (ver < 9) {   /* penyeimbangan: damage bola naik, heal 3x (darah 300) */
        const OLD_DMG = { '637': 20, '314': 12, '8472': 38, '4242': 9, '858': 3, '918': 35, '9876': 40 };
        for (const t of j.techniques) {
          const d = DEFAULT_TECHS.find(x => x.code === t.code);
          if (d && OLD_DMG[t.code] !== undefined && Number(t.damage) === OLD_DMG[t.code]) t.damage = d.damage;
        }
      }
      if (ver < 10) {   /* Bola Biru: cooldown 20 dtk, satu hantaman 150 (5x Byte Bolt) */
        for (const t of j.techniques) if (t.code === '858' && t.kind === 'orb') { if ([3, 5].includes(Number(t.damage))) t.damage = 150; if ([8, 2].includes(Number(t.cd))) t.cd = 20; }
      }
      if (ver < 11) for (const d of DEFAULT_TECHS) if (d.code === '6464' && !j.techniques.some(t => t.code === d.code)) j.techniques.push(Object.assign({}, d));
      if (ver < 12) for (const d of DEFAULT_TECHS) if (['8182', '4141', '4343'].includes(d.code) && !j.techniques.some(t => t.code === d.code)) j.techniques.push(Object.assign({}, d));
      if (ver < 13) for (const d of DEFAULT_TECHS) if (['6193', '4827', '5316', '2159'].includes(d.code) && !j.techniques.some(t => t.code === d.code)) j.techniques.push(Object.assign({}, d));
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
    color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#4de1ff',
    cd: num(t.cd, 0.2, 120, 2)
  };
  const desc = cleanName(t.desc, 80); if (desc) out.desc = desc;
  if (['bolt', 'nova', 'beam', 'trap'].includes(kind)) out.stun = num(t.stun, 0, 5, 0);
  if (kind === 'bolt') {
    out.damage = num(t.damage, 0, 100, 20); out.speed = num(t.speed, 5, 80, 24); out.life = num(t.life, 0.3, 4, 1.4);
    out.count = Math.round(num(t.count, 1, 7, 1)); out.spread = num(t.spread, 0, 1, 0);
    out.size = num(t.size, 0.5, 4, 1.6); out.boom = num(t.boom, 0, 10, 3);
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
    out.dur = num(t.dur, 3, 300, 10); out.speed = num(t.speed, 6, 60, 24);
  } else if (kind === 'orb') {
    out.damage = num(t.damage, 0, 300, 150); out.speed = num(t.speed, 3, 40, 11); out.life = num(t.life, 1, 10, 4); out.radius = num(t.radius, 2, 12, 5.5);
  } else if (kind === 'meteor') {
    out.damage = num(t.damage, 0, 100, 45); out.speed = num(t.speed, 15, 80, 34); out.count = Math.round(num(t.count, 1, 6, 3));
    out.size = num(t.size, 0.5, 4, 1.5); out.boom = num(t.boom, 0, 10, 3);
  } else if (kind === 'ring') {
    out.dur = num(t.dur, 1, 20, 5); out.radius = num(t.radius, 2.5, 10, 4); out.hp = num(t.hp, 10, 500, 100);
  } else if (kind === 'launch') {
    out.damage = num(t.damage, 0, 100, 40); out.range = num(t.range, 2, 8, 4.2); out.lift = num(t.lift, 10, 60, 34);
  } else if (kind === 'spin') {
    out.damage = num(t.damage, 0, 100, 28); out.dur = num(t.dur, 0.5, 6, 2); out.radius = num(t.radius, 2, 8, 3.6);
  } else if (kind === 'homing') {
    out.damage = num(t.damage, 0, 100, 30); out.count = Math.round(num(t.count, 1, 4, 2)); out.life = num(t.life, 1, 10, 7);
    out.size = num(t.size, 0.5, 3, 1.3); out.boom = num(t.boom, 0, 8, 2.6); out.turn = num(t.turn, 0.5, 6, 2.5);
  } else if (kind === 'face') {
    out.range = num(t.range, 10, 120, 60);
  } else if (kind === 'lion') {
    out.damage = num(t.damage, 1, 80, 25); out.count = Math.round(num(t.count, 1, 2, 1)); out.dur = num(t.dur, 3, 40, 15); out.speed = num(t.speed, 3, 12, 7); out.hp = Math.round(num(t.hp, 20, 300, 90));
  } else if (kind === 'wall') {
    out.hp = num(t.hp, 10, 500, 120); out.dur = num(t.dur, 2, 15, 6); out.len = num(t.len, 3, 16, 8);
  } else if (kind === 'jump') {
    out.power = num(t.power, 15, 80, 30);
  } else if (kind === 'blink') {
    out.range = num(t.range, 4, 30, 14);
  } else if (kind === 'haste') {
    out.power = num(t.power, 1.1, 2.5, 1.6); out.dur = num(t.dur, 1, 15, 5);
  }
  return out;
}
const techByCode = code => DB.techniques.find(t => t.code === code);
const techPublic = t => ({ code: t.code, name: t.name, kind: t.kind, color: t.color, cd: t.cd });
function techDesc(t) {
  if (t.desc) return t.desc;
  const st = t.stun ? ', beku ' + t.stun + ' dtk' : '';
  switch (t.kind) {
    case 'bolt': return 'Bola lempar ' + t.damage + ' dmg' + (t.count > 1 ? ' x' + t.count : '') + ', meledak saat kena tanah' + st;
    case 'nova': return 'Ledakan radius ' + t.radius + ', ' + t.damage + ' dmg' + st;
    case 'heal': return 'Pulihkan ' + t.damage + ' HP';
    case 'shield': return 'Perisai ' + t.dur + ' dtk, damage -70%';
    case 'dash': return 'Lesat ke arah gerakmu (kiri ya ke kiri), kebal sebentar';
    case 'summon': return 'Panggil ' + t.count + ' elang selama ' + t.dur + ' dtk, ' + t.damage + ' dmg/serangan. Mengejar musuh yang kamu serang. Jangan dipakai saat laga bersama kawan: bisa ikut menyerang kawan';
    case 'ring': return 'Tembok melingkar 360° selama ' + t.dur + ' dtk lalu hancur, bisa dihancurkan (' + t.hp + ' HP per bagian)';
    case 'launch': return 'Cungkil musuh di depan sampai terpental sangat tinggi, ' + t.damage + ' dmg';
    case 'spin': return 'Berputar dengan pedang ' + t.dur + ' dtk, menebas semua musuh sekitar, ' + t.damage + ' dmg per tebasan';
    case 'meteor': return 'Loncat tinggi, menghadap bawah, jatuhkan ' + t.count + ' bola cepat ke bawah, ' + t.damage + ' dmg/bola';
    case 'slam': return 'Lompat tinggi lalu hantam, radius ' + t.radius + ', ' + t.damage + ' dmg';
    case 'trap': return 'Ranjau tak terlihat musuh, tidak hilang sampai meledak, ' + t.damage + ' dmg' + st;
    case 'beam': return 'Sinar tembus ' + t.range + ' m, ' + t.damage + ' dmg' + st;
    case 'regen': return 'Pulih ' + t.damage + ' HP selama ' + t.dur + ' dtk';
    case 'ride': return 'Tunggangi elang terbang ' + t.dur + ' dtk (Lompat naik, Selam turun)';
    case 'orb': return 'Bola biru raksasa radius ' + t.radius + ', ' + t.damage + ' dmg sekali hantam, bisa diarahkan ke atas, bawah, samping';
    case 'homing': return t.count + ' bola pengejar sekaligus, ' + t.damage + ' dmg per bola, membelok mengikuti musuh terdekat';
    case 'face': return 'Langsung menghadap ke lawan terdekat (jarak ' + t.range + ' m), termasuk arah atas/bawah';
    case 'lion': return 'Panggil ' + t.count + ' singa di darat selama ' + t.dur + ' dtk, ' + t.damage + ' dmg/gigitan, ' + t.hp + ' HP';
    case 'wall': return 'Dinding sejauh ' + t.len + ' m di depanmu, tahan ' + t.hp + ' damage atau ' + t.dur + ' dtk, padat tidak tembus pandang, memblokir semua bola & tebasan angin (bisa dilompati)';
    case 'jump': return 'Loncat sangat tinggi (daya ' + t.power + '), bisa melompati dinding';
    case 'blink': return 'Teleport ' + t.range + ' m ke depan';
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
    players: new Map(), doors: new Array(DOOR_COUNT).fill(false), projs: [], mobs: [], traps: [], orbs: [], walls: [], rings: [], sols: [], forts: makeForts(), campNext: {}, later: [], chest: { open: false, reopenAt: 0 }, chatLog: [], voice: r.voice !== false, pick: r.pick === true, debug: r.debug === true,
    nextPid: 1, hour0: 9, t0: now(), tickN: 0
  };
}
function newRuntime(r) { const rt = makeRuntime(r); if (r.mode === 'duel') rt.duel = duelNew(clampN(Math.round(Number(r.team)) || 1, 1, 3), r.ff !== false, r.dmin, r.sdsec, r.drain); else if (r.mode === 'train') rt.train = true; else initBandits(rt); return rt; }
function roomHour(room) { return (room.hour0 + (now() - room.t0) / 1000 * 0.04) % 24; }

function send(ws, obj) { if (ws && !ws.closed) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, exceptId) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.id !== exceptId && p.ws && !p.ws.closed) p.ws.send(s);
}
function scoreList(room) { return [...room.players.values()].map(p => [p.id, p.k, p.d]); }

function spawnFor(room) { return room.duel ? standSpawn() : (room.train ? { x: r2((Math.random() - 0.5) * 4), z: -4 } : randomSpawn()); }
function randomSpawn() {
  const sp = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
  return { x: r2(sp.x + (Math.random() - 0.5) * 10), z: r2(sp.z + (Math.random() - 0.5) * 10) };
}

let projSeq = 1, mobSeq = 1, trapSeq = 1, orbSeq = 1, solSeq = 100000, wallSeq = 1, ringSeq = 1;
const GUARD_WINDOW = 9000, GUARD_MAX = 27, GUARD_BREAK_MS = 2500;
const MAX_TRAPS = 6;
const EAGLE_ORBIT = 10, EAGLE_HEIGHT = 7;   /* elang menunggu mengitari pemilik pada jarak ini (unit), tinggi di atas tanah */

/* ---- target umum: pemain + pasukan benteng ---- */
function victims(room) {
  const a = [];
  for (const p of room.players.values()) if (!p.dead && (!room.duel || duelFighting(room, p))) a.push(p);
  for (const s of room.sols) a.push(s);
  for (const m of room.mobs) a.push({ isMob: true, m, id: m.id, o: m.o, x: m.x, y: m.y - 0.9, z: m.z });
  return a;
}
let CUR = null;
const ffOn = room => !!(room && room.duel && room.duel.ff);   /* friendly fire per room (arena tim) */   /* room yang sedang diproses (untuk cek satu tim di arena) */
function sameTeam(room, aId, bId) { const tm = room && room.duel && room.duel.team; return !!tm && !!tm[aId] && tm[aId] === tm[bId]; }
function friendly(ownerId, v) {
  if (v.isMob) { if (v.o === ownerId) return true; }
  else if (v.id === ownerId || (v.isSol && v.owner === ownerId)) return true;
  return !ffOn(CUR) && sameTeam(CUR, ownerId, v.isMob ? v.o : v.id);
}
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
/* sasaran terbaru dulu: musuh yang kamu serang vs yang menyerangmu */
function focusOrder(o) { const a = [o.focus, o.defFocus].filter(Boolean); if (a.length > 1 && a[1].until > a[0].until) a.reverse(); return a; }
function hurt(room, v, dmg, attacker, kx, kz, opt) {
  if (!ffOn(room) && room.duel && attacker && sameTeam(room, attacker.id, v.isMob ? v.o : v.id)) return;   /* tidak melukai satu tim */
  kx *= KNOCK_MULT; kz *= KNOCK_MULT;
  if (attacker && attacker.ws && v !== attacker && !friendly(attacker.id, v)) attacker.focus = { v, until: now() + 7000 };   /* elang mengincar musuh yang kamu serang */
  /* pembalasan: yang terakhir menyerangmu (atau elangmu) juga jadi sasaran; yang paling baru menang antara ini dan musuh yang kamu serang */
  { const src = (opt && opt.src) || attacker, def = v.isMob ? room.players.get(v.o) : (v.ws ? v : null);
    if (def && src && src !== BANDIT && src !== def && !friendly(def.id, src)) def.defFocus = { v: src, until: now() + 7000 }; }
  if (v.isMob) damageMob(room, v.m, dmg, attacker);
  else if (v.isSol) { if (kx || kz) { v.kx = (v.kx || 0) + kx * 0.6; v.kz = (v.kz || 0) + kz * 0.6; } damageSoldier(room, v, dmg, attacker); }
  else damagePlayer(room, v, dmg, attacker, kx, kz, opt);
}
function damageSoldier(room, s, dmg, attacker) {
  if (s.dead) return;
  if (attacker && friendly(attacker.id, s)) return;
  dmg = Math.max(1, Math.round(dmg));
  s.hp = Math.max(0, s.hp - dmg);
  broadcast(room, { t: 'sh', id: s.id, hp: s.hp, dmg, by: attacker ? attacker.id : 0 });
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
  if (victim.dead) return;
  if (room.duel) { if (!duelFighting(room, victim)) return; if (attacker && attacker.ws && !duelFighting(room, attacker)) return; }
  if (t < victim.invuln) { if (attacker && attacker.ws && t - (victim.invMsgAt || 0) > 250) { victim.invMsgAt = t; broadcast(room, { t: 'hit', id: victim.id, by: attacker.id, dmg: 0, hp: victim.hp, kx: 0, kz: 0, inv: 1 }); } return; }
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
      const gw = opt.gw || (dmg >= 55 ? 3 : 1);   /* serangan berat menghabiskan perisai lebih cepat */
      for (let i = 0; i < gw; i++) victim.gh.push(t);
      if (victim.gh.length < GUARD_MAX) {
        broadcast(room, { t: 'hit', id: victim.id, by: attacker ? attacker.id : 0, dmg: 0, hp: victim.hp, kx: 0, kz: 0, blk: 1, left: GUARD_MAX - victim.gh.length, gmax: GUARD_MAX });
        return;
      }
      victim.guarding = false; victim.gh = []; victim.gbUntil = t + GUARD_BREAK_MS;
      broadcast(room, { t: 'gbreak', id: victim.id });
      broadcast(room, { t: 'guard', id: victim.id, on: false });
    }
  }
  if (t < victim.shield) dmg *= 0.3;
  if (room.duel && room.duel.sd && duelFighting(room, victim)) dmg = Math.max(dmg, victim.hp);   /* SUDDEN DEATH: sekali kena langsung K.O. */
  dmg = Math.max(1, Math.round(dmg));
  victim.hp = Math.max(0, victim.hp - dmg);
  broadcast(room, { t: 'hit', id: victim.id, by: attacker ? attacker.id : 0, dmg, hp: victim.hp, kx: r2(kx || 0), kz: r2(kz || 0), hr: opt.hr ? r2(opt.hr) : 0 });
  if (victim.bot) { victim.kx += kx || 0; victim.kz += kz || 0; }
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

/* bola/panah yang terkena tebasan dipukul balik ke penembaknya dan berpindah ke pemilik tebasan */
function deflectProj(room, pr, by) {
  const sh = room.players.get(pr.o);
  let dx, dy, dz;
  if (sh && !sh.dead) { dx = sh.x - pr.x; dy = (sh.y + 0.9) - pr.y; dz = sh.z - pr.z; } else { dx = -pr.dx; dy = -(pr.dy || 0); dz = -pr.dz; }
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; dx /= l; dy /= l; dz /= l;
  const i = room.projs.indexOf(pr); if (i >= 0) room.projs.splice(i, 1);
  const np = { id: projSeq++, o: by.id, x: pr.x, y: pr.y, z: pr.z, dx, dy, dz, sp: pr.sp * 1.25, life: Math.max(pr.life, 1.6), dmg: pr.dmg, stun: pr.stun, c: pr.c, hr: pr.hr, boom: pr.boom, size: pr.size, grav: pr.grav };
  room.projs.push(np);
  broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), boom: 0, c: pr.c, fizz: 1, sb: 1 });
  broadcast(room, { t: 'pr', id: np.id, x: r2(np.x), y: r2(np.y), z: r2(np.z), dx: r2(dx), dy: r2(dy), dz: r2(dz), sp: np.sp, life: np.life, c: np.c, sz: pr.size || 0.55 });
}
const WAVE = { speed: 17, life: 0.3, dmg: TUNING.waveDmg, hr: 1.25 };   /* tebasan angin: jarak tempuh sekitar 5 unit */
const MELEE_CONE = 0.64;   /* kerucut FPS: cos 50 derajat */
function vName(v) { return v.name || (v.isSol ? (v.bandit ? 'Penyamun' : 'Prajurit') : (v.isMob ? 'Elang' : '?')); }
/* apakah tebasan p (arah fx,fz, ay = arah vertikal bila FPS) mengenai v? */
function meleeCheck(p, v, fx, fz, ay, rb) {
  rb = rb || 0;
  const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
  if (ay !== undefined) {
    /* mode FPS: kerucut 3D mengikuti arah + (atas/bawah) */
    const dy = (v.y + 0.9) - (p.y + 1.45), d3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d3 > MELEE.range + rb + 0.6) return { ok: false, d: d3, why: 'terlalu jauh (' + d3.toFixed(1) + ' > ' + (MELEE.range + rb + 0.6).toFixed(1) + ')' };
    if (d3 > 1.3) {
      const hl = Math.sqrt(Math.max(0.0001, 1 - ay * ay));
      const cs = (dx * fx * hl + dz * fz * hl + dy * ay) / d3;
      if (cs < MELEE_CONE) return { ok: false, d: d3, why: 'di luar arah + (' + Math.round(Math.acos(Math.min(1, cs)) * 180 / Math.PI) + '° dari + , batas 50°)' };
    }
    return { ok: true, d, dx, dz, d3 };
  }
  if (d > MELEE.range + rb) return { ok: false, d, why: 'terlalu jauh (' + d.toFixed(1) + ' > ' + (MELEE.range + rb) + ')' };
  if (Math.abs(v.y - p.y) > 2.8) return { ok: false, d, why: 'selisih tinggi ' + Math.abs(v.y - p.y).toFixed(1) + ' (batas 2.8)' };
  if (d > 0.01 && (dx * fx + dz * fz) / d < -0.1) return { ok: false, d, why: 'ada di belakangmu' };
  return { ok: true, d, dx, dz };
}
function doMelee(room, p, fx, fz, ay) {
  const t = now();
  if (p.dead || t - p.atkAt < (p.atkCd || MELEE.cd) - 60) return;
  if (p.guarding) setGuard(room, p, false);
  if (p.sleeping) setSleep(room, p, false);
  /* kombo 3 tahap: tebasan 1-2 cepat, tebasan 3 (penutup) lebih kuat, jauh, dan jeda lebih lama */
  p.combo = (t - (p.atkAt || 0) > 900 || !p.combo) ? 1 : (p.combo % 3) + 1;
  const cb = p.combo, fin = cb === 3, dm = fin ? 1.6 : 1, rb = fin ? 0.7 : 0;
  p.atkCd = MELEE.cd;   /* 3 tebasan per detik, termasuk penutup kombo */
  p.atkAt = t; p.atkFx = fx; p.atkFz = fz;
  broadcast(room, { t: 'atk', id: p.id, fx, fz, cb });
  let hfSent = false;
  const hf = (v) => { if (hfSent) return; hfSent = true; send(p.ws, { t: 'hf', cb, x: r2(v.x), y: r2(v.y), z: r2(v.z) }); };
  let landed = 0, nearMiss = null;
  const hitIds = new Set();
  for (const v of victims(room)) {
    if (v === p || friendly(p.id, v)) continue;
    const ck = meleeCheck(p, v, fx, fz, ay, rb);
    if (!ck.ok) { if ((room.debug || p.dbg) && ck.d < 10 && (!nearMiss || ck.d < nearMiss.d)) nearMiss = { d: ck.d, why: vName(v) + ': ' + ck.why }; continue; }
    const dx = ck.dx, dz = ck.dz, d = ck.d;
    const nx = d > 0.01 ? dx / d : fx, nz = d > 0.01 ? dz / d : fz;
    if (v.atkAt !== undefined && !v.dead && t - v.atkAt < CLASH_MS && (v.atkFx * -nx + v.atkFz * -nz) > 0.2 && t >= v.invuln) {
      /* pedang beradu: keduanya terpental, tanpa damage */
      broadcast(room, { t: 'clash', a: p.id, b: v.id, ax: r2(-nx * MELEE.knock * 0.8 * KNOCK_MULT), az: r2(-nz * MELEE.knock * 0.8 * KNOCK_MULT), bx: r2(nx * MELEE.knock * 0.8 * KNOCK_MULT), bz: r2(nz * MELEE.knock * 0.8 * KNOCK_MULT) });
      v.atkAt = 0;
      if (room.debug || p.dbg) send(p.ws, { t: 'dbg', ok: 1, msg: 'Bentrok pedang dengan ' + vName(v) });
      landed++;
      continue;
    }
    landed++; hitIds.add(v.id);
    if (room.debug || p.dbg) send(p.ws, { t: 'dbg', ok: 1, msg: 'Kena ' + vName(v) + ' (jarak ' + d.toFixed(1) + ')' });
    hurt(room, v, MELEE.dmg * dm, p, nx * MELEE.knock * dm, nz * MELEE.knock * dm, { sx: -nx, sz: -nz, gw: fin ? 2 : 1 });
    hf(v);
  }
  /* tebasan angin: gelombang pendek yang meluncur sedikit lebih jauh dari jangkauan pedang */
  {
    const ay2 = ay === undefined ? 0 : ay, hl = Math.sqrt(Math.max(0.0001, 1 - ay2 * ay2));
    const wdx = fx * hl, wdz = fz * hl;
    const wv = { id: projSeq++, o: p.id, x: p.x + wdx * 1.7, y: p.y + (ay === undefined ? 1.1 : 1.45) + ay2 * 1.7, z: p.z + wdz * 1.7, dx: wdx, dy: ay2, dz: wdz, sp: WAVE.speed, life: WAVE.life * (fin ? 1.5 : 1), dmg: WAVE.dmg * dm, stun: 0, c: '#cfeeff', hr: WAVE.hr, boom: 0, size: 0, grav: 0, wv: 1, pierce: 3, skip: hitIds };
    room.projs.push(wv);
    broadcast(room, { t: 'pr', id: wv.id, x: r2(wv.x), y: r2(wv.y), z: r2(wv.z), dx: r2(wdx), dy: r2(ay2), dz: r2(wdz), sp: wv.sp, life: wv.life, c: wv.c, sz: 0.55, wv: 1, o: p.id });
  }
  ringHitArea(room, p.x, p.z, MELEE.range, MELEE.dmg, fx, fz);
  if ((room.debug || p.dbg) && !landed) send(p.ws, { t: 'dbg', ok: 0, msg: nearMiss ? 'Meleset: ' + nearMiss.why : 'Meleset: tidak ada target dalam 10 unit' });
  /* tebasan menghancurkan bola yang melintas di depan */
  for (let i = room.projs.length - 1; i >= 0; i--) {
    const pr = room.projs[i];
    if (pr.o === p.id) continue;
    const dx = pr.x - p.x, dz = pr.z - p.z, d = Math.hypot(dx, dz), dy = pr.y - (p.y + 1.3);
    const reach = MELEE.range + 0.8 + (pr.size ? 0.4 * pr.size : 0);
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > reach) continue;
    if (ay !== undefined) {
      const d3 = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d3 > 1.2) { const hl = Math.sqrt(Math.max(0.0001, 1 - ay * ay)); if ((dx * fx * hl + dz * fz * hl + dy * ay) / d3 < 0.6) continue; }
    } else {
      if (Math.abs(dy) > 2.2) continue;
      if (d > 0.01 && (dx * fx + dz * fz) / d < -0.1) continue;
    }
    if (pr.wv) { room.projs.splice(i, 1); broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), boom: 2.2, c: pr.c, g: 0, ds: 1 }); }
    else deflectProj(room, pr, p);
  }
}

function areaHit(room, p, radius, dmg, kb, stun) {
  ringHitArea(room, p.x, p.z, radius, dmg);
  for (const v of victims(room)) {
    if (v === p || friendly(p.id, v)) continue;
    const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
    if (d > radius || Math.abs(v.y - p.y) > 3) continue;
    const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
    hurt(room, v, dmg, p, nx * kb, nz * kb, { area: true, stun });
  }
}

/* ---------- tembok 360 derajat ---------- */
const RING_SEG_R = 1.0;
function ringDamage(room, w, i, dmg) {
  const sg = w.segs[i];
  if (!sg || sg.hp <= 0) return;
  sg.hp = Math.max(0, sg.hp - dmg);
  if (sg.hp <= 0) broadcast(room, { t: 'ringx', id: w.id, i, x: r2(sg.x), z: r2(sg.z) });
  else broadcast(room, { t: 'ringhit', id: w.id, i, hp: Math.round(sg.hp) });
}
/* serangan di titik (x,y,z) bertabrakan dengan bagian tembok? ikut memberi damage. ignoreOwner: peluru pemilik menembus tembok sendiri */
function ringHitAt(room, x, y, z, rad, dmg, ownerId) {
  for (const w of room.rings) {
    if (ownerId !== undefined && w.o === ownerId) continue;
    for (let i = 0; i < w.segs.length; i++) {
      const sg = w.segs[i];
      if (sg.hp <= 0) continue;
      if (Math.hypot(sg.x - x, sg.z - z) > RING_SEG_R + rad) continue;
      if (y < sg.y - 0.5 || y > sg.y + 3.4) continue;
      ringDamage(room, w, i, dmg);
      return true;
    }
  }
  return false;
}
/* serangan area / pedang: semua bagian tembok dalam radius (dan dalam arah serang bila fx diberikan) */
function ringHitArea(room, cx, cz, radius, dmg, fx, fz) {
  for (const w of room.rings) {
    for (let i = 0; i < w.segs.length; i++) {
      const sg = w.segs[i];
      if (sg.hp <= 0) continue;
      const dx = sg.x - cx, dz = sg.z - cz, d = Math.hypot(dx, dz);
      if (d > radius + RING_SEG_R) continue;
      if (fx !== undefined && d > 0.8 && (dx * fx + dz * fz) / d < 0.6) continue;
      ringDamage(room, w, i, dmg);
    }
  }
}
function stepRings(room, t) {
  for (let i = room.rings.length - 1; i >= 0; i--) {
    const w = room.rings[i];
    if (t >= w.until || w.segs.every(sg => sg.hp <= 0)) {
      if (t >= w.until) broadcast(room, { t: 'ringx', id: w.id, i: -1 });
      room.rings.splice(i, 1);
    }
  }
}

/* ---- dinding: memblokir bola/tebasan angin/sinar dari lawan ---- */
const WALL_H = 4, WALL_THICK = 0.9;
function wallRemove(room, w, broke) {
  const i = room.walls.indexOf(w); if (i < 0) return;
  room.walls.splice(i, 1);
  broadcast(room, { t: 'wallx', id: w.id, broke: broke ? 1 : 0 });
}
/* kena dinding? (semua bola tertahan, termasuk milik pembuatnya) kembalikan dinding bila titik (x,y,z) berada di dalamnya */
function wallAt(room, ownerId, x, y, z) {
  for (const w of room.walls) {
    if (y < w.y - 0.5 || y > w.y + WALL_H + 0.3) continue;
    const rx = x - w.x, rz = z - w.z, along = rx * w.tx + rz * w.tz, dist = rx * w.nx + rz * w.nz;
    if (Math.abs(along) <= w.len / 2 + 0.3 && Math.abs(dist) <= WALL_THICK) return w;
  }
  return null;
}
/* bola ketemu bola (beda pemilik, bukan satu tim): dua-duanya hancur */
function ballFoes(room, a, b) { return a !== b && !(!ffOn(room) && room.duel && sameTeam(room, a, b)); }
function isBall(pr) { return pr.size !== undefined && !pr.wv; }
function ballBurst(room, x, y, z, c, id) { broadcast(room, { t: 'px', id, x: r2(x), y: r2(y), z: r2(z), boom: 0, c, fizz: 1, bb: 1 }); }
/* tembok menghalangi badan (pemain, prajurit, penyamun, singa): apakah langkah (x0,z0)->(x1,z1) pada ketinggian y menembus tembok? Yang sudah berada di dalam tembok boleh keluar. */
function wallCrosses(room, x0, z0, x1, z1, y) {
  for (const w of room.walls) {
    if (y < w.y - 2.5 || y >= w.y + WALL_H - 0.35) continue;   /* terlalu rendah, atau melompat di atas tembok */
    const hl = w.len / 2 + 0.3;
    const a0 = (x0 - w.x) * w.tx + (z0 - w.z) * w.tz, d0 = (x0 - w.x) * w.nx + (z0 - w.z) * w.nz;
    const a1 = (x1 - w.x) * w.tx + (z1 - w.z) * w.tz, d1 = (x1 - w.x) * w.nx + (z1 - w.z) * w.nz;
    const in0 = Math.abs(a0) <= hl && Math.abs(d0) <= WALL_THICK, in1 = Math.abs(a1) <= hl && Math.abs(d1) <= WALL_THICK;
    if (in1 && !in0) return w;
    if (d0 * d1 < 0) { const f = d0 / (d0 - d1), ac = a0 + (a1 - a0) * f; if (Math.abs(ac) <= hl) return w; }
  }
  return null;
}
/* gerakkan unit server (darat) dengan tembok sebagai penghalang, meluncur di sepanjang tembok bila bisa */
function wallMove(room, o, nx, nz, yy) {
  if (!room.walls.length) { o.x = nx; o.z = nz; return; }
  const y = yy === undefined ? terrainH(o.x, o.z) : yy;
  if (!wallCrosses(room, o.x, o.z, nx, nz, y)) { o.x = nx; o.z = nz; }
  else if (!wallCrosses(room, o.x, o.z, nx, o.z, y)) o.x = nx;
  else if (!wallCrosses(room, o.x, o.z, o.x, nz, y)) o.z = nz;
}
/* periksa sepanjang lintasan (bukan hanya titik akhir) supaya bola cepat tidak menembus tembok */
function wallCross(room, ownerId, x0, y0, z0, x1, y1, z1) {
  if (!room.walls.length) return null;
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 0.45));
  for (let k = 1; k <= n; k++) { const f = k / n, w = wallAt(room, ownerId, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f); if (w) return w; }
  return null;
}
function wallDamage(room, w, dmg) { w.hp -= dmg; if (w.hp <= 0) wallRemove(room, w, true); else broadcast(room, { t: 'wallh', id: w.id, hp: Math.round(w.hp), max: w.max }); }
function doCast(room, p, slot, ax, ay, az) {
  if (p.dead || slot < 0 || slot >= MAX_TECH_SLOTS) return;
  const code = p.slots[slot];
  if (!code) return;
  const tech = techByCode(code);
  if (!tech) { p.slots[slot] = null; send(p.ws, { t: 'slotclear', slot }); return; }
  const t = now();
  if (t < p.stunUntil) return;
  {
    const cdv = tech.kind === 'face' ? 0 : (tech.kind === 'dash' ? Math.max(tech.cd, TUNING.dashMinCd) : tech.cd) * (room.tune ? room.tune.cd : 1);   /* Kunci Lawan: tanpa cooldown */   /* dash: cooldown min 3 dtk */
    if ((p.cdUntil[code] || 0) > t + 120) return;
    p.cdUntil[code] = t + cdv * 1000;
  }
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
        const size = tech.size || 1.6, boom = tech.boom == null ? 3 : tech.boom;
        const pr = { id: projSeq++, o: p.id, x: p.x + dx * 1.2, y: p.y + 1.55 + by * 1.2, z: p.z + dz * 1.2, dx, dy: by + 0.06, dz, sp: BALL_SPEED, life: tech.life * tech.speed / BALL_SPEED, dmg: tech.damage, stun: tech.stun || 0, c: tech.color, hr: 0.9 + 0.55 * size, boom, size, grav: BOLT_GRAVITY };
        room.projs.push(pr);
        broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(dx), dy: r2(pr.dy), dz: r2(dz), sp: pr.sp, life: pr.life, c: pr.c, sz: size });
      }
      break;
    }
    case 'face': {
      let tg = null, bd = tech.range || 60;
      for (const v of victims(room)) { if (v === p || v.isMob || friendly(p.id, v)) continue; const dd = Math.hypot(v.x - p.x, v.z - p.z); if (dd < bd) { bd = dd; tg = v; } }
      if (tg) {
        const nx = (tg.x - p.x) / (bd || 1), nz = (tg.z - p.z) / (bd || 1);
        p.fx = nx; p.fz = nz;
        const fdy = (tg.y || 0) + 0.9 - (p.y + 1.5), fy = clampN(fdy / (Math.hypot(bd, fdy) || 1), -0.9, 0.9);   /* arah vertikal juga dikunci */
        send(p.ws, { t: 'face', fx: r2(nx), fz: r2(nz), fy: r2(fy) });
        broadcast(room, { t: 'fx', k: 'face', id: p.id, tx: r2(tg.x), tz: r2(tg.z), c: tech.color });
      }
      break;
    }
    case 'lion': {
      const n = tech.count || 1;
      let have = room.mobs.filter(m => m.o === p.id).length;
      for (let i = 0; i < n && have < 4; i++, have++) {
        const mx = p.x + fx * 2.5 + (i - (n - 1) / 2) * 2, mz = p.z + fz * 2.5, hp = tech.hp || 90;
        const m = { id: mobSeq++, o: p.id, k: 'lion', hp, x: mx, y: terrainH(mx, mz) + 1.2, z: mz, fx, fz, until: t + (tech.dur || 15) * 1000, dmg: tech.damage || 25, sp: tech.speed || 7, atkAt: 0, tgt: 0, tgtAt: 0, atkFlag: 0, c: tech.color };
        room.mobs.push(m);
        broadcast(room, { t: 'mob', id: m.id, o: p.id, k: 'lion', hp, x: r2(m.x), y: r2(m.y), z: r2(m.z), c: m.c });
      }
      break;
    }
    case 'homing': {
      const n = tech.count || 2;
      for (let i = 0; i < n; i++) {
        const ang = (i - (n - 1) / 2) * 0.7, cs = Math.cos(ang), sn = Math.sin(ang);
        const dx = bx * cs - bz * sn, dz = bx * sn + bz * cs, size = tech.size || 1.3;
        const pr = { id: projSeq++, o: p.id, x: p.x + dx * 1.2, y: p.y + 1.55 + by * 1.2, z: p.z + dz * 1.2, dx, dy: by, dz, sp: BALL_SPEED, life: tech.life || 7, dmg: tech.damage, stun: 0, c: tech.color, hr: 0.9 + 0.55 * size, boom: tech.boom == null ? 2.6 : tech.boom, size, grav: 0, home: tech.turn || 2.5 };
        room.projs.push(pr);
        broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(dx), dy: r2(pr.dy), dz: r2(dz), sp: pr.sp, life: pr.life, c: pr.c, sz: size });
      }
      break;
    }
    case 'orb': {
      const r = tech.radius || 5.5;
      const orb = { id: orbSeq++, o: p.id, x: p.x + bx * (r + 1), y: p.y + 1.2 + by * (r + 1), z: p.z + bz * (r + 1), dx: bx, dy: by, dz: bz, sp: BALL_SPEED, life: (tech.life || 4) * (tech.speed || 11) / BALL_SPEED, r, dmg: tech.damage, c: tech.color, hit: new Map() };
      room.orbs.push(orb);
      broadcast(room, { t: 'orb', id: orb.id, o: p.id, x: r2(orb.x), y: r2(orb.y), z: r2(orb.z), dx: r2(bx), dy: r2(by), dz: r2(bz), sp: orb.sp, life: orb.life, r, c: orb.c });
      break;
    }
    case 'nova': {
      broadcast(room, { t: 'fx', k: 'nova', id: p.id, r: tech.radius, c: tech.color });
      areaHit(room, p, tech.radius, tech.damage, 14, tech.stun || 0);
      break;
    }
    case 'ring': {
      const R = tech.radius || 4, n = Math.max(8, Math.ceil(2 * Math.PI * R / 1.4)), hp = tech.hp || 100, dur = tech.dur || 5;
      const w = { id: ringSeq++, o: p.id, until: t + dur * 1000, segs: [] };
      const gy = terrainH(p.x, p.z);
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2;
        w.segs.push({ x: p.x + Math.cos(a) * R, z: p.z + Math.sin(a) * R, y: terrainH(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R), hp });
      }
      room.rings.push(w);
      broadcast(room, { t: 'ring', id: w.id, o: p.id, x: r2(p.x), z: r2(p.z), r: R, n, hp, dur, c: tech.color });
      break;
    }
    case 'launch': {
      const rng = tech.range || 4.2, lift = tech.lift || 34;
      broadcast(room, { t: 'fx', k: 'uppercut', id: p.id, fx: r2(fx), fz: r2(fz), c: tech.color });
      for (const v of victims(room)) {
        if (v === p || friendly(p.id, v)) continue;
        const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
        if (d > rng || Math.abs(v.y - p.y) > 2.5) continue;
        if (d > 0.8 && (dx * fx + dz * fz) / d < 0.3) continue;
        const nx = d > 0.01 ? dx / d : fx, nz = d > 0.01 ? dz / d : fz;
        const blocked = !v.isMob && !v.isSol && (t < v.invuln || v.guarding);
        hurt(room, v, tech.damage, p, nx * 5, nz * 5, { sx: -nx, sz: -nz });
        if (!blocked && !v.isMob && !v.isSol && !v.dead) broadcast(room, { t: 'fx', k: 'launch', id: v.id, vy: lift, c: tech.color });
      }
      break;
    }
    case 'spin': {
      const dur = tech.dur || 2, rad = tech.radius || 3.6;
      broadcast(room, { t: 'fx', k: 'spin', id: p.id, dur, r: rad, c: tech.color });
      for (let i = 1; i <= Math.floor(dur / 0.25); i++) {
        room.later.push({ at: t + i * 250, fn: () => {
          if (!room.players.has(p.id) || p.dead) return;
          areaHit(room, p, rad, tech.damage, 12, 0);
        } });
      }
      break;
    }
    case 'meteor': {
      const n = tech.count || 3, size = tech.size || 1.5, boom = tech.boom == null ? 3 : tech.boom;
      broadcast(room, { t: 'fx', k: 'meteor', id: p.id, c: tech.color });
      for (let i = 0; i < n; i++) {
        room.later.push({ at: t + 1000 + i * 170, fn: () => {
          if (!room.players.has(p.id) || p.dead) return;
          const pr = { id: projSeq++, o: p.id, x: p.x, y: p.y + 0.9, z: p.z, dx: 0, dy: -1, dz: 0, sp: tech.speed, life: 2, dmg: tech.damage, stun: 0, c: tech.color, hr: 0.9 + 0.55 * size, boom, size, grav: 0 };
          room.projs.push(pr);
          broadcast(room, { t: 'pr', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: 0, dy: -1, dz: 0, sp: pr.sp, life: pr.life, c: pr.c, sz: size });
        } });
      }
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
      let len = tech.range || 28;
      if (room.duel) { const ox = p.x - ARENA.x, oz = p.z - ARENA.z, bq = ox * fx + oz * fz, cq = ox * ox + oz * oz - ARENA.ringR * ARENA.ringR, disc = bq * bq - cq; if (disc >= 0) len = Math.min(len, Math.max(0, -bq + Math.sqrt(disc))); }
      for (const w of [...room.walls]) {
        if (w.o === p.id || sameTeam(room, w.o, p.id)) continue;
        const den = fx * w.nx + fz * w.nz; if (Math.abs(den) < 0.001) continue;
        const tt = ((w.x - p.x) * w.nx + (w.z - p.z) * w.nz) / den;
        if (tt > 0 && tt < len && Math.abs((p.x + fx * tt - w.x) * w.tx + (p.z + fz * tt - w.z) * w.tz) <= w.len / 2 + 0.3) { len = tt; wallDamage(room, w, tech.damage); }
      }
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
        const m = { id: mobSeq++, o: p.id, k: 'eagle', hp: MOB_HP, x: p.x + (i - (n - 1) / 2) * 1.6, y: p.y + 3, z: p.z, fx, fz, until: t + tech.dur * 1000, dmg: tech.damage, sp: (tech.speed || 12) * TUNING.eagleSpeedMul, atkAt: 0, tgt: 0, tgtAt: 0, atkFlag: 0, c: tech.color };
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
      broadcast(room, { t: 'fx', k: 'ride', id: p.id, dur: tech.dur, pw: (tech.speed || 24) * TUNING.eagleSpeedMul, c: tech.color });
      break;
    }
    case 'wall': {
      const mine = room.walls.filter(w => w.o === p.id);
      if (mine.length >= 3) wallRemove(room, mine[0], false);
      const dist = 4.5, w = { id: wallSeq++, o: p.id, x: p.x + fx * dist, z: p.z + fz * dist, y: p.y, nx: fx, nz: fz, tx: -fz, tz: fx, len: tech.len || 8, hp: tech.hp || 120, max: tech.hp || 120, c: tech.color, until: t + (tech.dur || 6) * 1000 };
      room.walls.push(w);
      broadcast(room, { t: 'wall', id: w.id, o: p.id, x: r2(w.x), z: r2(w.z), y: r2(w.y), nx: r2(fx), nz: r2(fz), len: w.len, hp: w.hp, dur: tech.dur || 6, c: tech.color });
      break;
    }
    case 'jump': {
      broadcast(room, { t: 'fx', k: 'hjump', id: p.id, pw: tech.power || 30, c: tech.color });
      if (p.bot) p.vy = tech.power || 30;
      break;
    }
    case 'blink': {
      let x = p.x + fx * (tech.range || 14), z = p.z + fz * (tech.range || 14);
      if (room.duel) { const rd = Math.hypot(x - ARENA.x, z - ARENA.z), lim = ARENA.ringR - 1.5; if (rd > lim) { x = ARENA.x + (x - ARENA.x) / rd * lim; z = ARENA.z + (z - ARENA.z) / rd * lim; } }
      broadcast(room, { t: 'fx', k: 'blink', id: p.id, x0: r2(p.x), z0: r2(p.z), x1: r2(x), z1: r2(z), c: tech.color });
      teleportTo(p, x, z, fx, fz);
      break;
    }
    case 'dash': {
      if (t - (p.lastDash || 0) > 700) p.invuln = Math.max(p.invuln, t + 350);   /* spam dash tidak memberi kebal terus-menerus */
      p.lastDash = t;
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
function solPublic(s) { return { id: s.id, fort: s.fort, kind: s.kind, x: r2(s.x), z: r2(s.z), hp: s.hp, max: s.max, owner: s.owner, ch: s.ch, bandit: s.bandit ? 1 : 0, nm: s.nm || undefined }; }
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
      const d = Math.hypot(v.x - s.x, v.z - s.z);
      if (Math.hypot(v.x - c.x, v.z - c.z) > BANDIT_AGGRO && d > BANDIT_SEE) continue;
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
          if (t >= s.atkAt && Math.abs(best.y - s.y) < 2.6) { s.atkAt = t + sp.cd; s.atkFlag = 1; hurt(room, best, sp.dmg, BANDIT, s.fx * 5, s.fz * 5, { sx: -s.fx, sz: -s.fz, src: s }); }
        }
      } else {
        if (d > sp.range) { tx = best.x; tz = best.z; speed = sp.speed; }
        else if (d < 6) { tx = s.x - s.fx * 3; tz = s.z - s.fz * 3; speed = sp.speed; }
        else { tx = s.x; tz = s.z; }
        if (d < sp.range + 4 && t >= s.atkAt) {
          s.atkAt = t + sp.cd; s.atkFlag = 1;
          const dyy = clampN((best.y + 0.9 - (s.y + 1.1)) / d, -0.3, 0.3), hl = Math.sqrt(1 - dyy * dyy);
          const pr = { id: projSeq++, o: BANDIT_OWNER, x: s.x + s.fx * 0.8, y: s.y + 1.1, z: s.z + s.fz * 0.8, dx: s.fx * hl, dy: dyy, dz: s.fz * hl, sp: sp.arrow, life: 1.3, dmg: sp.dmg, stun: 0, c: '#b0764a' };
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
      wallMove(room, s, nx, nz);
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
          if (t >= s.atkAt && Math.abs(best.y - s.y) < 2.6) { s.atkAt = t + sp.cd; s.atkFlag = 1; hurt(room, best, sp.dmg, owner, s.fx * 5, s.fz * 5, { sx: -s.fx, sz: -s.fz, src: s }); }
        }
      } else {
        if (d > sp.range) { tx = best.x; tz = best.z; speed = sp.speed; }
        else if (d < 6) { tx = s.x - s.fx * 3; tz = s.z - s.fz * 3; speed = sp.speed; }
        else { tx = s.x; tz = s.z; }
        if (d < sp.range + 4 && t >= s.atkAt) {
          s.atkAt = t + sp.cd; s.atkFlag = 1;
          const dyy = clampN((best.y + 0.9 - (s.y + 1.1)) / d, -0.3, 0.3), hl = Math.sqrt(1 - dyy * dyy);
          const pr = { id: projSeq++, o: s.owner, x: s.x + s.fx * 0.8, y: s.y + 1.1, z: s.z + s.fz * 0.8, dx: s.fx * hl, dy: dyy, dz: s.fz * hl, sp: sp.arrow, life: 1.3, dmg: sp.dmg, stun: 0, c: '#d9b27a' };
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
      wallMove(room, s, nx, nz);
      if (!best) { s.fx = ddx / dd; s.fz = ddz / dd; }
    }
  }
}

function stepRoom(room, dt, t) {
  CUR = room;
  /* peluru / bola / anak panah */
  /* gelombang angin memukul balik bola yang dilewatinya */
  for (const w of room.projs.filter(q => q.wv)) {
    const ow = room.players.get(w.o); if (!ow) continue;
    for (const b of room.projs.filter(q => !q.wv && q.o !== w.o)) {
      const dx = b.x - w.x, dy = b.y - w.y, dz = b.z - w.z, rr = 1.8 + (b.size ? 0.3 * b.size : 0);
      if (dx * dx + dy * dy + dz * dz < rr * rr) deflectProj(room, b, ow);
    }
  }
  /* tebasan angin ketemu tebasan angin lawan: keduanya hancur (bola tetap dipukul balik, tebasannya tidak hancur) */
  {
    const ws = room.projs.filter(q => q.wv);
    if (ws.length > 1) {
      const dead = new Set();
      for (let a = 0; a < ws.length; a++) for (let b = a + 1; b < ws.length; b++) {
        const w1 = ws[a], w2 = ws[b];
        if (dead.has(w1) || dead.has(w2) || !ballFoes(room, w1.o, w2.o)) continue;
        if ((w1.x - w2.x) ** 2 + (w1.y - w2.y) ** 2 + (w1.z - w2.z) ** 2 > 2.2 * 2.2) continue;
        dead.add(w1); dead.add(w2); ballBurst(room, w1.x, w1.y, w1.z, w1.c, w1.id); ballBurst(room, w2.x, w2.y, w2.z, w2.c, w2.id);
      }
      if (dead.size) room.projs = room.projs.filter(q => !dead.has(q));
    }
  }
  for (let i = room.projs.length - 1; i >= 0; i--) {
    const pr = room.projs[i];
    if (pr.home) {   /* bola pengejar: membelok ke musuh terdekat */
      let tg = null, bd = 45;
      for (const v of victims(room)) { if (friendly(pr.o, v) || v.isMob) continue; const dd = Math.hypot(v.x - pr.x, v.y + 0.9 - pr.y, v.z - pr.z); if (dd < bd) { bd = dd; tg = v; } }
      if (tg) {
        const ex = tg.x - pr.x, ey = tg.y + 0.9 - pr.y, ez = tg.z - pr.z, el = Math.hypot(ex, ey, ez) || 1, k = Math.min(1, pr.home * dt);
        let nx = pr.dx + (ex / el - pr.dx) * k, ny = (pr.dy || 0) + (ey / el - (pr.dy || 0)) * k, nz = pr.dz + (ez / el - pr.dz) * k;
        const nl = Math.hypot(nx, ny, nz) || 1; pr.dx = nx / nl; pr.dy = ny / nl; pr.dz = nz / nl;
      }
      pr.hn = (pr.hn || 0) + 1;
      if (pr.hn % 3 === 0) broadcast(room, { t: 'prd', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), dx: r2(pr.dx), dy: r2(pr.dy), dz: r2(pr.dz) });
    }
    if (pr.grav) pr.dy -= pr.grav / Math.max(1, pr.sp) * dt;
    const ox0 = pr.x, oy0 = pr.y, oz0 = pr.z;
    pr.x += pr.dx * pr.sp * dt; pr.y += (pr.dy || 0) * pr.sp * dt; pr.z += pr.dz * pr.sp * dt; pr.life -= dt;
    {
      const w = wallCross(room, pr.o, ox0, oy0, oz0, pr.x, pr.y, pr.z);
      if (w) {
        wallDamage(room, w, pr.dmg || 10);
        broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), boom: 0, c: pr.c, fizz: 1 });
        room.projs.splice(i, 1);
        continue;
      }
    }
    if (isBall(pr)) {
      let clash = false;
      for (let j = room.projs.length - 1; j > i; j--) {
        const q = room.projs[j];
        if (!isBall(q) || !ballFoes(room, pr.o, q.o)) continue;
        const rr = ((pr.hr || 1.35) + (q.hr || 1.35)) * 0.6;
        if ((pr.x - q.x) ** 2 + ((pr.y || 0) - (q.y || 0)) ** 2 + (pr.z - q.z) ** 2 > rr * rr) continue;
        ballBurst(room, q.x, q.y, q.z, q.c, q.id); room.projs.splice(j, 1);
        ballBurst(room, pr.x, pr.y, pr.z, pr.c, pr.id); room.projs.splice(i, 1);
        clash = true; break;
      }
      if (clash) continue;
    }
    let hit = null;
    const hr = pr.hr || 1.35;
    for (const v of victims(room)) {
      if (friendly(pr.o, v) || (pr.skip && pr.skip.has(v.id))) continue;
      if (Math.hypot(v.x - pr.x, v.z - pr.z) < hr && Math.abs((v.y + 0.9) - pr.y) < hr + 0.05) { hit = v; break; }
    }
    if (hit && !pr.wv && hit.guarding && !hit.isMob && !hit.isSol && hit.fx !== undefined && (hit.fx * -pr.dx + hit.fz * -pr.dz) > 0.15) {
      /* kena perisai: bola dipantulkan balik ke arah penembak */
      const nx = -pr.dx, nz = -pr.dz, hl2 = Math.hypot(nx, nz) || 1;
      room.projs.splice(i, 1);
      const np = { id: projSeq++, o: hit.id, x: hit.x + nx / hl2 * 1.5, y: pr.y, z: hit.z + nz / hl2 * 1.5, dx: nx, dy: -(pr.dy || 0) * 0.5 + 0.03, dz: nz, sp: pr.sp, life: Math.max(pr.life, 1.4), dmg: pr.dmg, stun: pr.stun, c: pr.c, hr: pr.hr, boom: pr.boom, size: pr.size, grav: pr.grav };
      room.projs.push(np);
      broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), boom: 0, c: pr.c, fizz: 1, rf: 1 });
      broadcast(room, { t: 'pr', id: np.id, x: r2(np.x), y: r2(np.y), z: r2(np.z), dx: r2(np.dx), dy: r2(np.dy), dz: r2(np.dz), sp: np.sp, life: np.life, c: np.c, sz: pr.size || 0.55 });
      continue;
    }
    const br = pr.size ? 0.5 * pr.size : 0.15;
    const gy = Math.max(terrainH(pr.x, pr.z), terrainH(pr.x + pr.dx * br, pr.z + pr.dz * br));
    const ground = pr.y - br <= gy;
    /* dinding dan langit-langit transparan arena: serangan meledak di dinding */
    let wall = false;
    if (!hit && !ground && ringHitAt(room, pr.x, pr.y, pr.z, br, pr.dmg || 10, pr.o)) wall = true;
    if (room.duel && !hit && !ground && !wall) {
      const wd = Math.hypot(pr.x - ARENA.x, pr.z - ARENA.z);
      if (wd > ARENA.ringR - br * 0.5) { wall = true; const k = (ARENA.ringR - br * 0.5) / wd; pr.x = ARENA.x + (pr.x - ARENA.x) * k; pr.z = ARENA.z + (pr.z - ARENA.z) * k; }
      else if (pr.y > ARENA.height) { wall = true; pr.y = ARENA.height; }
    }
    if (hit && pr.wv && !ground && !wall && pr.pierce > 1) {   /* tebasan angin tembus sampai 3 target */
      const ow = room.players.get(pr.o) || null;
      hurt(room, hit, pr.dmg, ow, pr.dx * 12, pr.dz * 12, { sx: -pr.dx, sz: -pr.dz, stun: 0, hr: 0 });
      pr.skip.add(hit.id); pr.pierce--;
      continue;
    }
    if (hit || ground || wall) {
      const owner = pr.o === BANDIT_OWNER ? BANDIT : (room.players.get(pr.o) || null);
      if (hit) hurt(room, hit, pr.dmg, owner, pr.dx * (pr.wv ? 12 : 26), pr.dz * (pr.wv ? 12 : 26), { sx: -pr.dx, sz: -pr.dz, stun: pr.stun, hr: pr.wv ? 0 : (pr.hr || 1.35) });
      const bm = pr.boom || 0;
      if (bm > 0) {
        for (const v of victims(room)) {
          if (v === hit || friendly(pr.o, v)) continue;
          const dx = v.x - pr.x, dy = v.y + 0.9 - pr.y, dz = v.z - pr.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > bm) continue;
          const f = 1 - d / bm * 0.6, hl = Math.hypot(dx, dz) || 1;
          hurt(room, v, pr.dmg * 0.6 * f, owner, dx / hl * 16 * f, dz / hl * 16 * f, { area: true, stun: pr.stun });
        }
      }
      broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(ground ? gy + 0.15 : pr.y), z: r2(pr.z), boom: bm, c: pr.c, g: ground ? 1 : 0, wl: wall ? 1 : 0 });
      room.projs.splice(i, 1);
    } else if (pr.life <= 0) {
      broadcast(room, { t: 'px', id: pr.id, x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), boom: 0, c: pr.c, fizz: 1 });
      room.projs.splice(i, 1);
    }
  }
  for (const w of [...room.walls]) if (t >= w.until) wallRemove(room, w, false);
  /* bola biru raksasa */
  for (let i = room.orbs.length - 1; i >= 0; i--) {
    const o = room.orbs[i], owner = room.players.get(o.o);
    const ox0 = o.x, oy0 = o.y, oz0 = o.z;
    o.x += o.dx * o.sp * dt; o.y += o.dy * o.sp * dt; o.z += o.dz * o.sp * dt; o.life -= dt;
    { const w = wallCross(room, o.o, ox0, oy0, oz0, o.x, o.y, o.z); if (w) { wallDamage(room, w, o.dmg || 10); room.orbs.splice(i, 1); broadcast(room, { t: 'orbx', id: o.id }); continue; } }   /* bola biru juga tertahan tembok */
    if (!owner || o.life <= 0 || (room.duel && (Math.hypot(o.x - ARENA.x, o.z - ARENA.z) > ARENA.ringR || o.y > ARENA.height))) { room.orbs.splice(i, 1); broadcast(room, { t: 'orbx', id: o.id }); continue; }
    {   /* Bola Biru bentrok dengan bola lain (bola biasa atau Bola Biru lawan): keduanya hancur */
      let clash = false;
      for (let j = room.projs.length - 1; j >= 0 && !clash; j--) {
        const q = room.projs[j];
        if (!isBall(q) || !ballFoes(room, o.o, q.o)) continue;
        if ((q.x - o.x) ** 2 + ((q.y || 0) - o.y) ** 2 + (q.z - o.z) ** 2 > (o.r + 0.5) * (o.r + 0.5)) continue;
        ballBurst(room, q.x, q.y, q.z, q.c, q.id); room.projs.splice(j, 1); clash = true;
      }
      for (let j = room.orbs.length - 1; j > i && !clash; j--) {
        const q = room.orbs[j];
        if (!ballFoes(room, o.o, q.o)) continue;
        const rr = (o.r + q.r) * 0.7;
        if ((q.x - o.x) ** 2 + (q.y - o.y) ** 2 + (q.z - o.z) ** 2 > rr * rr) continue;
        room.orbs.splice(j, 1); broadcast(room, { t: 'orbx', id: q.id }); clash = true;
      }
      if (clash) { room.orbs.splice(i, 1); broadcast(room, { t: 'orbx', id: o.id }); continue; }
    }
    for (const v of victims(room)) {
      if (friendly(o.o, v)) continue;
      const dx = v.x - o.x, dy = v.y + 0.9 - o.y, dz = v.z - o.z;
      if (dx * dx + dy * dy + dz * dz > (o.r + 0.5) * (o.r + 0.5)) continue;
      if (t < (o.hit.get(v.id) || 0)) continue;
      o.hit.set(v.id, Infinity);   /* satu hantaman besar per target */
      hurt(room, v, o.dmg, owner, o.dx * 5, o.dz * 5, { area: true });
    }
  }
  /* mob elang (dan singa) */
  for (let i = room.mobs.length - 1; i >= 0; i--) {
    const m = room.mobs[i], owner = room.players.get(m.o);
    if (!owner || t > m.until) { room.mobs.splice(i, 1); broadcast(room, { t: 'mobx', id: m.id }); continue; }
    if (m.k === 'lion') { lionStep(room, m, owner, dt, t); continue; }
    /* sasaran = musuh yang terakhir kamu serang atau yang terakhir menyerangmu (7 dtk); tanpa sasaran elang mengitari jauh dari kamu supaya tidak mengganggu */
    let tg = null, tp = null;
    /* utamakan musuh yang KAMU serang (bukan yang paling dekat); yang menyerangmu juga jadi sasaran, yang paling baru menang */
    for (const fo of focusOrder(owner)) {
      if (!fo || t >= fo.until) continue;
      const fv = fo.v;
      let alive = false, q = null;
      if (fv.isMob) { alive = room.mobs.includes(fv.m); q = alive ? { x: fv.m.x, y: fv.m.y - 0.9, z: fv.m.z } : null; }
      else if (fv.isSol) { alive = !fv.dead && room.sols.includes(fv); q = alive ? { x: fv.x, y: fv.y || 0, z: fv.z } : null; }
      else { alive = !fv.dead && room.players.get(fv.id) === fv && (!room.duel || duelFighting(room, fv)); q = alive ? { x: fv.x, y: fv.y, z: fv.z } : null; }
      if (alive && Math.hypot(q.x - m.x, q.z - m.z) < 90 && q.x < 1000 === owner.x < 1000) { tg = fv; tp = q; break; }
    }
    let tx, ty, tz;
    if (tg) { tx = tp.x; tz = tp.z; ty = tp.y + 2.6; }
    else { const a = t / 1600 + m.id * 2.1, r = EAGLE_ORBIT + 1.5 * Math.sin(t / 2300 + m.id); tx = owner.x + Math.cos(a) * r; tz = owner.z + Math.sin(a) * r; ty = owner.y + EAGLE_HEIGHT; }
    const dx = tx - m.x, dz = tz - m.z, dist = Math.hypot(dx, dz);
    const sp = m.sp * (dist > 12 ? 1.5 : 1), step = Math.min(dist, sp * dt);
    if (dist > 0.05) { m.x += dx / dist * step; m.z += dz / dist * step; }
    if (dist > 0.3) { m.fx = dx / dist; m.fz = dz / dist; }
    if (tg && dist < 4) ty = tp.y + 1.0;
    m.y += (ty - m.y) * Math.min(1, 6 * dt);
    if (tg && dist < 2.2 && Math.abs(m.y - (tp.y + 0.9)) < 2.4 && t >= m.atkAt) {
      m.atkAt = t + 1300; m.atkFlag = 1;
      const ddx = m.x - tp.x, ddz = m.z - tp.z, dd = Math.hypot(ddx, ddz);
      hurt(room, tg, m.dmg, owner, m.fx * 5, m.fz * 5, dd > 0.3 ? { sx: ddx / dd, sz: ddz / dd } : {});
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
  if (!room.duel) stepForts(room, dt, t);
  for (const s of room.sols) s.y = terrainH(s.x, s.z);   /* prajurit/penyamun mengikuti tinggi tanah (dulu selalu 0, jadi di bukit tidak bisa kena dan tidak bisa memukul) */
  for (const s of room.sols) { if (s.kx || s.kz) { wallMove(room, s, s.x + s.kx * dt, s.z + s.kz * dt); const dk = Math.exp(-9 * dt); s.kx *= dk; s.kz *= dk; if (Math.abs(s.kx) + Math.abs(s.kz) < 0.3) s.kx = s.kz = 0; } }
  if (room.duel) duelTick(room, t, dt); else if (room.train) trainTick(room, dt, t); else stepBandits(room, dt, t);
  stepRings(room, t);
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
    if (p.dead && !p.bot && t >= p.respawnAt) {
      const s = spawnFor(room);
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

/* ====================================================================
 *  ARENA DUEL 1 vs 1 (yang menang tetap, yang kalah antri lagi)
 * ==================================================================== */
const DUEL_COUNT_MS = 3500, DUEL_OVER_MS = 2800;
/* batas waktu pertandingan (menit, diatur per room di admin, maks 20): setelah itu -> SUDDEN DEATH (sekali kena langsung K.O.) selama DUEL_SD_MS;
   bila masih belum ada yang gugur -> darah semua petarung terkuras cepat sampai tersisa satu */
const DUEL_DEFAULT_MIN = 5, DUEL_MAX_MIN = 20, DUEL_SD_DEFAULT = 60;   /* sudden death: detik (10-300) */
const DUEL_DRAIN = { slow: 20, mid: 40, fast: 80 };   /* kecepatan darah terkuras (HP per detik) */
const normSd = v => clampN(Math.round(Number(v)) || DUEL_SD_DEFAULT, 10, 300);
const normDrain = v => (DUEL_DRAIN[v] ? v : 'mid');
function standSpawn() {
  const a = Math.random() * Math.PI * 2, r = ARENA.ringR + 3.5 + Math.random() * 5;
  return { x: r2(ARENA.x + Math.cos(a) * r), z: r2(ARENA.z + Math.sin(a) * r) };
}
function duelNew(size, ff, dmin, sdsec, drain) { return { size: size || 1, ff: ff !== false, dmin: clampN(Math.round(Number(dmin)) || DUEL_DEFAULT_MIN, 1, DUEL_MAX_MIN), sdsec: normSd(sdsec), drain: normDrain(drain), limit: 0, sdMs: 0, drainRate: 40, teamA: [], teamB: [], team: {}, out: {}, queue: [], st: 'wait', until: 0, fightAt: 0, ph: 0, sd: false, streak: {}, total: {}, best: {}, names: {}, last: null, aloneAt: 0 }; }
function duelFighting(room, p) { const d = room.duel; return !!d && d.st === 'fight' && !!d.team[p.id] && !d.out[p.id]; }
function duelMembers(room, side) { const d = room.duel; return d[side].map(id => room.players.get(id)).filter(Boolean); }
function duelRebuild(room) {
  const d = room.duel; d.team = {};
  for (const side of ['teamA', 'teamB']) { d[side] = d[side].filter(id => room.players.has(id)); for (const id of d[side]) d.team[id] = side === 'teamA' ? 'a' : 'b'; }
  for (const id of Object.keys(d.out)) if (!d.team[id]) delete d.out[id];
}
function duelState(room) {
  const d = room.duel;
  const P = id => { const q = room.players.get(id); return q ? { id, name: q.name, w: d.streak[id] || 0, o: d.out[id] ? 1 : 0, bot: q.bot ? 1 : 0 } : null; };
  const ta = d.teamA.map(P).filter(Boolean), tb = d.teamB.map(P).filter(Boolean);
  const top = Object.keys(d.total).map(id => ({ name: d.names[id] || '?', n: d.total[id], best: d.best[id] || 0 })).sort((x, y) => y.n - x.n || y.best - x.best).slice(0, 3);
  return { t: 'duel', size: d.size, top, st: d.st, ta, tb, a: ta[0] || null, b: tb[0] || null, q: d.queue.map(id => { const q = room.players.get(id); return q ? { id, name: q.name } : null; }).filter(Boolean), ms: Math.max(0, d.until - now()), ph: d.ph || 0, tl: d.st === 'fight' ? duelPhaseLeft(d) : 0, last: d.last };
}
/* sisa waktu (ms) sampai fase berikutnya; 0 pada fase terakhir */
function duelPhaseLeft(d) {
  const el = now() - d.fightAt;
  if (d.ph === 0) return Math.max(0, d.limit - el);
  if (d.ph === 1) return Math.max(0, d.limit + d.sdMs - el);
  return 0;
}
/* petarung gugur karena darah terkuras (tanpa penyerang) */
function duelKill(room, p) {
  p.hp = 0; p.dead = true; p.respawnAt = now() + RESPAWN_MS; p.d++;
  if (p.ammo) setAmmo(p, 0);
  if (p.guarding) { p.guarding = false; broadcast(room, { t: 'guard', id: p.id, on: false }); }
  broadcast(room, { t: 'hp', id: p.id, hp: 0 });
  broadcast(room, { t: 'die', id: p.id, name: p.name, by: 0, byName: '', ms: RESPAWN_MS });
  broadcast(room, { t: 'sc', s: scoreList(room) });
}
/* fase akhir: semua petarung kehilangan darah cepat; yang darahnya paling banyak ditahan di 1 HP supaya tersisa satu */
function duelDrain(room, d, mA, mB, dt) {
  const fs = [...mA, ...mB].filter(p => !p.dead && !d.out[p.id]);
  if (fs.length < 2) return;
  let keep = fs[0]; for (const p of fs) if (p.hp > keep.hp) keep = p;
  for (const p of fs) {
    p.drainAcc = (p.drainAcc || 0) + d.drainRate * dt;
    const w = Math.floor(p.drainAcc); if (w < 1) continue;
    p.drainAcc -= w;
    const nh = p.hp - w;
    if (p === keep) { p.hp = Math.max(1, nh); broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); }
    else if (nh <= 0) duelKill(room, p);
    else { p.hp = nh; broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); }
  }
}
function duelBroadcast(room) { broadcast(room, duelState(room)); }
function teleportTo(p, x, z, fx, fz) {
  p.x = x; p.y = 0; p.z = z; p.fx = fx; p.fz = fz; p.tpUntil = now() + 350;
  send(p.ws, { t: 'tp', x: r2(x), z: r2(z), fx: r2(fx), fz: r2(fz) });
}
/* posisi awal: tim a di kiri, tim b di kanan, berjajar menurut jumlah anggota */
function duelSide(which, idx, n) {
  const zo = ((idx || 0) - ((n || 1) - 1) / 2) * 4.5;
  return which === 'a' ? { x: ARENA.x - ARENA.side, z: ARENA.z + zo, fx: 1, fz: 0 } : { x: ARENA.x + ARENA.side, z: ARENA.z + zo, fx: -1, fz: 0 };
}
/* bersihkan peluru/bola/ranjau; elang pemilik yang ikut bertanding tetap ada */
function duelClearCombat(room) {
  const d = room.duel;
  room.projs = [];
  for (const w of [...room.walls]) wallRemove(room, w, false);
  room.mobs = room.mobs.filter(m => { if (d.team[m.o]) return true; broadcast(room, { t: 'mobx', id: m.id }); return false; });
  for (const o of room.orbs) broadcast(room, { t: 'orbx', id: o.id });
  room.orbs = [];
  for (const tr of room.traps) broadcast(room, { t: 'trapx', id: tr.id, x: r2(tr.x), y: r2(tr.y), z: r2(tr.z) });
  room.traps = [];
}
function duelRefresh(room, p) {
  p.hp = MAXHP; p.dead = false; p.shield = 0; p.stunUntil = 0; p.regenUntil = 0; p.gbUntil = 0; p.invuln = 0; p.cdUntil = {};
  if (p.guarding) setGuard(room, p, false);
  broadcast(room, { t: 'hp', id: p.id, hp: p.hp });
}
function duelNextAlive(room) {
  const d = room.duel;
  for (let i = 0; i < d.queue.length; i++) { const q = room.players.get(d.queue[i]); if (q && !q.dead) { d.queue.splice(i, 1); return q.id; } }
  return 0;
}
/* ---- lawan komputer: pemain virtual (tanpa koneksi) yang memakai tebasan/kombo, teknik, lompat, dash, dan perisai seperti pemain ---- */
function duelBotSpawn(room, side) {
  const sb = duelSide(side === 'teamA' ? 'a' : 'b', 0, 1);
  const p = {
    id: room.nextPid++, uid: 'bot', name: 'Komputer ' + (1 + [...room.players.values()].filter(q => q.bot).length), ch: Math.floor(Math.random() * 4), ws: null, room, bot: true,
    x: sb.x, y: 0, z: sb.z, fx: sb.fx, fz: sb.fz, m: 0, a: 0, sw: 0, hp: MAXHP, k: 0, d: 0, dead: false, respawnAt: 0,
    invuln: 0, shield: 0, atkAt: 0, slots: ['637', '8472', '753', '481', '5551'], cdUntil: {},
    guarding: false, gh: [], gbUntil: 0, stunUntil: 0, regenUntil: 0, regenRate: 0, regenAcc: 0, rideUntil: 0, sleeping: false, ammo: 0, snipeAt: 0,
    vy: 0, kx: 0, kz: 0, ai: { style: 'melee', styleAt: 0, guardUntil: 0, lastAx: 0, lastAz: 0, avx: 0, avz: 0, lastAt: 0, seen: 0, strafe: 1, strafeAt: 0 }
  };
  room.players.set(p.id, p);
  room.duel[side].push(p.id);
  broadcast(room, { t: 'pj', p: { id: p.id, name: p.name, ch: p.ch, hp: p.hp, k: 0, d: 0, x: p.x, y: 0, z: p.z } });
  broadcast(room, { t: 'sc', s: scoreList(room) });
  return p;
}
function duelBotsClear(room) {
  const d = room.duel;
  for (const p of [...room.players.values()]) if (p.bot) { delete d.team[p.id]; delete d.out[p.id]; d.teamA = d.teamA.filter(i => i !== p.id); d.teamB = d.teamB.filter(i => i !== p.id); removePlayer(room, p); }
}
function botReady(p, code, t) { return (p.cdUntil[code] || 0) <= t + 120; }
function botCast(room, p, code, ax, ay, az) { p.slots[4] = code; doCast(room, p, 4, ax, ay, az); }
function botDash(room, p, dx, dz, t) {
  if (!botReady(p, '753', t) || t < p.stunUntil) return false;
  const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  botCast(room, p, '753', dx, 0, dz);
  p.kx += dx * 60; p.kz += dz * 60;
  return true;
}
/* bidikan bola (bolt) dengan prediksi gerak dan kompensasi gravitasi */
function botAim(bot, A, ai, spd) {
  const dist0 = Math.hypot(A.x - bot.x, A.z - bot.z) || 1, tt = dist0 / spd;
  const px = A.x + ai.avx * tt * 0.8, pz = A.z + ai.avz * tt * 0.8;
  const dx = px - bot.x, dz = pz - bot.z, d = Math.hypot(dx, dz) || 1;
  const dy = (A.y + 0.9) - (bot.y + 1.55), t2 = d / spd;
  return { ax: dx / d, az: dz / d, ay: clampN((dy + 0.5 * BOLT_GRAVITY * t2 * t2) / d - 0.06, -0.6, 0.6) };
}
function duelBotStep(room, bot, enemies, dt, t) {
  if (bot.dead) return;
  let A = null, bd = 1e9;
  for (const e of enemies) { if (e.dead || room.duel.out[e.id] || !room.duel.team[e.id]) continue; /* yang sudah keluar dari ronde tidak dikejar */ const dd = Math.hypot(e.x - bot.x, e.z - bot.z); if (dd < bd) { bd = dd; A = e; } }
  if (!A) return;
  const ai = bot.ai;
  if (ai.tgt !== A.id) { ai.tgt = A.id; ai.lastAt = 0; ai.avx = ai.avz = 0; }
  const tm = room.duel.team, myT = tm[bot.id], isFoe = id => tm[id] && tm[id] !== myT;
  if (ai.lastAt) { const dd = (t - ai.lastAt) / 1000; if (dd > 0.001) { ai.avx = ai.avx * 0.6 + (A.x - ai.lastAx) / dd * 0.4; ai.avz = ai.avz * 0.6 + (A.z - ai.lastAz) / dd * 0.4; } }
  ai.lastAx = A.x; ai.lastAz = A.z; ai.lastAt = t;
  const dx = A.x - bot.x, dz = A.z - bot.z, dist = Math.hypot(dx, dz) || 0.01, nx = dx / dist, nz = dz / dist;
  const stunned = t < bot.stunUntil;
  bot.focus = { v: A, until: t + 7000 };
  if (!stunned) { bot.fx = nx; bot.fz = nz; }
  if (t > ai.styleAt) { ai.style = Math.random() < 0.6 ? 'melee' : 'ranged'; ai.styleAt = t + 3000 + Math.random() * 3500; }
  if (t > ai.strafeAt) { ai.strafe = Math.random() < 0.5 ? 1 : -1; ai.strafeAt = t + 900 + Math.random() * 1400; }
  let mx = 0, mz = 0, sp = 6.3;
  const grounded = bot.y <= terrainH(bot.x, bot.z) + 0.05;
  if (!stunned) {
    /* 1. ancaman: bola/sinar/orb dari lawan yang mengarah ke komputer */
    let eta = 9, thr = null;
    const scan = (o, rad) => {
      const rx = bot.x - o.x, ry = bot.y + 0.9 - o.y, rz = bot.z - o.z, dy = o.dy || 0;
      const along = rx * o.dx + ry * dy + rz * o.dz;
      if (along < 0 || along > o.sp * 0.7) return;
      const qx = rx - along * o.dx, qy = ry - along * dy, qz = rz - along * o.dz;
      if (Math.hypot(qx, qy, qz) > rad) return;
      const e = along / o.sp; if (e < eta) { eta = e; thr = o; }
    };
    for (const pr of room.projs) if (isFoe(pr.o)) scan(pr, (pr.hr || 1.35) + 0.8 + (pr.boom || 0) * 0.3);
    for (const o of room.orbs) if (isFoe(o.o)) scan(o, o.r + 0.8);
    if (thr) {
      if (!ai.seen) ai.seen = t + 70 + Math.random() * 90;   /* waktu reaksi */
      if (t >= ai.seen && eta < 0.42) {
        const side = ai.strafe, px = -thr.dz * side, pz = thr.dx * side;
        if (eta < 0.3 && botDash(room, bot, px, pz, t)) { /* dash menyamping: kebal sesaat */ }
        else if (!thr.r && !thr.wv && botReady(bot, '777', t) && Math.random() < 0.5) botCast(room, bot, '777', nx, 0, nz);   /* tembok kode */
        else if (thr.r && grounded && botReady(bot, '8181', t)) botCast(room, bot, '8181', nx, 0, nz);   /* loncat tinggi melewati orb */
        else if (!thr.r && !thr.wv && grounded) ai.guardUntil = Math.max(ai.guardUntil, t + eta * 1000 + 220);
        else if (grounded) { bot.vy = 18.5; }
      }
    } else ai.seen = 0;
    /* 2. lawan baru saja menebas dari dekat: tangkis atau mundur */
    if (dist < 4.4 && t - A.atkAt < 260 && t - (ai.lastDef || 0) > 500 && Math.random() < 0.8) {
      ai.lastDef = t;
      if (Math.random() < 0.3 && botDash(room, bot, -nx - nz * 0.6 * ai.strafe, -nz + nx * 0.6 * ai.strafe, t)) { }
      else ai.guardUntil = t + 520;
    }
    const wantG = t < ai.guardUntil && t >= bot.gbUntil;
    if (wantG !== !!bot.guarding) setGuard(room, bot, wantG);
    if (bot.guarding) { /* perisai tidak memperlambat gerak */ }
    else {
      /* 3. serangan */
      const cast = (code, d2) => { const a = botAim(bot, A, ai, BALL_SPEED); botCast(room, bot, code, a.ax, a.ay, a.az); };
      if (bot.hp < MAXHP * 0.42 && botReady(bot, '918', t) && dist > 4) botCast(room, bot, '918', nx, 0, nz);
      else if (botReady(bot, '481', t) && room.mobs.filter(m => m.o === bot.id).length < 1) botCast(room, bot, '481', nx, 0, nz);
      else if (dist < 5.6 && botReady(bot, '5551', t) && A.stunUntil < t && Math.random() < 0.25) botCast(room, bot, '5551', nx, 0, nz);
      else if (dist > 5 && dist < 24 && botReady(bot, '8472', t) && Math.random() < 0.3) cast('8472');
      else if (dist > 4 && botReady(bot, '637', t) && Math.random() < (ai.style === 'ranged' ? 0.5 : 0.2)) cast('637');
      else if (bot.hp < MAXHP * 0.35 && dist < 5 && botReady(bot, '2929', t)) botCast(room, bot, '2929', -nx, 0, -nz);   /* kabur dengan teleport */
      else if (bot.hp < MAXHP * 0.35 && dist < 6 && grounded && botReady(bot, '8181', t) && Math.random() < 0.2) botCast(room, bot, '8181', -nx, 0, -nz);
      else if (dist > 12 && ai.style === 'melee' && Math.random() < 0.04 && botReady(bot, '2929', t)) botCast(room, bot, '2929', nx, 0, nz);   /* teleport mendekat */
      else if (dist > 11 && ai.style === 'melee' && Math.random() < 0.03 && botDash(room, bot, nx, nz, t)) { }
      if (dist < 3.1 && Math.random() < 0.92) doMelee(room, bot, r2(nx), r2(nz));
      if (grounded && (Math.random() < 0.004 || (dist < 5 && A.y > bot.y + 0.8 && Math.random() < 0.05))) bot.vy = 18.5;
    }
    /* 4. gerak */
    const perp = ai.strafe;
    if (ai.style === 'ranged') {
      if (dist < 8) { mx = -nx - nz * 0.4 * perp; mz = -nz + nx * 0.4 * perp; }
      else if (dist > 13) { mx = nx; mz = nz; }
      else { mx = -nz * perp; mz = nx * perp; sp = 4.5; }
    } else {
      const retreat = bot.combo === 3 && t - bot.atkAt < 450;
      if (retreat) { mx = -nx; mz = -nz; sp = 5; }
      else if (dist > 2.4) { mx = nx - nz * 0.25 * perp; mz = nz + nx * 0.25 * perp; }
      else if (dist < 1.7) { mx = -nx; mz = -nz; sp = 3.5; }
      else { mx = -nz * perp * 0.7; mz = nx * perp * 0.7; sp = 3.5; }
    }
  } else if (bot.guarding) setGuard(room, bot, false);
  const ml = Math.hypot(mx, mz) || 1;
  let vx = (mx / ml) * (mx || mz ? sp : 0) + bot.kx, vz = (mz / ml) * (mx || mz ? sp : 0) + bot.kz;
  let x = bot.x + vx * dt, z = bot.z + vz * dt;
  const rd = Math.hypot(x - ARENA.x, z - ARENA.z), lim = ARENA.ringR - 1.2;
  if (rd > lim) { x = ARENA.x + (x - ARENA.x) / rd * lim; z = ARENA.z + (z - ARENA.z) / rd * lim; }
  if (Math.hypot(x - A.x, z - A.z) > 1.3 || Math.hypot(x - A.x, z - A.z) > dist) wallMove(room, bot, x, z, bot.y);
  const kd = Math.exp(-9 * dt); bot.kx *= kd; bot.kz *= kd;
  const g = terrainH(bot.x, bot.z);
  if (bot.y > g + 0.001 || bot.vy > 0) { bot.vy -= 30 * dt; bot.y += bot.vy * dt; if (bot.y <= g) { bot.y = g; bot.vy = 0; } }
  bot.m = (mx || mz) ? (sp > 5 ? 2 : 1) : 0; bot.a = bot.y > g + 0.05 ? (bot.vy > 0 ? 1 : 2) : 0;
}

/* ---- mode latihan: target diam yang hidup lagi setelah dikalahkan ---- */
const DUMMY_ATK = { id: -3, name: 'Target' };
const DUMMY_SPOTS = [[-6, 6], [0, 9], [6, 6]];
function trainResetDummies(room) {
  for (const sl of room.sols.filter(q => q.dummy)) broadcast(room, { t: 'solx', id: sl.id });
  room.sols = room.sols.filter(q => !q.dummy);
}
function trainTick(room, dt, t) {
  const hpMul = room.tune ? room.tune.hp : 1;
  DUMMY_SPOTS.forEach(([hx, hz], i) => {
    const cur = room.sols.find(q => q.dummy && q.slot === i);
    if (cur && room.tune && room.tune.fight && t >= (cur.atkAt || 0)) {   /* target menyerang balik pelan-pelan */
      let tgt = null, bd = 3.4;
      for (const pl of room.players.values()) { if (pl.dead) continue; const dd = Math.hypot(pl.x - cur.x, pl.z - cur.z); if (dd < bd) { bd = dd; tgt = pl; } }
      if (tgt) { const nx = (tgt.x - cur.x) / (bd || 1), nz = (tgt.z - cur.z) / (bd || 1); cur.fx = nx; cur.fz = nz; cur.atkAt = t + 1500; cur.atkFlag = 1; hurt(room, tgt, 20, DUMMY_ATK, nx * 6, nz * 6, { sx: -nx, sz: -nz }); }
    }
    if (cur) {   /* kembali ke tempat setelah terpental */
      const dx = hx - cur.x, dz = hz - cur.z; if (Math.hypot(dx, dz) > 0.05) { cur.x += dx * Math.min(1, 2 * dt); cur.z += dz * Math.min(1, 2 * dt); }
      return;
    }
    const k = room.dummyDeadAt || (room.dummyDeadAt = DUMMY_SPOTS.map(() => t - 2000));
    if (k[i] == null) { k[i] = t; return; }   /* baru dikalahkan */
    if (t - k[i] < 2000) return;
    k[i] = null;
    const hp = Math.round(MAXHP * hpMul);
    const sl = { id: solSeq++, isSol: true, bandit: true, dummy: true, slot: i, nm: 'Target', camp: -1, fort: -1, owner: BANDIT_OWNER, ch: 0, kind: 'brute', x: hx, y: 0, z: hz, fx: 0, fz: -1, hp, max: hp, atkAt: 0, dead: false, atkFlag: 0, hx, hz };
    room.sols.push(sl); broadcast(room, { t: 'sol', s: solPublic(sl) });
  });
}
/* singa: pemburu darat. Mengejar musuh yang kamu serang, atau musuh terdekat dalam 14 m; kalau sepi menjaga di dekatmu */
function lionStep(room, m, owner, dt, t) {
  let tg = null, bd = 1e9;
  /* utamakan musuh yang KAMU serang; yang menyerangmu hanya cadangan; bukan yang paling dekat */
  for (const fo of focusOrder(owner)) {
    if (!fo || t >= fo.until) continue;
    const fv = fo.v;
    if (!fv.isMob && !fv.dead && (fv.isSol ? room.sols.includes(fv) : room.players.get(fv.id) === fv) && (!room.duel || fv.isSol || duelFighting(room, fv)) && (fv.x < 1000) === (owner.x < 1000)) { tg = fv; bd = Math.hypot(fv.x - m.x, fv.z - m.z); break; }
  }
  let tx, tz, sp = m.sp;
  if (tg) { tx = tg.x; tz = tg.z; if (bd > 12) sp *= 1.5; }
  else { const a = t / 1600 + m.id * 2.1, r = EAGLE_ORBIT + 1.5 * Math.sin(t / 2300 + m.id); tx = owner.x + Math.cos(a) * r; tz = owner.z + Math.sin(a) * r; if (Math.hypot(tx - m.x, tz - m.z) > 12) sp *= 1.6; }
  const dx = tx - m.x, dz = tz - m.z, dist = Math.hypot(dx, dz);
  const stopAt = tg ? 1.7 : 1.0;
  if (dist > stopAt) { const step = Math.min(dist - stopAt, sp * dt); wallMove(room, m, m.x + dx / dist * step, m.z + dz / dist * step); }
  if (dist > 0.3) { m.fx = dx / dist; m.fz = dz / dist; }
  m.y = terrainH(m.x, m.z) + 1.2;
  if (tg && dist < 2.7 && Math.abs((tg.y || 0) - (m.y - 1.2)) < 2.6 && t >= m.atkAt) {
    m.atkAt = t + 1100; m.atkFlag = 1;
    hurt(room, tg, m.dmg, owner, m.fx * 8, m.fz * 8, { sx: -m.fx, sz: -m.fz });
  }
}
function duelToWait(room, d) { duelBotsClear(room); d.st = 'wait'; d.aloneAt = 0; }
function duelTick(room, t, dt) {
  const d = room.duel;
  d.queue = d.queue.filter(id => room.players.has(id) && !d.team[id]);
  duelRebuild(room);
  let changed = false;
  const mA = duelMembers(room, 'teamA'), mB = duelMembers(room, 'teamB');
  const alive = ms => ms.some(p => !p.dead && !d.out[p.id]);
  for (const p of [...mA, ...mB]) if (p.dead && d.st === 'fight' && !d.out[p.id]) { d.out[p.id] = 1; changed = true; }
  if (d.st === 'fight') {
    const aA = alive(mA), aB = alive(mB);
    if (!aA || !aB) {
      const wSide = aA ? 'teamA' : (aB ? 'teamB' : null), lSide = wSide === 'teamA' ? 'teamB' : (wSide === 'teamB' ? 'teamA' : null);
      const winners = wSide ? duelMembers(room, wSide) : [], losers = wSide ? duelMembers(room, lSide) : [...mA, ...mB];
      const wn = winners.filter(p => !p.bot).map(p => p.name), ln = losers.filter(p => !p.bot).map(p => p.name);
      let wmax = 0;
      for (const p of winners) {
        if (p.bot) continue;
        d.streak[p.id] = (d.streak[p.id] || 0) + 1; wmax = Math.max(wmax, d.streak[p.id]);
        d.total[p.id] = (d.total[p.id] || 0) + 1; d.names[p.id] = p.name; d.best[p.id] = Math.max(d.best[p.id] || 0, d.streak[p.id]);
        if (p.hp < MAXHP && !p.dead) { p.hp = MAXHP; broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); }
      }
      d.last = wSide ? { win: wn.length ? wn.join(' & ') : 'Komputer', names: wn, lose: ln.length ? ln.join(' & ') : 'Komputer', w: wn.length ? wmax : 0 } : null;
      for (const p of losers) {
        if (p.bot) continue;
        d.streak[p.id] = 0;
        const key = d.team[p.id] === 'a' ? 'teamA' : 'teamB';
        d[key] = d[key].filter(i => i !== p.id);
        delete d.team[p.id]; delete d.out[p.id];
        if (!d.queue.includes(p.id)) d.queue.push(p.id);
      }
      d.st = 'over'; d.until = t + DUEL_OVER_MS; d.sd = false; changed = true;
    } else {
      const el = t - d.fightAt, ph = el >= d.limit + d.sdMs ? 2 : (el >= d.limit ? 1 : 0);
      if (ph !== d.ph) { d.ph = ph; changed = true; }
      d.sd = ph >= 1;
      if (ph === 2) duelDrain(room, d, mA, mB, dt || 0.033);
    }
  } else if (d.st === 'over') {
    if (t >= d.until) { duelToWait(room, d); changed = true; }
  } else if (d.st === 'count') {
    if (!mA.length || !mB.length) { duelToWait(room, d); changed = true; }
    else if (t >= d.until) { d.st = 'fight'; d.fightAt = t; d.limit = d.dmin * 60000; d.sdMs = d.sdsec * 1000; d.drainRate = DUEL_DRAIN[d.drain] || 40; d.ph = 0; d.sd = false; for (const p of [...mA, ...mB]) { p.invuln = 0; p.drainAcc = 0; } changed = true; }
  }
  if (d.st === 'wait') {
    /* isi tim dari antrian: yang menang tetap, penantang masuk ke sisi yang kurang */
    for (;;) {
      const na = d.teamA.length, nb = d.teamB.length;
      if (na >= d.size && nb >= d.size) break;
      const side = (na <= nb && na < d.size) ? 'teamA' : (nb < d.size ? 'teamB' : 'teamA');
      const id = duelNextAlive(room); if (!id) break;
      d[side].push(id); changed = true;
    }
    duelRebuild(room);
    const humans = d.teamA.length + d.teamB.length;
    if (humans > 0) {
      let go = humans >= d.size * 2;
      if (!go) { if (!d.aloneAt) d.aloneAt = t; else if (t - d.aloneAt > 2500) go = true; } else d.aloneAt = 0;
      if (go) {
        while (d.teamA.length < d.size) duelBotSpawn(room, 'teamA');
        while (d.teamB.length < d.size) duelBotSpawn(room, 'teamB');
        duelRebuild(room);
        duelClearCombat(room);
        ['teamA', 'teamB'].forEach(side => {
          const ms = duelMembers(room, side), w = side === 'teamA' ? 'a' : 'b';
          ms.forEach((p, i) => {
            const sd = duelSide(w, i, ms.length);
            duelRefresh(room, p); teleportTo(p, sd.x, sd.z, sd.fx, sd.fz); p.invuln = t + DUEL_COUNT_MS + 200;
            if (p.bot) { p.vy = 0; p.kx = p.kz = 0; p.combo = 0; }
          });
        });
        d.out = {};
        d.st = 'count'; d.until = t + DUEL_COUNT_MS; d.last = null; d.aloneAt = 0; changed = true;
      }
    } else d.aloneAt = 0;
  }
  if (d.st === 'fight') {
    for (const bot of [...mA, ...mB]) if (bot.bot && !d.out[bot.id]) duelBotStep(room, bot, d.team[bot.id] === 'a' ? mB : mA, dt || 0.033, t);
  }
  /* batas ring: penonton & yang sudah gugur tidak boleh masuk, petarung tidak boleh keluar */
  for (const p of room.players.values()) {
    if (p.dead || t < (p.tpUntil || 0) + 150) continue;
    const dx = p.x - ARENA.x, dz = p.z - ARENA.z, dist = Math.hypot(dx, dz) || 0.01;
    const slot = d.team[p.id] && !d.out[p.id] ? d.team[p.id] : null;
    if (slot && p.y > ARENA.height + 2) { teleportTo(p, p.x, p.z, p.fx, p.fz); continue; }
    if (slot && (d.st === 'fight' || d.st === 'count')) {
      if (d.st === 'count') {
        const ms = duelMembers(room, slot === 'a' ? 'teamA' : 'teamB'), sd = duelSide(slot, ms.indexOf(p), ms.length);
        if (Math.hypot(p.x - sd.x, p.z - sd.z) > 1.4) teleportTo(p, sd.x, sd.z, sd.fx, sd.fz);
      } else if (dist > ARENA.ringR + 0.5) { const k = (ARENA.ringR - 2.2) / dist; teleportTo(p, ARENA.x + dx * k, ARENA.z + dz * k, -dx / dist, -dz / dist); }
    } else if (!slot && !p.bot) {
      if (dist < ARENA.ringR + 1.3) { const k = (ARENA.ringR + 3.2) / dist; teleportTo(p, ARENA.x + dx * k, ARENA.z + dz * k, dx / dist, dz / dist); }
      else if (dist > ARENA.ringR + ARENA.standR + 0.5) { const k = (ARENA.ringR + ARENA.standR - 1) / dist; teleportTo(p, ARENA.x + dx * k, ARENA.z + dz * k, -dx / dist, -dz / dist); }   /* penonton tidak keluar dari area stadion */
    }
  }
  if (changed) duelBroadcast(room);
}

function removePlayer(room, p) {
  if (!room.players.has(p.id)) return;
  room.players.delete(p.id);
  room.projs = room.projs.filter(x => x.o !== p.id);
  room.mobs = room.mobs.filter(x => { if (x.o === p.id) { broadcast(room, { t: 'mobx', id: x.id }); return false; } return true; });
  room.traps = room.traps.filter(x => x.o !== p.id);
  for (const w of [...room.walls]) if (w.o === p.id) wallRemove(room, w, false);
  room.orbs = room.orbs.filter(x => { if (x.o === p.id) { broadcast(room, { t: 'orbx', id: x.id }); return false; } return true; });
  for (const f of room.forts) { if (f.owner === p.id) setFortOwner(room, f, null); if (f.cap && f.cap.by === p.id) { f.cap = null; broadcast(room, { t: 'cap', fort: f.id, cancel: 1 }); } }
  broadcast(room, { t: 'pl', id: p.id });
  broadcast(room, { t: 'sc', s: scoreList(room) });
  if (room.duel) { room.duel.queue = room.duel.queue.filter(id => id !== p.id); duelBroadcast(room); }
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
  if ([...room.players.values()].filter(q => !q.bot).length >= room.max) return send(ws, { t: 'err', msg: 'Room penuh (' + room.max + ' pemain)' });

  const s = spawnFor(room);
  const p = {
    id: room.nextPid++, uid, tag: crypto.createHash('sha1').update(uid).digest('hex').slice(0, 4).toUpperCase(), name, ch, ws, room,
    x: s.x, y: 0, z: s.z, fx: 0, fz: 1, m: 0, a: 0, sw: 0,
    hp: MAXHP, k: 0, d: 0, dead: false, respawnAt: 0,
    invuln: now() + SPAWN_PROTECT_MS, shield: 0, atkAt: 0,
    slots: new Array(MAX_TECH_SLOTS).fill(null), cdUntil: {},
    guarding: false, gh: [], gbUntil: 0, stunUntil: 0, regenUntil: 0, regenRate: 0, regenAcc: 0, rideUntil: 0, sleeping: false, ammo: 0, snipeAt: 0
  };
  room.players.set(p.id, p);
  ws.player = p;
  send(ws, {
    t: 'welcome', id: p.id, tag: p.tag, room: { name: room.name, max: room.max, voice: room.voice, pick: room.pick, debug: !!room.debug, mode: room.duel ? 'duel' : (room.train ? 'train' : 'world') }, duel: room.duel ? duelState(room) : null, hour: roomHour(room), hp: p.hp,
    forts: room.forts.map(f => Object.assign(fortPublic(f), { name2: f.name, x: f.x, z: f.z })), sols: room.sols.map(solPublic), walls: room.walls.map(w => ({ id: w.id, o: w.o, x: r2(w.x), z: r2(w.z), y: r2(w.y), nx: r2(w.nx), nz: r2(w.nz), len: w.len, hp: Math.round(w.hp), dur: Math.max(0.1, (w.until - now()) / 1000), c: w.c || '#b8a27a' })), chat: room.chatLog.slice(-20),
    spawn: s, doors: room.doors, book: !!DB.settings.showBook, chest: room.chest.open,
    players: [...room.players.values()].map(q => ({ id: q.id, tag: q.tag, name: q.name, ch: q.ch, hp: q.hp, k: q.k, d: q.d, x: q.x, y: q.y, z: q.z, dead: q.dead, sl: q.sleeping }))
  });
  broadcast(room, { t: 'pj', p: { id: p.id, tag: p.tag, name: p.name, ch: p.ch, hp: p.hp, k: 0, d: 0, x: p.x, y: 0, z: p.z } }, p.id);
  broadcast(room, { t: 'sc', s: scoreList(room) });
  if (room.duel) { room.duel.queue.push(p.id); duelBroadcast(room); }
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
  const room = p.room; CUR = room;
  switch (m.t) {
    case 's': {
      if (p.dead || now() < (p.tpUntil || 0)) break;
      const x = num(m.x, -200, 5200, null), y = num(m.y, -12, 80, null), z = num(m.z, -200, 200, null);
      if (x === null || y === null || z === null) break;
      if (room.walls.length && wallCrosses(room, p.x, p.z, x, z, y)) { teleportTo(p, p.x, p.z, p.fx, p.fz); break; }   /* pemain tidak boleh menembus tembok (kecuali melompatinya) */
      p.x = x; p.y = y; p.z = z;
      p.fx = num(m.fx, -1, 1, p.fx); p.fz = num(m.fz, -1, 1, p.fz);
      p.m = clampN(m.m | 0, 0, 2); p.a = clampN(m.a | 0, 0, 2); p.sw = clampN(m.sw | 0, 0, 2);
      break;
    }
    case 'ping': { send(p.ws, { t: 'pong', ts: m.ts }); break; }
    case 'tune': {   /* mode latihan: pengatur cooldown teknik & darah target */
      if (!room.train) break;
      const tu = room.tune || (room.tune = { cd: 1, hp: 1 });
      const hpOld = tu.hp;
      tu.cd = num(m.cd, 0, 3, tu.cd); tu.hp = num(m.hp, 1, 10, tu.hp); tu.fight = !!m.fight;
      if (tu.hp !== hpOld) trainResetDummies(room);
      break;
    }
    case 'pref': { p.dbg = !!m.dbg; break; }   /* pemain menyalakan notifikasi hasil tebasan di Pengaturan */
    case 'atk': {
      if (room.duel && !duelFighting(room, p)) break;
      let fx = num(m.fx, -1, 1, 0), fz = num(m.fz, -1, 1, 1); const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
      doMelee(room, p, r2(fx), r2(fz), m.fy === undefined ? undefined : num(m.fy, -0.95, 0.95, 0));
      break;
    }
    case 'cast': {
      if (room.duel && !duelFighting(room, p)) break;
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
    case 'techs': {
      if (!room.pick) break;
      send(ws, { t: 'techs', list: DB.techniques.map(t => Object.assign(techPublic(t), { desc: techDesc(t) })) });
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
      if (room.duel) break;
      doSnipe(room, p, num(m.fx, -1, 1, 0), 0, num(m.fz, -1, 1, 1));
      break;
    }
    case 'cap': {
      if (room.duel) break;
      startCapture(room, p, m.fort | 0);
      break;
    }
    case 'chat': {
      const t = now();
      if (t - (p.chatAt || 0) < 600) break;
      const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!text) break;
      p.chatAt = t;
      const msg = { t: 'chat', id: p.id, tag: p.tag, name: p.name, text };
      room.chatLog.push({ name: p.name, text, id: p.id });
      if (room.chatLog.length > 60) room.chatLog.shift();
      broadcast(room, msg);
      break;
    }
    case 'emote': {
      const t = now();
      if (p.dead || p.sleeping || t - (p.emoteAt || 0) < EMOTE_CD_MS) break;
      const e = m.e | 0;
      if (e < 0 || e >= EMOTE_COUNT) break;
      p.emoteAt = t;
      broadcast(room, { t: 'emote', id: p.id, e });
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
  return { code: r.code, name: r.name, max: r.max, mode: r.mode === 'duel' ? 'duel' : (r.mode === 'train' ? 'train' : 'world'), team: r.mode === 'duel' ? clampN(Math.round(Number(r.team)) || 1, 1, 3) : 1, ff: r.ff !== false, dmin: clampN(Math.round(Number(r.dmin)) || DUEL_DEFAULT_MIN, 1, DUEL_MAX_MIN), sdsec: normSd(r.sdsec), drain: normDrain(r.drain), debug: r.debug === true, voice: r.voice !== false, pick: r.pick === true, created: r.created, count: rt ? rt.players.size : 0, players: rt ? [...rt.players.values()].map(p => p.name + ' #' + p.tag) : [] };
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
    const r = { code: newRoomCode(), name, max, created: now(), voice: b.voice !== false, pick: b.pick === true, debug: b.debug === true, mode: b.mode === 'duel' ? 'duel' : (b.mode === 'train' ? 'train' : 'world'), team: clampN(Math.round(Number(b.team)) || 1, 1, 3), ff: b.ff !== false, dmin: clampN(Math.round(Number(b.dmin)) || DUEL_DEFAULT_MIN, 1, DUEL_MAX_MIN), sdsec: normSd(b.sdsec), drain: normDrain(b.drain) };
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
      if (b.pick !== undefined) r.pick = !!b.pick;
      if (b.debug !== undefined) r.debug = !!b.debug;
      if (b.max !== undefined) { const mx = Math.round(Number(b.max)); if (!isFinite(mx) || mx < 2 || mx > ROOM_MAX_LIMIT) return json(res, 400, { error: 'Maksimal pemain harus angka 2-' + ROOM_MAX_LIMIT }); r.max = mx; }
      if (b.dmin !== undefined) { const dm = Math.round(Number(b.dmin)); if (!isFinite(dm) || dm < 1 || dm > DUEL_MAX_MIN) return json(res, 400, { error: 'Batas waktu harus 1-' + DUEL_MAX_MIN + ' menit' }); r.dmin = dm; }
      if (b.sdsec !== undefined) { const sv = Math.round(Number(b.sdsec)); if (!isFinite(sv) || sv < 10 || sv > 300) return json(res, 400, { error: 'Lama sudden death harus 10-300 detik' }); r.sdsec = sv; }
      if (b.drain !== undefined) { if (!DUEL_DRAIN[b.drain]) return json(res, 400, { error: 'Kecepatan darah terkuras tidak dikenal' }); r.drain = b.drain; }
      const rt = rooms.get(r.code); if (rt && rt.duel) { rt.duel.dmin = clampN(Math.round(Number(r.dmin)) || DUEL_DEFAULT_MIN, 1, DUEL_MAX_MIN); rt.duel.sdsec = normSd(r.sdsec); rt.duel.drain = normDrain(r.drain); }
      if (rt) { rt.name = r.name; rt.max = r.max; rt.voice = r.voice !== false; rt.pick = r.pick === true; rt.debug = r.debug === true; }
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
  /* cadangan data (tanpa password admin) */
  if (pathname === '/api/admin/backup' && method === 'GET') {
    return json(res, 200, { app: 'digital-war', version: 1, at: new Date().toISOString(), rooms: DB.rooms, techniques: DB.techniques, settings: DB.settings });
  }
  if (pathname === '/api/admin/restore' && method === 'POST') {
    const b = await readBody(req, 1024 * 1024);
    if (!b || b.app !== 'digital-war' || !Array.isArray(b.rooms) || !Array.isArray(b.techniques)) return json(res, 400, { error: 'File cadangan tidak dikenali' });
    if (b.rooms.length > 200 || b.techniques.length > 100) return json(res, 400, { error: 'Isi cadangan terlalu banyak' });
    const techs = [], seenT = new Set();
    for (const t of b.techniques) {
      const st = sanitizeTech(t);
      if (!st || st.error) return json(res, 400, { error: 'Teknik di cadangan tidak valid' + (st && st.error ? ': ' + st.error : '') });
      if (seenT.has(st.code)) return json(res, 400, { error: 'Kode teknik dobel di cadangan: ' + st.code });
      seenT.add(st.code); techs.push(st);
    }
    const rs = [], seenR = new Set();
    for (const r of b.rooms) {
      if (!r || typeof r.code !== 'string' || !/^[A-Z0-9]{4,10}$/.test(r.code) || seenR.has(r.code)) return json(res, 400, { error: 'Data room di cadangan tidak valid' });
      const max = Math.round(Number(r.max));
      if (!isFinite(max) || max < 2 || max > ROOM_MAX_LIMIT) return json(res, 400, { error: 'Maksimal pemain di cadangan tidak valid' });
      seenR.add(r.code);
      rs.push({ code: r.code, name: cleanName(r.name, 30) || 'Room', max, created: Number(r.created) || now(), voice: r.voice !== false, pick: r.pick === true, debug: r.debug === true, mode: r.mode === 'duel' ? 'duel' : (r.mode === 'train' ? 'train' : 'world'), team: clampN(Math.round(Number(r.team)) || 1, 1, 3), ff: r.ff !== false, dmin: clampN(Math.round(Number(r.dmin)) || DUEL_DEFAULT_MIN, 1, DUEL_MAX_MIN), sdsec: normSd(r.sdsec), drain: normDrain(r.drain) });
    }
    for (const rt of [...rooms.values()]) { closeRoom(rt); rooms.delete(rt.code); }
    DB.rooms = rs; DB.techniques = techs;
    DB.settings = Object.assign({ showBook: true }, { showBook: !(b.settings && b.settings.showBook === false) });
    for (const r of DB.rooms) rooms.set(r.code, newRuntime(r));
    saveDBNow();
    return json(res, 200, { ok: true, rooms: DB.rooms.length, techniques: DB.techniques.length });
  }
  if (pathname === '/api/admin/techniques' && method === 'GET') return json(res, 200, { techniques: DB.techniques });
  if (pathname === '/api/admin/techniques/defaults' && method === 'GET') return json(res, 200, { techniques: DEFAULT_TECHS });
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
      return json(res, 200, { name: v.name, max: v.max, count: v.count, voice: v.voice, pick: v.pick, mode: v.mode });
    }
    if (pathname === '/api/book') {
      if (!DB.settings.showBook) return json(res, 200, { enabled: false, techniques: [] });
      return json(res, 200, { enabled: true, techniques: DB.techniques.map(t => Object.assign(techPublic(t), { desc: techDesc(t) })) });
    }
    /* aset pihak ketiga disajikan lokal dari folder vendor/ (tanpa CDN) */
    const vm = /^\/vendor\/([A-Za-z0-9][A-Za-z0-9._-]*\.(js|css|woff2))$/.exec(pathname);
    if (vm) {
      const types = { js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };
      return fs.readFile(path.join(__dirname, 'vendor', vm[1]), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[vm[2]], 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length });
        res.end(buf);
      });
    }
    if (pathname === '/') return html(res, LANDING_HTML);
    if (pathname === '/admin') return html(res, ADMIN_HTML);
    if (/^\/r\/[A-Za-z0-9]{4,10}$/.test(pathname)) return html(res, GAME_HTML.replace('<!--TUNING-->', '<script>window.TUNING=' + JSON.stringify(TUNING) + ';</script>'));
    if (pathname === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(JSON.stringify({ name: 'Digital War', short_name: 'Digital War', start_url: '/', display: 'fullscreen', orientation: 'landscape', background_color: '#0b1020', theme_color: '#0b1020' })); }
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
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Digital War">
<link href="/vendor/fonts.css" rel="stylesheet">
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
<link href="/vendor/fonts.css" rel="stylesheet">
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
.rhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 0 12px}.rhead h2{margin:0;font-size:18px}
.modal{position:fixed;inset:0;z-index:50;background:rgba(2,6,14,.72);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
.mbox{width:min(100%,460px);max-height:calc(100vh - 32px);overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.mbox h2{margin:0 0 4px;font-size:18px}
.mact{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
.room .rsum{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.room .rsum .tx{flex:1;min-width:0}
.room .rsum .meta{margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.room .rsum svg{flex:0 0 auto;width:18px;height:18px;transition:transform .2s;color:var(--mut)}
.room.open .rsum svg{transform:rotate(180deg)}
.room .rbody{display:none;margin-top:10px}.room.open .rbody{display:block}
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
.tech .tsum{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.tech .tsum .dot{flex:0 0 12px;height:12px;border-radius:50%}
.tech .tsum .tx{flex:1;min-width:0}.tech .tsum b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tech .tsum small{display:block;font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tech .tsum svg{flex:0 0 auto;width:18px;height:18px;color:var(--mut);transition:transform .2s}
.tech.open .tsum svg{transform:rotate(180deg)}
.tech .tbody{display:none;margin-top:10px}.tech.open .tbody{display:block}
.tech .hd .nm{flex:1}
.tech .code{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:2px}
.hint{font-size:12px;color:var(--mut);margin:0 0 10px;line-height:1.5}
#login{max-width:360px;margin:12vh auto 0}
.hidden{display:none!important}
.chk{display:flex;gap:10px;align-items:center;font-size:13px;color:var(--tx);margin-top:12px;cursor:pointer}
.chk input{width:20px;height:20px;flex:0 0 20px;accent-color:#1e6fff;padding:0}
#rcreate,#pgo{display:block;margin-left:auto}
#techAdd,#techSave,#techReset{flex:1 1 auto}
.room .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.room .row>*{min-width:0;width:100%}
.room .row>input{grid-column:1 / -1}
@media (max-width:520px){
.wrap{padding:14px 18px}
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
  <div id="warnPw" class="msg warn hidden"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg> Password masih default (admin). Ganti di tab Akun supaya tidak sembarang orang bisa membuat room.</div>
  <div class="tabs">
    <button data-tab="rooms" class="on">Room</button>
    <button data-tab="tech">Buku Teknik</button>
    <button data-tab="acc">Akun</button>
  </div>

  <div id="tab-rooms">
    <div class="rhead"><h2>Room</h2><button class="pri" id="rnew">+ Buat room</button></div>
    <div id="roomList"></div>
  </div>
  <div id="rmodal" class="modal hidden"><div class="mbox">
      <h2>Buat room baru</h2>
      <label>Nama room</label><input id="rname" maxlength="30" placeholder="Misal: Duel Sabtu Malam">
      <label>Mode room</label>
      <select id="rmode"><option value="world">Dunia biasa</option><option value="duel1">Arena Duel 1 vs 1</option><option value="duel2">Arena Tim 2 vs 2</option><option value="duel3">Arena Tim 3 vs 3</option><option value="train">Mode Latihan (target diam + pengatur kecepatan/cooldown)</option></select>
      <label>Maksimal pemain</label>
      <div class="chips" id="presets"></div>
      <input id="rmax" type="number" min="2" max="100" value="10" style="margin-top:8px">
      <div id="rdminBox" class="hidden">
        <label>Batas waktu pertandingan (menit, maks 20). Setelah habis: sudden death 1 menit, lalu darah terkuras</label>
        <div class="chips" id="dpresets"></div>
        <input id="rdmin" type="number" min="1" max="20" value="5" style="margin-top:8px">
        <div class="row" style="margin-top:8px">
          <div><label>Lama sudden death</label><select id="rsd"><option value="30">30 detik</option><option value="60" selected>1 menit</option><option value="120">2 menit</option><option value="180">3 menit</option></select></div>
          <div><label>Darah terkuras</label><select id="rdr"><option value="slow">Pelan (20 HP/dtk)</option><option value="mid" selected>Sedang (40 HP/dtk)</option><option value="fast">Cepat (80 HP/dtk)</option></select></div>
        </div>
      </div>
      <label class="chk"><input type="checkbox" id="rvoice" checked> Voice chat: pemain bisa bicara (mikrofon) dan mendengar suara</label>
      <label class="chk"><input type="checkbox" id="rpick"> Mode pilih teknik: pemain memilih teknik dari daftar, tanpa mengetik kode angka</label>
      <label class="chk"><input type="checkbox" id="rff" checked> Friendly fire (khusus Arena Tim): teman satu tim bisa saling melukai</label>
      <label class="chk"><input type="checkbox" id="rdebug"> Mode uji hit: tampilkan alasan serangan meleset di layar penyerang (untuk mencari bug)</label>
      <div id="rmsg"></div>
      <div class="mact"><button id="rcancel">Batal</button><button class="pri" id="rcreate">Buat room</button></div>
  </div></div>

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
    <div class="card">
      <h2>Cadangan data</h2>
      <p class="hint">Unduh semua room dan buku teknik (tanpa password admin) ke satu file. Pulihkan akan mengganti semua room dan teknik yang ada, dan mengeluarkan pemain yang sedang online.</p>
      <div id="bmsg"></div>
      <button class="pri" id="bdl" style="margin-top:10px">Unduh cadangan</button>
      <label>Pulihkan dari file cadangan</label>
      <input id="bfile" type="file" accept="application/json,.json">
      <button class="bad" id="brs" style="margin-top:10px">Pulihkan</button>
    </div>
  </div>
</div>
</div>

<script>
(function(){
const $=id=>document.getElementById(id);
let token=null;try{token=localStorage.getItem('dw_admin')}catch(e){}
let techs=[],pollT=null;
const KINDS={bolt:'Bola lempar (bolt)',orb:'Bola biru raksasa (orb)',nova:'Ledakan area (nova)',beam:'Sinar tembus (beam)',slam:'Lompat & hantam (slam)',meteor:'Loncat & bola ke bawah (meteor)',spin:'Berputar dengan pedang (spin)',launch:'Cungkil musuh ke atas (launch)',ring:'Tembok 360° (ring)',trap:'Ranjau (trap)',summon:'Panggil elang (summon)',ride:'Tunggang elang (ride)',heal:'Penyembuh (heal)',regen:'Pulih bertahap (regen)',shield:'Perisai (shield)',haste:'Percepat lari (haste)',dash:'Lesat (dash)',wall:'Dinding (wall)',jump:'Loncat tinggi (jump)',blink:'Teleport (blink)',homing:'Bola pengejar (homing)',lion:'Panggil singa (lion)',face:'Hadap lawan terdekat (face)'};
const FIELDS={ // kind -> [field,label]
  bolt:[['damage','Damage'],['cd','Cooldown (dtk)'],['speed','Kecepatan'],['life','Lama terbang (dtk)'],['count','Jumlah bola'],['spread','Sebaran (rad)'],['size','Ukuran bola'],['boom','Radius ledakan'],['stun','Beku (dtk)']],
  orb:[['damage','Damage (sekali hantam)'],['cd','Cooldown (dtk)'],['speed','Kecepatan'],['life','Lama melaju (dtk)'],['radius','Radius bola']],
  nova:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius'],['stun','Beku (dtk)']],
  beam:[['damage','Damage'],['cd','Cooldown (dtk)'],['range','Panjang sinar'],['stun','Beku (dtk)']],
  slam:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius']],
  ring:[['dur','Durasi (dtk)'],['cd','Cooldown (dtk)'],['radius','Radius tembok'],['hp','HP tiap bagian']],
  launch:[['damage','Damage'],['cd','Cooldown (dtk)'],['range','Jangkauan'],['lift','Daya cungkil (tinggi)']],
  spin:[['damage','Damage per tebasan (tiap 0,25 dtk)'],['cd','Cooldown (dtk)'],['dur','Durasi (dtk)'],['radius','Radius']],
  meteor:[['damage','Damage per bola'],['cd','Cooldown (dtk)'],['count','Jumlah bola'],['speed','Kecepatan jatuh'],['size','Ukuran bola'],['boom','Radius ledakan']],
  trap:[['damage','Damage'],['cd','Cooldown (dtk)'],['radius','Radius pemicu'],['stun','Beku (dtk)']],
  summon:[['damage','Damage per serangan'],['cd','Cooldown (dtk)'],['count','Jumlah elang (maks 4)'],['dur','Durasi (dtk)'],['speed','Kecepatan terbang']],
  ride:[['dur','Durasi terbang (dtk, maks 300)'],['speed','Kecepatan terbang'],['cd','Cooldown (dtk)']],
  heal:[['damage','Jumlah HP pulih'],['cd','Cooldown (dtk)']],
  regen:[['damage','Total HP pulih'],['cd','Cooldown (dtk)'],['dur','Durasi (dtk)']],
  shield:[['dur','Durasi (dtk)'],['cd','Cooldown (dtk)']],
  haste:[['power','Pengali kecepatan'],['cd','Cooldown (dtk)'],['dur','Durasi (dtk)']],
  dash:[['speed','Daya lesat'],['cd','Cooldown (dtk)']],
  wall:[['hp','Kekuatan dinding (HP)'],['cd','Cooldown (dtk)'],['dur','Lama bertahan (dtk)'],['len','Lebar dinding (m)']],
  jump:[['power','Daya lompat'],['cd','Cooldown (dtk)']],
  blink:[['range','Jarak teleport (m)'],['cd','Cooldown (dtk)']],
  face:[['range','Jarak cari lawan (m)'],['cd','Cooldown (dtk)']],
  lion:[['damage','Damage per gigitan'],['cd','Cooldown (dtk)'],['count','Jumlah singa (maks 2)'],['dur','Durasi (dtk)'],['speed','Kecepatan lari'],['hp','HP singa']],
  homing:[['damage','Damage per bola'],['cd','Cooldown (dtk)'],['count','Jumlah bola'],['life','Lama mengejar (dtk)'],['size','Ukuran bola'],['boom','Radius ledakan'],['turn','Ketajaman belok']]
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
[5,10,15,20].forEach(n=>{const c=document.createElement('div');c.className='chip'+(n===5?' on':'');c.textContent=n+' menit';c.addEventListener('click',()=>{$('rdmin').value=n;markD();});$('dpresets').appendChild(c);});
function markD(){document.querySelectorAll('#dpresets .chip').forEach(c=>c.classList.toggle('on',parseInt(c.textContent,10)===parseInt($('rdmin').value,10)));}
$('rdmin').addEventListener('input',markD);
function modeUI(){$('rdminBox').classList.toggle('hidden',$('rmode').value.slice(0,4)!=='duel');}
$('rmode').addEventListener('change',modeUI);
function mark(){document.querySelectorAll('#presets .chip').forEach(c=>c.classList.toggle('on',parseInt(c.textContent,10)===parseInt($('rmax').value,10)));}
$('rmax').addEventListener('input',mark);
function rOpen(){msg($('rmsg'),'');modeUI();$('rmodal').classList.remove('hidden');setTimeout(()=>$('rname').focus(),50);}
function rClose(){$('rmodal').classList.add('hidden');}
$('rnew').addEventListener('click',rOpen);$('rcancel').addEventListener('click',rClose);
$('rmodal').addEventListener('click',e=>{if(e.target===$('rmodal'))rClose();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')rClose();});
$('rcreate').addEventListener('click',async()=>{
  try{await api('/rooms',{method:'POST',body:{name:$('rname').value,max:parseInt($('rmax').value,10),voice:$('rvoice').checked,pick:$('rpick').checked,debug:$('rdebug').checked,mode:$('rmode').value==='world'?'world':($('rmode').value==='train'?'train':'duel'),team:parseInt($('rmode').value.slice(4),10)||1,ff:$('rff').checked,dmin:parseInt($('rdmin').value,10)||5,sdsec:parseInt($('rsd').value,10),drain:$('rdr').value}});$('rname').value='';rClose();loadRooms();}
  catch(e){msg($('rmsg'),e.message);}
});
const openRooms=new Set();
const CHEV='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
function roomLink(code){return location.origin+'/r/'+code;}
async function loadRooms(){
  let j;try{j=await api('/rooms');}catch(e){return;}
  const box=$('roomList');
  if(document.activeElement&&box.contains(document.activeElement)&&document.activeElement.tagName==='INPUT'&&document.activeElement.dataset.edit)return;
  box.innerHTML='';
  if(!j.rooms.length){const p=document.createElement('p');p.className='hint';p.textContent='Belum ada room. Tekan "+ Buat room".';box.appendChild(p);return;}
  j.rooms.forEach(r=>{
    const card=document.createElement('div');card.className='room'+(openRooms.has(r.code)?' open':'');
    const sum=document.createElement('div');sum.className='rsum';const tx=document.createElement('div');tx.className='tx';sum.appendChild(tx);
    const chv=document.createElement('span');chv.innerHTML=CHEV;sum.appendChild(chv);
    sum.addEventListener('click',()=>{const o=card.classList.toggle('open');if(o)openRooms.add(r.code);else openRooms.delete(r.code);});
    card.appendChild(sum);
    const d=document.createElement('div');d.className='rbody';card.appendChild(d);
    const h=document.createElement('h3');h.textContent=r.name+'  ('+r.count+'/'+r.max+')';tx.appendChild(h);
    const m=document.createElement('div');m.className='meta';m.textContent='Kode '+r.code+(r.mode==='duel'?' · ARENA '+(r.team||1)+'v'+(r.team||1)+((r.team||1)>1?' (tim, FF '+(r.ff===false?'mati':'nyala')+')':' DUEL'):(r.mode==='train'?' · MODE LATIHAN':' · dunia biasa'))+(r.voice!==false?' · voice aktif':' · voice mati')+(r.pick?' · pilih teknik':' · ketik kode')+(r.debug?' · UJI HIT':'')+(r.mode==='duel'?' · batas '+(r.dmin||5)+' mnt + SD '+(r.sdsec||60)+' dtk':'')+' · dibuat '+new Date(r.created).toLocaleString();tx.appendChild(m);
    const l=document.createElement('div');l.className='link';
    const i=document.createElement('input');i.readOnly=true;i.value=roomLink(r.code);i.addEventListener('focus',()=>i.select());
    const cp=document.createElement('button');cp.className='ok';cp.textContent='Salin';
    cp.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(i.value);}catch(e){i.select();document.execCommand('copy');}cp.textContent='Tersalin';setTimeout(()=>cp.textContent='Salin',1500);});
    l.appendChild(i);l.appendChild(cp);d.appendChild(l);
    const row=document.createElement('div');row.className='row';
    const nm=document.createElement('input');nm.value=r.name;nm.maxLength=30;nm.dataset.edit=1;
    const mx=document.createElement('input');mx.type='number';mx.min=2;mx.max=100;mx.value=r.max;mx.dataset.edit=1;mx.style.maxWidth='110px';
    const vl=document.createElement('label');vl.className='chk';vl.style.gridColumn='1 / -1';vl.style.margin='0';const vc=document.createElement('input');vc.type='checkbox';vc.checked=r.voice!==false;vc.dataset.edit=1;vl.appendChild(vc);vl.appendChild(document.createTextNode('Voice chat aktif'));
    const pl2=document.createElement('label');pl2.className='chk';pl2.style.gridColumn='1 / -1';pl2.style.margin='0';const pc=document.createElement('input');pc.type='checkbox';pc.checked=r.pick===true;pc.dataset.edit=1;pl2.appendChild(pc);pl2.appendChild(document.createTextNode('Mode pilih teknik (tanpa ketik kode)'));
    const dgl=document.createElement('label');dgl.className='chk';dgl.style.gridColumn='1 / -1';dgl.style.margin='0';const dgc=document.createElement('input');dgc.type='checkbox';dgc.checked=r.debug===true;dgc.dataset.edit=1;dgl.appendChild(dgc);dgl.appendChild(document.createTextNode('Mode uji hit (alasan meleset tampil di layar)'));
    let dm=null,dwEl=null,sdSel=null,drSel=null,sdW=null,drW=null;
    if(r.mode==='duel'){const dw=document.createElement('label');dw.style.gridColumn='1 / -1';dw.style.margin='0';dw.style.display='flex';dw.style.alignItems='center';dw.style.gap='8px';dw.style.fontSize='13px';dw.appendChild(document.createTextNode('Batas waktu (menit, 1-20)'));dm=document.createElement('input');dm.type='number';dm.min=1;dm.max=20;dm.value=r.dmin||5;dm.dataset.edit=1;dm.style.maxWidth='90px';dw.appendChild(dm);dwEl=dw;
      const mk=(label,opts,val)=>{const w=document.createElement('label');w.style.cssText='grid-column:1 / -1;display:flex;align-items:center;gap:8px;font-size:13px;margin:0';w.appendChild(document.createTextNode(label));const se=document.createElement('select');se.dataset.edit=1;se.style.maxWidth='190px';opts.forEach(o=>{const e=document.createElement('option');e.value=o[0];e.textContent=o[1];if(String(o[0])===String(val))e.selected=true;se.appendChild(e);});w.appendChild(se);return [w,se];};
      const sdOpts=[[30,'30 detik'],[60,'1 menit'],[120,'2 menit'],[180,'3 menit']];const sdv=r.sdsec||60;if(!sdOpts.some(o=>o[0]===sdv)){sdOpts.push([sdv,sdv+' detik']);sdOpts.sort((a,b)=>a[0]-b[0]);}
      const a1=mk('Lama sudden death',sdOpts,sdv);sdW=a1[0];sdSel=a1[1];
      const a2=mk('Darah terkuras',[['slow','Pelan (20 HP/dtk)'],['mid','Sedang (40 HP/dtk)'],['fast','Cepat (80 HP/dtk)']],r.drain||'mid');drW=a2[0];drSel=a2[1];}
    const sv=document.createElement('button');sv.textContent='Ubah';
    sv.addEventListener('click',async()=>{try{await api('/rooms/'+r.code,{method:'PATCH',body:{name:nm.value,max:parseInt(mx.value,10),voice:vc.checked,pick:pc.checked,debug:dgc.checked,...(dm?{dmin:parseInt(dm.value,10),sdsec:parseInt(sdSel.value,10),drain:drSel.value}:{})}});sv.textContent='Tersimpan';setTimeout(loadRooms,800);}catch(e){alert(e.message);}});
    const dl=document.createElement('button');dl.className='bad';dl.textContent='Hapus';
    dl.addEventListener('click',async()=>{if(!confirm('Hapus room "'+r.name+'"? Semua pemain akan dikeluarkan.'))return;try{await api('/rooms/'+r.code,{method:'DELETE'});loadRooms();}catch(e){alert(e.message);}});
    row.appendChild(nm);row.appendChild(mx);row.appendChild(vl);row.appendChild(pl2);row.appendChild(dgl);if(dwEl){row.appendChild(dwEl);row.appendChild(sdW);row.appendChild(drW);}row.appendChild(sv);row.appendChild(dl);d.appendChild(row);
    if(r.players.length){const p=document.createElement('div');p.className='pl';p.appendChild(document.createTextNode('Online: '));r.players.forEach(n=>{const b=document.createElement('b');b.textContent=n;p.appendChild(b);});d.appendChild(p);}
    box.appendChild(card);
  });
}

/* techniques */
let defTechs=[];
async function loadTech(){const j=await api('/techniques');techs=j.techniques;try{defTechs=(await api('/techniques/defaults')).techniques;}catch(e){}renderTech();const st=await api('/settings');$('showBook').checked=!!st.showBook;}
$('showBook').addEventListener('change',async()=>{try{await api('/settings',{method:'PUT',body:{showBook:$('showBook').checked}});msg($('tmsg'),$('showBook').checked?'Buku tampil di game':'Buku disembunyikan dari game','ok');}catch(e){msg($('tmsg'),e.message);}});
const XSVG='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const openTech=new WeakSet();
function renderTech(){
  const box=$('techList');box.innerHTML='';
  techs.forEach((t,idx)=>{
    const card=document.createElement('div');card.className='tech'+(openTech.has(t)?' open':'');
    const sum=document.createElement('div');sum.className='tsum';
    const dot=document.createElement('span');dot.className='dot';dot.style.background=/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#4db8ff';
    const tx=document.createElement('div');tx.className='tx';const tb=document.createElement('b');const ts=document.createElement('small');tx.appendChild(tb);tx.appendChild(ts);
    const chv=document.createElement('span');chv.innerHTML=CHEV;
    function upSum(){tb.textContent=t.name||'(tanpa nama)';ts.textContent='Kode '+(t.code||'-')+' · '+(KINDS[t.kind]||t.kind)+(t.cd!=null&&!isNaN(t.cd)?' · CD '+t.cd+' dtk':'');}upSum();
    sum.appendChild(dot);sum.appendChild(tx);sum.appendChild(chv);
    sum.addEventListener('click',()=>{const o=card.classList.toggle('open');if(o)openTech.add(t);else openTech.delete(t);});
    card.appendChild(sum);
    const d=document.createElement('div');d.className='tbody';card.appendChild(d);
    const hd=document.createElement('div');hd.className='hd';
    const nm=document.createElement('input');nm.className='nm';nm.value=t.name;nm.maxLength=24;nm.placeholder='Nama teknik';nm.addEventListener('input',()=>{t.name=nm.value;upSum();});
    const rm=document.createElement('button');rm.className='bad';rm.innerHTML=XSVG;rm.addEventListener('click',()=>{techs.splice(idx,1);renderTech();});
    const df=defTechs.find(x=>x.code===t.code);
    if(df){const rb=document.createElement('button');rb.textContent='Bawaan';rb.title='Kembalikan teknik ini ke angka bawaan (lalu tekan Simpan)';rb.style.marginRight='6px';rb.addEventListener('click',()=>{techs[idx]=Object.assign({},df);openTech.add(techs[idx]);renderTech();msg($('tmsg'),'"'+df.name+'" dikembalikan ke bawaan. Tekan Simpan untuk menyimpan.','ok');});hd.appendChild(nm);hd.appendChild(rb);hd.appendChild(rm);}
    else{hd.appendChild(nm);hd.appendChild(rm);}
    d.appendChild(hd);
    const g=document.createElement('div');g.className='g';
    function field(label,el){const w=document.createElement('div');const l=document.createElement('label');l.textContent=label;w.appendChild(l);w.appendChild(el);g.appendChild(w);}
    const code=document.createElement('input');code.className='code';code.value=t.code;code.maxLength=12;code.inputMode='numeric';code.addEventListener('input',()=>{code.value=code.value.replace(/[^1-9]/g,'');t.code=code.value;upSum();});field('Kode (1-9)',code);
    const kind=document.createElement('select');Object.keys(KINDS).forEach(k=>{const o=document.createElement('option');o.value=k;o.textContent=KINDS[k];if(k===t.kind)o.selected=true;kind.appendChild(o);});
    kind.addEventListener('change',()=>{t.kind=kind.value;renderTech();});field('Jenis',kind);
    const col=document.createElement('input');col.type='color';col.value=/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#4db8ff';col.addEventListener('input',()=>{t.color=col.value;dot.style.background=col.value;});field('Warna',col);
    const ds=document.createElement('input');ds.value=t.desc||'';ds.maxLength=80;ds.placeholder='(otomatis)';ds.addEventListener('input',()=>t.desc=ds.value);field('Deskripsi di buku',ds);
    (FIELDS[t.kind]||[]).forEach(f=>{const n=document.createElement('input');n.type='number';n.step='any';n.value=t[f[0]]==null?'':t[f[0]];n.addEventListener('input',()=>t[f[0]]=parseFloat(n.value));field(f[1],n);});
    d.appendChild(g);box.appendChild(card);
  });
}
$('techAdd').addEventListener('click',()=>{const nt={code:'',name:'Teknik baru',kind:'bolt',color:'#4db8ff',damage:20,cd:2,speed:24,life:1.4,count:1,spread:0};techs.push(nt);openTech.add(nt);renderTech();const cs=$('techList').children;cs[cs.length-1].scrollIntoView({block:'center',behavior:'smooth'});});
$('techSave').addEventListener('click',async()=>{try{const j=await api('/techniques',{method:'PUT',body:{techniques:techs}});techs=j.techniques;renderTech();msg($('tmsg'),'Buku tersimpan ('+techs.length+' teknik)','ok');}catch(e){msg($('tmsg'),e.message);}});
$('techReset').addEventListener('click',async()=>{if(!confirm('Kembalikan semua teknik ke default?'))return;try{const j=await api('/techniques/reset',{method:'POST'});techs=j.techniques;renderTech();msg($('tmsg'),'Dikembalikan ke default','ok');}catch(e){msg($('tmsg'),e.message);}});

/* account */
$('bdl').addEventListener('click',async()=>{
  try{
    const j=await api('/backup');
    const blob=new Blob([JSON.stringify(j,null,2)],{type:'application/json'});
    const u=URL.createObjectURL(blob);const el=document.createElement('a');
    const d=new Date();const pad=n=>String(n).padStart(2,'0');
    el.href=u;el.download='digital-war-cadangan-'+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+'.json';
    document.body.appendChild(el);el.click();el.remove();setTimeout(()=>URL.revokeObjectURL(u),2000);
    msg($('bmsg'),'Cadangan diunduh: '+j.rooms.length+' room, '+j.techniques.length+' teknik','ok');
  }catch(e){msg($('bmsg'),e.message,'err');}
});
$('brs').addEventListener('click',async()=>{
  const f=$('bfile').files[0];if(!f){msg($('bmsg'),'Pilih file cadangan dulu','err');return;}
  if(!confirm('Pulihkan dari "'+f.name+'"? Semua room dan teknik sekarang akan diganti dan pemain online dikeluarkan.'))return;
  try{
    const txt=await f.text();let j;try{j=JSON.parse(txt);}catch(e){throw new Error('File bukan JSON yang valid');}
    const r=await api('/restore',{method:'POST',body:j});
    msg($('bmsg'),'Dipulihkan: '+r.rooms+' room, '+r.techniques+' teknik','ok');loadRooms();
  }catch(e){msg($('bmsg'),e.message,'err');}
});
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
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="theme-color" content="#0b1020">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Digital War">
<!--TUNING--><title>Digital War</title>
<link href="/vendor/fonts.css" rel="stylesheet">
<style>
:root{--gx:10px;--s:clamp(46px,8vh,60px)}
html,body{margin:0;position:fixed;left:0;top:0;width:100%;height:100%;height:var(--vh,100dvh);overflow:hidden;overscroll-behavior:none;-webkit-text-size-adjust:100%;background:#0b1020;color:#fff;font-family:"Poppins","Segoe UI","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-user-select:none;user-select:none;touch-action:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
canvas#c{display:block;position:fixed;left:0;top:0;width:100%;height:100%;touch-action:none;outline:none}
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
#hpBox{position:fixed;left:max(var(--gx),env(safe-area-inset-left));top:max(10px,env(safe-area-inset-top));width:190px;z-index:3;pointer-events:none}
#hpName{font-weight:800;font-size:14px;text-shadow:0 1px 3px #000;display:flex;justify-content:space-between;gap:8px}
.bar{height:12px;border-radius:7px;background:rgba(10,16,32,.7);border:2px solid rgba(255,255,255,.55);overflow:hidden;margin-top:3px}
.bar i{display:block;height:100%;width:100%;background:linear-gradient(#6dff96,#2fc45f);transition:width .15s}
#oxyBox{position:fixed;left:50%;top:max(46px,calc(env(safe-area-inset-top) + 40px));transform:translateX(-50%);width:160px;z-index:3;pointer-events:none;opacity:0;transition:opacity .2s}
#oxyBox .bar i{background:linear-gradient(#9fe3ff,#3aa7e8)}
#oxyBox small{display:block;text-align:center;font-size:11px;font-weight:700;text-shadow:0 1px 3px #000}
#mini{cursor:pointer;position:fixed;left:max(var(--gx),env(safe-area-inset-left));top:calc(max(10px,env(safe-area-inset-top)) + 52px);width:96px;height:96px;border-radius:50%;border:2px solid rgba(255,255,255,.65);box-shadow:0 2px 10px rgba(0,0,0,.3);pointer-events:auto;z-index:3}
#roomTag{top:max(10px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);font-size:12px;padding:4px 12px;white-space:nowrap}
#net{top:max(10px,env(safe-area-inset-top));left:calc(50% - 62px);transform:translateX(-100%);font-size:12px;padding:4px 10px;display:flex;align-items:center;gap:6px;white-space:nowrap}
#net svg{width:16px;height:14px;display:block}
#net.q4 .on{fill:#4de27a}#net.q3 .on{fill:#a6e04d}#net.q2 .on{fill:#ffd84d}#net.q1 .on{fill:#ff9a3c}#net.q0 .on{fill:#ff4d4d}
#net .off{fill:rgba(255,255,255,.25)}
#net.q0{color:#ff9d9d}
#clock{top:max(10px,env(safe-area-inset-top));right:max(var(--gx),env(safe-area-inset-right));font-size:12px;padding:4px 10px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 122px)}
#sbBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(var(--gx),env(safe-area-inset-right));width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:16px;z-index:4;cursor:pointer;padding:0}
#fsBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:calc(max(var(--gx),env(safe-area-inset-right)) + 40px);width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:17px;z-index:4;cursor:pointer;padding:0;line-height:1}
#bookBtn{position:fixed;top:max(8px,env(safe-area-inset-top));right:calc(max(var(--gx),env(safe-area-inset-right)) + 80px);width:34px;height:30px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;font-size:16px;z-index:4;cursor:pointer;padding:0;line-height:1}
#board{position:fixed;top:calc(max(8px,env(safe-area-inset-top)) + 38px);right:max(var(--gx),env(safe-area-inset-right));min-width:170px;max-width:240px;background:rgba(10,16,32,.78);border-radius:12px;padding:8px 10px;font-size:13px;z-index:4;display:none;pointer-events:none}
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
#hint{left:max(var(--gx),env(safe-area-inset-left));bottom:10px;font-size:11px;font-weight:600;opacity:.8;max-width:60vw;white-space:normal;border-radius:12px}
#uw{position:fixed;inset:0;background:rgba(20,100,170,.5);opacity:0;transition:opacity .15s;pointer-events:none;z-index:2}
#fxScr{position:fixed;inset:0;pointer-events:none;z-index:2}
#fxScr .fl{position:absolute;inset:0;opacity:0;transition:opacity .6s}
#fxIce{background:radial-gradient(ellipse at center,rgba(120,190,255,.2) 25%,rgba(80,160,255,.52) 62%,rgba(160,220,255,.9) 100%)}
#fxShield{box-shadow:inset 0 0 100px 22px rgba(108,212,255,.5);border:4px solid rgba(190,240,255,.45)}
#fxHaste{box-shadow:inset 0 0 110px 20px rgba(255,235,90,.5)}
#fxRegen{box-shadow:inset 0 0 120px 24px rgba(80,255,150,.5);animation:fxPulse 1.4s ease-in-out infinite}
@keyframes fxPulse{0%,100%{filter:brightness(.7)}50%{filter:brightness(1.3)}}
#fxGuard{box-shadow:inset 0 0 70px 6px rgba(150,205,255,.38)}
#fxBreak{box-shadow:inset 0 0 130px 40px rgba(255,150,40,.55)}
#fxRide{box-shadow:inset 0 0 110px 16px rgba(255,224,176,.4)}
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
#btnJump{width:62px;height:62px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 98px);bottom:max(18px,env(safe-area-inset-bottom));font-size:20px}
#btnAtk{width:86px;height:86px;right:max(var(--gx),env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));background:rgba(190,45,55,.7);font-size:26px}
#btnAtk svg,#btnAtk i{width:38px;height:38px}
#btnGuard{width:58px;height:58px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 100px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 72px);background:rgba(40,90,170,.6);font-size:18px}
#btnGuard.on{background:rgba(110,200,255,.85);box-shadow:0 0 18px rgba(120,210,255,.9);color:#04223a}
#btnGuard.broken{opacity:.45}
#btnAct{width:48px;height:48px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 172px);bottom:calc(max(18px,env(safe-area-inset-bottom)) + 74px);display:none;font-size:18px}
#btnAct.on{display:flex;background:rgba(255,200,60,.85);color:#3a2a00;box-shadow:0 0 22px rgba(255,210,80,.9)}
#btnDive{width:58px;height:58px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 172px);bottom:max(18px,env(safe-area-inset-bottom));display:none;background:rgba(30,120,200,.6);font-size:18px}
#btnDive.on{display:flex}
#btnSnipe{width:58px;height:58px;right:calc(max(var(--gx),env(safe-area-inset-right)) + 236px);bottom:max(18px,env(safe-area-inset-bottom));display:none;background:rgba(150,105,15,.7);font-size:18px}
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
#bkX svg{width:16px;height:16px;display:block;margin:0}
.kdi{width:13px;height:13px;vertical-align:-2px}
.bki{width:20px;height:20px;vertical-align:-4px;margin-right:6px;display:inline-block}
.mi{display:inline-block;width:18px;height:18px;vertical-align:-4px;margin-right:5px}
.mi svg{width:100%;height:100%}
.clki{width:14px;height:14px;vertical-align:-2px}
#rotHint{position:fixed;inset:0;z-index:99999;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0b1020;color:#fff;text-align:center;padding:24px;font-size:17px;font-weight:600}
#rotHint small{display:block;font-size:13px;font-weight:400;opacity:.7;margin-top:6px}
#rotHint .ph{width:54px;height:96px;border:4px solid #4de1ff;border-radius:12px;position:relative;animation:rotPh 2.4s ease-in-out infinite}
#rotHint .ph:after{content:"";position:absolute;left:50%;bottom:6px;width:14px;height:3px;margin-left:-7px;border-radius:2px;background:#4de1ff}
@keyframes rotPh{0%,15%{transform:rotate(0)}55%,85%{transform:rotate(-90deg)}100%{transform:rotate(0)}}
@keyframes rotGone{to{opacity:0;visibility:hidden;pointer-events:none}}
@media (orientation:portrait) and (pointer:coarse) and (max-width:900px){#rotHint{display:flex;animation:rotGone .3s 3s forwards}}
span.clki{display:inline-block}
span.clki svg{width:14px;height:14px;vertical-align:-2px}
@media (orientation:portrait){
body #slots{top:42%}
}
#slots{position:fixed;right:max(var(--gx),env(safe-area-inset-right));top:50%;transform:translateY(-46%);display:none;flex-direction:column;gap:6px;z-index:3}
body.playing #slots{display:flex}
@media (orientation:landscape) and (max-height:520px){:root{--s:clamp(38px,7.4vh,52px)}#slots{top:62px;transform:none}#btnAtk{width:78px;height:78px}#btnAtk svg,#btnAtk i{width:32px;height:32px}#btnJump{right:calc(max(var(--gx),env(safe-area-inset-right)) + 90px)}#btnGuard{right:calc(max(var(--gx),env(safe-area-inset-right)) + 92px)}#btnAct,#btnDive{right:calc(max(var(--gx),env(safe-area-inset-right)) + 164px)}#btnSnipe{right:calc(max(var(--gx),env(safe-area-inset-right)) + 228px)}}
.slot{position:relative;width:var(--s);height:var(--s);border-radius:14px;border:2px solid rgba(255,255,255,.6);background:rgba(10,16,32,.55);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;touch-action:none;font-family:inherit;padding:0}
.slot .k{position:absolute;left:4px;top:1px;font-size:10px;font-weight:800;opacity:.75}
.slot .ic{font-size:calc(var(--s)*.42);line-height:1}
.slot .nm{font-size:8.5px;font-weight:700;max-width:96%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9;margin-top:1px}
.slot.empty .ic{opacity:.55;font-weight:300}
.slot.filled{border-color:var(--c,#fff);box-shadow:0 0 12px var(--c,#fff) inset}
.slot.filled.avail{border-color:#fff;box-shadow:0 0 0 2px var(--c,#fff),0 0 16px 3px var(--c,#fff),0 0 12px var(--c,#fff) inset}
.slot.filled:not(.avail){border-color:rgba(255,255,255,.22);opacity:.8}
.slot .cd{position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(0,0,0,.65);pointer-events:none}
.slot.down{transform:scale(.93)}
.slot.ready{animation:rd .5s}
@keyframes rd{0%{filter:brightness(2)}100%{filter:none}}
#book{position:fixed;inset:0;background:rgba(0,0,10,.68);display:none;align-items:center;justify-content:center;z-index:25;touch-action:manipulation}
#book.show{display:flex}
#bk{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;position:relative;width:min(calc(100vw - 2*var(--gx)),780px);height:min(88vh,560px);background:linear-gradient(#6b4528,#46301a);border-radius:14px;padding:12px 12px 16px;box-shadow:0 20px 60px rgba(0,0,0,.75),inset 0 0 0 2px #8a5e38}
#bkTabs{display:flex;gap:6px;overflow-x:auto;flex:none;padding:2px 36px 2px 2px;scrollbar-width:none}#bkTabs::-webkit-scrollbar{display:none}
#bkTabs button{flex:none;border:2px solid #8a5e38;background:#5a3b21;color:#f3e2b8;border-radius:999px;padding:5px 13px;font:600 12.5px Poppins,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
#bkTabs button.on{background:#f3e2b8;color:#4a2c12;border-color:#f3e2b8}
#bkPages{display:flex;flex:1;min-height:0;border-radius:4px;overflow:hidden;box-shadow:0 3px 0 #d3c08c,0 6px 0 #bda877,0 9px 0 #a8935f,0 14px 18px rgba(0,0,0,.55)}
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
#bkX{display:flex;align-items:center;justify-content:center;line-height:0;position:absolute;top:-10px;right:-8px;width:32px;height:32px;border-radius:50%;border:2px solid #f3e2b8;background:#46301a;color:#f3e2b8;font-size:14px;cursor:pointer;padding:0;z-index:3}
#lcol{position:fixed;left:max(var(--gx),env(safe-area-inset-left));top:calc(max(10px,env(safe-area-inset-top)) + 168px);display:flex;flex-direction:column;gap:6px;z-index:4}
body.playing #lcol.hud{display:flex!important}
#lcol button{position:relative;width:36px;height:34px;border-radius:12px;border:0;background:rgba(10,16,32,.55);color:#fff;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
#lcol button svg{width:20px;height:20px}
#lcol.collapsed button:not(#lcolTog){display:none}
#lcolTog{background:rgba(10,16,32,.8)!important}
#lcol button.active{background:rgba(30,111,255,.85)}
#lcol .vo.off{display:none}
#emoPanel{position:fixed;left:calc(max(var(--gx),env(safe-area-inset-left)) + 46px);top:calc(max(10px,env(safe-area-inset-top)) + 168px);display:none;grid-template-columns:repeat(4,60px);gap:6px;padding:8px;background:rgba(8,14,32,.94);border:1px solid rgba(120,190,255,.28);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:12;touch-action:manipulation;font-family:Poppins,system-ui,sans-serif}
#emoPanel.show{display:grid}
#emoPanel button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:5px 2px 4px;border:0;border-radius:12px;background:rgba(255,255,255,.07);color:#fff;font:600 9.5px/1.1 Poppins,system-ui,sans-serif;cursor:pointer;text-align:center}
#emoPanel button:active{background:rgba(30,111,255,.7)}
#emoPanel button img{width:34px;height:34px;image-rendering:pixelated}
#emoSelf{left:50%;top:20%;transform:translateX(-50%);display:none;align-items:center;gap:8px;padding:5px 14px 5px 8px;font-size:14px}
#emoSelf img{width:30px;height:30px;image-rendering:pixelated}
@media (max-height:560px){#emoPanel{left:calc(max(var(--gx),env(safe-area-inset-left)) + 90px)}}
.badge{position:absolute;top:-4px;right:-4px;background:#ff4d4d;color:#fff;font-size:10px;font-weight:700;border-radius:8px;padding:1px 5px;display:none;font-style:normal}
#chatFeed{position:fixed;left:max(var(--gx),env(safe-area-inset-left));bottom:84px;max-width:min(62vw,420px);z-index:3;pointer-events:none;display:none;flex-direction:column;gap:2px;font-size:13px}
body.playing #chatFeed.hud{display:flex!important}
#chatFeed div{background:rgba(5,10,22,.55);padding:3px 10px;border-radius:10px;animation:fd 9s forwards;text-shadow:0 1px 2px #000}
#chatFeed b,#chatList b{color:#4db8ff}
#chatPanel{position:fixed;left:max(var(--gx),env(safe-area-inset-left));bottom:70px;box-sizing:border-box;width:min(calc(100vw - 2*var(--gx)),360px);max-height:52vh;display:none;flex-direction:column;background:rgba(5,10,22,.94);border:2px solid #1c3a66;border-radius:16px;z-index:12;touch-action:manipulation;-webkit-user-select:text;user-select:text}
#chatPanel.show{display:flex}
#chatHead{display:flex;align-items:center;justify-content:space-between;padding:6px 8px 6px 14px;border-bottom:1px solid #1c3a66;font-weight:700;font-size:13px;color:#9fd0ff}
#chatX{width:34px;height:34px;border-radius:50%;border:1.5px solid #3a5f95;background:#10264a;color:#e6f2ff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
#chatX svg{width:16px;height:16px}
#chatPanel{max-height:min(60vh,420px)!important;overflow:hidden;border:1px solid rgba(120,190,255,.28)!important;border-radius:18px!important;background:rgba(8,14,32,.94)!important;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:Poppins,system-ui,sans-serif}
#chatHead{flex:0 0 auto}
body.playing.chatopen #chatFeed.hud{display:none!important}
#chatList{flex:1 1 auto;min-height:0;max-height:none!important;overflow-y:auto;padding:10px 12px;font-size:13px;line-height:1.45;word-break:break-word;display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}
#chatList div{margin:0;align-self:flex-start;max-width:86%;background:rgba(255,255,255,.07);padding:6px 11px;border-radius:14px 14px 14px 4px}
#chatList div.me{align-self:flex-end;background:rgba(30,111,255,.38);border-radius:14px 14px 4px 14px}
#chatList div.me b{display:none}
#chatList:empty:before{content:'Belum ada pesan. Sapa temanmu!';color:#7f93b5;font-size:12px;text-align:center;margin:auto}
#chatForm{flex:0 0 auto;display:flex;gap:8px;padding:8px 10px 10px;border-top:1px solid rgba(120,190,255,.18);align-items:center}
#chatIn{flex:1;min-width:0;height:40px;box-sizing:border-box;background:rgba(255,255,255,.08);border:1px solid rgba(160,200,255,.25);border-radius:999px;color:#fff;font-size:14px;padding:0 16px;font-family:inherit;outline:none;-webkit-user-select:text;user-select:text;transition:border-color .15s,background .15s}
#chatIn::placeholder{color:#8396b8}
#chatIn:focus{border-color:rgba(108,212,255,.8);background:rgba(255,255,255,.11)}
#chatForm button{flex:0 0 auto;width:40px;height:40px;border:0;border-radius:50%;background:linear-gradient(135deg,#1e6fff,#4db8ff);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 10px rgba(30,111,255,.45)}
#chatForm button svg{width:18px;height:18px}
#xhair{position:fixed;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);pointer-events:none;z-index:3;display:none}
#xhair.show{display:block}
#fpsView{position:fixed;inset:0;pointer-events:none;z-index:2;display:none;overflow:hidden}
#fpsView.show{display:block}
body.playing.cine #fpsView{display:none!important}
#fpsView .arm{position:absolute;bottom:calc(-4vh - min(58vh,420px)*52/32);height:calc(min(58vh,420px)*84/32);aspect-ratio:24/84;will-change:transform;}
#fpsView .arm canvas{width:100%;height:100%;display:block;image-rendering:pixelated}
#fpsRc{transform:rotate(12deg);transform-origin:50% 38.1%}
#fpsR{right:max(2vw,env(safe-area-inset-right));transform-origin:70% 38.1%}
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
#pickBox{display:none;grid-template-columns:1fr 1fr;gap:8px;max-height:min(56vh,360px);overflow-y:auto;padding:2px;text-align:left;-webkit-overflow-scrolling:touch;touch-action:pan-y}
.pk{border:2px solid #1c3a66;border-radius:12px;background:#0a1424;color:#fff;padding:8px;cursor:pointer;font-family:inherit;text-align:left;display:flex;gap:8px;align-items:center;touch-action:manipulation}
.pk:active{background:#12408a}
.pk svg{width:26px;height:26px;flex:0 0 26px}
.pk b{display:block;font-size:13px}.pk small{display:block;font-size:10px;opacity:.7;line-height:1.25}
.pk.has{opacity:.45}
body.pickmode #pad,body.pickmode #codeBox,body.pickmode #codeErr,body.pickmode #mOk,body.pickmode #mBack{display:none!important}
body.pickmode #pickBox{display:grid}
#pickTabs{display:none;gap:6px;overflow-x:auto;margin:0 0 8px;padding:2px;scrollbar-width:none;touch-action:pan-x}#pickTabs::-webkit-scrollbar{display:none}
#pickTabs button{flex:none;border:2px solid #1c3a66;background:#0a1424;color:#cfe3ff;border-radius:999px;padding:5px 12px;font:600 12px Poppins,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
#pickTabs button.on{background:#2a7bff;border-color:#2a7bff;color:#fff}
body.pickmode #pickTabs{display:flex;align-items:center;gap:10px}body.pickmode #pickTabs:empty{display:none}
#pickTabs .pt{font-weight:700;font-size:14px;color:#fff}
.pk.pf{flex-direction:column;justify-content:center;text-align:center;gap:4px;padding:14px 8px;min-height:88px}.pk.pf svg{width:34px;height:34px;flex:0 0 34px}.pk.pf b{font-size:14px}.pk.pf small{font-size:11px}
body.pickmode #mrow{grid-template-columns:1fr}
/* popup pilih teknik: hampir seluruh layar (95% x 95%), kartu kecil dan rapat */
body.pickmode #mcard{width:95vw;height:95vh;height:95dvh;max-width:none;display:flex;flex-direction:column;padding:12px}
body.pickmode #mcard h3{font-size:15px}body.pickmode #mcard p{margin:0 0 6px}
body.pickmode #pickBox{flex:1 1 auto;min-height:0;max-height:none;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-auto-rows:min-content;align-content:start;gap:6px}
body.pickmode #pickTabs{flex:none}body.pickmode #mrow,body.pickmode #mrow2{flex:none;margin-top:8px}
body.pickmode .pk{padding:6px 8px;gap:7px;border-radius:10px}
body.pickmode .pk svg{width:22px;height:22px;flex:0 0 22px}
body.pickmode .pk b{font-size:12.5px;line-height:1.2}
body.pickmode .pk small{font-size:10px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
body.pickmode .pk.pf{padding:8px 6px;min-height:0;gap:2px}body.pickmode .pk.pf svg{width:26px;height:26px;flex:0 0 26px}body.pickmode .pk.pf b{font-size:13px}body.pickmode .pk.pf small{font-size:10.5px;-webkit-line-clamp:1}
#modal{position:fixed;inset:0;background:rgba(0,0,10,.6);display:none;align-items:center;justify-content:center;z-index:20;touch-action:manipulation}
#modal.show{display:flex}
#mcard{box-sizing:border-box;width:min(calc(100vw - 2*var(--gx)),320px);background:#141b34;border:2px solid #4de1ff55;border-radius:22px;padding:16px;box-shadow:0 12px 50px rgba(0,0,0,.6),0 0 40px #4de1ff33;text-align:center}
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
#card{background:rgba(5,10,22,.95);border:2px solid #4db8ff66;border-radius:24px;padding:24px 22px;box-sizing:border-box;width:min(calc(100vw - 2*var(--gx)),460px);text-align:center;box-shadow:0 10px 50px rgba(0,0,0,.5),0 0 60px #4de1ff22;margin:auto}
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
@media (max-width:700px){#net{top:calc(max(10px,env(safe-area-inset-top)) + 106px);left:auto;right:max(var(--gx),env(safe-area-inset-right));transform:none}body.playing #hint.hud{display:none!important}#roomTag{top:calc(max(10px,env(safe-area-inset-top)) + 74px);left:auto;right:max(var(--gx),env(safe-area-inset-right));transform:none}#clock{top:calc(max(10px,env(safe-area-inset-top)) + 40px);right:max(var(--gx),env(safe-area-inset-right))}}
@media (pointer:coarse){body.playing #hint.hud{display:none!important}.key{display:none}#prompt{bottom:auto;top:40%}}

#cine{display:none;position:fixed;inset:0;z-index:70;pointer-events:none;font-family:Poppins,system-ui,sans-serif}
body.cine #cine{display:block}
#cine .bar{position:absolute;left:0;right:0;height:9vh;background:#000}
#cine .bar.t{top:0}#cine .bar.b{bottom:0}
#cineSkip{position:absolute;top:calc(max(12px,env(safe-area-inset-top)) + 4px);right:max(var(--gx),env(safe-area-inset-right));pointer-events:auto;border:1px solid rgba(160,210,255,.45);background:rgba(10,18,40,.7);color:#e8f3ff;font:600 13px Poppins,system-ui,sans-serif;padding:9px 16px;border-radius:999px;cursor:pointer}
#cineBox{box-sizing:border-box;position:absolute;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(620px,calc(100vw - 2*var(--gx)));pointer-events:auto;background:rgba(8,14,34,.9);border:1px solid rgba(120,190,255,.4);border-radius:16px;padding:14px 18px 12px;color:#fff;box-shadow:0 10px 40px rgba(0,0,0,.5);display:none;cursor:pointer}
#cine.talk #cineBox{display:block}
#cineName{display:block;color:#6cd4ff;font-weight:700;font-size:14px;margin-bottom:4px}
#cineTxt{margin:0;font-size:15px;line-height:1.5;min-height:3em}
#cineHint{display:block;text-align:right;color:#9db4d6;font-size:11px;margin-top:4px}
body.playing.cine :is(.hud,button.btn,button.btn.hud,#lcol.hud,#chatFeed.hud,#board.hud,#hint.hud,#sbBtn.hud,#fsBtn.hud,#bookBtn.hud,#slots,#xhair,#joyBase,#joyKnob,#hpBox,#oxyBox,#toast,#prompt,#hurt,#btnDive,#btnAct,#btnSnipe){display:none!important}
#uiShow{display:none;position:fixed;top:max(10px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:30;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;border:1px solid rgba(160,210,255,.5);background:rgba(10,18,40,.82);color:#e8f3ff;font:600 13px Poppins,system-ui,sans-serif;cursor:pointer}
#uiShow span{display:flex;width:18px;height:18px}#uiShow svg{width:18px;height:18px}
body.playing.uihide.uiask #uiShow{display:flex}
body.playing.uihide :is(button.btn,button.btn.hud,#lcol,#lcol.hud,#slots,#bookBtn,#fsBtn,#sbBtn,#hint,#hint.hud,#btnDive,#btnAct,#btnSnipe,#chatPanel,#aimbar,.hud,.pill:not(#toast),#mini,#hpBox,#oxyBox,#roomTag,#net,#clock,#board,#feed,#chatFeed,#duelBox,#capBox){display:none!important}
#duelBox{display:none;position:fixed;top:calc(max(10px,env(safe-area-inset-top)) + 38px);left:50%;transform:translateX(-50%);z-index:5;max-width:min(92vw,480px);text-align:center;pointer-events:none;font-family:Poppins,system-ui,sans-serif}
body.playing.duel #duelBox{display:block}
#duelTimer{display:none;position:fixed;top:calc(max(10px,env(safe-area-inset-top)) + 38px);left:50%;transform:translateX(-50%);z-index:5;pointer-events:none;font:700 13px Poppins,system-ui,sans-serif;color:#fff;background:rgba(8,14,34,.82);border:1px solid rgba(120,190,255,.35);border-radius:999px;padding:5px 14px;white-space:nowrap}
body.playing.duel #duelTimer.show{display:block}
body:not(.noduelbar) #duelTimer{top:calc(max(10px,env(safe-area-inset-top)) + 100px)}
#duelTimer.sd{background:rgba(120,10,20,.88);border-color:#ff5d5d;color:#ffd9d9}
#duelTimer.dr{background:rgba(120,10,20,.92);border-color:#ff5d5d;color:#fff;animation:tmp .6s infinite alternate}
@keyframes tmp{from{opacity:.65}to{opacity:1}}
body.noduelbar #duelBox{display:none!important}
#trainBox{display:none;position:fixed;left:calc(max(10px,env(safe-area-inset-left)) + 120px);top:calc(max(10px,env(safe-area-inset-top)) + 52px);z-index:6;width:min(200px,40vw);background:rgba(8,14,34,.82);border:1px solid rgba(120,190,255,.35);border-radius:14px;padding:8px 10px;color:#fff;font:600 12px Poppins,system-ui,sans-serif}
body.playing.train #trainBox{display:block}
body:not(.train) #trainBox{display:none!important}
#trainBox b{display:block;color:#ffd84d;margin-bottom:4px}
#trainBox label{display:block;margin:5px 0 0}#trainBox label span{float:right;color:#6cd4ff}
#trainBox input{width:100%;accent-color:#4de1ff;margin:2px 0 0}
#duelBox .vs{display:inline-flex;align-items:center;gap:10px;background:rgba(8,14,34,.82);border:1px solid rgba(120,190,255,.35);border-radius:999px;padding:6px 16px;font-weight:700;font-size:14px;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35)}
#duelBox .vs i{font-style:normal;color:#ffd84d;font-size:12px}
#duelBox .vs span.w{color:#6cd4ff;font-weight:600;font-size:11px}
#duelBox .q{margin-top:5px;display:inline-block;background:rgba(8,14,34,.7);border-radius:12px;padding:4px 12px;font-size:12px;color:#cfe3ff}
#duelBox .me{color:#7dffae;font-weight:700}
#duelBig{display:none;position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:8;pointer-events:none;text-align:center;font-family:Poppins,system-ui,sans-serif;color:#fff;font-weight:800;text-shadow:0 4px 24px rgba(0,0,0,.6);letter-spacing:1px}
#duelBig.show{display:block}
#netRep{display:none;position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:9;width:min(92vw,340px);background:rgba(8,14,34,.94);border:1px solid rgba(160,190,255,.25);border-left:6px solid var(--nc,#4de27a);border-radius:14px;padding:12px 40px 14px 14px;font-family:Poppins,system-ui,sans-serif;color:#eaf1ff;box-shadow:0 10px 36px rgba(0,0,0,.5);overflow:hidden;cursor:pointer;animation:netIn .22s ease-out}
#netRep.show{display:block}
@keyframes netIn{from{opacity:0;transform:translate(-50%,14px)}to{opacity:1;transform:translate(-50%,0)}}
#netRep .nh{font-size:12px;font-weight:600;color:#9fb4dd;letter-spacing:.4px;text-transform:uppercase}
#netRep .nq{font-size:22px;font-weight:800;color:var(--nc,#4de27a);line-height:1.15;margin:2px 0 6px}
#netRep .nl{font-size:13px;font-weight:500;line-height:1.5}
#netRep .nl b{font-weight:700;color:#fff}
#netRep .nx{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(255,255,255,.1);color:#fff;font-size:17px;line-height:28px;text-align:center;cursor:pointer;padding:0}
#netRep .nx:hover{background:rgba(255,255,255,.22)}
#netRep .nb{position:absolute;left:0;bottom:0;height:4px;width:100%;background:var(--nc,#4de27a);transform-origin:left;opacity:.85}
#netRep.show .nb{animation:netBar 5s linear forwards}
@keyframes netBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
#duelBig b{display:block;font-size:min(22vw,120px);line-height:1}
#duelBig small{display:block;font-size:min(5vw,22px);font-weight:600;margin-top:6px;color:#cfe3ff}
body.cine #duelBox,body.cine #duelBig,body.cine #duelTimer{display:none!important}
#dbgBox{display:none;position:fixed;left:50%;transform:translateX(-50%);bottom:96px;align-items:center;z-index:6;pointer-events:none;flex-direction:column;gap:4px;font-family:Poppins,system-ui,sans-serif;max-width:min(70vw,420px)}
body.playing.dbg #dbgBox{display:flex}
#dbgBox div{background:rgba(8,14,34,.82);border-left:4px solid #ff6a6a;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;color:#ffe3e3;animation:dbgf 4s forwards}
#dbgBox div.ok{border-left-color:#4de27a;color:#dcffe8}
@keyframes dbgf{0%,80%{opacity:1}100%{opacity:0}}
#duelHelp{display:none;position:fixed;inset:0;z-index:60;background:rgba(2,6,18,.78);align-items:center;justify-content:center;font-family:Poppins,system-ui,sans-serif}
#duelHelp.show{display:flex}
#duelHelp .card{box-sizing:border-box;width:min(calc(100vw - 2*var(--gx)),460px);background:#0b1430;border:1px solid rgba(120,190,255,.4);border-radius:18px;padding:18px 20px 16px;color:#fff;box-shadow:0 16px 50px rgba(0,0,0,.6)}
#duelHelp h3{margin:0 0 10px;font-size:18px;color:#6cd4ff}
#duelHelp ol{margin:0;padding-left:20px;font-size:14px;line-height:1.55;color:#dfeaff}
#duelHelp li{margin-bottom:8px}
#duelHelp b{color:#ffd84d}
#duelHelp button{margin-top:6px;width:100%;border:0;border-radius:12px;background:linear-gradient(90deg,#1e6fff,#4db8ff);color:#fff;font:700 15px Poppins,system-ui,sans-serif;padding:11px;cursor:pointer}
#setBox{display:none;position:fixed;inset:0;z-index:55;background:rgba(2,6,18,.7);align-items:center;justify-content:center;font-family:Poppins,system-ui,sans-serif}
#setBox.show{display:flex}
#setBox .card{box-sizing:border-box;width:min(calc(100vw - 2*var(--gx)),440px);max-height:88vh;overflow:auto;background:#0b1430;border:1px solid rgba(120,190,255,.4);border-radius:18px;padding:14px 18px 8px;color:#fff;box-shadow:0 16px 50px rgba(0,0,0,.6)}
#setBox .sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
#setBox h3{margin:0;font-size:18px;color:#6cd4ff}
#tipBox{display:none;position:fixed;inset:0;z-index:55;background:rgba(2,6,18,.7);align-items:center;justify-content:center;font-family:Poppins,system-ui,sans-serif}
#tipBox.show{display:flex}
#tipBox .card{width:min(92vw,460px);max-height:88vh;overflow:auto;background:#0b1430;border:1px solid rgba(120,190,255,.4);border-radius:18px;padding:14px 18px 16px;color:#fff;box-shadow:0 16px 50px rgba(0,0,0,.6)}
#tipBox .sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
#tipBox h3{margin:0;font-size:18px;color:#ffd84d}
#tipBox .tp{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid rgba(120,190,255,.15)}
#tipBox .tp i{flex:0 0 34px;height:34px;border-radius:10px;background:#10264a;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:19px}
#tipBox .tp b{display:block;font-size:14px;color:#6cd4ff}
#tipBox .tp small{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:#cfe0f6}
#tipX{width:34px;height:34px;border-radius:50%;border:1.5px solid #3a5f95;background:#10264a;color:#e6f2ff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
#tipX svg{width:16px;height:16px}
#tipOk{margin-top:10px;width:100%;border:0;border-radius:12px;background:linear-gradient(90deg,#1e6fff,#4db8ff);color:#fff;font:700 15px Poppins,system-ui,sans-serif;padding:11px;cursor:pointer}
body.cine #tipBox{display:none!important}
#setX{width:34px;height:34px;border-radius:50%;border:1.5px solid #3a5f95;background:#10264a;color:#e6f2ff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
#setX svg{width:16px;height:16px}
.srow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid rgba(120,190,255,.15);cursor:pointer}
.srow span{display:block;flex:1}.srow b{display:block;font-size:14px}.srow small{display:block;margin-top:2px;font-size:11.5px;line-height:1.4;color:#9db4d6}
.srow input{display:none}
.sens{padding:11px 0;border-top:1px solid rgba(120,190,255,.15)}.sens b{display:flex;justify-content:space-between;font-size:14px}.sens small{display:block;margin:2px 0 8px;font-size:11.5px;line-height:1.4;color:#9db4d6}.sens input{width:100%;accent-color:#4de1ff}
.srow .sw{flex:0 0 auto;width:46px;height:26px;border-radius:999px;background:#26344f;position:relative;transition:background .15s}
.srow .sw:after{content:'';position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s}
.srow input:checked+.sw{background:#1e6fff}.srow input:checked+.sw:after{transform:translateX(20px)}
body.nonet #net{display:none!important}
@media (max-height:560px){#lcol{flex-direction:row!important;flex-wrap:wrap;width:78px}}
body.cine #setBox{display:none!important}
@media (max-width:700px),(pointer:coarse){:root{--gx:18px}}
</style>
</head>
<body>
<canvas id="c" tabindex="0"></canvas>
<div id="uw"></div>
<div id="night"></div>
<div id="fade"></div>
<div id="lcol" class="hud">
  <button id="lcolTog" title="Sembunyikan / tampilkan tombol" aria-label="Sembunyikan atau tampilkan tombol" style="font-size:13px">▲</button>
  <button id="camBtn" data-ico="eye" title="Kamera FPS (C)" aria-label="Kamera FPS"></button>
  <button id="uiBtn" data-ico="hideui" title="Sembunyikan tombol (H)" aria-label="Sembunyikan tombol"></button>
  <button id="tipBtn" title="Tips &amp; trik" aria-label="Tips dan trik" data-ico="bulb"></button>
  <button id="setBtn" data-ico="gear" title="Pengaturan" aria-label="Pengaturan"></button>
  <button id="chatBtn" title="Chat (Enter)" aria-label="Chat"><span data-ico="chat" style="display:flex;width:20px;height:20px"></span><i class="badge" id="chatBadge"></i></button>
  <button id="emoBtn" data-ico="raisehand" title="Emote (T)" aria-label="Emote"></button>
  <button id="micBtn" class="vo off" data-ico="micoff" title="Mikrofon" aria-label="Mikrofon"></button>
  <button id="spkBtn" class="vo off active" data-ico="spk" title="Suara room" aria-label="Suara room"></button>
</div>
<div id="chatFeed" class="hud"></div>
<div id="emoPanel" role="menu" aria-label="Emote"></div>
<div id="emoSelf" class="pill"></div>
<div id="rotHint" role="alert"><div class="ph"></div><div>Putar HP kamu ke mode horizontal<small>Game ini dimainkan dengan layar melebar. Pastikan kunci rotasi layar HP mati.</small></div></div>
<div id="chatPanel"><div id="chatHead"><span>Chat</span><button id="chatX" type="button" aria-label="Tutup chat" data-ico="close"></button></div><div id="chatList"></div><form id="chatForm"><input id="chatIn" maxlength="140" placeholder="Tulis pesan..." autocomplete="off"><button type="submit" data-ico="send" aria-label="Kirim"></button></form></div>
<div id="xhair"></div>
<div id="fpsView" aria-hidden="true"><div class="arm" id="fpsR"><canvas id="fpsRc" width="24" height="84"></canvas></div></div>
<div id="aimbar"><button id="aimFire">Tembak</button><button id="aimCancel">Batal</button></div>
<div id="capBox"><small id="capTxt"></small><div class="bar"><i id="capFill"></i></div></div>
<div id="hurt"></div>
<div id="fxScr"><div class="fl" id="fxIce"></div><div class="fl" id="fxShield"></div><div class="fl" id="fxHaste"></div><div class="fl" id="fxRegen"></div><div class="fl" id="fxGuard"></div><div class="fl" id="fxBreak"></div><div class="fl" id="fxRide"></div></div>

<div id="hpBox" class="hud"><div id="hpName"><span id="myName"></span><span id="kd"></span></div><div class="bar"><i id="hpFill"></i></div></div>
<div id="oxyBox" class="hud"><small><span data-ico="bubble" class="clki"></span> Napas</small><div class="bar"><i id="oxyFill"></i></div></div>
<canvas id="mini" class="hud" width="192" height="192"></canvas>
<div id="roomTag" class="pill hud"></div>
<div id="net" class="pill hud" title="Kualitas jaringan"></div>
<div id="clock" class="pill hud"><span data-ico="sun" class="clki"></span> 09:00</div>
<button id="bookBtn" class="hud off" aria-label="Buku teknik" title="Buku teknik (B)" data-ico="book"></button>
<button id="fsBtn" class="hud" aria-label="Layar penuh" title="Layar penuh" data-ico="fs"></button>
<button id="sbBtn" class="hud" aria-label="Papan skor" data-ico="trophy"></button>
<div id="board" class="hud"></div>
<div id="feed" class="hud"></div>
<div id="toast" class="pill"></div>
<div id="tipBox"><div class="card"><div class="sh"><h3><span data-ico="book" class="bki"></span>Tips &amp; Trik</h3><button id="tipX" type="button" aria-label="Tutup" data-ico="close"></button></div>
<div class="tp"><i data-ico="sword"></i><div><b>Pedang bisa menebas bola</b><small>Tebas bola yang meluncur ke arahmu: bola hancur atau terpukul balik ke penembaknya. Tebasan angin juga memukul balik bola yang dilewatinya.</small></div></div>
<div class="tp"><i data-ico="shield"></i><div><b>Perisai bisa memantulkan bola</b><small>Tahan perisai menghadap bola yang datang dan bola itu dipantulkan balik ke penembak. Awas: perisai hanya menahan serangan dari depan dan bisa pecah kalau dihantam terus.</small></div></div>
<div class="tp"><i data-ico="nova"></i><div><b>Tebasan pedang itu besar sekali</b><small>Satu tebasan 50 damage. Tebas 3 kali berturut-turut untuk kombo: tebasan ketiga (penutup) 80 damage, jangkauannya lebih jauh, dan angin tebasannya melesat lebih jauh.</small></div></div>
<div class="tp"><i data-ico="dash"></i><div><b>Dash itu kebal sesaat</b><small>Lesat saat bola atau tebasan lawan hampir kena, kamu kebal sebentar dan lolos.</small></div></div>
<div class="tp"><i data-ico="wall"></i><div><b>Dinding dan lompat tinggi</b><small>Tembok Kode memblokir bola dan sinar lawan. Loncat Tinggi membuatmu bisa melompati dinding.</small></div></div>
<div class="tp"><i data-ico="summon"></i><div><b>Elang dan Singa Rimba</b><small>Jangan gunakan Elang atau Singa Rimba di laga yang ada kawanmu di sekitar, karena mereka bisa ikut menyerang kawan. Mereka mengejar musuh yang kamu serang atau yang menyerangmu (yang paling baru menang), bukan yang paling dekat.</small></div></div>
<button id="tipOk" type="button">Mengerti</button>
</div></div>
<div id="setBox"><div class="card"><div class="sh"><h3>Pengaturan</h3><button id="setX" type="button" aria-label="Tutup" data-ico="close"></button></div>
<div class="sens"><b><span>Sensitivitas kamera</span><span id="sensVal">1.0x</span></b><small>Seberapa cepat kamera menoleh saat layar digeser (atau tombol Q/R). Geser ke kanan untuk lebih cepat.</small><input type="range" id="sensIn" min="0.5" max="3" step="0.1" value="1"></div>
<label class="srow"><span><b>Auto aim pedang</b><small>Serangan pedang otomatis menghadap musuh terdekat di depanmu. Mati: menebas ke arah hadap karaktermu.</small></span><input type="checkbox" data-set="autoAim"><i class="sw"></i></label>
<label class="srow"><span><b>Analog kiri selalu kecepatan penuh</b><small>Hidup: analog kiri digeser sedikit pun karakter tetap lari kecepatan penuh (hanya arah yang berubah). Mati: kecepatan mengikuti seberapa jauh analog digeser.</small></span><input type="checkbox" data-set="joyFull"><i class="sw"></i></label>
<label class="srow"><span><b>Auto aim bola</b><small>Di mode non-FPS, teknik bola (bola lempar dan bola biru) langsung dilempar ke musuh terdekat dalam 40 unit. Tidak ada musuh: bidik manual seperti biasa. Mode FPS tetap bidik sendiri.</small></span><input type="checkbox" data-set="autoAimBall"><i class="sw"></i></label>
<label class="srow"><span><b>Notifikasi hasil tebasan</b><small>Pesan kecil di bawah layar: kena siapa atau kenapa meleset. Untuk menguji serangan. Default mati.</small></span><input type="checkbox" data-set="hitDbg"><i class="sw"></i></label>
<label class="srow"><span><b>Layar bergetar</b><small>Getaran kamera saat kena atau mengenai musuh.</small></span><input type="checkbox" data-set="shake"><i class="sw"></i></label>
<label class="srow"><span><b>Efek badan saat kena</b><small>Selubung cahaya di badan korban selama 0.5 detik.</small></span><input type="checkbox" data-set="hitFx"><i class="sw"></i></label>
<label class="srow"><span><b>Tampilkan body fisika objek 3D</b><small>Garis kerangka collider semua objek di sekitarmu (radius 60): pohon, batu, tiang, tembok, rumah, dan pagar arena. Oranye = tabung, kuning = batu/pijakan, magenta = kotak (rumah, pintu tertutup).</small></span><input type="checkbox" data-set="physObj"><i class="sw"></i></label>
<label class="srow"><span><b>Tampilkan body fisika</b><small>Garis kerangka badan karakter 2D (pemain, prajurit, penyamun, elang) dan cincin jangkauan tebasan.</small></span><input type="checkbox" data-set="physics"><i class="sw"></i></label>
<label class="srow"><span><b>Teks besar di tengah layar</b><small>Hitung mundur, FIGHT!, pengumuman pemenang, dan layar KO di arena.</small></span><input type="checkbox" data-set="bigText"><i class="sw"></i></label>
<label class="srow"><span><b>Dinding arena berkilau</b><small>Efek dinding biru transparan di sekeliling arena saat hitung mundur dan terkena.</small></span><input type="checkbox" data-set="arenaWall"><i class="sw"></i></label>
<label class="srow"><span><b>Pesan notifikasi di tengah layar</b><small>Tulisan info yang muncul di tengah layar (misal "Naik elang!", "Tunggu hitungan mundur"). Mati secara bawaan.</small></span><input type="checkbox" data-set="toast"><i class="sw"></i></label>
<label class="srow"><span><b>Bar "A vs B" di atas layar</b><small>Nama petarung, antrian, dan juara di arena. Mati secara bawaan.</small></span><input type="checkbox" data-set="duelBar"><i class="sw"></i></label>
<label class="srow"><span><b>Tulisan efek (MANTUL, TAHAN, KEBAL, dll)</b><small>Tulisan melayang di atas karakter saat bola dipantulkan, serangan ditahan, kebal, atau pedang beradu.</small></span><input type="checkbox" data-set="fxText"><i class="sw"></i></label>
<label class="srow"><span><b>Angka damage</b><small>Angka merah/kuning yang melayang saat ada yang terkena serangan.</small></span><input type="checkbox" data-set="dmgText"><i class="sw"></i></label>
<label class="srow"><span><b>Indikator jaringan</b><small>Ikon sinyal dan angka ping di atas layar.</small></span><input type="checkbox" data-set="net"><i class="sw"></i></label>
</div></div>
<div id="trainBox" class="hud"><b>Mode Latihan</b><label>Kecepatan gerak <span id="tvSpd">1.0x</span><input type="range" id="trSpd" min="0.5" max="3" step="0.1" value="1"></label><label>Tinggi lompat <span id="tvJmp">1.0x</span><input type="range" id="trJmp" min="0.5" max="2" step="0.1" value="1"></label><label>Cooldown teknik <span id="tvCd">1.0x</span><input type="range" id="trCd" min="0" max="2" step="0.1" value="1"></label><label>Darah target <span id="tvHp">1x</span><input type="range" id="trHp" min="1" max="10" step="1" value="1"></label><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="trFight" style="width:auto;margin:0"> Target menyerang balik</label><div id="trDps" style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(120,190,255,.2)">DPS <b style="display:inline;color:#fff" id="dpsV">0</b> · Total <b style="display:inline;color:#fff" id="dpsT">0</b> <button id="dpsR" type="button" style="float:right;border:0;border-radius:8px;background:#10264a;color:#cfe3ff;font:600 11px Poppins,sans-serif;padding:2px 8px;cursor:pointer">Reset</button></div></div>
<div id="duelBox"></div><div id="duelTimer" class="hud"></div><div id="duelBig"></div>
<div id="netRep"><button class="nx" id="netX" aria-label="Tutup">×</button><div class="nh">Jaringan saat bertarung</div><div class="nq" id="netQ"></div><div class="nl" id="netL"></div><div class="nb"></div></div><div id="dbgBox"></div>
<div id="duelHelp"><div class="card"><h3>Cara main Arena</h3><ol><li><b>Menang lanjut, kalah antri.</b> Dua pemain (atau dua tim di mode 2v2/3v3) bertarung di ring. Kalau kurang pemain, komputer mengisi. Yang menang tetap bertahan dan melawan penantang berikutnya, yang kalah antri di paling belakang.</li><li><b>Tebas dan tahan.</b> Tombol Serang untuk menebas. Tombol Tahan (perisai) menangkis serangan dari depan, dan bola yang kena perisai dipantulkan balik ke penembaknya.</li><li><b>Teknik.</b> Isi slot dengan kode dari buku (tombol buku). Teknik hanya bisa dipakai saat giliranmu bertarung, setelah hitungan mundur selesai.</li><li><b>Penonton</b> tidak bisa terkena serangan dan tidak bisa masuk ring. Tunggu namamu dipanggil dari antrian di atas layar.</li></ol><button id="duelHelpOk">Mengerti</button></div></div>
<button id="uiShow" aria-label="Tampilkan tombol"><span data-ico="hideui"></span><b>Tampilkan tombol</b></button>
<div id="cine"><button id="cineSkip">Lewati &raquo;</button><div id="cineBox"><b id="cineName"></b><p id="cineTxt"></p><small id="cineHint">Ketuk untuk lanjut</small></div></div>
<div id="prompt" class="pill"><span class="key">E</span><span id="ptxt">Buka pintu</span></div>
<div id="hint" class="pill hud">WASD gerak · Shift lari · Spasi lompat/naik · V selam · J serang · K tahan · 1-5 teknik (bidik dulu) · B buku · C FPS · Enter chat · E aksi · T emote · Tab skor</div>
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
  <div id="pickTabs"></div>
  <div id="pickBox"></div>
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
  <div id="bkTabs"></div>
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

<script src="/vendor/three.min.js"></script>
<script>
(function(){
if(typeof THREE==='undefined'){document.body.innerHTML='<p style="padding:24px;font-size:16px">Three.js gagal dimuat. Coba muat ulang halaman.</p>';return;}
const $=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const sstep=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t)};
const damp=(k,dt)=>1-Math.exp(-k*dt);
const LS={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
const ROOM=(location.pathname.split('/')[2]||'').toUpperCase();
const MAXHP=TUNING.maxHp;
/* ---------- ikon SVG buatan sendiri ---------- */
const ICO={
 book:'<path d="M2.5 5.5c3.2-1.6 6.3-1.4 9.5 1v13c-3.200-2.400-6.300-2.600-9.500-1z"/><path d="M21.500 5.500c-3.200-1.600-6.300-1.400-9.500 1v13c3.200-2.400 6.300-2.600 9.500-1z"/>',
 fs:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
 fsx:'<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
 trophy:'<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M12 14v4M8 20h8"/>',
 orb:'<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/><path d="M12 4a8 8 0 0 1 0 16M12 4a8 8 0 0 0 0 16"/>',
 chat:'<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.500h8M8 12.500h5"/>',
 raisehand:'<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.500V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.800 0-4.500-.86-5.990-2.340l-3.600-3.600a2 2 0 0 1 2.830-2.820L7 15"/>',
 gear:'<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
 hideui:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
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
 ring:'<path d="M3 20V8h18v12M3 14h18M9 8v6M15 14v6M12 8V4"/>',
 launch:'<path d="M12 20V5M6.500 10.500L12 5l5.500 5.500M7 20h10"/>',
 spin:'<circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity=".25"/><path d="M12 2.500v6M12 15.500v6M2.500 12h6M15.500 12h6"/>',
 meteor:'<circle cx="12" cy="6" r="3" fill="currentColor" fill-opacity=".3"/><path d="M12 11v4M8 13v4M16 13v4M12 21v-3"/>',
 slam:'<path d="M13.500 3.500l7 7-4 4-7-7z"/><path d="M11.500 12.500L3.500 20.500"/>',
 trap:'<circle cx="12" cy="12" r="5" fill="currentColor" fill-opacity=".25"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2 2M16.700 16.700l2 2M18.700 5.300l-2 2M7.300 16.700l-2 2"/>',
 summon:'<path d="M1.500 9.500c4-1.200 7.500 0 10.500 4.500 3-4.500 6.500-5.700 10.500-4.500-2 3.200-4.200 4.500-6.500 4.500L12 20.500l-4-6c-2.300 0-4.500-1.300-6.500-5z"/>',
 ride:'<path d="M1.500 12.500c4-1.200 7.500 0 10.500 4.500 3-4.500 6.500-5.700 10.500-4.500-2 3.200-4.200 4.500-6.500 4.500L12 23l-4-6c-2.300 0-4.500-1.300-6.500-4.500z"/><circle cx="12" cy="6" r="2.500"/><path d="M12 8.500v3"/>',
 heal:'<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor" fill-opacity=".2"/>',
 regen:'<path d="M20 12a8 8 0 1 1-2.700-6"/><path d="M20 3.500v4.500h-4.500"/><path d="M12 9v6M9 12h6"/>',
 haste:'<path d="M4.500 5l7 7-7 7M12.500 5l7 7-7 7"/>',
 dash:'<path d="M13.500 2L4.500 14h7l-1 8 9-12h-7z" fill="currentColor" fill-opacity=".2"/>',
 foot:'<ellipse cx="8" cy="7.500" rx="2.600" ry="3.800" fill="currentColor" fill-opacity=".25"/><circle cx="8" cy="14.500" r="1.700"/><ellipse cx="16" cy="11" rx="2.600" ry="3.800" fill="currentColor" fill-opacity=".25"/><circle cx="16" cy="18" r="1.700"/>',
 wall:'<path d="M3 5h18v4H3zM3 9h18v5H3zM3 14h18v5H3zM9 5v4M15 9v5M9 14v5"/>',
 blink:'<circle cx="6" cy="12" r="2.500"/><circle cx="18" cy="12" r="2.500" fill="currentColor" fill-opacity=".3"/><path d="M9.500 12h5M12.500 9l3 3-3 3"/>',
 homing:'<circle cx="6" cy="7" r="3" fill="currentColor" fill-opacity=".25"/><circle cx="6" cy="17" r="3" fill="currentColor" fill-opacity=".25"/><path d="M9 7c5 0 7 3 9 5M9 17c5 0 7-3 9-5"/><circle cx="20" cy="12" r="1.500"/>',
 lion:'<circle cx="12" cy="12.500" r="9" fill="currentColor" fill-opacity=".22"/><circle cx="12" cy="12.500" r="5" fill="currentColor" fill-opacity=".35"/><circle cx="6.500" cy="5.500" r="2"/><circle cx="17.500" cy="5.500" r="2"/>',
 face:'<circle cx="12" cy="12" r="7.500"/><circle cx="12" cy="12" r="2.500" fill="currentColor"/><path d="M12 1.500v4M12 18.500v4M1.500 12h4M18.500 12h4"/>',
 spark:'<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
 bubble:'<circle cx="9" cy="15" r="5"/><circle cx="17" cy="8" r="3"/><circle cx="16" cy="18" r="1.500"/>',
 bulb:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.500 10.900c.700.600 1 1.300 1 2.100h5c0-.800.300-1.500 1-2.100A6 6 0 0 0 12 3z"/>'
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
const ARENA={x:5000,z:0,ringR:38,side:22,h:72,standR:10};
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
  const da=Math.hypot(x-ARENA.x,z-ARENA.z),fa=ARENA.ringR+8;let ma=1;
  if(da<fa+12){const t=da<=fa?0:(da-fa)/12;ma=t*t*(3-2*t);}
  return hills*m+e*e*(3-2*e)*38*ma-lakeDepth(x,z);
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
const walls=new Map();
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
  if(Math.hypot(x-ARENA.x,z-ARENA.z)<ARENA.ringR+1)continue;
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
  box(g,2.0,0.7,0.3,wm,0,3.05,3.5);
  box(g,0.16,2.56,0.38,dark,-1.06,1.28,3.5);box(g,0.16,2.56,0.38,dark,1.06,1.28,3.5);box(g,2.28,0.16,0.4,dark,0,2.68,3.5);
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(7.7,6.7).rotateX(-Math.PI/2),mat('#b98a5a',{polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));fl.position.set(0,0.02,0);g.add(fl);
  const rug=new THREE.Mesh(new THREE.CircleGeometry(1.5,24).rotateX(-Math.PI/2),mat(roofPal[(idx+3)%8],{polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));rug.position.set(0.2,0.025,-0.9);g.add(rug);
  const mt=new THREE.Mesh(new THREE.PlaneGeometry(1.5,0.9).rotateX(-Math.PI/2),mat('#9a4a3a',{polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));mt.position.set(0,0.03,4.2);g.add(mt);
  box(g,2.0,0.5,1.6,wood,-2.6,0.3,-2.5);box(g,1.94,0.25,1.54,mat('#e8e0d0'),-2.6,0.65,-2.5);box(g,0.7,0.15,0.5,mat('#e06a6a'),-3.2,0.84,-2.5);addOBB(h,-2.6,-2.5,1.0,0.8);
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
function fortFloorTex(){
  if(fortFloorTex.t)return fortFloorTex.t;
  const cv=document.createElement('canvas');cv.width=cv.height=256;const c=cv.getContext('2d');
  c.fillStyle='#4f493e';c.fillRect(0,0,256,256);
  let sd=7;const rnd2=()=>{sd=(sd*16807)%2147483647;return sd/2147483647;};
  for(let ty=0;ty<2;ty++)for(let tx=0;tx<2;tx++){
    const v=Math.floor(158+rnd2()*34-17);
    c.fillStyle='rgb('+v+','+(v-6)+','+(v-20)+')';c.fillRect(tx*128+3,ty*128+3,122,122);
    c.fillStyle='rgba(255,255,255,.12)';c.fillRect(tx*128+3,ty*128+3,122,4);c.fillRect(tx*128+3,ty*128+3,4,122);
    c.fillStyle='rgba(0,0,0,.16)';c.fillRect(tx*128+3,ty*128+121,122,4);c.fillRect(tx*128+121,ty*128+3,4,122);
    for(let i=0;i<14;i++){c.fillStyle='rgba(0,0,0,'+(0.05+rnd2()*0.07)+')';c.fillRect(tx*128+8+rnd2()*108,ty*128+8+rnd2()*108,3+rnd2()*6,2+rnd2()*4);}
  }
  const t=new THREE.CanvasTexture(cv);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(4,4);t.anisotropy=4;
  return fortFloorTex.t=t;
}
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
  const sideM=mat('#8e877a'),topM=new THREE.MeshLambertMaterial({map:fortFloorTex()});const fl=new THREE.Mesh(new THREE.BoxGeometry(15.6,0.3,15.6),[sideM,sideM,topM,sideM,sideM,sideM]);fl.position.y=-0.1;g.add(fl);
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
  updArena(dt);updDuel();
  for(const f of forts){
    f.flag.rotation.y=Math.sin(tAll*3+f.id)*0.25;
    const d=Math.hypot(f.x-pos.x,f.z-pos.z);f.lab.visible=d<34&&!inCave&&roomMode!=='duel';
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
/* tebasan pedang */
/* tebasan tipis 3D: tabung bulan sabit meruncing (tebal di ujung depan, menipis ke belakang) */
function makeTrailGeo(R,rmax,arc,seg,rad){
  const pos=[],idx=[];
  for(let i=0;i<=seg;i++){
    const t=i/seg,phi=t*arc,r=rmax*Math.pow(1-t,0.85);
    const cx=Math.cos(phi)*R,cz=-Math.sin(phi)*R;                 /* titik pusat di bidang xz, mengekor ke arah -z */
    const tx=-Math.sin(phi),tz=-Math.cos(phi);                    /* arah singgung */
    for(let k=0;k<rad;k++){
      const a=k/rad*Math.PI*2,nx=Math.cos(phi),nz=-Math.sin(phi); /* normal radial */
      pos.push(cx+nx*Math.cos(a)*r,Math.sin(a)*r*0.9,cz+nz*Math.cos(a)*r);
    }
  }
  for(let i=0;i<seg;i++)for(let k=0;k<rad;k++){const a=i*rad+k,b=i*rad+(k+1)%rad,c=(i+1)*rad+k,d=(i+1)*rad+(k+1)%rad;idx.push(a,c,b,b,c,d);}
  const gm=new THREE.BufferGeometry();gm.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));gm.setIndex(idx);return gm;
}
const slashGeo=makeTrailGeo(2.15,0.13,1.9,30,7),slashGeo2=makeTrailGeo(2.15,0.045,1.9,30,5),slashGeo3=makeTrailGeo(1.55,0.03,1.5,26,5);
const slashes=[];
function slashFx(x,y,z,fx,fz,col,sc,flip,ay){
  return;   /* busur tebasan 2D dihapus: visual tebasan sekarang hanya gelombang angin */
  const l=Math.hypot(fx,fz)||1;fx/=l;fz/=l;sc=sc||1;
  const g=new THREE.Group();const fp=ay!==undefined;g.position.set(x+fx*0.3,fp?y+1.4:y+1.15,z+fz*0.3);g.scale.setScalar(sc*1.4);if(fp){g.rotation.order='YZX';}
  const s=new THREE.Group();s.rotation.x=fp?(flip?-0.95:0.95):0.25;s.scale.z=flip?-1:1;g.add(s);
  const mk=(c,o)=>new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:o,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const m1=mk(col||0xffffff,0.55),m2=mk(0xffffff,1),m3=mk(col||0xffffff,0.45);
  s.add(new THREE.Mesh(slashGeo,m1),new THREE.Mesh(slashGeo2,m2),new THREE.Mesh(slashGeo3,m3));scene.add(g);
  const base=Math.atan2(-fz,fx),dir=flip?-1:1;
  slashes.push({g,m1,m2,m3,t:0,base,dir});
  g.rotation.y=base+dir*1.0;if(fp){const el=Math.asin(clamp(ay,-0.95,0.95));g.rotation.z=el;g.position.y+=ay*0.7;g.position.x+=fx*0.4;g.position.z+=fz*0.4;}
}
function updSlashes(dt){
  for(let i=slashes.length-1;i>=0;i--){
    const q=slashes[i];q.t+=dt;const k=q.t/0.18;
    if(k>=1){scene.remove(q.g);q.m1.dispose();q.m2.dispose();q.m3.dispose();slashes.splice(i,1);continue;}
    const e=1-Math.pow(1-k,3);
    q.g.rotation.y=q.base+q.dir*(1.0-2.0*e);
    q.m1.opacity=0.55*Math.pow(1-k,1.5);q.m2.opacity=Math.pow(1-k,2);q.m3.opacity=0.45*Math.pow(1-k,1.8);
  }
}
/* floating text */
const floats=[];
function floatText(x,y,z,txt,col){
  {let on=true;try{on=/^[-+]?\d/.test(String(txt))?SET.dmgText:SET.fxText;}catch(e){}if(on===false)return;}
  const cv=document.createElement('canvas');cv.width=128;cv.height=48;const c=cv.getContext('2d');
  c.font='bold 34px sans-serif';c.textAlign='center';c.textBaseline='middle';c.lineWidth=6;c.strokeStyle='rgba(10,10,30,.9)';c.strokeText(txt,64,24);c.fillStyle=col;c.fillText(txt,64,24);
  const tex=new THREE.CanvasTexture(cv);const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));
  const wk=/^[-+]?\d/.test(String(txt))?1:0.5;   /* tulisan efek (MANTUL, dll) 2x lebih kecil dari angka damage */
  sp.scale.set(2*wk,0.75*wk,1);sp.renderOrder=22;sp.position.set(x,y,z);scene.add(sp);floats.push({sp,tex,t:0});
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
const SFX_RANGE=45,VOICE_RANGE=40;
/* jarak dengar per jenis suara (unit); di atas jarak ini tidak terdengar sama sekali */
const SFX_R={swing:24,hit:26,clang:26,clash:30,block:24,twang:26,arrowHit:24,soldierDie:24,gbreak:26,
  throw:30,dash:26,orb:38,beam:36,shield:26,heal:26,regen:22,haste:22,eagle:30,step:16,land:18,jump:18,stroke:18,splash:26,sleep:14,
  roar:34,wall:26,wallbreak:34,blink:28,hjump:24,
  boom:55,snipe:70,horn:70,fanfare:60,chestOpen:30};
let sfxWin=[];
function distVol(d,R){return d>=R?0:Math.pow(1-d/R,2.2);}
function sfxAt(name,x,z){if(!AC||!sfx[name])return;const R=SFX_R[name]||SFX_RANGE;const d=Math.hypot(x-pos.x,z-pos.z);const v=distVol(d,R);if(v<0.03)return;
  /* batasi tumpukan suara jauh: maksimal 4 suara pelan per 150 ms */
  const tn=performance.now();sfxWin=sfxWin.filter(t=>tn-t<150);if(v<0.35){if(sfxWin.length>=4)return;sfxWin.push(tn);}
  SV=v;const a=Array.prototype.slice.call(arguments,3);try{sfx[name].apply(null,a);}catch(e){}SV=1;}
let techClickT=0;
const sfx={
  /* klik pribadi saat teknik berhasil dipakai: retak tajam lalu serpihan kaca berdenting, cukup keras. Hanya didengar pemilik, bukan suara berjarak */
  techClick(){
    const n=performance.now();if(n-techClickT<110)return;techClickT=n;
    noiseHit(0.035,0.95,7500,0,'highpass');tone(3400,1700,0.045,'square',0.17,0);tone(1500,800,0.1,'sine',0.14,0);
    noiseHit(0.26,0.55,5200,0.012,'highpass');noiseHit(0.18,0.35,3000,0.02,'bandpass',2);
    for(let k=0;k<8;k++){const f=rnd(2300,7600);tone(f,f*rnd(0.65,0.95),rnd(0.05,0.16),'triangle',0.1,0.014+k*rnd(0.012,0.03));}
  },
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
  clash(){/* benturan besi: dentang logam berlapis, bernada tak harmonis, dengan gema */
    noiseHit(0.05,0.5,6000,0,'highpass');noiseHit(0.12,0.3,1800,0,'bandpass');
    [[1180,0.5,0.9],[1763,0.42,0.7],[2491,0.36,0.55],[3320,0.3,0.4],[640,0.55,0.8]].forEach(([f,d,v],i)=>tone(f,f*0.97,d,i%2?'triangle':'square',0.075*v,i*0.006));
    tone(1180,1150,0.55,'sine',0.05,0.04);tone(1763,1740,0.5,'sine',0.035,0.04);
    tone(1180,1160,0.3,'sine',0.02,0.19);tone(2491,2470,0.28,'sine',0.015,0.19);
  },
  clang(){tone(rnd(850,1250),rnd(500,700),0.22,'square',0.06);tone(rnd(1700,2300),rnd(1200,1500),0.18,'triangle',0.05);noiseHit(0.06,0.18,4200,0,'highpass');},
  hurt(){pick([()=>{tone(300,120,0.25,'sawtooth',0.12);noiseHit(0.15,0.2,500,0);},()=>{tone(380,150,0.22,'square',0.08);tone(260,100,0.28,'sawtooth',0.07);},()=>{tone(220,90,0.3,'sawtooth',0.1);noiseHit(0.2,0.18,400,0);tone(520,260,0.12,'triangle',0.05);}])();},
  block(){noiseHit(0.08,0.25,2000,0,'highpass');tone(700,500,0.1,'square',0.08);tone(rnd(1100,1500),900,0.16,'triangle',0.05);},
  gbreak(){tone(400,80,0.35,'sawtooth',0.12);noiseHit(0.3,0.3,700,0);tone(1500,300,0.25,'triangle',0.06);},
  shield(){tone(300,700,0.3,'sine',0.1);tone(450,900,0.3,'triangle',0.06);tone(150,150,0.2,'square',0.02);},
  twang(){tone(rnd(320,430),rnd(140,190),0.16,'triangle',0.09);noiseHit(0.1,0.08,3500,0.02,'highpass');},
  arrowHit(){noiseHit(0.05,0.2,1500,0);tone(rnd(500,700),300,0.07,'square',0.05);},
  /* teknik */
  throw(){tone(rnd(160,220),rnd(420,520),0.28,'sawtooth',0.08);noiseHit(0.3,0.14,rnd(900,1400),0,'bandpass',0.8);tone(rnd(700,900),rnd(250,320),0.2,'triangle',0.05,0.05);},
  zap(){pick([()=>{tone(900,300,0.18,'square',0.06);tone(1400,500,0.14,'sawtooth',0.03);},()=>{tone(1200,400,0.2,'sawtooth',0.05);noiseHit(0.1,0.06,5000,0,'highpass');},()=>{tone(700,1500,0.12,'triangle',0.07);tone(1500,300,0.16,'square',0.04,0.1);}])();},
  beam(){tone(200,2200,0.35,'sawtooth',0.07);tone(2200,600,0.3,'square',0.04,0.1);noiseHit(0.4,0.1,5000,0,'highpass');},
  boom(){noiseHit(0.5,0.35,500,0);tone(120,40,0.4,'sine',0.25);noiseHit(0.8,0.12,200,0.1);},
  slam(){tone(260,60,0.3,'sawtooth',0.1);noiseHit(0.25,0.3,300,0.5);tone(80,35,0.5,'sine',0.3,0.5);noiseHit(0.7,0.14,150,0.55);},
  trapset(){tone(900,900,0.03,'square',0.05);tone(700,700,0.04,'square',0.05,0.09);noiseHit(0.1,0.06,2500,0.15,'highpass');},
  heal(){[523,659,784,1047].forEach((f,i)=>tone(f,f,0.22,'triangle',0.1,i*0.07));tone(2093,2093,0.35,'sine',0.03,0.28);},
  regen(){[392,494,587].forEach((f,i)=>tone(f,f*1.01,0.5,'sine',0.06,i*0.15));},
  wall(){noiseHit(0.5,0.18,300,0,'lowpass');tone(90,60,0.5,'sawtooth',0.07);tone(180,320,0.25,'square',0.04,0.1);noiseHit(0.15,0.2,900,0.35,'lowpass');},
  wallbreak(){noiseHit(0.6,0.25,1200,0,'bandpass',0.7);tone(300,60,0.5,'sawtooth',0.06);noiseHit(0.3,0.2,2500,0.1,'highpass');},
  blink(){tone(1500,200,0.25,'sine',0.08);tone(400,2000,0.2,'triangle',0.05,0.12);noiseHit(0.2,0.1,3000,0,'highpass');},
  hjump(){tone(180,900,0.35,'sine',0.12);noiseHit(0.25,0.12,1800,0,'highpass');tone(400,1200,0.25,'triangle',0.06,0.1);},
  roar(){tone(150,55,0.6,'sawtooth',0.12);tone(110,70,0.5,'square',0.05,0.05);noiseHit(0.5,0.12,500,0,'lowpass');},
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
let comboN=0,comboT=0;
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
/* teknik yang terpasang disimpan per room di localStorage (tiap room datanya beda) */
let hjT=0,restoreN=0,trainSpd=1,trainJump=1,trainCd=1;
function slotsKey(){return 'dw_slots_'+ROOM;}
function saveSlots(){LS.set(slotsKey(),JSON.stringify(slots.map(t=>t?t.code:null)));}
function restoreSlots(){
  let sv=[];try{sv=JSON.parse(LS.get(slotsKey())||'[]');}catch(e){}
  restoreN=0;
  sv.forEach((c,i)=>{if(c&&i<slots.length&&!slots[i]){restoreN++;netSend({t:'learn',slot:i,code:String(c)});}});
}
let modalSlot=-1,typed='',modalOpen=false,pendingLearn=false;
let boardRows=[];
let atkSide=false,strokeT=0,ambT=3,hbT=0,humT=0,inCave=false,inArena=false,fade=null,sleeping=false,sleepHouse=null,sleepPos=null,ammo=0,snipeCd=0,chestOpen=false,zT=0,fountT=0;
const zTex=(function(){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.font='bold 48px sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillStyle='#fff';x.fillText('Z',32,34);return new THREE.CanvasTexture(c);})();
let guarding=false,guardMax=27,guardPips=27,guardPipT=0,gbT=0,stunT=0,hasteT=0,hastePw=1.6,myRegenT=0,bookOpen=false,bookEnabled=false,bookData=[],bookPage=0,guardLbl='',rideT=0,ridePw=13,myMount=null;

/* ---------- UI helpers ---------- */
let toastT=0;   /* waktu habis (jam nyata, ms), bukan jam game, supaya tetap pas walau frame rate rendah */
function toast(msg,secs){let on=false;try{on=SET.toast;}catch(e){}if(!on)return;const t=$('toast');t.textContent=msg;t.classList.add('show');toastT=performance.now()+(secs||2.2)*1000;}
function feed(txt,ms){const f=$('feed'),d=document.createElement('div');d.textContent=txt;f.appendChild(d);while(f.children.length>4)f.removeChild(f.firstChild);setTimeout(()=>{if(d.parentNode)d.parentNode.removeChild(d);},ms||5000);}
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
  guardAtk();
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
/* auto aim bola (non-FPS): vektor 3D ke musuh terdekat dalam 40 unit, atau null */
function ballAim(){
  let best=null,bd=40;
  const eh=pos.y+1.45;
  const test=(x,y,z)=>{const dx=x-pos.x,dz=z-pos.z,d=Math.hypot(dx,dz);if(d<1||d>=bd)return;bd=d;const dy=(y+0.9)-eh,l=Math.hypot(d,dy);best={x:dx/l,y:dy/l,z:dz/l};};
  for(const o of others.values()){if(o.dead)continue;test(o.x,o.y||0,o.z);}
  for(const o of sols.values()){if(o.dead||o.owner===me.id)continue;test(o.x,terrainH(o.x,o.z),o.z);}
  return best;
}
function aim(){
  if(!SET.autoAim)return {x:faceX,z:faceZ};
  let fx=faceX,fz=faceZ,best=null,bs=-9;
  for(const o of others.values()){
    if(o.dead)continue;const dx=o.x-pos.x,dz=o.z-pos.z,d=Math.hypot(dx,dz);if(d<0.5||d>28)continue;
    const dot=(dx*faceX+dz*faceZ)/d;
    if(dot>0.74){const sc=dot-d*0.004;if(sc>bs){bs=sc;best=[dx/d,dz/d];}}
  }
  return best?{x:best[0],z:best[1]}:{x:fx,z:fz};
}
function comboStep(){comboN=comboT>0?comboN%3+1:1;comboT=0.9;return comboN===3;}
function doAttack(){
  if(!started||dead||modalOpen||bookOpen||stunT>0||fade||attackT>0||atkCool>0)return;
  if(duelBlock())return;
  if(sleeping)wakeUp();
  guardAtk();
  if(fps&&started){
    const v=aimVec(),hl=Math.hypot(v.x,v.z)||1,ax=v.x/hl,az=v.z/hl;faceX=ax;faceZ=az;
    {comboStep();attackT=0.32;atkCool=0.333;}sfx.swing();atkSide=!atkSide;slashFx(pos.x,pos.y,pos.z,ax,az,0xbfe9ff,1,atkSide,v.y);
    netSend({t:'atk',fx:+ax.toFixed(3),fz:+az.toFixed(3),fy:+v.y.toFixed(3)});return;
  }
  const a=aim();faceX=a.x;faceZ=a.z;
  {comboStep();attackT=0.32;atkCool=0.333;}sfx.swing();atkSide=!atkSide;slashFx(pos.x,pos.y,pos.z,a.x,a.z,0xbfe9ff,1,atkSide);
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
  if(duelBlock())return;
  if(aiming===i){sfx.techClick();fireAim();return;}
  if(slotCd[i]>0)return;
  sfx.techClick();   /* tombol teknik benar-benar tertekan dan jalan */
  if(AIM_KINDS[s.kind]){if(fps){castAimed(i);return;}if(SET.autoAimBall&&(s.kind==='bolt'||s.kind==='orb')){const bv=ballAim();if(bv){castAimed(i,bv);return;}}enterAim(i);return;}
  if(aiming>=0)cancelAim();
  guardAtk();
  let a;
  if(s.kind==='dash'){a=tAll-moveDirT<0.3?{x:moveDirX,z:moveDirZ}:{x:faceX,z:faceZ};faceX=a.x;faceZ=a.z;}
  else{a=aim();faceX=a.x;faceZ=a.z;}
  slotCd[i]=slotCdMax[i]=s.kind==='face'?0:(s.kind==='dash'?Math.max(s.cd,TUNING.dashMinCd):s.cd)*trainCd;
  attackT=s.kind==='dash'?0:Math.max(attackT,0.32);
  netSend({t:'cast',slot:i,fx:a.x,fy:0,fz:a.z});
}

/* ---------- code modal ---------- */
function renderCode(){$('codeBox').textContent=typed||'· · · · · ·';$('mOk').disabled=typed.length<2||pendingLearn;}
let pickList=[],pickCat=null;
const PICK_ICON={all:'book',atk:'bolt',boom:'nova',sum:'summon',def:'shield',move:'foot'};
function renderPick(list){
  if(list)pickList=list;
  const tb=$('pickTabs'),box=$('pickBox');tb.innerHTML='';box.innerHTML='';
  if(pickCat===null){   /* tampilan folder: pilih kategori dulu */
    BOOK_CATS.forEach(c=>{const n=c[2]?pickList.filter(t=>c[2].includes(t.kind)).length:pickList.length;if(!n)return;
      const b=document.createElement('button');b.className='pk pf';b.innerHTML=svg(PICK_ICON[c[0]]||'book','#ffd84d');
      const w=document.createElement('div');const nm=document.createElement('b');nm.textContent=(c[0]==='all'?'Semua teknik':c[1]);const d=document.createElement('small');d.textContent=n+' teknik';w.appendChild(nm);w.appendChild(d);b.appendChild(w);
      b.addEventListener('click',()=>{pickCat=c[0];sfx.click();renderPick();});box.appendChild(b);});
    return;
  }
  const cat=BOOK_CATS.find(x=>x[0]===pickCat),shown=!cat||!cat[2]?pickList:pickList.filter(t=>cat[2].includes(t.kind));
  const back=document.createElement('button');back.type='button';back.textContent='‹ Folder';back.addEventListener('click',()=>{pickCat=null;sfx.click();renderPick();});
  const ttl=document.createElement('span');ttl.className='pt';ttl.textContent=(cat&&cat[0]!=='all'?cat[1]:'Semua teknik')+' ('+shown.length+')';tb.appendChild(back);tb.appendChild(ttl);
  shown.forEach(t=>{const b=document.createElement('button');b.className='pk'+(slots.some((s,j)=>s&&s.code===t.code&&j!==modalSlot)?' has':'');
    b.innerHTML=svg(t.kind,t.color);const w=document.createElement('div');const n=document.createElement('b');n.textContent=t.name;const d=document.createElement('small');d.textContent=t.desc+'. CD '+t.cd+' dtk';w.appendChild(n);w.appendChild(d);b.appendChild(w);
    b.addEventListener('click',()=>{if(pendingLearn)return;pendingLearn=true;sfx.click();netSend({t:'learn',slot:modalSlot,code:t.code});});box.appendChild(b);});
}
function openModal(i){
  modalSlot=i;typed='';modalOpen=true;pendingLearn=false;$('codeErr').textContent='';$('codeBox').classList.remove('err');
  $('mTitle').textContent='TEKNIK DIGITAL, SLOT '+(i+1);
  $('mSub').textContent=slots[i]?'Slot ini berisi: '+slots[i].name+'. Ketik kode baru untuk mengganti.':'Masukkan kode angka 1-9 dari buku';
  $('mrow2').style.display=slots[i]?'block':'none';
  const pm=!!(roomInfo&&roomInfo.pick);document.body.classList.toggle('pickmode',pm);
  if(pm){pickCat=null;$('mSub').textContent='Pilih teknik untuk slot ini';$('pickBox').innerHTML='<small>Memuat...</small>';netSend({t:'techs'});}
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
$('mClear').addEventListener('click',()=>{const i=modalSlot;slots[i]=null;slotCd[i]=0;updSlotUI(i);saveSlots();netSend({t:'clear',slot:i});closeModal();});
$('modal').addEventListener('pointerdown',e=>{if(e.target===$('modal'))closeModal();});
document.querySelectorAll('.slot').forEach(el=>{
  const i=+el.dataset.i;let timer=null,longDone=false;
  el.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();initAudio();el.classList.add('down');longDone=false;
    clearTimeout(timer);timer=setTimeout(()=>{if(slots[i]){longDone=true;openModal(i);}},550);});
  const up=()=>{clearTimeout(timer);el.classList.remove('down');};
  try{el.addEventListener('pointerdown',e=>{try{el.setPointerCapture(e.pointerId);}catch(_){}});}catch(_){}
  el.addEventListener('pointerup',e=>{const was=el.classList.contains('down');up();if(was&&!longDone&&!modalOpen)castSlot(i);});
  el.addEventListener('pointercancel',up);
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
  if(e.code==='KeyT'){toggleEmo();return;}
  if(e.code==='KeyH')fireSniper();
  if(e.code==='Space')jumpBuf=0.13;
  if(e.code==='KeyE')interact();
  if(e.code==='Enter')openChat();
  if(e.code==='KeyC')setFps(!fps);if(e.code==='KeyH')setUiHidden(!uiHid);
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
    const sn=(typeof SET!=='undefined'&&SET.sens>0)?SET.sens:1;cam.yawT-=(e.clientX-look.lx)*0.0065*sn;if(fps)fpsPitch=clamp(fpsPitch-(e.clientY-look.ly)*0.004*sn,-1.3,1.3);else cam.pitchT=clamp(cam.pitchT+(e.clientY-look.ly)*0.004*sn,0.22,1.1);look.lx=e.clientX;look.ly=e.clientY;
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
bindBtn($('btnGuard'),()=>{
  if(guardLatch||guarding){setGuard(false);return;}
  guardLatch=true;setGuard(true);if(!guarding)guardLatch=false;
},null);
bindBtn($('btnSnipe'),()=>fireSniper());

/* ---------- fullscreen ---------- */
let wantFs=false;
(function(){
  const el=document.documentElement,btn=$('fsBtn');
  const req=el.requestFullscreen||el.webkitRequestFullscreen,exit=document.exitFullscreen||document.webkitExitFullscreen;
  const isFs=()=>!!(document.fullscreenElement||document.webkitFullscreenElement);
  const ios=/iPhone|iPod/.test(navigator.userAgent)||(/iPad|Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1&&!req);
  const standalone=window.navigator.standalone||matchMedia('(display-mode:standalone)').matches||matchMedia('(display-mode:fullscreen)').matches;
  if(!req){
    if(standalone){btn.classList.add('off');return;}
    btn.addEventListener('pointerdown',e=>e.stopPropagation());
    btn.addEventListener('click',()=>{toast(ios?'iPhone: ketuk Bagikan lalu "Tambah ke Layar Utama" untuk layar penuh':'Layar penuh tidak didukung browser ini',4);window.scrollTo(0,1);});
    return;
  }
  const doReq=()=>{try{const r=req.call(el,{navigationUI:'hide'});if(r&&r.catch)r.catch(()=>{});}catch(_){}
    try{if(screen.orientation&&screen.orientation.lock&&innerWidth<innerHeight)screen.orientation.lock('landscape').catch(()=>{});}catch(_){}};
  const sync=()=>{btn.innerHTML=svg(isFs()?'fsx':'fs');setTimeout(resize,150);setTimeout(resize,500);};
  document.addEventListener('fullscreenchange',sync);document.addEventListener('webkitfullscreenchange',sync);
  if(!standalone){const auto=()=>{removeEventListener('pointerdown',auto,true);removeEventListener('keydown',auto,true);if(!isFs()){wantFs=true;doReq();}};
    addEventListener('pointerdown',auto,true);addEventListener('keydown',auto,true);}
  btn.addEventListener('pointerdown',e=>e.stopPropagation());
  btn.addEventListener('click',()=>{
    try{
      if(isFs()){wantFs=false;exit.call(document);}
      else{wantFs=true;doReq();}
    }catch(_){}
    canvas.focus();
  });
  /* keluar fullscreen tanpa sengaja (mis. dialog izin mikrofon di Android): masuk lagi di sentuhan berikutnya */
  window.reFs=()=>{if(wantFs&&!isFs())doReq();};
  const again=()=>{if(wantFs&&!isFs())doReq();};
  window.addEventListener('pointerup',again,true);window.addEventListener('click',again,true);
  const onFsChange=()=>{if(!isFs()&&!(window._micAsk||Date.now()<(window._micUntil||0)))wantFs=false;};
  document.addEventListener('fullscreenchange',onFsChange);document.addEventListener('webkitfullscreenchange',onFsChange);
})();

/* ---------- tameng, buku, elang, ranjau, sinar ---------- */
function iconTex(name,color){const c=document.createElement('canvas');c.width=c.height=64;const t=new THREE.CanvasTexture(c);const im=new Image();im.onload=()=>{c.getContext('2d').drawImage(im,4,4,56,56);t.needsUpdate=true;};im.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+(ICO[name]||ICO.spark)+'</svg>');return t;}
const guardMat=new THREE.SpriteMaterial({map:iconTex('shield','#6cd4ff'),depthTest:false,transparent:true,fog:false});
let myGuardSp=null;
/* tangan FPS: pixel art satu gaya dengan sprite karakter */
let fvCh=-1;
function buildFpsArms(){
  const pal=Object.assign({},PAL_PLAYER,CHARS[clamp(me.ch|0,0,CHARS.length-1)].pal),SK2='#d8a77c';
  const mk=(id,draw)=>{
    const cv=$(id),g=cv.getContext('2d');g.clearRect(0,0,24,84);
    C=pal;sx=g;OX=0;OY=0;draw();
    const im=g.getImageData(0,0,24,84),d=im.data,out=new Uint8ClampedArray(d);
    for(let y=0;y<84;y++)for(let x=0;x<24;x++){const k=(y*24+x)*4;if(d[k+3]>0)continue;
      if((x>0&&d[k-4+3]>0)||(x<23&&d[k+4+3]>0)||(y>0&&d[k-96+3]>0)||(y<83&&d[k+96+3]>0)){out[k]=43;out[k+1]=34;out[k+2]=51;out[k+3]=255;}}
    im.data.set(out);g.putImageData(im,0,0);
  };
  mk('fpsRc',()=>{
    R(11,0,1,2,C.blade);R(10,2,3,16,C.blade);R(12,2,1,16,'#ffffff');
    R(5,18,14,2,C.hilt);R(5,18,14,1,'#f0d060');
    R(10,20,3,5,C.belt);
    R(8,22,8,6,C.skin);R(8,22,8,1,SK2);R(8,24,8,1,SK2);R(8,26,8,1,SK2);R(15,21,3,4,C.skin);R(15,24,3,1,SK2);
    R(6,28,13,56,C.tunic);R(6,28,13,1,C.tunicD);R(6,29,2,55,C.tunicD);
  });
}
let guardLatch=false,guardResume=0;
function guardAtk(){if(guarding){const l=guardLatch;setGuard(false,true);if(l)guardResume=0.3;}}
function setGuard(on,keep){
  if(!on&&!keep)guardLatch=false;
  if(on&&!(started&&!dead&&!modalOpen&&!bookOpen&&stunT<=0&&gbT<=0&&rideT<=0&&!sleeping&&!swimNow))on=false;
  if(guarding===on)return;
  guarding=on;$('btnGuard').classList.toggle('on',on);netSend({t:'guard',on});if(on)sfx.shield();
}
/* buku */
const BOOK_CATS=[['all','Semua',null],['atk','Serangan',['bolt','orb','beam','homing']],['boom','Ledakan',['nova','slam','trap']],['sum','Pemanggil',['summon','lion','ride']],['def','Pertahanan',['heal','regen','shield','wall']],['move','Gerak',['haste','dash','jump','blink','face']]];
let bookCat='all';
function bookList(){const c=BOOK_CATS.find(x=>x[0]===bookCat);return !c||!c[2]?bookData:bookData.filter(t=>c[2].includes(t.kind));}
function renderBookTabs(){
  const bx=$('bkTabs');bx.innerHTML='';
  BOOK_CATS.forEach(c=>{const n=c[2]?bookData.filter(t=>c[2].includes(t.kind)).length:bookData.length;if(c[2]&&!n)return;
    const b=document.createElement('button');b.type='button';b.textContent=c[1]+' ('+n+')';if(c[0]===bookCat)b.className='on';
    b.addEventListener('click',()=>{bookCat=c[0];bookPage=0;renderBook();sfx.plop();});bx.appendChild(b);});
}
function bookPer(){return innerHeight<400?2:(innerHeight<500?3:(innerWidth<520?4:5));}
function renderBook(){
  const per=bookPer(),lst=bookList(),spreads=Math.max(1,Math.ceil(lst.length/(per*2)));renderBookTabs();
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
  fill($('pgL'),lst.slice(base,base+per),bookPage*2+1,svg('book',null,'bki')+'Buku Teknik Digital');
  fill($('pgR'),lst.slice(base+per,base+per*2),bookPage*2+2,'Kode dan kekuatan');
  $('bkPrev').style.visibility=bookPage>0?'visible':'hidden';$('bkNext').style.visibility=bookPage<spreads-1?'visible':'hidden';
}
function openBook(){
  if(!started||bookOpen||modalOpen||!bookEnabled)return;
  fetch('/api/book').then(r=>r.json()).then(j=>{
    if(!j.enabled){toast('Buku tidak tersedia',2);return;}
    bookData=j.techniques;bookPage=0;bookCat='all';bookOpen=true;keys.clear();jumpBtnHeld=false;diveBtnHeld=false;setGuard(false);
    $('book').classList.add('show');renderBook();sfx.plop();
  }).catch(()=>toast('Gagal memuat buku',2));
}
function closeBook(){if(typeof tipOpen!=='undefined'&&tipOpen){closeTips();return;}if(typeof setOpen!=='undefined'&&setOpen){closeSet();return;}bookOpen=false;$('book').classList.remove('show');}
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
/* singa: sprite 5 arah x 2 frame, sama susunannya dengan elang */
const lionCv=document.createElement('canvas');lionCv.width=EW*2;lionCv.height=EH*5;
(function(){
  const x=lionCv.getContext('2d');
  const fur='#e0a84c',fd='#b57a2a',fl='#f4cf86',mane='#8a4f1c',md='#5e3512',nose='#2a1a12',eye='#1a1a1a',wh='#ffffff';
  function draw(row,f){
    const ox=f*EW,oy=row*EH;const E=(a,b,w,h,c)=>{x.fillStyle=c;x.fillRect(ox+a,oy+b,w,h);};
    const lg=f?1:0;
    const legsSide=()=>{E(16-lg*2,13,2,4,fd);E(13+lg*2,13,2,3,fur);E(6+lg*2,13,2,4,fd);E(9-lg*2,13,2,3,fur);E(16-lg*2,16,2,1,md);E(6+lg*2,16,2,1,md);};
    const tail=()=>{E(2,8,4,1,fd);E(1,6,2,4,md);E(2,7,1,2,mane);};
    /* singa tanpa wajah: kepala polos (tanpa mata, hidung, mulut) */
    if(row===0){   /* samping, menghadap kanan */
      E(4,8,12,6,fur);E(5,12,10,2,fl);legsSide();tail();
      E(11,3,6,11,mane);E(11,3,2,11,md);E(14,4,3,1,md);
      E(15,4,9,9,fur);E(16,4,7,1,fl);E(21,8,5,4,fl);E(15,2,3,3,fur);E(16,3,1,1,fd);
    }else if(row===1){   /* depan */
      E(6,2,16,14,mane);E(6,2,16,2,md);E(6,13,16,3,md);E(7,1,3,3,fur);E(18,1,3,3,fur);E(8,2,1,1,md);E(19,2,1,1,md);
      E(9,5,10,9,fur);E(10,6,8,1,fl);E(11,10,6,4,fl);
      E(9,14-lg,3,4,fur);E(16,14-(1-lg),3,4,fur);E(9,17-lg,3,1,md);E(16,17-(1-lg),3,1,md);
    }else if(row===2){   /* belakang */
      E(9,0,3,3,fur);E(16,0,3,3,fur);E(10,1,1,1,fd);E(17,1,1,1,fd);
      E(8,2,12,1,mane);E(6,3,16,6,mane);E(7,9,14,2,mane);E(9,11,10,1,mane);
      E(6,3,16,1,md);E(7,4,2,5,md);E(19,4,2,5,md);E(10,4,8,2,'#a36228');
      E(8,10,12,5,fur);E(8,10,5,5,fd);E(15,10,5,5,fd);E(13,9,2,6,fur);
      E(13,10,2,5,fd);E(12,14,4,3,md);E(13,13,2,1,mane);
      E(8,15-lg,4,3,md);E(16,15-(1-lg),4,3,md);E(9,15-lg,2,1,fd);E(17,15-(1-lg),2,1,fd);
    }else if(row===3){   /* 3/4 depan, menghadap kanan */
      E(4,8,12,6,fur);E(5,12,10,2,fl);legsSide();tail();
      E(11,2,12,12,mane);E(11,2,12,2,md);E(11,12,12,2,md);E(12,2,2,3,fur);E(20,2,2,3,fur);
      E(13,5,9,8,fur);E(15,10,6,3,fl);
    }else{   /* 3/4 belakang, menghadap kanan */
      E(4,8,12,6,fur);E(5,12,10,2,fl);legsSide();tail();
      E(11,2,12,12,mane);E(11,2,12,2,md);E(11,12,12,2,md);E(12,2,2,3,fur);E(19,2,2,3,fur);E(13,5,6,6,md);
      E(19,4,7,8,fur);E(23,9,4,3,fl);E(20,3,3,2,fur);
    }
  }
  for(let r=0;r<5;r++)for(let f=0;f<2;f++)draw(r,f);
  outlineCv(lionCv,EW,EH);
})();
const lionBase=new THREE.CanvasTexture(lionCv);lionBase.magFilter=lionBase.minFilter=THREE.NearestFilter;lionBase.generateMipmaps=false;
function lionTex(){const t=lionBase.clone();t.needsUpdate=true;t.repeat.set(0.5,0.2);return t;}
const mobs=new Map();
function addMob(m){
  if(mobs.has(m.id))return;
  const lion=m.k==='lion';
  const tex=lion?lionTex():eagleTex();
  const mesh=new THREE.Mesh(eagleGeo,new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide}));mesh.rotation.order='YXZ';scene.add(mesh);
  const sh=new THREE.Mesh(aShGeo,aShMat);scene.add(sh);
  const mine=m.o===me.id||isMate(m.o);const lab=makeLabel();const mo={friend:mine,name:lion?(mine?'Singamu':'Singa'):(mine?'Elangmu':'Elang'),hp:m.hp||40,max:m.hp||40,lab};
  mobs.set(m.id,{lion,lab,friend:mine,name:mo.name,max:mo.max,hp:m.hp||40,flash:0,id:m.id,o:m.o,mesh,tex,sh,x:m.x,y:m.y,z:m.z,tx:m.x,ty:m.y,tz:m.z,fx:1,fz:0,atkT:0});
  drawMobLabel(mobs.get(m.id));burst(m.x,m.y,m.z,m.c||'#ffd9a0',10,4);sfxAt(lion?'roar':'eagle',m.x,m.z);
}
function drawMobLabel(o){drawLabel({name:o.name,hp:o.hp/o.max*MAXHP,shieldT:0,lab:o.lab,friend:o.friend});}
function removeMob(id,quiet){
  const o=mobs.get(id);if(!o)return;
  if(!quiet)burst(o.x,o.y,o.z,'#ffd9a0',10,4);
  scene.remove(o.mesh);scene.remove(o.sh);scene.remove(o.lab.sp);o.lab.sp.material.dispose();o.lab.tex.dispose();o.mesh.material.dispose();o.tex.dispose();mobs.delete(id);
}
function updMobs(dt,rgt,fwd){
  for(const m of mobs.values()){
    const k=damp(10,dt);m.x+=(m.tx-m.x)*k;m.y+=(m.ty-m.y)*k;m.z+=(m.tz-m.z)*k;m.atkT=Math.max(0,m.atkT-dt);
    const sc=(m.lion?1.45:1)*(1+(m.atkT>0?0.35:0));
    m.mesh.position.set(m.x,m.y,m.z);m.mesh.rotation.y=cam.yaw;m.mesh.rotation.x=-cam.pitch*0.55;
    const fl=eagleSet(m,m.fx,m.fz,rgt,fwd,Math.floor(tAll*(m.lion?6:10)+m.id)%2);
    m.flash=Math.max(0,m.flash-dt);m.mesh.material.color.setHex(m.flash>0?0xff7a7a:0xffffff);m.mesh.scale.set(fl?-sc:sc,sc,1);
    const gy=Math.max(groundAt(m.x,m.z,m.y),WATER_Y);
    m.lab.sp.visible=(!inCave||inArena)&&Math.hypot(m.x-pos.x,m.z-pos.z)<40;m.lab.sp.position.set(m.x,m.y+(m.lion?1.9:1.3),m.z);
    m.sh.position.set(m.x,gy+0.07,m.z);m.sh.scale.setScalar(clamp(1-(m.y-gy)*0.1,0.3,1)*1.2);
  }
}
/* tunggangan elang */
function mountMake(){const tex=eagleTex();const mesh=new THREE.Mesh(eagleGeo,new THREE.MeshBasicMaterial({map:tex,alphaTest:0.5,side:THREE.DoubleSide}));mesh.rotation.order='YXZ';scene.add(mesh);return {mesh,tex};}
/* penunggang duduk di punggung elang; posisi dihitung per arah hadap (ruang layar) */
const MOUNT_LIFT=1.3;
const RIDE_OFF={0:[-0.02,0.2,0.5],1:[0,0.5,-0.8],3:[0.1,0.12,-0.55],2:[0,0.0,0.7],4:[0.34,0.0,0.55]};
function mountPlace(m,x,y,z,fx,fz,rgt,fwd,id){
  const fl=eagleSet(m,fx,fz,rgt,fwd,Math.floor(tAll*7+id)%2);
  const rw=ROWMAP[m.vk],t=RIDE_OFF[rw]||RIDE_OFF[0],tail=fl?1:-1;
  m.mesh.position.set(x,y+MOUNT_LIFT,z);m.mesh.rotation.y=cam.yaw;m.mesh.rotation.x=-cam.pitch*0.55;
  m.mesh.scale.set(fl?-1.6:1.6,1.6,1);
  const dx=t[0]*(rw===0||rw===3||rw===4?tail:0)*1.6,sx2=Math.cos(cam.yaw),sz2=-Math.sin(cam.yaw),tx=Math.sin(cam.yaw),tz=Math.cos(cam.yaw);
  m.off={x:sx2*dx+tx*t[2],y:MOUNT_LIFT+t[1],z:sz2*dx+tz*t[2]};
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
/* dinding teknik: kotak tembus pandang + penghalang gerak (bisa dilompati) */
function addWall(m){
  if(walls.has(m.id))return;
  const gy=terrainH(m.x,m.z),H=4;
  const mat=new THREE.MeshPhongMaterial({color:m.c||'#b8a27a',flatShading:true,emissive:new THREE.Color(m.c||'#b8a27a'),emissiveIntensity:0.18});
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(m.len,H,0.9),mat);
  mesh.position.set(m.x,gy+H/2,m.z);mesh.rotation.y=Math.atan2(-m.nx,-m.nz);mesh.scale.y=0.05;scene.add(mesh);
  const edge=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:0.9,fog:false}));mesh.add(edge);
  const cs=[],tx=-m.nz,tz=m.nx,n=Math.max(2,Math.ceil(m.len/1.3));
  for(let i=0;i<n;i++){const a=(i/(n-1)-0.5)*(m.len-0.8),c={x:m.x+tx*a,z:m.z+tz*a,r:0.85,top:gy+H};circles.push(c);cs.push(c);}
  walls.set(m.id,{mesh,cs,t:0,gy,H,hp:m.hp});
  burst(m.x,gy+1,m.z,m.c||'#b8a27a',14,4);
  for(let i=0;i<24;i++){const a=(Math.random()-0.5)*m.len;emit(m.x+tx*a,gy+0.2,m.z+tz*a,(Math.random()-0.5)*1.5,1.5+Math.random()*2.5,(Math.random()-0.5)*1.5,0.8,0.9,'#cdbf9a',0,0.7,1.2);}   /* debu naik dari tanah */
  ringFx(m.x,gy+0.15,m.z,m.len*0.55,m.c||'#b8a27a');sfxAt('wall',m.x,m.z);
}
function removeWall(id,broke){
  const w=walls.get(id);if(!w)return;walls.delete(id);
  for(const c of w.cs){const i=circles.indexOf(c);if(i>=0)circles.splice(i,1);}
  if(broke){const wx=w.mesh.position.x,wz=w.mesh.position.z,len=w.mesh.geometry.parameters.width,ry=w.mesh.rotation.y,tx=Math.cos(ry),tz=-Math.sin(ry);
    for(let i=0;i<40;i++){const a=(Math.random()-0.5)*len;emit(wx+tx*a,w.gy+0.5+Math.random()*3.5,wz+tz*a,(Math.random()-0.5)*7,2+Math.random()*5,(Math.random()-0.5)*7,0.9,0.8,Math.random()<0.5?'#d9c9a0':'#8a7a5a',14,0.95,0.2);}
    burst(wx,w.gy+2,wz,'#d9c9a0',18,6);sfxAt('wallbreak',wx,wz);if(Math.hypot(wx-pos.x,wz-pos.z)<22)shake=Math.max(shake,0.3);}
  scene.remove(w.mesh);w.mesh.geometry.dispose();w.mesh.material.dispose();
}
function updTrail(dt){if(hjT>0){hjT-=dt;if(!grounded)emit(pos.x+(Math.random()-0.5)*0.6,pos.y+0.4,pos.z+(Math.random()-0.5)*0.6,0,-0.5,0,0.5,0.55,'#9dffb0',0,0.7,0.8);}}
function updWalls(dt){updTrail(dt);walls.forEach(w=>{w.t+=dt;if(w.mesh.scale.y<1)w.mesh.scale.y=Math.min(1,w.mesh.scale.y+dt*6);w.mesh.position.y=w.gy+w.H/2*w.mesh.scale.y;});}
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
  const disc=new THREE.Mesh(new THREE.CylinderGeometry(0.52,0.52,0.08,32).rotateX(Math.PI/2),mat(pal.tunic,{shininess:70,specular:0x99bbff}));g.add(disc);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(0.52,0.05,10,36),mat('#e8f1ff',{shininess:90,specular:0xffffff}));rim.position.z=0.07;g.add(rim);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(0.33,0.025,8,32),mat('#bfe4ff',{shininess:60}));ring.position.z=0.065;g.add(ring);
  const gem=new THREE.Mesh(new THREE.SphereGeometry(0.11,14,10),new THREE.MeshBasicMaterial({color:0x8fe0ff}));gem.scale.z=0.6;gem.position.z=0.1;g.add(gem);
  const halo=new THREE.Mesh(new THREE.CircleGeometry(0.78,32),new THREE.MeshBasicMaterial({color:0x6cc8ff,transparent:true,opacity:0.16,depthWrite:false,side:THREE.DoubleSide,fog:false}));halo.position.z=-0.14;halo.renderOrder=-1;g.add(halo);
  g.visible=false;scene.add(g);return g;
}
function makeGuardSp(ch){return makeShield3D(ch);}
function placeShield(sh,x,y,z,fx,fz,t){
  sh.position.set(x+fx*0.95,y+1.0+Math.sin(tAll*2.2)*0.04,z+fz*0.95);
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
  const o={id:info.id,isSol:true,kind:info.kind,fort:info.fort,owner:info.owner,x:info.x,z:info.z,tx:info.x,tz:info.z,fx:0,fz:1,hp:info.hp,max:info.max,name:info.nm?info.nm:info.bandit?bnm:((info.kind==='sword'?'Pedang ':'Panah ')+owner),bandit:!!info.bandit,sc:info.kind==='brute'?1.3:1,shieldT:0,
    mesh,tex,mat:m,sh,lab:makeLabel(),viewK:0,wt:Math.random()*4,atkT:0,flash:0,moving:false};
  o.hpv=o.hp/o.max*MAXHP;
  drawSolLabel(o);sols.set(o.id,o);
}
function drawSolLabel(o){const fake={name:o.name,hp:o.hp/o.max*MAXHP,shieldT:0,lab:o.lab,friend:o.owner===me.id&&!o.bandit};drawLabel(fake);}
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
const AIM_KINDS={bolt:1,beam:1,orb:1,slam:1};
let moveDirX=0,moveDirZ=1,moveDirT=-9;
const retC=document.createElement('canvas');retC.width=retC.height=64;
(function(){const x=retC.getContext('2d');x.strokeStyle='#fff';x.lineWidth=5;x.beginPath();x.arc(32,32,22,0,6.2832);x.stroke();x.lineWidth=4;x.beginPath();x.moveTo(32,4);x.lineTo(32,18);x.moveTo(32,46);x.lineTo(32,60);x.moveTo(4,32);x.lineTo(18,32);x.moveTo(46,32);x.lineTo(60,32);x.stroke();})();
const aimRet=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(retC),depthTest:false,transparent:true,fog:false,opacity:0.95}));aimRet.renderOrder=25;aimRet.visible=false;scene.add(aimRet);
const aimLine=new THREE.Mesh(new THREE.BoxGeometry(1,0.07,0.07).translate(0.5,0,0),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.55,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));aimLine.visible=false;scene.add(aimLine);
const _v1=new THREE.Vector3(1,0,0),_v2=new THREE.Vector3();
function camFwd(){return {x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)};}
function aimPitchVal(){return fps?Math.sin(fpsPitch):clamp((0.55-cam.pitchT)*1.6,-0.9,0.9);}
function aimVec(){
  const f=camFwd();
  return {x:f.x,y:aimPitchVal(),z:f.z,lock:null};
}
function enterAim(i){
  sfx.aim();aiming=i;const el=document.querySelector('.slot[data-i="'+i+'"]');
  document.querySelectorAll('.slot').forEach(x=>x.classList.remove('aiming'));el.classList.add('aiming');
  $('aimbar').classList.add('show');toast('Bidik dulu: geser kamera, lalu Tembak',1.8);sfx.plop();
}
function cancelAim(){aiming=-1;document.querySelectorAll('.slot').forEach(x=>x.classList.remove('aiming'));$('aimbar').classList.remove('show');aimRet.visible=false;aimLine.visible=false;}
function castAimed(i,vOverride){
  const s=slots[i];
  if(!s||slotCd[i]>0||!started||dead||modalOpen||bookOpen||stunT>0||fade)return false;
  const v=vOverride||aimVec(),hl=Math.hypot(v.x,v.z)||1;
  faceX=v.x/hl;faceZ=v.z/hl;
  guardAtk();if(sleeping)wakeUp();
  slotCd[i]=slotCdMax[i]=s.cd;attackT=Math.max(attackT,0.32);sfx.techClick();
  netSend({t:'cast',slot:i,fx:+v.x.toFixed(3),fy:+v.y.toFixed(3),fz:+v.z.toFixed(3)});
  return true;
}
function fireAim(){
  if(aiming<0)return;const i=aiming;
  castAimed(i);cancelAim();
}
function updAim(){
  if(aiming<0){return;}
  if(dead||stunT>0||modalOpen||bookOpen||fade||!slots[aiming]){cancelAim();return;}
  const v=aimVec(),hl=Math.hypot(v.x,v.z)||1;
  faceX=v.x/hl;faceZ=v.z/hl;
  const s=slots[aiming],col=v.lock?'#ff5d5d':s.color,L=v.lock?v.lock.d:20;
  const dx=v.x/hl*Math.sqrt(Math.max(0.0001,1-v.y*v.y)),dz=v.z/hl*Math.sqrt(Math.max(0.0001,1-v.y*v.y));
  _v2.set(dx,v.y,dz).normalize();
  aimLine.visible=true;aimLine.position.set(pos.x,pos.y+1.55,pos.z);aimLine.quaternion.setFromUnitVectors(_v1,_v2);aimLine.scale.x=L;aimLine.material.color.set(col);aimLine.material.opacity=0.4+0.2*Math.sin(tAll*10);
  aimRet.visible=true;aimRet.position.set(pos.x+_v2.x*L,pos.y+1.55+_v2.y*L,pos.z+_v2.z*L);aimRet.material.color.set(col);const rs=v.lock?2.2+0.3*Math.sin(tAll*12):1.4;aimRet.scale.set(rs,rs,1);
}

/* ---------- chat ---------- */
let chatOpen=false,chatUnread=0;
function addChatLine(m,live){
  const d=document.createElement('div');if(m.id===me.id)d.className='me';const b=document.createElement('b');b.textContent=m.name+(m.tag?' #'+m.tag:'')+': ';const sp=document.createElement('span');sp.textContent=m.text;d.appendChild(b);d.appendChild(sp);
  const lst=$('chatList');lst.appendChild(d);while(lst.children.length>80)lst.removeChild(lst.firstChild);lst.scrollTop=lst.scrollHeight;
  if(live){
    const f=document.createElement('div');f.innerHTML=d.innerHTML;$('chatFeed').appendChild(f);while($('chatFeed').children.length>5)$('chatFeed').removeChild($('chatFeed').firstChild);setTimeout(()=>{if(f.parentNode)f.parentNode.removeChild(f);},9000);
    if(!chatOpen){chatUnread++;$('chatBadge').textContent=chatUnread>9?'9+':chatUnread;$('chatBadge').style.display='block';}
  }
}
function openChat(){if(!started||modalOpen||bookOpen||chatOpen)return;chatOpen=true;document.body.classList.add('chatopen');chatUnread=0;$('chatBadge').style.display='none';$('chatPanel').classList.add('show');keys.clear();jumpBtnHeld=false;diveBtnHeld=false;setGuard(false);setTimeout(()=>$('chatIn').focus(),30);$('chatList').scrollTop=$('chatList').scrollHeight;}
function closeChat(){chatOpen=false;document.body.classList.remove('chatopen');$('chatPanel').classList.remove('show');$('chatIn').blur();canvas.focus();}
$('chatBtn').addEventListener('click',()=>{if(chatOpen)closeChat();else openChat();});
$('chatBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('chatX').addEventListener('click',e=>{e.stopPropagation();closeChat();});$('chatX').addEventListener('pointerdown',e=>e.stopPropagation());
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
/* indikator bicara: ikon speaker + gelombang di atas nama */
let VAC=null;
function makeAnalyser(stream){
  try{
    if(!VAC)VAC=new (window.AudioContext||window.webkitAudioContext)();
    if(VAC.state==='suspended')VAC.resume().catch(()=>{});
    const src=VAC.createMediaStreamSource(stream),an=VAC.createAnalyser();an.fftSize=512;src.connect(an);
    return {an,src,buf:new Uint8Array(an.fftSize),lv:0};
  }catch(e){return null;}
}
function readLevel(a){
  if(!a)return 0;a.an.getByteTimeDomainData(a.buf);let s=0;
  for(let i=0;i<a.buf.length;i++){const v=(a.buf[i]-128)/128;s+=v*v;}
  const r=Math.sqrt(s/a.buf.length),t=clamp((r-0.015)*9,0,1);
  a.lv=t>a.lv?t:a.lv*0.82;return a.lv;
}
function makeBadge(){
  const cv=document.createElement('canvas');cv.width=cv.height=64;const tex=new THREE.CanvasTexture(cv);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));
  sp.scale.set(0.7,0.7,1);sp.renderOrder=21;sp.visible=false;scene.add(sp);return {cv,tex,sp,bucket:-1};
}
function drawBadge(b,n){
  if(b.bucket===n)return;b.bucket=n;
  const c=b.cv.getContext('2d');c.clearRect(0,0,64,64);
  c.fillStyle='rgba(20,20,40,.78)';c.beginPath();c.arc(32,32,29,0,Math.PI*2);c.fill();
  c.lineWidth=3;c.strokeStyle='#4dff88';c.stroke();
  c.fillStyle='#4dff88';c.strokeStyle='#4dff88';c.lineWidth=4;c.lineCap='round';
  c.beginPath();c.moveTo(14,26);c.lineTo(23,26);c.lineTo(33,17);c.lineTo(33,47);c.lineTo(23,38);c.lineTo(14,38);c.closePath();c.fill();
  for(let i=1;i<=3;i++){if(i>n)break;c.beginPath();c.arc(33,32,5+i*6,-0.75,0.75);c.stroke();}
  b.tex.needsUpdate=true;
}
function setBadge(b,lv,x,y,z){
  const on=lv>0.06;b.sp.visible=on;if(!on){b.bucket=-1;return;}
  drawBadge(b,lv>0.55?3:(lv>0.28?2:1));b.sp.position.set(x,y,z);const s=0.62+lv*0.18;b.sp.scale.set(s,s,1);
}
function killBadge(b){if(!b)return;scene.remove(b.sp);b.sp.material.dispose();b.tex.dispose();}
let myBadge=null;
function updVoice(){
  peers.forEach((p,id)=>{
    const o=others.get(id);if(!o)return;
    if(!p.vu&&p.el.srcObject)p.vu=makeAnalyser(p.el.srcObject);
    const lv=readLevel(p.vu);
    if(lv>0.06&&!o.badge)o.badge=makeBadge();
    if(o.badge)setBadge(o.badge,(o.dead||!o.lab.sp.visible)?0:lv,o.x,o.lab.sp.position.y+0.62,o.z);
  });
  let ml=0;
  if(micOn&&localStream){if(!myVu)myVu=makeAnalyser(localStream);ml=readLevel(myVu);}else if(myVu)myVu.lv=0;
  if(ml>0.06&&!myBadge)myBadge=makeBadge();
  if(myBadge)setBadge(myBadge,(dead||fps)?0:ml,pos.x,pos.y+2.6,pos.z);
}
let myVu=null;
function closePeer(id){const p=peers.get(id);if(!p)return;try{p.pc.close();}catch(e){}try{if(p.vu)p.vu.src.disconnect();}catch(e){}p.el.srcObject=null;peers.delete(id);const o=others.get(id);if(o&&o.badge){killBadge(o.badge);o.badge=null;}}
function closeAllPeers(){[...peers.keys()].forEach(closePeer);}
function setMicUI(){const b=$('micBtn');b.innerHTML=svg(micOn?'mic':'micoff');b.classList.toggle('active',micOn);}
function setSpkUI(){const b=$('spkBtn');b.innerHTML=svg(spkOn?'spk':'spkoff');b.classList.toggle('active',spkOn);peers.forEach(p=>{p.el.muted=!spkOn;});}
async function toggleMic(){
  if(!voiceEnabled())return;
  sfx.mic(!micOn);
  if(micOn){micOn=false;if(localStream)localStream.getAudioTracks().forEach(t=>{t.enabled=false;});peers.forEach(p=>{if(p.snd)p.snd.replaceTrack(null).catch(()=>{});});setMicUI();toast('Mikrofon mati',1.2);return;}
  try{
    if(!localStream){window._micAsk=true;try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});}finally{window._micAsk=false;window._micUntil=Date.now()+1500;if(window.reFs)setTimeout(window.reFs,0);setTimeout(resize,300);}}
    const tk=localStream.getAudioTracks()[0];tk.enabled=true;micOn=true;
    peers.forEach(p=>{if(p.snd)p.snd.replaceTrack(tk).catch(()=>{});});setMicUI();toast('Mikrofon nyala, kamu bisa bicara',1.6);
  }catch(e){toast('Mikrofon tidak bisa dipakai (izinkan mikrofon, butuh HTTPS)',3);}
}
$('micBtn').addEventListener('click',toggleMic);
$('spkBtn').addEventListener('click',()=>{spkOn=!spkOn;setSpkUI();toast(spkOn?'Suara room nyala':'Suara room dimatikan',1.2);});
$('micBtn').addEventListener('pointerdown',e=>e.stopPropagation());$('spkBtn').addEventListener('pointerdown',e=>e.stopPropagation());

/* ---------- kamera FPS ---------- */
function setFps(on){
  fps=!!on;if(fps)cancelAim();$('camBtn').classList.toggle('active',fps);$('xhair').classList.toggle('show',fps&&started);
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

/* ---------- emote (gelembung ikon pixel di atas kepala, 3 detik) ---------- */
const EMO_DUR=3;
const EMOTES=[
  {n:'Angkat tangan',d:q=>{emoHand(q,0);}},
  {n:'Lambaikan tangan',d:q=>{emoHand(q,-1);q(13,3,1,5,'#4db8ff');q(15,4,1,3,'#4db8ff');}},
  {n:'Terima kasih',d:q=>{const R='#ff4d4d';q(3,1,4,2,R);q(9,1,4,2,R);q(2,3,12,2,R);q(3,5,10,2,R);q(4,7,8,2,R);q(5,9,6,1,R);q(6,10,4,1,R);q(7,11,2,1,R);q(4,2,1,2,'#ff9a9a');q(4,12,9,3,'#f2c28a');q(4,13,9,1,'#d8a77c');q(3,12,2,2,'#f2c28a');q(12,12,3,4,'#4db8ff');}},
  {n:'Setuju',d:q=>{q(3,8,9,6,'#f2c28a');q(3,10,9,1,'#d8a77c');q(3,12,9,1,'#d8a77c');q(5,2,3,7,'#f2c28a');q(3,14,9,2,'#4db8ff');}},
  {n:'Tidak setuju',d:q=>{for(let i=0;i<12;i++){q(2+i,2+i,2,2,'#ff4d4d');q(12-i,2+i,2,2,'#ff4d4d');}}},
  {n:'Tolong',d:q=>{q(6,1,4,9,'#ff4d4d');q(7,2,1,6,'#ff9a9a');q(6,12,4,3,'#ff4d4d');}},
  {n:'Semangat',d:q=>{q(3,5,9,7,'#f2c28a');q(3,7,9,1,'#d8a77c');q(3,9,9,1,'#d8a77c');q(4,12,7,4,'#4db8ff');q(1,1,2,1,'#ffd84d');q(13,1,2,1,'#ffd84d');q(0,5,2,1,'#ffd84d');q(14,5,2,1,'#ffd84d');q(7,0,2,2,'#ffd84d');}},
  {n:'Heran',d:q=>{q(5,1,6,2,'#ffd84d');q(10,3,2,4,'#ffd84d');q(7,7,4,2,'#ffd84d');q(7,9,2,2,'#ffd84d');q(7,12,2,2,'#ffd84d');}}
];
function emoHand(q,ox){q(4+ox,8,8,6,'#f2c28a');q(4+ox,11,8,1,'#d8a77c');q(4+ox,3,2,5,'#f2c28a');q(6+ox,1,2,7,'#f2c28a');q(8+ox,1,2,7,'#f2c28a');q(10+ox,3,2,5,'#f2c28a');q(2+ox,8,3,3,'#f2c28a');q(5+ox,14,6,2,'#4db8ff');}
const EMO_ICON=[],EMO_URL=[],EMO_TEX=[];
function emoIcon(e){
  if(EMO_ICON[e])return EMO_ICON[e];
  const cv=document.createElement('canvas');cv.width=cv.height=18;const g=cv.getContext('2d');
  EMOTES[e].d((x,y,w,h,c)=>{g.fillStyle=c;g.fillRect(x+1,y+1,w,h);});
  const im=g.getImageData(0,0,18,18),d=im.data,out=new Uint8ClampedArray(d);
  for(let y=0;y<18;y++)for(let x=0;x<18;x++){const k=(y*18+x)*4;if(d[k+3]>0)continue;
    if((x>0&&d[k-4+3]>0)||(x<17&&d[k+4+3]>0)||(y>0&&d[k-72+3]>0)||(y<17&&d[k+72+3]>0)){out[k]=43;out[k+1]=34;out[k+2]=51;out[k+3]=255;}}
  im.data.set(out);g.putImageData(im,0,0);return EMO_ICON[e]=cv;
}
function emoURL(e){
  if(EMO_URL[e])return EMO_URL[e];
  const cv=document.createElement('canvas');cv.width=cv.height=72;const g=cv.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(emoIcon(e),0,0,72,72);
  return EMO_URL[e]=cv.toDataURL();
}
function emoTex(e){
  if(EMO_TEX[e])return EMO_TEX[e];
  const cv=document.createElement('canvas');cv.width=cv.height=80;const g=cv.getContext('2d');
  g.fillStyle='rgba(255,255,255,.96)';g.strokeStyle='#2b2233';g.lineWidth=3;
  g.beginPath();g.moveTo(18,4);g.lineTo(62,4);g.quadraticCurveTo(76,4,76,18);g.lineTo(76,52);g.quadraticCurveTo(76,66,62,66);g.lineTo(46,66);g.lineTo(40,77);g.lineTo(34,66);g.lineTo(18,66);g.quadraticCurveTo(4,66,4,52);g.lineTo(4,18);g.quadraticCurveTo(4,4,18,4);g.closePath();g.fill();g.stroke();
  g.imageSmoothingEnabled=false;g.drawImage(emoIcon(e),0,0,18,18,13,8,54,54);
  const t=new THREE.CanvasTexture(cv);return EMO_TEX[e]=t;
}
const rtS=()=>performance.now()/1000;
const meEmo={emo:null};let emoCdUntil=0;
function emoClear(h){const em=h.emo;if(!em)return;scene.remove(em.sp);em.sp.material.dispose();h.emo=null;if(h===meEmo)$('emoSelf').style.display='none';}
function emoStart(h,e){
  if(!(e>=0&&e<EMOTES.length))return;
  emoClear(h);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:emoTex(e),depthTest:false,transparent:true,fog:false}));sp.scale.set(0.01,0.01,1);sp.renderOrder=21;scene.add(sp);
  h.emo={e,t0:rtS(),sp};
  if(h===meEmo&&fps){const b=$('emoSelf');b.innerHTML='<img src="'+emoURL(e)+'" alt=""><span>'+EMOTES[e].n+'</span>';b.style.display='flex';}
}
/* gerak kecil sprite: dy naik, rz miring, dx geser kanan, sy tinggi */
function emoMotion(e,t){
  const r={dy:0,rz:0,dx:0,sy:1};
  switch(e){
    case 0:r.dy=0.1*Math.abs(Math.sin(t*5));break;
    case 1:r.rz=Math.sin(t*9)*0.18;break;
    case 2:r.sy=1-0.09*Math.max(0,Math.sin(t*2.5));break;
    case 3:r.sy=1-0.07*Math.max(0,Math.sin(t*7));break;
    case 4:r.dx=Math.sin(t*16)*0.07;break;
    case 6:r.dy=0.28*Math.abs(Math.sin(t*6));break;
    case 7:r.rz=0.16;break;
  }
  return r;
}
function emoTick(h,x,y,z,off,cancel,hide){
  const em=h.emo;if(!em)return null;
  const t=rtS()-em.t0;
  if(cancel||t>=EMO_DUR){emoClear(h);return null;}
  const k=clamp(Math.min(t/0.15,(EMO_DUR-t)/0.25),0,1),mo=emoMotion(em.e,t);
  const sc=1.25*(t<0.22?(t/0.22)*(1+0.25*(1-t/0.22)):1);
  em.sp.scale.set(sc,sc,1);em.sp.position.set(x,y+off+0.06*Math.sin(t*4),z);em.sp.material.opacity=clamp((EMO_DUR-t)/0.3,0,1);em.sp.visible=!hide;
  return {dy:mo.dy*k,rz:mo.rz*k,dx:mo.dx*k,sy:1+(mo.sy-1)*k};
}
let emoOpen=false;
function toggleEmo(force){emoOpen=force===undefined?!emoOpen:force;$('emoPanel').classList.toggle('show',emoOpen);}
function sendEmote(e){
  if(!started||dead||sleeping||chatOpen||modalOpen||bookOpen)return;
  toggleEmo(false);
  if(performance.now()<emoCdUntil){toast('Tunggu sebentar untuk emote lagi',1.4);return;}
  emoCdUntil=performance.now()+3000;netSend({t:'emote',e});
}
(function(){
  const pn=$('emoPanel');
  EMOTES.forEach((em,i)=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitem');b.title=em.n;
    b.innerHTML='<img src="'+emoURL(i)+'" alt=""><span>'+em.n+'</span>';b.addEventListener('click',()=>{sfx.click();sendEmote(i);});pn.appendChild(b);});
  pn.addEventListener('pointerdown',e=>e.stopPropagation());
  $('emoBtn').addEventListener('pointerdown',e=>e.stopPropagation());
  $('emoBtn').addEventListener('click',()=>{if(started)toggleEmo();});
  document.addEventListener('pointerdown',e=>{if(emoOpen&&!(e.target.closest&&e.target.closest('#emoPanel,#emoBtn')))toggleEmo(false);},true);
})();

/* ---------- remote players ---------- */
function makeLabel(){
  const cv=document.createElement('canvas');cv.width=192;cv.height=44;const tex=new THREE.CanvasTexture(cv);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true,fog:false}));sp.scale.set(2.4,0.55,1);sp.renderOrder=20;scene.add(sp);return {cv,tex,sp};
}
function drawLabel(o){
  const c=o.lab.cv.getContext('2d');c.clearRect(0,0,192,44);
  c.font='bold 22px sans-serif';c.textAlign='center';c.textBaseline='middle';
  const nmT=o.tag?o.name+' #'+o.tag:o.name;
  let fs=22;while(c.measureText(nmT).width>180&&fs>12){fs--;c.font='bold '+fs+'px sans-serif';}
  c.lineWidth=5;c.strokeStyle='rgba(20,20,40,.85)';c.strokeText(nmT,96,13);c.fillStyle='#fff';c.fillText(nmT,96,13);
  c.fillStyle='#2b2233';c.fillRect(26,28,140,11);c.fillStyle='#5a1f26';c.fillRect(28,30,136,7);
  c.fillStyle=o.shieldT>0?'#6cd4ff':(o.friend?'#3fe06c':'#ff3b3b');c.fillRect(28,30,Math.round(136*clamp(o.hp/MAXHP,0,1)),7);
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
  const o={id:info.id,name:info.name,tag:info.tag||'',ch:info.ch,hp:info.hp==null?MAXHP:info.hp,k:info.k||0,d:info.d||0,dead:!!info.dead,
    x:info.x||0,y:info.y||0,z:info.z||0,tx:info.x||0,ty:info.y||0,tz:info.z||0,fx:0,fz:1,m:0,a:0,sw:0,
    mesh,tex,mat:m,sh,lab:makeLabel(),shield:makeShield(),shieldT:0,ride:false,sleep:!!info.sl,mount:null,guard:false,gsp:null,stunT:0,regenT:0,hasteT:0,viewK:0,wt:Math.random()*4,atkT:0,flash:0};
  drawLabel(o);others.set(o.id,o);return o;
}
function removeOther(id){
  const o=others.get(id);if(!o)return;
  emoClear(o);killBadge(o.badge);scene.remove(o.mesh);scene.remove(o.sh);scene.remove(o.lab.sp);scene.remove(o.shield);if(o.gsp)scene.remove(o.gsp);if(o.mount)mountDrop(o.mount);
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
    else col=o.still?0:Math.floor(tAll/0.55+o.id)%2;
    setTexFrame(o.tex,col,row);
    const bob=wet?Math.sin(tAll*3+o.id)*0.06:0;
    let lift=0,rox=0,roz=0;
    if(o.ride&&!o.dead){if(!o.mount)o.mount=mountMake();o.mount.mesh.visible=true;mountPlace(o.mount,o.x,o.y,o.z,o.fx,o.fz,rgt,fwd,o.id);lift=o.mount.off.y;rox=o.mount.off.x;roz=o.mount.off.z;}else if(o.mount)o.mount.mesh.visible=false;
    o.mesh.position.set(o.x+rox,o.y+bob+lift,o.z+roz);o.mesh.rotation.y=cam.yaw;o.mesh.rotation.x=-cam.pitch*0.55;
    o.mesh.scale.set(flip?-1:1,1,1);
    {const mo=emoTick(o,o.x+rox,o.y+bob+lift,o.z+roz,3.3,o.dead||o.sleep||o.atkT>0||o.m>0,!(dp<60));o.mesh.rotation.z=mo?mo.rz:0;if(mo){o.mesh.position.x+=rgt.x*mo.dx;o.mesh.position.y+=mo.dy;o.mesh.position.z+=rgt.z*mo.dx;o.mesh.scale.y=mo.sy;}}
    o.mat.color.setHex(o.flash>0?(o.flash>0.2&&Math.sin(o.flash*42)>0?0xffffff:0xff6a6a):(o.stunT>0?0xaee6ff:0xffffff));
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
let boomFlash=null;const BOLT_G=0.08;   /* sama dengan server */
const boltLight=new THREE.PointLight(0xffffff,0,18,2);scene.add(boltLight);
const poolGeo=new THREE.CircleGeometry(1,28).rotateX(-Math.PI/2);
function waveGeo(){
  const sh=new THREE.Shape();const tipA=[0.65,-1.45];
  sh.moveTo(tipA[0],tipA[1]);sh.absarc(0,0,1.6,-1.15,1.15,false);sh.absarc(-1.4611,0,2.5611,0.6,-0.6,true);
  return new THREE.ShapeGeometry(sh,24).rotateX(-Math.PI/2);
}
const waveSide=new Map();   /* sisi miring tebasan terakhir tiap penyerang: kiri, kanan, kiri, ... */
function addWave(m){
  const side=!waveSide.get(m.o);waveSide.set(m.o,side);
  const g=new THREE.Group(),s=new THREE.Group();
  const col=new THREE.Color(m.c||'#cfeeff');
  const mat=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:0.9,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const core=new THREE.Mesh(waveGeo(),mat);core.scale.set(0.75,1,1.05);
  const hi=new THREE.Mesh(waveGeo(),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.9,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}));hi.scale.set(0.42,1,0.68);hi.position.x=0.3;
  s.add(core,hi);g.add(s);g.rotation.order='YZX';
  const l=Math.hypot(m.dx,m.dz)||1,el=Math.asin(clamp(m.dy||0,-0.95,0.95));
  g.rotation.y=Math.atan2(-m.dz/l,m.dx/l);g.rotation.z=el;s.rotation.x=side?0.5:-0.5;   /* true = miring kiri, false = miring kanan */
  g.position.set(m.x,m.y,m.z);scene.add(g);
  projs.push({wave:true,pool:null,sm:false,big:false,sz:0.5,id:m.id,g,x:m.x,y:m.y,z:m.z,dx:m.dx,dy:m.dy||0,dz:m.dz,sp:m.sp,life:m.life,maxLife:m.life,c:m.c,tr:9,mats:[mat,hi.material]});
}
function addProj(m){
  if(m.wv){addWave(m);return;}
  const g=new THREE.Group(),big=(m.sz||1)>=0.8,sz=m.sz||1;
  if(big){
    const r=0.45*sz;
    const ball=new THREE.Mesh(new THREE.IcosahedronGeometry(r,1),new THREE.MeshBasicMaterial({color:m.c,transparent:true,opacity:0.92,fog:false}));
    const shell=new THREE.Mesh(new THREE.IcosahedronGeometry(r*1.35,1),new THREE.MeshBasicMaterial({color:m.c,wireframe:true,transparent:true,opacity:0.55,fog:false}));
    const core=new THREE.Mesh(new THREE.IcosahedronGeometry(r*0.55,0),new THREE.MeshBasicMaterial({color:0xffffff,fog:false}));
    const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:m.c,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false,opacity:0.85}));glow.scale.setScalar(r*7);
    g.add(ball,shell,core,glow);g.userData={ball,shell,core,glow};
  }else{
    const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:m.c,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false,opacity:0.9}));glow.scale.setScalar(1.8*sz);g.add(glow);
    const core=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xffffff,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false}));core.scale.setScalar(0.8*sz);g.add(core);
  }
  let pool=null;
  if(big){pool=new THREE.Mesh(poolGeo,new THREE.MeshBasicMaterial({map:dotTex,color:m.c,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));pool.renderOrder=2;scene.add(pool);}
  g.position.set(m.x,m.y,m.z);scene.add(g);
  projs.push({pool,sm:!big,big,sz,id:m.id,g,x:m.x,y:m.y,z:m.z,dx:m.dx,dy:m.dy||0,dz:m.dz,sp:m.sp,life:m.life,c:m.c,tr:0});
}
function disposeProj(p){if(p.pool){scene.remove(p.pool);p.pool.material.dispose();}scene.remove(p.g);p.g.traverse(c=>{if(c.geometry)c.geometry.dispose();if(c.material)c.material.dispose();});}
function removeProj(id,hit){
  const i=projs.findIndex(p=>p.id===id);if(i<0)return;
  const p=projs[i];projs.splice(i,1);disposeProj(p);
  if(hit&&hit.boom>0)explodeFx(hit.x,hit.y,hit.z,hit.boom,p.c,hit.g);
  else if(hit&&!hit.fizz)burst(hit.x,hit.y,hit.z,p.c,12,5);
  else if(hit)burst(hit.x,hit.y,hit.z,p.c,6,3);
}
function explodeFx(x,y,z,r,col,ground){
  ringFx(x,y+0.15,z,r*1.15,col);ringFx(x,y+0.25,z,r*0.7,'#ffffff');
  burst(x,y+0.5,z,col,26,r*2.6);burst(x,y+0.4,z,'#fff6a0',12,r*1.6);
  for(let i=0;i<10;i++){const a=Math.random()*6.28;emit(x+Math.cos(a)*r*0.4,y+0.2,z+Math.sin(a)*r*0.4,Math.cos(a)*r*0.8,1.2+Math.random()*1.8,Math.sin(a)*r*0.8,0.9,r*0.55,'#d9cfae',-0.6,0.55,1.6);}
  boomFlash={x,y:y+0.8,z,c:col,t:0.35};sfxAt('boom',x,z);
  const d=Math.hypot(x-pos.x,z-pos.z);if(d<22)shake=Math.max(shake,0.35*(1-d/22)+0.05);
}
function updProjs(dt){
  let lp=null,ld=1e9;
  for(let i=projs.length-1;i>=0;i--){
    const p=projs[i];p.life-=dt;
    if(p.life<=0){projs.splice(i,1);disposeProj(p);continue;}
    if(p.big)p.dy-=BOLT_G/Math.max(1,p.sp)*dt;
    p.x+=p.dx*p.sp*dt;p.y+=p.dy*p.sp*dt;p.z+=p.dz*p.sp*dt;
    if(p.big){const rr=0.5*p.sz,gg=Math.max(terrainH(p.x,p.z),terrainH(p.x+p.dx*rr,p.z+p.dz*rr))+rr;if(p.y<gg)p.y=gg;}
    p.g.position.set(p.x,p.y,p.z);
    if(p.wave){const k=clamp(1-p.life/p.maxLife,0,1);p.g.scale.setScalar(1+0.5*k);const o=Math.pow(1-k,1.1);p.mats[0].opacity=0.85*o;p.mats[1].opacity=0.95*o;continue;}
    if(p.big){
      const u=p.g.userData,gh=terrainH(p.x,p.z),h=Math.max(0,p.y-gh),r=0.45*p.sz,k=clamp(h/(r*5+0.4),0,1);
      u.shell.rotation.x+=dt*7;u.shell.rotation.y+=dt*9;u.ball.rotation.y-=dt*5;
      const gl=u.glow;gl.material.opacity=0.85*(0.18+0.82*k);gl.scale.setScalar(r*7*(0.45+0.55*k));
      const near=1-k,pw=p.sz*3.6*(0.55+0.45*near);
      p.pool.position.set(p.x,gh+0.07,p.z);p.pool.scale.set(pw,1,pw);p.pool.material.opacity=0.08+0.4*near*near;
      p.lightK=near;
    }
    if(p.big){const d=Math.hypot(p.x-pos.x,p.z-pos.z);if(d<ld){ld=d;lp=p;}}
    p.tr-=dt;if(p.tr<=0){p.tr=p.big?0.018:0.025;const k=p.big?p.sz*0.45:0.5;emit(p.x+(Math.random()-0.5)*k*0.8,p.y+(Math.random()-0.5)*k*0.8,p.z+(Math.random()-0.5)*k*0.8,(Math.random()-0.5)*0.8,(Math.random()-0.5)*0.8,(Math.random()-0.5)*0.8,p.big?0.5:0.35,p.big?0.9*p.sz:0.5,p.c,0,0.7,-0.6);}
  }
  if(lp&&ld<60){boltLight.position.set(lp.x,lp.y+0.3,lp.z);boltLight.color.set(lp.c);boltLight.intensity=1.2+1.4*(0.4+0.6*(lp.lightK||0));boltLight.distance=8+lp.sz*5;}
  else boltLight.intensity=0;
  if(boomFlash){boomFlash.t-=dt;if(boomFlash.t<=0)boomFlash=null;else if(!(lp&&ld<60)){boltLight.position.set(boomFlash.x,boomFlash.y,boomFlash.z);boltLight.color.set(boomFlash.c);boltLight.intensity=5*(boomFlash.t/0.35);boltLight.distance=14;}}
}

/* ---------- network ---------- */
function addBoardRow(){}
function renderBoard(){
  const rows=[{id:me.id,name:me.name,tag:me.tag,k:me.k,d:me.d,me:true}].concat([...others.values()].map(o=>({id:o.id,name:o.name,tag:o.tag,k:o.k,d:o.d})));
  rows.sort((a,b)=>b.k-a.k||a.d-b.d);
  const bd=$('board');bd.innerHTML='<h4>PAPAN SKOR</h4>';
  rows.forEach((r,i)=>{const d=document.createElement('div');if(r.me)d.className='me';const b=document.createElement('b');b.textContent=(i+1)+'. '+r.name+(r.tag?' #'+r.tag:'');const s=document.createElement('span');s.innerHTML=kdHtml(r.k,r.d);d.appendChild(b);d.appendChild(s);bd.appendChild(d);});
  $('kd').innerHTML=kdHtml(me.k,me.d);
  $('roomTag').textContent=(roomInfo.name||'Room')+' '+rows.length+'/'+(roomInfo.max||'?');
}
let roomInfo={name:'',max:0};
function setHp(v){me.hp=clamp(v,0,MAXHP);$('hpFill').style.width=(me.hp/MAXHP*100)+'%';$('hpFill').style.background=me.hp>MAXHP*0.35?'':'linear-gradient(#ff8080,#d63a3a)';}
function applyDoor(i,open,silent){const d=doors[i];if(!d)return;if(d.open===open)return;d.open=open;d.target=open?1.65:0;if(!silent)sfxAt(open?'doorOpen':'doorClose',d.wx,d.wz);}
function onMsg(m){
  netTrackMsg();
  switch(m.t){
    case 'welcome':{
      me.id=m.id;me.tag=m.tag||'';roomInfo=m.room;hourBase=m.hour;hourAt=performance.now();slots.fill(null);
      setHp(m.hp==null?MAXHP:m.hp);me.k=0;me.d=0;
      {const f=findFree(m.spawn.x,m.spawn.z);pos.set(f.x,0,f.z);}vel.set(0,0,0);vy=0;grounded=true;cam.tx=pos.x;cam.tz=pos.z;cam.ty=0;
      chestOpen=!!m.chest;if(chest){chest.open=chestOpen;chest.target=chest.ang=chestOpen?1.25:0;}ammo=0;sleeping=false;$('night').style.opacity=0;fade=null;$('fade').style.opacity=0;
      cam.yaw=cam.yawT=0;
      cwalls.forEach((w,id)=>removeRing(id,-1));
      walls.forEach((_,id)=>removeWall(id,false));(m.walls||[]).forEach(addWall);if(roomMode==='train')setTimeout(()=>netSend({t:'tune',cd:trainCd,hp:parseInt($('trHp').value,10)}),300);
      others.forEach((o,id)=>removeOther(id));mobs.forEach((_,id)=>removeMob(id,true));traps.forEach((_,id)=>removeTrap(id));
      bookEnabled=!!m.book;$('bookBtn').classList.toggle('off',!bookEnabled);
      m.players.forEach(p=>{if(p.id!==me.id)addOther(p);});
      m.doors.forEach((o,i)=>applyDoor(i,!!o,true));
      forts.forEach(f=>setFortState({id:f.id,owner:0,name:'',ch:0}));(m.forts||[]).forEach(setFortState);
      sols.forEach((_,id)=>removeSol(id));orbs.forEach((_,id)=>removeOrb(id,true));(m.sols||[]).forEach(addSol);
      $('chatList').innerHTML='';(m.chat||[]).forEach(c=>addChatLine(c,false));
      closeAllPeers();{const vo=voiceEnabled();document.querySelectorAll('.vo').forEach(b=>b.classList.toggle('off',!vo));micOn=false;spkOn=true;setMicUI();setSpkUI();if(vo)m.players.forEach(pl=>{if(pl.id!==me.id)ensurePeer(pl.id);});}
      joined=true;started=true;slots.forEach((_,i)=>{slotCd[i]=0;updSlotUI(i);});restoreSlots();
      document.body.classList.add('playing');$('start').classList.add('hide');canvas.focus();
      playerRoot.visible=true;pShadow.visible=true;
      toast('Siapkan teknikmu! Tekan ＋ di kanan untuk menulis kode',3.4);
      roomMode=(m.room&&m.room.mode)==='duel'?'duel':((m.room&&m.room.mode)==='train'?'train':'world');document.body.classList.toggle('train',roomMode==='train');
      applySet();netSend({t:'pref',dbg:SET.hitDbg?1:0});
      if(roomMode==='duel'){document.body.classList.add('duel');duelSize=(m.duel&&m.duel.size)||1;buildArena();forts.forEach(f=>{f.g.visible=false;});if(m.duel)onDuel(m.duel);cam.yaw=cam.yawT=Math.atan2(-(ARENA.x-pos.x),-(ARENA.z-pos.z));cam.pitchT=0.38;toast(duelSize>1?'Arena Tim '+duelSize+' vs '+duelSize+': tim menang lanjut. Kalau kurang pemain, komputer jadi rekan & lawan!':'Arena Duel 1 vs 1: menang lanjut, kalah antri. Siapkan tekniknya!',3.6);showDuelHelp();renderBoard();break;}
      renderBoard();startIntro();break;}
    case 'err':{$('ferr').textContent=m.msg;$('go').disabled=false;if(joined)toast(m.msg,2.5);break;}
    case 'pj':{if(m.p.id!==me.id){addOther(m.p);ensurePeer(m.p.id);feed(m.p.name+' bergabung',1000);renderBoard();}break;}
    case 'pl':{closePeer(m.id);const o=others.get(m.id);if(o){feed(o.name+' keluar');removeOther(m.id);renderBoard();}break;}
    case 'sc':{m.s.forEach(r=>{if(r[0]===me.id){me.k=r[1];me.d=r[2];}else{const o=others.get(r[0]);if(o){o.k=r[1];o.d=r[2];}}});renderBoard();break;}
    case 'ps':{
      m.p.forEach(r=>{const o=others.get(r[0]);if(!o)return;
        o.tx=r[1];o.ty=r[2];o.tz=r[3];
        if(Math.hypot(r[4],r[5])>0.1){o.fx=r[4];o.fz=r[5];}
        o.m=r[6];o.a=r[7];o.sw=r[8];
        if(o.fresh===undefined){o.x=o.tx;o.y=o.ty;o.z=o.tz;o.fresh=false;}
      });break;}
    case 'atk':{const o=others.get(m.id);if(o){o.atkT=0.32;o.fx=m.fx;o.fz=m.fz;sfxAt('swing',o.x,o.z);o.side=!o.side;slashFx(o.x,o.y,o.z,m.fx,m.fz,0xffd9a0,1,o.side);}break;}
    case 'hf':{const big=m.cb===3;shake=Math.max(shake,big?0.5:0.22);burst(m.x,m.y+1.1,m.z,big?'#ffd84d':'#ffffff',big?16:8,big?6:4);if(big)floatText(m.x,m.y+2.8,m.z,'PENUTUP!','#ffd84d');break;}
    case 'door':applyDoor(m.i,!!m.open);break;
    case 'learned':{
      const i=m.slot;slots[i]=m.tech;slotCd[i]=0;slotCdMax[i]=m.tech.cd;updSlotUI(i);saveSlots();
      if(restoreN>0){restoreN--;break;}   /* pemulihan otomatis: tanpa suara/pesan */
      pendingLearn=false;closeModal();sfx.learn();toast(m.tech.name+' siap dipakai!',3);break;}
    case 'learnerr':if(restoreN>0){restoreN--;break;}if(document.body.classList.contains('pickmode')){pendingLearn=false;toast(m.msg||'Gagal memasang teknik',3);sfx.bad();}else modalErr(m.msg||'Kode salah');break;
    case 'techs':renderPick(m.list);break;
    case 'slotclear':{slots[m.slot]=null;updSlotUI(m.slot);saveSlots();toast('Teknik itu sudah tidak tersedia',3);break;}
    case 'face':{faceX=m.fx;faceZ=m.fz;cam.yawT=Math.atan2(-m.fx,-m.fz);if(typeof m.fy==='number'){if(fps)fpsPitch=clamp(Math.asin(m.fy),-1.3,1.3);else cam.pitchT=clamp(0.55-m.fy/1.6,0.22,1.1);}break;}
    case 'prd':{const q=projs.find(p=>p.id===m.id);if(q){q.x=m.x;q.y=m.y;q.z=m.z;q.dx=m.dx;q.dy=m.dy;q.dz=m.dz;}break;}
    case 'pr':addProj(m);if(m.wv)break;if(m.sz===0.55)sfxAt('twang',m.x,m.z);else sfxAt('throw',m.x,m.z);break;
    case 'px':{const pj=projs.find(q=>q.id===m.id);if(pj&&pj.sm)sfxAt('arrowHit',m.x,m.z);if(m.sb){floatText(m.x,m.y+0.8,m.z,'PUKUL BALIK!','#fff2a0');sfxAt('clash',m.x,m.z);burst(m.x,m.y,m.z,'#fff6a0',12,5);}if(m.bb){floatText(m.x,m.y+0.8,m.z,'BENTROK!','#ffd24d');sfxAt('clash',m.x,m.z);burst(m.x,m.y,m.z,'#ffd24d',14,5);}if(m.wl){wallPulse=1;burst(m.x,m.y,m.z,'#9fe3ff',10,4);sfxAt('block',m.x,m.z);}if(m.ds){floatText(m.x,m.y+0.8,m.z,'TEBAS!','#ffffff');sfxAt('clash',m.x,m.z);}if(m.rf){floatText(m.x,m.y+0.8,m.z,'MANTUL!','#9fe3ff');sfxAt('block',m.x,m.z);burst(m.x,m.y,m.z,'#bfe9ff',10,4);}removeProj(m.id,m);break;}
    case 'fx':onFx(m);break;
    case 'pong':{const r=performance.now()-m.ts;netTrackPing(r);netRtt=netRtt<0?r:netRtt*0.6+r*0.4;netLast=performance.now();drawNet();break;}
    case 'hit':onHit(m);break;
    case 'clash':onClash(m);break;
    case 'hp':{if(m.id===me.id)setHp(m.hp);else{const o=others.get(m.id);if(o){o.hp=m.hp;drawLabel(o);}}break;}
    case 'die':onDie(m);break;
    case 'duel':onDuel(m);break;
    case 'dbg':addDbg(m);break;
    case 'tp':{pos.set(m.x,terrainH(m.x,m.z),m.z);vel.set(0,0,0);kb.x=kb.z=0;vy=0;grounded=true;faceX=m.fx;faceZ=m.fz;cam.yaw=cam.yawT=Math.atan2(-m.fx,-m.fz);cam.tx=pos.x;cam.tz=pos.z;break;}
    case 'resp':{
      if(m.id===me.id){dead=false;$('ko').style.display='none';setHp(MAXHP);{const f=findFree(m.x,m.z);pos.set(f.x,0,f.z);}vel.set(0,0,0);kb.x=kb.z=0;vy=0;grounded=true;cam.tx=pos.x;cam.tz=pos.z;invuln=2;stunT=0;gbT=0;myRegenT=0;hasteT=0;sfx.respawn();toast('Kembali bertarung!',1.6);}
      else{const o=others.get(m.id);if(o){o.dead=false;o.hp=MAXHP;o.tx=o.x=m.x;o.tz=o.z=m.z;o.ty=o.y=0;drawLabel(o);}}break;}
    case 'guard':{if(m.id===me.id){guarding=!!m.on;$('btnGuard').classList.toggle('on',!!m.on);}else{const o=others.get(m.id);if(o){o.guard=!!m.on;if(m.on)sfxAt('shield',o.x,o.z);}}break;}
    case 'gbreak':{if(m.id===me.id){gbT=2.5;guarding=false;guardLatch=false;$('btnGuard').classList.remove('on');toast('Tameng pecah!',3);sfx.gbreak();shake=Math.max(shake,0.3);}else{const o=others.get(m.id);if(o){o.guard=false;floatText(o.x,o.y+2.4,o.z,'PECAH!','#ffb84d');sfxAt('gbreak',o.x,o.z);}}break;}
    case 'stun':{if(m.id===me.id){stunT=m.ms/1000;setGuard(false);toast('Kamu membeku!',3);}else{const o=others.get(m.id);if(o)o.stunT=m.ms/1000;}break;}
    case 'mob':addMob(m);break;
    case 'mobx':{const o=mobs.get(m.id);if(o&&m.dead){floatText(o.x,o.y+1.2,o.z,'KO','#ffd84d');sfxAt('soldierDie',o.x,o.z);}removeMob(m.id);break;}
    case 'mh':{const o=mobs.get(m.id);if(o){showHitbox(o,0,0);o.hp=m.hp;drawMobLabel(o);o.flash=0.2;floatText(o.x,o.y+1.4,o.z,'-'+m.dmg,'#ffd84d');sfxAt('hit',o.x,o.z);burst(o.x,o.y,o.z,'#ffe9c0',6,3);}break;}
    case 'ms':m.m.forEach(r=>{const o=mobs.get(r[0]);if(!o)return;o.tx=r[1];o.ty=r[2];o.tz=r[3];o.fx=r[4];o.fz=r[5];if(r[6])o.atkT=0.3;});break;
    case 'trap':addTrap(m);break;
    case 'trapx':removeTrap(m.id,m.quiet?null:m);break;
    case 'wall':addWall(m);break;
    case 'wallx':removeWall(m.id,!!m.broke);break;
    case 'wallh':{const w=walls.get(m.id);if(w){w.hp=m.hp;w.mesh.material.opacity=0.45+0.4*Math.max(0,m.hp/m.max);}break;}
    case 'sleep':{if(m.id===me.id){if(!m.on&&sleeping)wakeUp(true);}else{const o=others.get(m.id);if(o)o.sleep=!!m.on;}break;}
    case 'chest':{chestOpen=!!m.open;if(chest){chest.open=chestOpen;chest.target=chestOpen?1.25:0;}if(m.open)sfxAt('chestOpen',CX,CZ);break;}
    case 'wpn':{const had=ammo;ammo=m.ammo|0;if(ammo>0&&had===0)toast('Sniper didapat! Peluru '+ammo+' (tombol Sniper / H)',3.2);else if(ammo===0&&had>0)toast('Peluru sniper habis',1.8);break;}
    case 'toast':toast(m.msg,3);break;
    case 'fort':{setFortState(m.f);{const ff=forts[m.f.id];if(ff&&m.f.owner)sfxAt('fanfare',ff.x,ff.z);}if(capState&&capState.fort===m.f.id){capState=null;$('capBox').classList.remove('show');}break;}
    case 'sol':addSol(m.s);break;
    case 'solx':{const o=sols.get(m.id);if(o&&m.dead)sfxAt('soldierDie',o.x,o.z);removeSol(m.id,!!m.dead);break;}
    case 'bshout':{const o=sols.get(m.id);if(o){sfxAt(Math.random()<0.3?'banditLaugh':'bandit',o.x,o.z);}break;}
    case 'bloot':{sfx.loot();toast('Penyamun kalah! +'+m.heal+' HP',1.6);break;}
    case 'ss':m.s.forEach(r=>{const o=sols.get(r[0]);if(!o)return;o.tx=r[1];o.tz=r[2];o.fx=r[3];o.fz=r[4];if(r[5]){o.atkT=0.3;if(o.kind==='archer')sfxAt('twang',o.x,o.z);else{sfxAt('swing',o.x,o.z);o.side=!o.side;slashFx(o.x,terrainH(o.x,o.z),o.z,o.fx,o.fz,o.bandit?0xff6a5a:0xfff0c0,o.kind==='brute'?1.4:1,o.side);}}});break;
    case 'sh':{if(roomMode==='train'&&m.by===me.id&&m.dmg>0)dpsAdd(m.dmg);const o=sols.get(m.id);if(o){showHitbox({get x(){return o.x},get z(){return o.z},get y(){return terrainH(o.x,o.z)}},0.9,0);o.hp=m.hp;o.flash=0.18;drawSolLabel(o);sfxAt(Math.random()<0.5?'clang':'hit',o.x,o.z);floatText(o.x,terrainH(o.x,o.z)+2.1,o.z,'-'+m.dmg,'#ffd84d');}break;}
    case 'cap':onCap(m);break;
    case 'orb':addOrb(m);break;
    case 'orbx':removeOrb(m.id);break;
    case 'ring':startRing(m);break;
    case 'ringhit':hitRing(m.id,m.i,m.hp);break;
    case 'ringx':removeRing(m.id,m.i,m.x,m.z);break;
    case 'chat':addChatLine(m,true);if(m.id!==me.id)sfx.pop();break;
    case 'emote':{if(m.id===me.id)emoStart(meEmo,m.e|0);else{const o=others.get(m.id);if(o)emoStart(o,m.e|0);}break;}
    case 'rtc':onRtc(m.from,m.d);break;
    case 'closed':{ws.onclose=null;showDc('Room ditutup','Admin menutup room ini.');break;}
  }
}
const cwalls=new Map();
const cwallGeo=new THREE.BoxGeometry(1.7,3,0.7),cwallEdgeGeo=new THREE.EdgesGeometry(cwallGeo),cwallEdgeMat=new THREE.LineBasicMaterial({color:0x1b2740});
function startRing(m){
  const arr=[];const col=new THREE.Color(m.c||'#9fb4d0');
  for(let k=0;k<m.n;k++){
    const a=k/m.n*Math.PI*2,x=m.x+Math.cos(a)*m.r,z=m.z+Math.sin(a)*m.r,gy=terrainH(x,z);
    const mat2=new THREE.MeshBasicMaterial({color:col.clone()});
    const mesh=new THREE.Mesh(cwallGeo,mat2);mesh.add(new THREE.LineSegments(cwallEdgeGeo,cwallEdgeMat));mesh.position.set(x,gy+1.5,z);mesh.rotation.y=-a+Math.PI/2;mesh.scale.y=0.01;scene.add(mesh);
    const circ={x,z,r:1.0};circles.push(circ);
    arr.push({mesh,mat:mat2,circ,hp:m.hp,max:m.hp,x,z,gy,flash:0,base:col.clone().multiplyScalar(k%2?0.8:1),alive:true});
  }
  const w={id:m.id,segs:arr,t:0,dur:m.dur,col:m.c||'#9fb4d0'};cwalls.set(m.id,w);
  burst(m.x,terrainH(m.x,m.z)+0.5,m.z,m.c||'#9fb4d0',18,6);sfxAt('boom',m.x,m.z);
}
function ringSegKill(sg,col,big){
  if(!sg.alive)return;sg.alive=false;
  const ci=circles.indexOf(sg.circ);if(ci>=0)circles.splice(ci,1);
  scene.remove(sg.mesh);sg.mat.dispose();
  burst(sg.x,sg.gy+1.5,sg.z,col||'#9fb4d0',big?8:16,5);
}
function removeRing(id,i,sx,sz){
  const w=cwalls.get(id);if(!w)return;
  if(i<0){w.segs.forEach(sg=>ringSegKill(sg,w.col,true));cwalls.delete(id);sfxAt('boom',w.segs[0]?w.segs[0].x:0,w.segs[0]?w.segs[0].z:0);return;}
  const sg=w.segs[i];if(!sg)return;ringSegKill(sg,w.col,false);sfxAt('hit',sg.x,sg.z);
  if(w.segs.every(q=>!q.alive))cwalls.delete(id);
}
function hitRing(id,i,hp){const w=cwalls.get(id);if(!w)return;const sg=w.segs[i];if(!sg||!sg.alive)return;sg.hp=hp;sg.flash=0.15;burst(sg.x,sg.gy+1.5,sg.z,w.col,6,3);sfxAt('hit',sg.x,sg.z);}
function updCWalls(dt){
  for(const [id,w] of cwalls){
    w.t+=dt;const rise=Math.min(1,w.t/0.25),left=w.dur-w.t;
    for(const sg of w.segs){
      if(!sg.alive)continue;
      sg.mesh.scale.y=Math.max(0.01,rise);sg.mesh.position.y=sg.gy+1.5*rise;
      const k=clamp(sg.hp/sg.max,0,1);
      sg.flash=Math.max(0,sg.flash-dt);
      sg.mat.color.copy(sg.base).multiplyScalar(0.45+0.55*k);
      if(sg.flash>0)sg.mat.color.setRGB(1,1,1);
      if(left<1)sg.mesh.visible=Math.floor(w.t*14)%2===0;
    }
  }
}
const spins=[];
function mkSpinSword(col){
  const g=new THREE.Group();
  const bm=new THREE.MeshBasicMaterial({color:0xe8f6ff}),gm=new THREE.MeshBasicMaterial({color:new THREE.Color(col)}),hm=new THREE.MeshBasicMaterial({color:0x5a3a22});
  const bl=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.07,1.5),bm);bl.position.z=0.95;
  const gd=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.1,0.12),gm);gd.position.z=0.18;
  const hd=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.1,0.4),hm);
  g.add(bl,gd,hd);return g;
}
function startSpin(id,dur,r,col){
  for(let i=spins.length-1;i>=0;i--)if(spins[i].id===id){scene.remove(spins[i].g);spins.splice(i,1);}
  const g=new THREE.Group();
  for(let k=0;k<2;k++){const a=k*Math.PI,sw=mkSpinSword(col);sw.position.set(Math.cos(a)*1.1,0,Math.sin(a)*1.1);sw.rotation.y=-a+Math.PI/2*0;sw.rotation.y=Math.atan2(Math.cos(a),-Math.sin(a));g.add(sw);}
  scene.add(g);spins.push({id,g,t:0,dur,r,col});
}
function updSpins(dt){
  for(let i=spins.length-1;i>=0;i--){
    const q=spins[i],p=entPos(q.id);q.t+=dt;
    if(!p||q.t>=q.dur){scene.remove(q.g);spins.splice(i,1);continue;}
    q.g.position.set(p.x,p.y+1.0,p.z);q.g.rotation.y+=dt*15;
    const a=q.g.rotation.y;
    if(Math.random()<0.9)emit(p.x+Math.cos(a)*q.r*0.8,p.y+1.0,p.z-Math.sin(a)*q.r*0.8,0,0.3,0,0.35,0.5,q.col,0,0.5,0.2);
  }
}
function entPos(id){if(id===me.id)return {x:pos.x,y:pos.y,z:pos.z};const o=others.get(id);return o?{x:o.x,y:o.y,z:o.z}:null;}
function onFx(m){
  const p=entPos(m.id);if(!p)return;const near=Math.hypot(p.x-pos.x,p.z-pos.z)<45;
  const col=m.c||'#ffffff';
  if(m.k==='cast'){if(m.id!==me.id){const o=others.get(m.id);if(o){o.atkT=0.32;if(m.fx!=null){o.fx=m.fx;o.fz=m.fz;}}}burst(p.x,p.y+1.1,p.z,col,8,3);{const kk=m.kind;const mp={bolt:'zap',beam:'beam',summon:'eagle',lion:'roar',ride:'eagle',orb:'orb',slam:'slam',dash:null,nova:null,heal:null,regen:null,shield:null,haste:null,trap:null};const nm=mp[kk];if(nm)sfxAt(nm,p.x,p.z);if(kk==='trap'&&m.id===me.id)sfx.trapset();}}
  else if(m.k==='nova'){ringFx(p.x,p.y+0.2,p.z,m.r,col);burst(p.x,p.y+0.8,p.z,col,22,7);sfxAt('boom',p.x,p.z);if(m.id===me.id)shake=Math.max(shake,0.3);}
  else if(m.k==='heal'){for(let i=0;i<14;i++)emit(p.x+(Math.random()-0.5)*1.2,p.y+0.2,p.z+(Math.random()-0.5)*1.2,0,1.5+Math.random()*2,0,1,0.45,i%2?'#7dffae':'#ffffff',0,0.9,0.2);floatText(p.x,p.y+2.2,p.z,'+'+(m.v||''),'#6dff96');sfxAt('heal',p.x,p.z);}
  else if(m.k==='shield'){if(m.id===me.id)myShieldT=m.dur;else{const o=others.get(m.id);if(o){o.shieldT=m.dur;drawLabel(o);}}burst(p.x,p.y+1,p.z,col,10,3);sfxAt('shield',p.x,p.z);}
  else if(m.k==='ride'){if(m.id===me.id){rideT=m.dur;ridePw=m.pw;setGuard(false);toast('Naik elang! Lompat = naik, Selam = turun',3);sfx.eagle();}else{const o=others.get(m.id);if(o)o.ride=true;sfxAt('eagle',p.x,p.z);}burst(p.x,p.y+1,p.z,col,14,4);}
  else if(m.k==='rideend'){if(m.id===me.id){rideT=0;}else{const o=others.get(m.id);if(o)o.ride=false;}}
  else if(m.k==='snipe'){beamFx(p.x,p.y+1.0,p.z,m.fx,m.fz,m.len,'#ffffff',0.07);burst(p.x+m.fx,p.y+1,p.z+m.fz,'#fff6a0',6,3);sfxAt('snipe',p.x,p.z);}
  else if(m.k==='beam'){beamFx(p.x,p.y+1.0,p.z,m.fx,m.fz,m.len,col);burst(p.x+m.fx,p.y+1,p.z+m.fz,col,8,4);sfxAt('beam',p.x,p.z);}
  else if(m.k==='uppercut'){if(m.id===me.id){vy=Math.max(vy,7);grounded=false;jumping=false;attackT=Math.max(attackT,0.32);}for(let i=0;i<12;i++){const a=i/12*Math.PI;emit(p.x+m.fx*Math.sin(a)*2,p.y+0.2+Math.cos(a)*1.4+1.2,p.z+m.fz*Math.sin(a)*2,m.fx*2,3,m.fz*2,0.4,0.6,col,0,0.8,0.3);}sfxAt('swing',p.x,p.z);}
  else if(m.k==='launch'){if(m.id===me.id){vy=m.vy;grounded=false;jumping=false;sq.y=1.4;shake=Math.max(shake,0.4);sfx.jump();}ringFx(p.x,p.y+0.2,p.z,2.4,col);burst(p.x,p.y+0.5,p.z,col,16,6);sfxAt('hit',p.x,p.z);}
  else if(m.k==='spin'){startSpin(m.id,m.dur,m.r,col);burst(p.x,p.y+1,p.z,col,10,4);sfxAt('swing',p.x,p.z);if(m.id===me.id)attackT=Math.max(attackT,0.32);}
  else if(m.k==='meteor'){if(m.id===me.id){vy=36;grounded=false;jumping=false;sq.y=1.3;sfx.jump();const pp=cam.pitchT,fp=fpsPitch;if(fps)fpsPitch=-1.25;else cam.pitchT=1.1;setTimeout(()=>{if(fps)fpsPitch=fp;else cam.pitchT=pp;},2300);}burst(p.x,p.y+0.3,p.z,col,14,4);}
  else if(m.k==='face'){ringFx(m.tx,terrainH(m.tx,m.tz)+0.2,m.tz,2.2,col);burst(m.tx,terrainH(m.tx,m.tz)+1.2,m.tz,col,10,3);sfxAt('click',p.x,p.z);}
  else if(m.k==='hjump'){if(m.id===me.id){vy=m.pw;grounded=false;jumping=false;sq.y=1.35;hjT=1.4;shake=Math.max(shake,0.15);}
    ringFx(p.x,p.y+0.15,p.z,5,col);burst(p.x,p.y+0.3,p.z,col,14,5);
    for(let i=0;i<16;i++){const a=Math.random()*6.28,r=Math.random()*1.2;emit(p.x+Math.cos(a)*r,p.y+0.2,p.z+Math.sin(a)*r,0,5+Math.random()*5,0,0.7,0.5,col,0,0.8,0.6);}
    sfxAt('hjump',p.x,p.z);}
  else if(m.k==='blink'){
    const g0=terrainH(m.x0,m.z0),g1=terrainH(m.x1,m.z1);
    ringFx(m.x0,g0+0.2,m.z0,3,col);ringFx(m.x1,g1+0.2,m.z1,4.5,col);
    burst(m.x0,g0+1,m.z0,col,16,5);burst(m.x1,g1+1,m.z1,col,20,6);
    for(let i=0;i<=18;i++){const t=i/18;emit(m.x0+(m.x1-m.x0)*t,g0+(g1-g0)*t+1,m.z0+(m.z1-m.z0)*t,0,0.6,0,0.35+0.5*t,1.1,col,0,0.8,0.8);}   /* bayangan di sepanjang lintasan */
    sfxAt('blink',m.x0,m.z0);sfxAt('blink',m.x1,m.z1);}
  else if(m.k==='leap'){if(m.id===me.id){vy=15.5;grounded=false;jumping=false;kb.x+=m.fx*9;kb.z+=m.fz*9;sq.y=1.3;sfx.jump();}burst(p.x,p.y+0.3,p.z,col,12,4);}
  else if(m.k==='regen'){if(m.id===me.id)myRegenT=m.dur;else{const o=others.get(m.id);if(o)o.regenT=m.dur;}sfxAt('regen',p.x,p.z);}
  else if(m.k==='haste'){if(m.id===me.id){hasteT=m.dur;hastePw=m.pw;}else{const o=others.get(m.id);if(o)o.hasteT=m.dur;}burst(p.x,p.y+0.8,p.z,col,10,3);sfxAt('haste',p.x,p.z);}
  else if(m.k==='dash'){
    if(m.id===me.id){kb.x+=m.fx*m.pw;kb.z+=m.fz*m.pw;invuln=Math.max(invuln,0.35);}
    for(let i=0;i<10;i++)emit(p.x-m.fx*i*0.35,p.y+0.9,p.z-m.fz*i*0.35,0,0.2,0,0.5,0.7,col,0,0.8,0.5);
    sfxAt('dash',p.x,p.z);}
}
function onClash(m){
  const va=entPos(m.a),vb=entPos(m.b);if(!va||!vb)return;
  const mx=(va.x+vb.x)/2,my=(va.y+vb.y)/2+1.2,mz=(va.z+vb.z)/2;
  floatText(mx,my+0.6,mz,'BENTROK!','#ffffff');burst(mx,my,mz,'#fff6a0',14,5);sfxAt('clash',mx,mz);
  if(m.a===me.id||m.b===me.id){const k=m.a===me.id?[m.ax,m.az]:[m.bx,m.bz];kb.x+=k[0];kb.z+=k[1];if(grounded&&!swimNow){vy=Math.max(vy,3.5);grounded=false;}shake=Math.max(shake,0.3);attackT=0;}
}
function onHit(m){
  const v=entPos(m.id);if(!v)return;
  if(m.mnt){floatText(v.x,v.y+2.3,v.z,'-'+m.dmg,'#ffb84d');burst(v.x,v.y+0.6,v.z,'#ffe0b0',8,3);sfxAt('hit',v.x,v.z);if(m.id===me.id){hurtFlash=0.15;shake=Math.max(shake,0.15);toast('Elangmu diserang! Sisa '+m.mhp,1.2);}return;}
  if(m.inv){floatText(v.x,v.y+2.1,v.z,'KEBAL','#c9d6ff');sfxAt('block',v.x,v.z);return;}
  if(m.blk){floatText(v.x,v.y+2.1,v.z,'TAHAN!','#9fe3ff');burst(v.x,v.y+1,v.z,'#bfe9ff',8,4);sfxAt('block',v.x,v.z);if(m.id===me.id){guardMax=m.gmax||guardMax;guardPips=m.left;guardPipT=9;shake=Math.max(shake,0.12);}return;}
  floatText(v.x,v.y+2.1,v.z,'-'+m.dmg,m.id===me.id?'#ff6a6a':'#ffd84d');
  showHitbox(m.id===me.id?pos:others.get(m.id),0.9,m.hr||0);
  burst(v.x,v.y+1,v.z,'#fff6a0',6,3);
  if(m.id===me.id){
    setHp(m.hp);hurtFlash=0.25;shake=Math.max(shake,0.35);sfx.hurt();$('hurt').style.opacity=1;setTimeout(()=>{$('hurt').style.opacity=0;},120);
    if(m.kx||m.kz){kb.x+=m.kx;kb.z+=m.kz;if(grounded&&!swimNow){vy=Math.max(vy,4);grounded=false;}}
    if(attackT>0&&m.dmg>0)attackT=0;
  }else{const o=others.get(m.id);if(o){o.hp=m.hp;o.flash=0.18;drawLabel(o);if(m.kx||m.kz){o.x+=m.kx*0.05;o.z+=m.kz*0.05;}}sfxAt('hit',v.x,v.z);if(m.by===me.id){shake=Math.max(shake,0.2);burst(v.x,v.y+1.1,v.z,'#ffffff',8,4);}}
}
function onDie(m){
  feed(m.name+(m.by&&m.by!==m.id?' dikalahkan '+m.byName:' kalah sendiri'));
  if(m.by===me.id&&m.id!==me.id)sfx.kill();
  if(m.id===me.id){dead=true;deadT=m.ms/1000;$('ko').style.display=(SET.bigText||roomMode!=='duel')?'flex':'none';$('koTxt').textContent=m.by&&m.by!==m.id?'Dikalahkan oleh '+m.byName:'Kamu kalah';sfx.ko();attackT=0;rideT=0;if(sleeping){sleeping=false;$('night').style.opacity=0;}setHp(0);}
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
  const vv=window.visualViewport,w=Math.round((vv&&vv.width)||innerWidth),h=Math.round((vv&&vv.height)||innerHeight);
  document.documentElement.style.setProperty('--vh',h+'px');
  renderer.setSize(w,h,false);camera.aspect=w/h;
  cam.baseFov=w/h<1.3?Math.min(78,50+(1.3-w/h)*34):50;camera.updateProjectionMatrix();
}
window.addEventListener('resize',resize);window.addEventListener('orientationchange',()=>{resize();setTimeout(resize,250);setTimeout(resize,700);});
if(window.visualViewport)window.visualViewport.addEventListener('resize',resize);
/* iOS: cegah scroll/zoom/pantul halaman */
(function(){
  const ok=t=>t&&t.closest&&t.closest('#start,#pickBox,#chatList,#book,#setBox,#modal,#chatPanel,input,textarea');
  document.addEventListener('touchmove',e=>{if(!ok(e.target)||e.touches.length>1)e.preventDefault();window.scrollTo(0,0);},{passive:false});
  ['gesturestart','gesturechange','gestureend'].forEach(t=>document.addEventListener(t,e=>e.preventDefault()));
  window.addEventListener('scroll',()=>window.scrollTo(0,0));
})();
resize();

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
const caveBg=new THREE.Color(0x0a0c18),arenaBg=new THREE.Color(0x0e1838);
const winDay=new THREE.Color(0xa9dcf5),winNight=new THREE.Color(0xffd27a),uwBg=new THREE.Color(0x14507f);
let skyT=0,gameHour=9,underwater=false;
function applyEnv(dt){
  if(inArena){scene.background=arenaBg;scene.fog.color.copy(arenaBg);scene.fog.near=90;scene.fog.far=300;hemi.color.setHex(0xc8d8ff);hemi.groundColor.setHex(0x3c3a52);hemi.intensity=0.95;sun.color.setHex(0xfff2d8);sun.intensity=0.85;sun.position.set(30,90,20);stars.visible=true;stars.material.opacity=0.9;sunSp.visible=moonSp.visible=false;return;}
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
  const ox=inArena?ARENA.x:inCave?CX:0,oz=inArena?ARENA.z:inCave?CZ:0,sc=(H-4)/(inArena?ARENA.ringR+ARENA.standR+2:inCave?CAVE_R:140),mx=x=>H+(x-ox)*sc,mz=z=>H+(z-oz)*sc;
  const dot=(x,y,r,col)=>{c.fillStyle=col;c.beginPath();c.arc(x,y,r,0,6.2832);c.fill();};
  if(inArena){
    c.fillStyle='#232a44';c.fillRect(0,0,S,S);dot(mx(ARENA.x),mz(ARENA.z),(ARENA.ringR+ARENA.standR)*sc,'#3a3f5c');dot(mx(ARENA.x),mz(ARENA.z),ARENA.ringR*sc,'#cdb47c');
  }else if(inCave){
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
const SPEED_WALK=TUNING.walk,SPEED_RUN=TUNING.run,GRAV=30,JUMPV=TUNING.jump; /* lompat 2x lebih tinggi (v^2 x2) */
function canMove(nx,nz,step,swim){
  const g=groundAt(nx,nz,pos.y);const rise=g-pos.y;
  const maxRise=swim?1.6:(grounded?0.9*step+0.03:0.45);
  return rise<=maxRise;
}
function resolve(){
  if(roomMode==='duel'&&duel&&(duel.st==='fight'||duel.st==='count')&&duelMine()){const dx=pos.x-ARENA.x,dz=pos.z-ARENA.z,d=Math.hypot(dx,dz),lim=ARENA.ringR-0.7;if(d>lim){pos.x=ARENA.x+dx/d*lim;pos.z=ARENA.z+dz/d*lim;}if(pos.y>ARENA.h-1.2){pos.y=ARENA.h-1.2;if(vy>0)vy=0;}}
  for(const c of circles){if(c.top!==undefined&&pos.y>=c.top-0.35)continue;const dx=pos.x-c.x,dz=pos.z-c.z,rr=c.r+PR,d2=dx*dx+dz*dz;if(d2<rr*rr){const d=Math.sqrt(d2)||0.001;pos.x=c.x+dx/d*rr;pos.z=c.z+dz/d*rr;}}
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
/* ---------- efek layar saat mode FPS (karakter tidak terlihat, jadi status ditampilkan di layar) ---------- */
const fxCache={};
function updFxScr(){
  const on=started&&fps&&!dead;
  const want={fxIce:on&&stunT>0,fxShield:on&&myShieldT>0,fxHaste:on&&hasteT>0,fxRegen:on&&myRegenT>0,fxGuard:on&&guarding&&gbT<=0,fxBreak:on&&gbT>0,fxRide:on&&rideT>0};
  for(const id in want){
    const v=want[id];if(fxCache[id]===v)continue;fxCache[id]=v;
    const el=$(id);el.style.transitionDuration=v?'.15s':'.6s';el.style.opacity=v?1:0;
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
  if(intro)updIntro(dt);
  updUiHide();
  updHitboxes(dt);
  updPhysics();
  gameHour=(hourBase+(performance.now()-hourAt)/1000*0.04)%24;
  inCave=pos.x>1000;inArena=pos.x>4000;
  const fwd={x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)},rgt={x:Math.cos(cam.yaw),z:-Math.sin(cam.yaw)};
  const live=started&&!dead&&!modalOpen&&!bookOpen&&!chatOpen&&stunT<=0&&!fade&&!intro;
  let ix=0,iy=0,run=false,diveHeld=diveBtnHeld;
  if(live){
    if(keys.has('KeyA')||keys.has('ArrowLeft'))ix-=1;if(keys.has('KeyD')||keys.has('ArrowRight'))ix+=1;
    if(keys.has('KeyW')||keys.has('ArrowUp'))iy+=1;if(keys.has('KeyS')||keys.has('ArrowDown'))iy-=1;
    {const sn=SET.sens>0?SET.sens:1;if(keys.has('KeyQ'))cam.yawT+=1.9*dt*sn;if(keys.has('KeyR'))cam.yawT-=1.9*dt*sn;}
    run=keys.has('ShiftLeft')||keys.has('ShiftRight');
    if(keys.has('KeyV')||keys.has('ControlLeft')||keys.has('KeyZ'))diveHeld=true;
    if(joy.id!==null){ix+=joy.x;iy+=joy.y;}
  }
  let mag=Math.hypot(ix,iy);if(mag>1){ix/=mag;iy/=mag;mag=1;}
  if(SET.joyFull&&joy.id!==null&&mag>0.02){ix/=mag;iy/=mag;mag=1;}   /* analog: digeser sedikit pun arahnya dinormalkan, jadi kecepatan penuh */
  if(!live)jumpBuf=0;
  if(sleeping&&(mag>0.3||jumpBuf>0)){wakeUp();jumpBuf=0;}
  const riding=rideT>0&&!dead;
  const wd=waterDepthAt(pos.x,pos.z);
  let swim=wd>0.5&&pos.y<WATER_Y-0.1&&!dead&&!riding;
  const jumpHeld=live&&(keys.has('Space')||jumpBtnHeld);
  if(swim&&jumpBuf>0&&pos.y>SURF_Y-0.45){vy=JUMPV*trainJump*0.82;jumpBuf=0;jumping=true;swim=false;grounded=false;sfx.jump();}
  swimNow=swim;
  if(swim&&!wasSwim){sfx.splash();for(let i=0;i<14;i++)emit(pos.x,WATER_Y+0.1,pos.z,(Math.random()-0.5)*4,2+Math.random()*3,(Math.random()-0.5)*4,0.7,0.45,'#cfeeff',8,0.9,0.3);}
  if(!swim&&wasSwim&&vy>0){}
  wasSwim=swim;
  let speed;
  if(joy.id!==null&&mag>0.02)speed=(mag>=0.9||SET.joyFull)?SPEED_RUN:SPEED_WALK*mag/0.9;
  else speed=run?SPEED_RUN:SPEED_WALK;
  if(swim)speed*=0.55;
  if(hasteT>0)speed*=hastePw;
  speed*=trainSpd;
  if(riding)speed=(joy.id!==null&&mag>0.02&&!SET.joyFull?ridePw*Math.min(1,mag/0.9):ridePw);
  if(attackT>0)speed*=0.55;
  if(!live||sleeping)speed=0;
  if(mag>0.1){const mx=rgt.x*ix+fwd.x*iy,mz=rgt.z*ix+fwd.z*iy,ml=Math.hypot(mx,mz)||1;moveDirX=mx/ml;moveDirZ=mz/ml;moveDirT=tAll;}
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
    if(jumpBuf>0&&coyote>0&&live){vy=JUMPV*trainJump;grounded=false;coyote=0;jumpBuf=0;jumping=true;sq.y=1.28;sq.v=0;sfx.jump();dust(6,2.2,0.6);}
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
    if(inArena){const ddx=pos.x-ARENA.x,ddz=pos.z-ARENA.z,r0=Math.hypot(ddx,ddz),lim=ARENA.ringR+ARENA.standR-0.8;if(r0>lim){const k0=lim/r0;pos.x=ARENA.x+ddx*k0;pos.z=ARENA.z+ddz*k0;}if(pos.y>ARENA.h-1.2)pos.y=ARENA.h-1.2;}
    else if(inCave){const ddx=pos.x-CX,ddz=pos.z-CZ,r0=Math.hypot(ddx,ddz);if(r0>CAVE_R-1.2){const k0=(CAVE_R-1.2)/r0;pos.x=CX+ddx*k0;pos.z=CZ+ddz*k0;}if(pos.y>12)pos.y=12;}
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
    const solid=fps&&started;const rt=solid?1:(h===insideHouse?0:(occ?0.18:1)),wt=solid?1:((occ||h===insideHouse)?0.3:1);
    h.roofOp+=(rt-h.roofOp)*damp(9,dt);h.wallOp+=(wt-h.wallOp)*damp(9,dt);
    const vis=h.roofOp>0.03;h.roofParts.forEach(m=>m.visible=vis);
    h.roofMats.forEach(m=>{m.opacity=h.roofOp;m.transparent=h.roofOp<0.99;});
    h.wallMats.forEach(m=>{m.opacity=h.wallOp;m.transparent=h.wallOp<0.99;m.depthWrite=h.wallOp>0.99;});
  }

  atkCool=Math.max(0,atkCool-dt);comboT=Math.max(0,comboT-dt);invuln=Math.max(0,invuln-dt);hurtFlash=Math.max(0,hurtFlash-dt);shake=Math.max(0,shake-dt*2);
  if(myShieldT>0)myShieldT-=dt;
  if(rideT>0)rideT-=dt;
  if(stunT>0){stunT-=dt;if(Math.random()<dt*10)emit(pos.x+Math.cos(tAll*8)*0.5,pos.y+2.0,pos.z+Math.sin(tAll*8)*0.5,0,0,0,0.5,0.3,'#fff6a0',0,1,0);}
  if(gbT>0)gbT-=dt;
  updFxScr();
  if(hasteT>0&&Math.random()<dt*9)emit(pos.x,pos.y+0.8,pos.z,-faceX*2,0.3,-faceZ*2,0.4,0.6,'#fff27a',0,0.8,0.5);
  if(hasteT>0)hasteT-=dt;
  if(myRegenT>0){myRegenT-=dt;if(Math.random()<dt*9)emit(pos.x+(Math.random()-0.5)*1.2,pos.y+0.3,pos.z+(Math.random()-0.5)*1.2,0,1.4,0,0.9,0.4,'#7dffae',0,0.9,0.2);}
  if(guardPipT>0){guardPipT-=dt;if(guardPipT<=0)guardPips=guardMax;}
  if(guarding&&(!live||gbT>0||swim||riding))setGuard(false);
  if(guardLatch){
    if(!live||gbT>0||swim||riding||stunT>0||sleeping||modalOpen||bookOpen)guardLatch=false;
    else if(!guarding){if(attackT<=0&&atkCool<=0){guardResume-=dt;if(guardResume<=0)setGuard(true);}}
  }
  kb.x*=Math.exp(-9*dt);kb.z*=Math.exp(-9*dt);
  if(attackT>0)attackT-=dt;
  if(dead){deadT-=dt;$('koTxt').dataset.t=Math.max(0,Math.ceil(deadT));}
  /* slot cooldown ui */
  for(let i=0;i<5;i++){
    document.querySelector('.slot[data-i="'+i+'"]').classList.toggle('avail',!!slots[i]&&slotCd[i]<=0);
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
  {const mo=emoTick(meEmo,pos.x,pos.y,pos.z,3.3,dead||sleeping||attackT>0||sp>0.9||riding,fps);spriteMesh.rotation.z=mo?mo.rz:0;spriteMesh.position.set(mo?rgt.x*mo.dx:0,mo?mo.dy:0,mo?rgt.z*mo.dx:0);if(mo)spriteMesh.scale.y*=mo.sy;}
  playerRoot.position.copy(pos);
  {const fv=$('fpsView'),on=fps&&started&&!dead&&!sleeping&&aiming<0;
    if(fv.classList.contains('show')!==on)fv.classList.toggle('show',on);
    if(on){
      if(fvCh!==me.ch){fvCh=me.ch;buildFpsArms();}
      const mv=clamp(sp/7,0,1),bw=Math.sin(walkT*Math.PI)*mv,bx=Math.cos(walkT*Math.PI*0.5)*mv;
      const pk=attackT>0?Math.sin((1-attackT/0.32)*Math.PI):0,side=atkSide?1:-1;
            $('fpsR').style.transform='translate('+(bx*10-pk*side*90)+'px,'+(Math.abs(bw)*12-pk*40)+'px) rotate('+(pk*side*38)+'deg)';
    }}
  if(swim)playerRoot.position.y+=Math.sin(tAll*3)*0.05;
  ghost.visible=!riding;
  if(riding){if(!myMount)myMount=mountMake();myMount.mesh.visible=!fps;mountPlace(myMount,pos.x,pos.y,pos.z,faceX,faceZ,rgt,fwd,0);playerRoot.position.x+=myMount.off.x;playerRoot.position.y+=myMount.off.y;playerRoot.position.z+=myMount.off.z;}else if(myMount)myMount.mesh.visible=false;
  const hAbove=pos.y-terrainBelow();
  pShadow.position.set(pos.x,Math.max(groundAt(pos.x,pos.z,pos.y-0.5)+0.07,swim?WATER_Y+0.03:-999),pos.z);
  const sc=clamp(1-hAbove*0.12,0.35,1);pShadow.scale.setScalar(sc*1.25);pShadow.material.opacity=clamp(1-hAbove*0.1,0.35,1);
  updVoice();
  myShield.visible=myShieldT>0&&!dead;if(myShield.visible){myShield.position.set(pos.x,pos.y+0.95,pos.z);const s2=3.2+Math.sin(tAll*8)*0.15;myShield.scale.set(s2,s2,1);}

  if(guarding&&!dead){if(!myGuardSp)myGuardSp=makeShield3D(me.ch);myGuardSp.visible=true;placeShield(myGuardSp,pos.x,pos.y,pos.z,faceX,faceZ,tAll);}else if(myGuardSp)myGuardSp.visible=false;
  if(AC&&!muted&&started){
    ambT-=dt;
    if(ambT<=0){
      ambT=rnd(2.5,6);const nf=envC.nf;
      if(inCave&&!inArena){pick([()=>sfx.drip(),()=>sfx.drip(),()=>sfx.bat(),()=>sfx.wind()])();}
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
  updOthers(dt,rgt,fwd);updMobs(dt,rgt,fwd);updTraps(dt);updBeams(dt);updSols(dt,rgt,fwd);updOrbs(dt);updSlashes(dt);updSpins(dt);updCWalls(dt);updWalls(dt);updForts(dt);updCamps(dt);updAim();
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
  {const gl=gbT>0?'Pecah':(guardPips<guardMax?guardPips+'/'+guardMax:'Tahan');if(gl!==guardLbl){guardLbl=gl;$('btnGuard').querySelector('small').textContent=gl;}$('btnGuard').classList.toggle('broken',gbT>0);}
  if(toastT>0&&performance.now()>=toastT){toastT=0;$('toast').classList.remove('show');}
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
  if(inArena){const ddx=cx-ARENA.x,ddz=cz-ARENA.z,r0=Math.hypot(ddx,ddz),lim=ARENA.ringR+ARENA.standR+1.5;if(r0>lim){const k0=lim/r0;cx=ARENA.x+ddx*k0;cz=ARENA.z+ddz*k0;}cy=clamp(cy,1.5,ARENA.h-1.5);}
  else if(inCave){const ddx=cx-CX,ddz=cz-CZ,r0=Math.hypot(ddx,ddz);if(r0>CAVE_R-2){const k0=(CAVE_R-2)/r0;cx=CX+ddx*k0;cz=CZ+ddz*k0;}cy=clamp(cy,1.5,13);}
  if(!started){/* menu orbit above the village */cx=Math.sin(cam.yaw)*38;cz=Math.cos(cam.yaw)*38+10;cy=terrainH(cx,cz)+16;}
  camera.position.set(cx,cy,cz);camera.lookAt(started?cam.tx:0,started?cam.ty+1.0:2,started?cam.tz:0);
  if(fps&&started){const ey=pos.y+(swim?0.9:1.6)+(riding?0.8:0)+introBob,cp=Math.cos(fpsPitch);camera.position.set(pos.x,ey,pos.z);camera.lookAt(pos.x-Math.sin(cam.yaw)*cp,ey+Math.sin(fpsPitch),pos.z-Math.cos(cam.yaw)*cp);}
  if(shake>0&&SET.shake){camera.position.x+=(Math.random()-0.5)*shake*0.5;camera.position.y+=(Math.random()-0.5)*shake*0.5;}
  const fovGoal=(cam.baseFov||50)+(sp>8.5?6:0)+(fps?12:0);cam.fov+=(fovGoal-cam.fov)*damp(4,dt);
  if(Math.abs(camera.fov-cam.fov)>0.02){camera.fov=cam.fov;camera.updateProjectionMatrix();}
  underwater=camera.position.y<WATER_Y&&lakeDist(camera.position.x,camera.position.z)<LAKE.R+1;
  $('uw').style.opacity=underwater?1:0;
  applyEnv(dt);
}

/* ---------- loop ---------- */
let last=performance.now();


/* ---------- ARENA DUEL 1 vs 1 ---------- */
let duelSize=1,roomMode='world',arenaBuilt=false,duel=null,duelAt=0,duelPrevSt='';
function buildArena(){
  if(arenaBuilt)return;arenaBuilt=true;
  const g=new THREE.Group();g.position.set(ARENA.x,0,ARENA.z);scene.add(g);
  const R=ARENA.ringR;
  const cv=document.createElement('canvas');cv.width=cv.height=512;const c=cv.getContext('2d');
  const gr=c.createRadialGradient(256,256,20,256,256,256);gr.addColorStop(0,'#e6d3a3');gr.addColorStop(1,'#cdb47c');c.fillStyle=gr;c.fillRect(0,0,512,512);
  for(let i=0;i<1400;i++){c.fillStyle='rgba(120,90,40,'+(0.05+Math.random()*0.08)+')';c.fillRect(Math.random()*512,Math.random()*512,2,2);}
  c.strokeStyle='rgba(90,60,25,.7)';c.lineWidth=7;c.beginPath();c.arc(256,256,238,0,6.283);c.stroke();c.lineWidth=4;c.beginPath();c.arc(256,256,60,0,6.283);c.stroke();
  c.beginPath();c.moveTo(256-238,256);c.lineTo(256+238,256);c.stroke();
  c.fillStyle='rgba(60,120,255,.35)';c.beginPath();c.arc(256-(ARENA.side/R)*256,256,40,0,6.283);c.fill();
  c.fillStyle='rgba(255,70,70,.35)';c.beginPath();c.arc(256+(ARENA.side/R)*256,256,40,0,6.283);c.fill();
  const tex=new THREE.CanvasTexture(cv);
  const fl=new THREE.Mesh(new THREE.CircleGeometry(R,48).rotateX(-Math.PI/2),new THREE.MeshLambertMaterial({map:tex,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));fl.position.y=0.05;g.add(fl);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(R+0.2,0.35,6,48).rotateX(Math.PI/2),mat('#8e7650'));rim.position.y=0.15;g.add(rim);
  const wood=mat('#7a5233'),rope=mat('#d9c48a');
  const N=Math.round(2*Math.PI*(R+0.5)/1.45);
  for(let i=0;i<N;i++){
    const a=i/N*Math.PI*2,px=Math.cos(a)*(R+0.5),pz=Math.sin(a)*(R+0.5);
    const p=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.2,1.7,6),wood);p.position.set(px,0.85,pz);g.add(p);
    circles.push({x:ARENA.x+px,z:ARENA.z+pz,r:0.5});
  }
  [0.7,1.3].forEach(h=>{const t=new THREE.Mesh(new THREE.TorusGeometry(R+0.5,0.06,5,72).rotateX(Math.PI/2),rope);t.position.y=h;g.add(t);});
  /* obor di empat penjuru */
  [[1,1],[-1,1],[1,-1],[-1,-1]].forEach(([dx,dz],i)=>{
    const x=dx*(R+3.2)*0.707,z=dz*(R+3.2)*0.707;
    const post=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.3,3.2,8),mat('#5a4636'));post.position.set(x,1.6,z);g.add(post);
    const bowl=new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.3,0.4,8),mat('#3a3a44'));bowl.position.set(x,3.3,z);g.add(bowl);
    const fire=new THREE.Mesh(new THREE.ConeGeometry(0.42,1.1,7),new THREE.MeshBasicMaterial({color:0xff9a2a}));fire.position.set(x,4.0,z);g.add(fire);
    const inner=new THREE.Mesh(new THREE.ConeGeometry(0.22,0.7,6),new THREE.MeshBasicMaterial({color:0xffe28a}));inner.position.set(x,3.85,z);g.add(inner);
    circles.push({x:ARENA.x+x,z:ARENA.z+z,r:0.5});
    arenaFires.push(fire,inner);
  });
  /* dinding + langit-langit transparan (terlihat saat duel dimulai, lalu memudar) */
  {
    const wc=document.createElement('canvas');wc.width=256;wc.height=256;const w=wc.getContext('2d');
    const gr=w.createLinearGradient(0,0,0,256);gr.addColorStop(0,'rgba(120,200,255,.05)');gr.addColorStop(0.5,'rgba(120,200,255,.3)');gr.addColorStop(1,'rgba(160,230,255,.7)');w.fillStyle=gr;w.fillRect(0,0,256,256);
    w.strokeStyle='rgba(190,235,255,.85)';w.lineWidth=2;for(let i=0;i<=256;i+=32){w.beginPath();w.moveTo(i,0);w.lineTo(i,256);w.stroke();w.beginPath();w.moveTo(0,i);w.lineTo(256,i);w.stroke();}
    const wt=new THREE.CanvasTexture(wc);wt.wrapS=wt.wrapT=THREE.RepeatWrapping;wt.repeat.set(18,5);
    arenaWallMat=new THREE.MeshBasicMaterial({map:wt,color:0x7fd0ff,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending,fog:false});
    const wall=new THREE.Mesh(new THREE.CylinderGeometry(R+0.2,R+0.2,ARENA.h,64,1,true),arenaWallMat);wall.position.y=ARENA.h/2;wall.visible=false;g.add(wall);
    const cap=new THREE.Mesh(new THREE.CircleGeometry(R+0.2,48).rotateX(-Math.PI/2),arenaWallMat);cap.position.y=ARENA.h;cap.visible=false;g.add(cap);
    arenaWallParts=[wall,cap];
  }
  /* ---- stadion: lantai luar, tribun bertingkat, penonton, dinding luar, tiang lampu sorot ---- */
  {
    const SR=R+ARENA.standR+1,TIERS=6,TH=1.25,TD=2.3;
    const out=new THREE.Mesh(new THREE.CircleGeometry(SR+TIERS*TD+2,64).rotateX(-Math.PI/2),mat('#4a4d63'));out.position.y=0.01;g.add(out);
    const seatCols=['#b23b3b','#3b64b2','#d9c24a','#e6e6ee'];
    for(let k=0;k<TIERS;k++){
      const r0=SR+k*TD,y0=k*TH,col=seatCols[k%seatCols.length];
      const rise=new THREE.Mesh(new THREE.CylinderGeometry(r0,r0,TH,64,1,true),mat('#6b6e86',{side:THREE.DoubleSide}));rise.position.y=y0+TH/2;g.add(rise);
      const top=new THREE.Mesh(new THREE.RingGeometry(r0,r0+TD,64).rotateX(-Math.PI/2),mat(col,{side:THREE.DoubleSide}));top.position.y=y0+TH;g.add(top);
    }
    const WR=SR+TIERS*TD,WH=(TIERS*TH+7)*3;
    const owall=new THREE.Mesh(new THREE.CylinderGeometry(WR,WR,WH,64,1,true),mat('#2e3150',{side:THREE.DoubleSide}));owall.position.y=WH/2;g.add(owall);
    const crown=new THREE.Mesh(new THREE.TorusGeometry(WR,0.5,6,64).rotateX(Math.PI/2),mat('#ffd84d'));crown.position.y=WH;g.add(crown);
    /* penonton: titik warna di tiap tingkat */
    {
      const N=2600,pa=new Float32Array(N*3),pc=new Float32Array(N*3),pal=['#ff6a6a','#6aa8ff','#ffe066','#9dffb0','#ffffff','#ff9ad5'];const cc=new THREE.Color();
      for(let i=0;i<N;i++){const k=Math.floor(Math.random()*TIERS),a=Math.random()*6.2832,r=SR+k*TD+0.3+Math.random()*(TD-0.6);pa[i*3]=Math.cos(a)*r;pa[i*3+1]=(k+1)*TH+0.45+Math.random()*0.25;pa[i*3+2]=Math.sin(a)*r;cc.set(pal[Math.floor(Math.random()*pal.length)]);pc[i*3]=cc.r;pc[i*3+1]=cc.g;pc[i*3+2]=cc.b;}
      const pg=new THREE.BufferGeometry();pg.setAttribute('position',new THREE.BufferAttribute(pa,3));pg.setAttribute('color',new THREE.BufferAttribute(pc,3));
      const crowd=new THREE.Points(pg,new THREE.PointsMaterial({size:5,sizeAttenuation:false,vertexColors:true}));crowd.frustumCulled=false;g.add(crowd);
    }
    /* tiang lampu sorot di enam penjuru */
    for(let i=0;i<6;i++){
      const a=i/6*6.2832+0.5,x=Math.cos(a)*(WR+1.2),z=Math.sin(a)*(WR+1.2);
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.55,WH+9,8),mat('#3a3d52'));pole.position.set(x,(WH+9)/2,z);g.add(pole);
      const head=new THREE.Mesh(new THREE.BoxGeometry(4,1.6,1.2),new THREE.MeshBasicMaterial({color:0xfff6d0}));head.position.set(x,WH+9,z);head.rotation.y=-a+Math.PI/2;g.add(head);
      const gl=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTex,color:0xfff0b0,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,opacity:0.8,fog:false}));gl.scale.set(18,18,1);gl.position.set(x,WH+9,z);g.add(gl);
    }
    /* spanduk biru dan merah di sisi petarung */
    [[-1,'#3b64ff'],[1,'#ff4d4d']].forEach(([sx,col])=>{const b=new THREE.Mesh(new THREE.PlaneGeometry(8,4),new THREE.MeshBasicMaterial({color:col,side:THREE.DoubleSide}));b.position.set(sx*(SR+TIERS*TD-0.5),TIERS*TH+3,0);b.rotation.y=Math.PI/2;g.add(b);});
  }
  /* papan nama */
  const lc=document.createElement('canvas');lc.width=512;lc.height=128;const lx=lc.getContext('2d');
  lx.fillStyle='rgba(8,14,34,.85)';lx.fillRect(0,0,512,128);lx.strokeStyle='#6cd4ff';lx.lineWidth=6;lx.strokeRect(6,6,500,116);
  lx.fillStyle='#ffffff';lx.font='800 54px Poppins,sans-serif';lx.textAlign='center';lx.textBaseline='middle';lx.fillText('ARENA '+duelSize+' vs '+duelSize,256,50);
  lx.fillStyle='#ffd84d';lx.font='600 26px Poppins,sans-serif';lx.fillText(duelSize>1?'Tim menang lanjut, kalah antri':'Menang lanjut, kalah antri',256,96);
  const sign=new THREE.Mesh(new THREE.PlaneGeometry(6,1.5),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(lc),side:THREE.DoubleSide}));sign.position.set(0,5.2,-(R+3.2));g.add(sign);
  const sp1=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,5,6),wood),sp2=sp1.clone();sp1.position.set(-2.8,2.5,-(R+3.2));sp2.position.set(2.8,2.5,-(R+3.2));g.add(sp1,sp2);
}
let arenaWallMat=null,arenaWallParts=[],wallA=0,wallPulse=0,fightAt=0;
const arenaFires=[];
function updArena(dt){
  if(arenaWallMat){
    const sinceFight=(performance.now()-fightAt)/1000;
    let tgt=0;
    if(duel&&duel.st==='count')tgt=0.4;
    else if(duel&&duel.st==='fight'&&sinceFight<1.6)tgt=0.4*Math.max(0,1-sinceFight/1.6);
    wallPulse=Math.max(0,wallPulse-dt*2.2);
    const goal=SET.arenaWall?Math.max(tgt,wallPulse*0.5):0;
    wallA+=(goal-wallA)*Math.min(1,dt*(goal>wallA?8:3));
    arenaWallMat.opacity=wallA;arenaWallParts.forEach(m=>m.visible=wallA>0.012);
  }
  if(!arenaFires.length)return;arenaFires.forEach((f,i)=>{f.scale.y=1+0.18*Math.sin(tAll*11+i*1.7);f.scale.x=f.scale.z=1+0.08*Math.sin(tAll*9+i);});}
/* teman satu tim (arena tim): bar HP hijau */
function isMate(id){if(!duel||!id||id===me.id)return false;const mt=duelMine();if(!mt)return false;const l=mt===1?duel.ta:duel.tb;return !!(l&&l.some(x=>x.id===id));}
function refreshMates(){others.forEach(o=>{const f=isMate(o.id);if(o.friend!==f){o.friend=f;drawLabel(o);}});mobs.forEach(m=>{const f=m.o===me.id||isMate(m.o);if(m.friend!==f){m.friend=f;drawMobLabel(m);}});}
function duelMine(){if(!duel)return 0;const f=l=>(l||[]).some(x=>x.id===me.id&&!x.o);if(f(duel.ta))return 1;if(f(duel.tb))return 2;return 0;}
function duelCanFight(){return roomMode!=='duel'||(duel&&duel.st==='fight'&&duelMine()>0);}
let duelWarnT=0;
function duelBlock(){
  if(duelCanFight())return false;
  if(tAll-duelWarnT>1.5){duelWarnT=tAll;toast(duelMine()?'Tunggu hitungan mundur selesai':'Kamu penonton. Tunggu giliranmu masuk ring',1.6);}
  return true;
}
function renderDuelBox(){
  const el=$('duelBox');if(!duel||roomMode!=='duel'){el.innerHTML='';return;}
  const nm=p=>p?esc(p.name)+(p.w>0?' <span class="w">'+p.w+'x menang</span>':''):'?';
  const side=l=>(l&&l.length?l.map(x=>nm(x)+(x.o?' (kalah)':'')).join(' &amp; '):'?');
  let h='<div class="vs"><span>'+side(duel.ta)+'</span><i>VS</i><span>'+side(duel.tb)+'</span></div>';
  const mine=duelMine();let q='';
  if(mine)q='<span class="me">Kamu bertarung!</span>';
  else{const i=duel.q.findIndex(x=>x.id===me.id);q=i>=0?'Antrianmu: <b>#'+(i+1)+'</b>':'';}
  const names=duel.q.slice(0,5).map((x,i)=>(i+1)+'. '+esc(x.name)).join(' · ')+(duel.q.length>5?' +'+(duel.q.length-5):'');
  if(duel.top&&duel.top.length)h+='<div><span class="q">Juara: '+duel.top.map(x=>esc(x.name)+' '+x.n+'x'+(x.best>1?' (terbaik '+x.best+' beruntun)':'')).join(' · ')+'</span></div>';
  h+='<div><span class="q">'+(names?'Antri: '+names:'Tidak ada antrian')+(q?' · '+q:'')+'</span></div>';
  el.innerHTML=h;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function onDuel(m){
  duel=m;duelAt=performance.now();refreshMates();
  const prev=duelPrevSt;duelPrevSt=m.st;
  renderDuelBox();
  if(m.st==='count'&&prev!=='count'){sfx.horn&&sfx.horn();}
  if(m.st==='fight'&&prev==='count'){sfx.fanfare&&sfx.fanfare();duelBig('FIGHT!','',900);}
  if(m.st==='fight'&&prev!=='fight'){fightAt=performance.now();if(duelMine())netTrackStart();else netTrk=null;}
  if(m.st!=='fight'&&prev==='fight')netTrackFinish();
  if(m.st==='fight'&&(m.ph||0)!==duelPh){
    const np=m.ph||0;
    if(np===1){sfx.horn&&sfx.horn();duelBig('SUDDEN DEATH','Sekali kena langsung K.O.!',3000);}
    else if(np===2){sfx.horn&&sfx.horn();duelBig('DARAH TERKURAS','Darah semua petarung habis cepat',3000);}
  }
  duelPh=m.st==='fight'?(m.ph||0):0;
  if(m.st==='over'&&m.last){duelBig(m.last.win+' menang!',m.last.w>1?m.last.w+'x beruntun':'',2600);if(m.last.names&&m.last.names.indexOf(me.name)>=0)sfx.fanfare&&sfx.fanfare();}
}
/* ---------- catatan jaringan saat bertarung di ring ---------- */
const NET_STALL_MS=600;   /* tidak ada pesan dari server selama ini = jaringan nyandet */
let netTrk=null,netMsgT=0,netRepTimer=0;
function netTrackStart(){netTrk={t0:performance.now(),pings:[],stalls:[],hid:0};netMsgT=performance.now();}
function netTrackMsg(){
  const n=performance.now();
  if(netTrk){
    const gap=n-netMsgT;
    if(netMsgT&&gap>NET_STALL_MS&&document.visibilityState==='visible')netTrk.stalls.push(gap);
  }
  netMsgT=n;
}
function netTrackPing(r){if(netTrk)netTrk.pings.push(r);}
function netTrackFinish(){
  const k=netTrk;netTrk=null;if(!k)return;
  const dur=(performance.now()-k.t0)/1000,pg=k.pings;
  const avg=pg.length?pg.reduce((a,b)=>a+b,0)/pg.length:-1,mn=pg.length?Math.min.apply(null,pg):-1,mx=pg.length?Math.max.apply(null,pg):-1;
  const sc=k.stalls.length,longest=sc?Math.max.apply(null,k.stalls)/1000:0,total=k.stalls.reduce((a,b)=>a+b,0)/1000;
  let q=0;   /* 0 baik, 1 cukup, 2 buruk */
  if(avg>=120||sc>=1||mx>=300)q=1;
  if(avg>=220||sc>=2||longest>=1.5||mx>=600)q=2;
  showNetRep(q,{dur,avg,mn,mx,sc,longest,total});
}
function showNetRep(q,d){
  const el=$('netRep');if(!el)return;
  const names=['BAIK','CUKUP','BURUK'],cols=['#4de27a','#ffd84d','#ff6a6a'];
  const tips=['Koneksimu lancar selama bertarung.','Ada sedikit gangguan. Serangan bisa terasa terlambat sesekali.','Jaringanmu buruk. Serangan dan gerakan bisa tertunda atau meleset. Coba pindah ke sinyal lebih baik.'];
  el.style.setProperty('--nc',cols[q]);
  $('netQ').textContent=names[q];
  const f=v=>v<0?'-':Math.round(v)+' ms';
  $('netL').innerHTML=
    'Lama bertarung: <b>'+Math.round(d.dur)+' dtk</b><br>'+
    'Ping rata-rata: <b>'+f(d.avg)+'</b> (terendah '+f(d.mn)+', tertinggi '+f(d.mx)+')<br>'+
    'Nyandet: <b>'+(d.sc?d.sc+' kali, terlama '+d.longest.toFixed(1)+' dtk':'tidak ada')+'</b><br>'+
    '<span style="color:#9fb4dd">'+tips[q]+'</span>';
  /* ulang animasi bar 5 detik */
  el.classList.remove('show');void el.offsetWidth;el.classList.add('show');
  clearTimeout(netRepTimer);netRepTimer=setTimeout(hideNetRep,5000);
}
function hideNetRep(){clearTimeout(netRepTimer);netRepTimer=0;const el=$('netRep');if(el)el.classList.remove('show');}
$('netRep').addEventListener('click',hideNetRep);
$('netRep').addEventListener('pointerdown',e=>e.stopPropagation());
let duelBigT=0;
function duelBig(t,sub,ms){const el=$('duelBig');if(!SET.bigText)return;el.innerHTML='<b style="'+(t.length>8?'font-size:min(11vw,64px)':'')+'">'+esc(t)+'</b>'+(sub?'<small>'+esc(sub)+'</small>':'');el.classList.add('show');duelBigT=performance.now()+ms;}
function updDuel(){
  if(roomMode!=='duel')return;
  const now=performance.now();
  if(duelBigT&&now>duelBigT){$('duelBig').classList.remove('show');duelBigT=0;}
  if(duel&&duel.st==='count'){
    const rem=Math.max(0,duel.ms-(now-duelAt)),n=Math.ceil(rem/1000);
    if(n>0&&n!==duelCntN){duelCntN=n;sfx.click&&sfx.click();}
    if(SET.bigText){$('duelBig').innerHTML='<b>'+n+'</b><small>Bersiap...</small>';$('duelBig').classList.add('show');duelBigT=now+400;}else $('duelBig').classList.remove('show');
  }else duelCntN=0;
  const tm=$('duelTimer');
  if(duel&&duel.st==='fight'){
    const ph=duel.ph||0,rem=Math.max(0,(duel.tl||0)-(now-duelAt)),sec=Math.ceil(rem/1000),mm=Math.floor(sec/60),ss=String(sec%60).padStart(2,'0');
    const txt=ph===0?'Sisa waktu '+mm+':'+ss:(ph===1?'SUDDEN DEATH '+mm+':'+ss:'DARAH TERKURAS');
    if(tm.textContent!==txt)tm.textContent=txt;
    tm.className='hud show'+(ph===1?' sd':(ph===2?' dr':''));
  }else if(tm.className!=='hud')tm.className='hud';
}
let duelCntN=0,duelPh=0;


/* ---------- pengaturan ---------- */
const SET=Object.assign({physObj:false,joyFull:true,autoAim:false,autoAimBall:true,hitDbg:false,shake:true,hitFx:true,net:true,physics:false,bigText:true,arenaWall:true,toast:false,duelBar:false,fxText:true,dmgText:true,sens:1},(()=>{try{return JSON.parse(localStorage.getItem('dw_set')||'{}');}catch(e){return {};}})());
function applySet(){document.body.classList.toggle('nonet',!SET.net);document.body.classList.toggle('noduelbar',!SET.duelBar);document.body.classList.toggle('dbg',!!SET.hitDbg);}
function saveSet(){try{localStorage.setItem('dw_set',JSON.stringify(SET));}catch(e){}}
function openSet(){if(!started||modalOpen||chatOpen||setOpen)return;setOpen=true;bookOpen=true;keys.clear();jumpBtnHeld=false;diveBtnHeld=false;if(guarding)setGuard(false);document.querySelectorAll('#setBox input[data-set]').forEach(i=>{i.checked=!!SET[i.dataset.set];});$('sensIn').value=SET.sens;$('sensVal').textContent=(+SET.sens).toFixed(1)+'x';$('setBox').classList.add('show');}
function closeSet(){if(!setOpen)return;setOpen=false;bookOpen=false;$('setBox').classList.remove('show');}
let setOpen=false;
/* popup buku tips & trik */
let dpsLog=[],dpsTotal=0;
function dpsAdd(d){dpsLog.push([performance.now(),d]);dpsTotal+=d;}
setInterval(()=>{if(roomMode!=='train')return;const now=performance.now();dpsLog=dpsLog.filter(x=>now-x[0]<5000);let sum=0;dpsLog.forEach(x=>sum+=x[1]);const span=dpsLog.length?Math.max(1,Math.min(5,(now-dpsLog[0][0])/1000)):5;$('dpsV').textContent=Math.round(sum/span);$('dpsT').textContent=dpsTotal;},300);
$('dpsR').addEventListener('click',()=>{dpsLog=[];dpsTotal=0;});$('dpsR').addEventListener('pointerdown',e=>e.stopPropagation());
let tipOpen=false;
/* tombol kiri: collapse / expand (diingat di browser) */
function setLcol(c){$('lcol').classList.toggle('collapsed',c);$('lcolTog').textContent=c?'▼':'▲';try{localStorage.setItem('dw_lcol',c?'1':'0');}catch(e){}}
$('lcolTog').addEventListener('click',()=>setLcol(!$('lcol').classList.contains('collapsed')));$('lcolTog').addEventListener('pointerdown',e=>e.stopPropagation());
try{if(localStorage.getItem('dw_lcol')==='1')setLcol(true);}catch(e){}
function openTips(){if(!started||modalOpen||chatOpen||setOpen||tipOpen)return;tipOpen=true;bookOpen=true;keys.clear();jumpBtnHeld=false;diveBtnHeld=false;if(guarding)setGuard(false);$('tipBox').classList.add('show');try{localStorage.setItem('dw_tips_seen','1');}catch(e){}}
function closeTips(){if(!tipOpen)return;tipOpen=false;bookOpen=false;$('tipBox').classList.remove('show');}
$('tipBtn').addEventListener('click',openTips);$('tipBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('tipX').addEventListener('click',closeTips);$('tipOk').addEventListener('click',closeTips);$('tipBox').addEventListener('pointerdown',e=>{e.stopPropagation();if(e.target===$('tipBox'))closeTips();});
/* tampil otomatis satu kali di awal: tunggu intro & bantuan arena selesai */
(function(){let seen=false;try{seen=localStorage.getItem('dw_tips_seen')==='1';}catch(e){}if(seen)return;
  const iv=setInterval(()=>{if(!started)return;if(document.body.classList.contains('cine')||$('duelHelp').classList.contains('show')||modalOpen||chatOpen||setOpen)return;clearInterval(iv);setTimeout(openTips,600);},1500);})();
document.querySelectorAll('#setBox input[data-set]').forEach(i=>i.addEventListener('change',()=>{SET[i.dataset.set]=i.checked;saveSet();applySet();if(i.dataset.set==='hitDbg')netSend({t:'pref',dbg:SET.hitDbg?1:0});}));
$('sensIn').addEventListener('input',()=>{SET.sens=parseFloat($('sensIn').value)||1;$('sensVal').textContent=SET.sens.toFixed(1)+'x';saveSet();});
{
  const sync=()=>{const sp=parseFloat($('trSpd').value),jm=parseFloat($('trJmp').value),cd=parseFloat($('trCd').value),hp=parseInt($('trHp').value,10);
    trainSpd=sp;trainJump=jm;trainCd=cd;$('tvSpd').textContent=sp.toFixed(1)+'x';$('tvJmp').textContent=jm.toFixed(1)+'x';$('tvCd').textContent=cd.toFixed(1)+'x';$('tvHp').textContent=hp+'x';
    return {cd,hp,fight:$('trFight').checked};};
  $('trFight').addEventListener('change',()=>{const v=sync();if(roomMode==='train')netSend({t:'tune',cd:v.cd,hp:v.hp,fight:v.fight});});$('trFight').addEventListener('pointerdown',e=>e.stopPropagation());
  ['trSpd','trJmp','trCd','trHp'].forEach(id=>{$(id).addEventListener('input',()=>{const v=sync();if(roomMode==='train')netSend({t:'tune',cd:v.cd,hp:v.hp,fight:v.fight});});$(id).addEventListener('pointerdown',e=>e.stopPropagation());});
  $('trainBox').addEventListener('pointerdown',e=>e.stopPropagation());
}
$('setBtn').addEventListener('click',openSet);$('setBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('setX').addEventListener('click',closeSet);$('setBox').addEventListener('pointerdown',e=>{e.stopPropagation();if(e.target===$('setBox'))closeSet();});
applySet();

/* ---------- tampilan body fisika (collider) ---------- */
let phBodies=[],phRing=null;
const phCylGeo=(()=>{const pts=[];const N=10,R=PR,H=1.8;for(let i=0;i<N;i++){const a=i/N*6.2832,b=(i+1)/N*6.2832;pts.push(Math.cos(a)*R,0,Math.sin(a)*R,Math.cos(b)*R,0,Math.sin(b)*R,Math.cos(a)*R,H,Math.sin(a)*R,Math.cos(b)*R,H,Math.sin(b)*R);if(i%2===0)pts.push(Math.cos(a)*R,0,Math.sin(a)*R,Math.cos(a)*R,H,Math.sin(a)*R);}const gm=new THREE.BufferGeometry();gm.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));return gm;})();
const phMat={me:new THREE.LineBasicMaterial({color:0x4de1ff,depthTest:false,fog:false}),foe:new THREE.LineBasicMaterial({color:0xff4d4d,depthTest:false,fog:false}),fr:new THREE.LineBasicMaterial({color:0x4de27a,depthTest:false,fog:false})};
function phBody(i,mat){
  let b=phBodies[i];
  if(!b){b=new THREE.LineSegments(phCylGeo,mat);b.renderOrder=25;b.frustumCulled=false;scene.add(b);phBodies[i]=b;}
  b.material=mat;b.visible=true;return b;
}
/* body fisika objek 3D: tabung (circles/platforms) dan kotak (obbs), hanya yang dalam 60 unit */
let phoCyl=[],phoBox=[];
const phoMat={cyl:new THREE.LineBasicMaterial({color:0xffa63d,depthTest:false,fog:false}),plat:new THREE.LineBasicMaterial({color:0xffe14d,depthTest:false,fog:false}),box:new THREE.LineBasicMaterial({color:0xff4de1,depthTest:false,fog:false})};
const phoCylGeo=(()=>{const pts=[],N=12;for(let i=0;i<N;i++){const a=i/N*6.2832,b=(i+1)/N*6.2832,ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);pts.push(ca,0,sa,cb,0,sb,ca,1,sa,cb,1,sb);if(i%3===0)pts.push(ca,0,sa,ca,1,sa);}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));return g;})();
const phoBoxGeo=new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1).translate(0,0.5,0));
function phoGet(pool,i,geo,mat){let b=pool[i];if(!b){b=new THREE.LineSegments(geo,mat);b.renderOrder=24;b.frustumCulled=false;scene.add(b);pool[i]=b;}b.material=mat;b.visible=true;return b;}
function updPhysObj(){
  if(!SET.physObj){phoCyl.forEach(b=>b.visible=false);phoBox.forEach(b=>b.visible=false);return;}
  const R2=60*60,px=pos.x,pz=pos.z;let nc=0,nb=0;
  for(const c of circles){const dx=c.x-px,dz=c.z-pz;if(dx*dx+dz*dz>R2)continue;const gy=terrainH(c.x,c.z),h=c.top!==undefined?Math.max(0.5,c.top-gy):3.5,r=c.r+PR,b=phoGet(phoCyl,nc++,phoCylGeo,phoMat.cyl);b.position.set(c.x,gy,c.z);b.scale.set(r,h,r);}
  for(const p of platforms){const dx=p.x-px,dz=p.z-pz;if(dx*dx+dz*dz>R2)continue;const gy=terrainH(p.x,p.z),r=p.r+PR,b=phoGet(phoCyl,nc++,phoCylGeo,phoMat.plat);b.position.set(p.x,gy,p.z);b.scale.set(r,Math.max(0.5,p.top-gy),r);}
  for(const o of obbs){if(!o.enabled)continue;const dx=o.cx-px,dz=o.cz-pz;if(dx*dx+dz*dz>R2)continue;const gy=terrainH(o.cx,o.cz),b=phoGet(phoBox,nb++,phoBoxGeo,phoMat.box);b.position.set(o.cx,gy,o.cz);b.rotation.y=Math.atan2(o.s,o.c);b.scale.set((o.hx+PR)*2,WALLH,(o.hz+PR)*2);}
  for(let i=nc;i<phoCyl.length;i++)phoCyl[i].visible=false;
  for(let i=nb;i<phoBox.length;i++)phoBox[i].visible=false;
}
function updPhysics(){
  updPhysObj();
  if(!SET.physics){phBodies.forEach(b=>b.visible=false);if(phRing)phRing.visible=false;return;}
  if(!phRing){const pts=[];for(let i=0;i<48;i++){const a=i/48*6.2832,b=(i+1)/48*6.2832;pts.push(Math.cos(a),0,Math.sin(a),Math.cos(b),0,Math.sin(b));}const gm=new THREE.BufferGeometry();gm.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));phRing=new THREE.LineSegments(gm,new THREE.LineBasicMaterial({color:0xffe14d,depthTest:false,fog:false}));phRing.renderOrder=25;phRing.frustumCulled=false;scene.add(phRing);}
  phRing.visible=true;phRing.position.set(pos.x,pos.y+0.08,pos.z);phRing.scale.setScalar(3.3);
  let n=0;
  if(!dead){const b=phBody(n++,phMat.me);b.position.set(pos.x,pos.y,pos.z);}
  for(const o of others.values()){if(o.dead)continue;const b=phBody(n++,phMat.foe);b.position.set(o.x,o.y,o.z);}
  for(const o of sols.values()){const b=phBody(n++,(o.owner===me.id&&!o.bandit)?phMat.fr:phMat.foe);b.position.set(o.x,terrainH(o.x,o.z),o.z);}
  for(const m of mobs.values()){const b=phBody(n++,m.o===me.id?phMat.fr:phMat.foe);b.position.set(m.x,m.y-0.9,m.z);}
  for(let i=n;i<phBodies.length;i++)phBodies[i].visible=false;
}
/* ---------- uji hit (admin) + bantuan arena ---------- */
function addDbg(m){
  const box=$('dbgBox');if(!box)return;
  const d=document.createElement('div');if(m.ok)d.className='ok';d.textContent=m.msg;box.appendChild(d);
  while(box.children.length>4)box.removeChild(box.firstChild);
  setTimeout(()=>{if(d.parentNode)d.parentNode.removeChild(d);},4000);
}
function showDuelHelp(){
  let seen=false;try{seen=localStorage.getItem('dw_duel_help')==='1';}catch(e){}
  if(seen)return;$('duelHelp').classList.add('show');
}
$('duelHelpOk').addEventListener('click',()=>{$('duelHelp').classList.remove('show');try{localStorage.setItem('dw_duel_help','1');}catch(e){}});
$('duelHelp').addEventListener('pointerdown',e=>e.stopPropagation());
/* ---------- skenario pembuka: jalan FPS ke desa, ngobrol dengan warga ---------- */
const INTRO_NPC=-999;
const INTRO_LINES=[
  'Oh, ada pendatang baru! Selamat datang di Desa Digital.',
  'Dunia ini dibuat dari kode-kode. Dengan angka dari buku teknik, kamu bisa memunculkan bola cahaya, perisai, bahkan elang.',
  'Hati-hati di luar sana. Para penyamun mengintai dari kamp mereka, dan benteng yang kosong menunggu untuk direbut.',
  'Kalau lelah, tidurlah di rumah atau di goa, darahmu akan pulih. Nah, tulis kode tekniknya di tombol +, lalu berangkatlah!'
];
let intro=null,introBob=0;
function startIntro(){
  if(intro)return;
  const sx=pos.x,sz=pos.z;let dx=-sx,dz=-sz,dist=Math.hypot(dx,dz);
  if(dist<1){dx=0;dz=1;dist=1;}
  const ux=dx/dist,uz=dz/dist;                       /* arah ke pusat desa */
  const nd=dist>28?dist-22:9;                        /* jarak dari titik awal ke warga */
  let np=findFree(sx+ux*nd,sz+uz*nd);
  let wx=np.x-sx,wz=np.z-sz,wl=Math.hypot(wx,wz)||1;wx/=wl;wz/=wl;
  const stop={x:np.x-wx*3.4,z:np.z-wz*3.4};
  const walk=Math.min(24,Math.hypot(stop.x-sx,stop.z-sz));
  const st=findFree(stop.x-wx*walk,stop.z-wz*walk);
  pos.set(st.x,0,st.z);vel.set(0,0,0);vy=0;
  const ddx=np.x-st.x,ddz=np.z-st.z,dl=Math.hypot(ddx,ddz)||1;
  const dir={x:ddx/dl,z:ddz/dl};
  const chs=CHARS.length,ch=((me.ch|0)+1+Math.floor(Math.random()*(chs-1)))%chs;
  const ny=terrainH(np.x,np.z);const o=addOther({id:INTRO_NPC,name:'Warga Desa',ch,x:np.x,y:ny,z:np.z,hp:MAXHP});o.friend=true;o.still=true;o.m=0;o.fx=-dir.x;o.fz=-dir.z;drawLabel(o);
  intro={ph:'walk',t:0,dir,goal:Math.max(0,dl-3.4),walked:0,line:0,chars:0,full:'',npcY:0};
  fps=true;fpsPitch=0;cam.yaw=cam.yawT=Math.atan2(-dir.x,-dir.z);cam.tx=pos.x;cam.tz=pos.z;
  document.body.classList.add('cine');$('cine').classList.remove('talk');
}
function introSay(i){
  intro.line=i;intro.full=INTRO_LINES[i];intro.chars=0;
  $('cineName').textContent='Warga Desa';$('cineTxt').textContent='';
  $('cineHint').textContent=i===INTRO_LINES.length-1?'Ketuk untuk mulai bermain':'Ketuk untuk lanjut';
  sfx.click&&sfx.click();
}
function introNext(){
  if(!intro||intro.ph!=='talk')return;
  if(intro.chars<intro.full.length){intro.chars=intro.full.length;$('cineTxt').textContent=intro.full;return;}
  if(intro.line+1>=INTRO_LINES.length)endIntro();else introSay(intro.line+1);
}
function endIntro(){
  if(!intro)return;
  intro=null;introBob=0;removeOther(INTRO_NPC);
  fps=false;$('xhair').classList.remove('show');$('camBtn').classList.remove('active');
  document.body.classList.remove('cine');$('cine').classList.remove('talk');
  cam.yawT=cam.yaw;cam.tx=pos.x;cam.tz=pos.z;cam.pitchT=0.32;
  renderBoard();toast('Siapkan teknikmu! Tekan ＋ di kanan untuk menulis kode',3.4);
}
function updIntro(dt){
  const I=intro;if(dead){endIntro();return;}
  I.t+=dt;
  if(I.ph==='walk'){
    if(I.goal-I.walked<=0.05){I.ph='talk';$('cine').classList.add('talk');introSay(0);}
    else{const st=5.5*dt;I.walked+=st;pos.x+=I.dir.x*st;pos.z+=I.dir.z*st;introBob=Math.sin(I.t*10)*0.05;
      if(Math.floor(I.t*3.2)!==I.stp){I.stp=Math.floor(I.t*3.2);sfx.step&&sfx.step('grass');}}
  }else{
    introBob*=0.9;
    if(I.chars<I.full.length){I.acc=(I.acc||0)+dt*42;const add=Math.floor(I.acc);if(add>0){I.acc-=add;I.chars=Math.min(I.full.length,I.chars+add);$('cineTxt').textContent=I.full.slice(0,I.chars);}}
  }
}
function introBlock(e){
  if(!intro)return;
  if(e.target&&e.target.closest&&e.target.closest('#cine')){return;}
  e.stopImmediatePropagation();
  if(e.type==='keydown'){e.preventDefault();if(e.code==='Escape')endIntro();else if(e.code==='Space'||e.code==='Enter'||e.code==='KeyE'||e.code==='KeyJ')introNext();}
  else if(e.type==='pointerdown')introNext();
}
['keydown','keyup','pointerdown','pointerup','pointermove','wheel'].forEach(t=>window.addEventListener(t,introBlock,true));
$('cineSkip').addEventListener('click',e=>{e.stopPropagation();endIntro();});
$('cineBox').addEventListener('click',e=>{e.stopPropagation();introNext();});

/* ---------- sembunyikan semua tombol ---------- */
let uiHid=null;
function setUiHidden(on){
  if(on){if(chatOpen)closeChat();uiHid={yaw:cam.yawT,pitch:cam.pitchT,fp:fpsPitch};document.body.classList.add('uihide');document.body.classList.remove('uiask');toast('Tombol disembunyikan. Putar kamera sedikit untuk memunculkan tombol pengembali.',2.6);}
  else{uiHid=null;document.body.classList.remove('uihide','uiask');}
}
function updUiHide(){
  if(!uiHid||document.body.classList.contains('uiask'))return;
  const dy=Math.abs(Math.atan2(Math.sin(cam.yawT-uiHid.yaw),Math.cos(cam.yawT-uiHid.yaw)));
  if(dy>0.22||Math.abs(cam.pitchT-uiHid.pitch)>0.18||Math.abs(fpsPitch-uiHid.fp)>0.18)document.body.classList.add('uiask');
}
$('uiBtn').addEventListener('click',()=>setUiHidden(true));$('uiBtn').addEventListener('pointerdown',e=>e.stopPropagation());
$('uiShow').addEventListener('click',e=>{e.stopPropagation();setUiHidden(false);});$('uiShow').addEventListener('pointerdown',e=>e.stopPropagation());

/* ---------- indikator jaringan ---------- */
let netRtt=-1,netLast=0,netPingT=0;
function drawNet(){
  const el=$('net');if(!el)return;
  const lost=netLast&&performance.now()-netLast>6000;
  let q,txt;
  if(netRtt<0&&!lost){q=0;txt='...';}
  else if(lost){q=0;txt='putus?';}
  else{q=netRtt<70?4:netRtt<130?3:netRtt<220?2:1;txt=Math.round(netRtt)+' ms';}
  let h='<svg viewBox="0 0 16 14">';
  for(let i=0;i<4;i++){const bh=4+i*3;h+='<rect class="'+(i<q?'on':'off')+'" x="'+(i*4+0.5)+'" y="'+(14-bh)+'" width="3" height="'+bh+'" rx="0.8"/>';}
  h+='</svg><span>'+txt+'</span>';
  el.className='pill hud q'+q;el.innerHTML=h;
  el.title=q>=3?'Jaringan bagus':q===2?'Jaringan lumayan':q===1?'Jaringan jelek':'Jaringan sangat jelek / terputus';
}
setInterval(()=>{if(!joined)return;netPingT=performance.now();netSend({t:'ping',ts:netPingT});drawNet();},2000);
setInterval(()=>{if(joined&&netTrk)netSend({t:'ping',ts:performance.now()});},700);
drawNet();

/* ---------- efek kena (0.5 dtk): gaya 'flash' (siluet+cincin) atau 'glass' (silinder kaca) atau 'lines' ---------- */
const hitboxes=[];
let HB_STYLE='glass';
const hbCyl=new THREE.CylinderGeometry(0.5,0.5,1.8,16,1,true);
const hbGlowTex=radialTex([[0,'rgba(255,200,130,.55)'],[0.7,'rgba(255,170,90,.25)'],[1,'rgba(255,170,90,0)']],128);
function hbGlassTex(){const cv=document.createElement('canvas');cv.width=4;cv.height=64;const c=cv.getContext('2d');const gr=c.createLinearGradient(0,0,0,64);gr.addColorStop(0,'rgba(255,255,255,0)');gr.addColorStop(0.18,'rgba(255,225,170,.75)');gr.addColorStop(0.5,'rgba(255,170,90,.38)');gr.addColorStop(0.85,'rgba(255,225,170,.75)');gr.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=gr;c.fillRect(0,0,4,64);return new THREE.CanvasTexture(cv);}
const hbGlass=hbGlassTex();
function showHitbox(o,off,hr){
  if(!o||!SET.hitFx)return;
  const style=HB_STYLE;const parts=[];
  const add=(mesh,fn)=>{mesh.renderOrder=26;scene.add(mesh);parts.push({mesh,fn});return mesh;};
  const am=(map,col)=>new THREE.MeshBasicMaterial({map,color:col||0xffffff,transparent:true,opacity:1,depthTest:false,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,fog:false});
  if(style==='glass'){
    add(new THREE.Mesh(hbCyl,am(hbGlass,0xffffff)),(m,k)=>{m.material.opacity=(1-k)*(1-k);m.scale.set(1+k*0.18,1,1+k*0.18);});
    add(new THREE.Mesh(new THREE.CircleGeometry(0.9,24).rotateX(-Math.PI/2),am(hbGlowTex)),(m,k)=>{m.material.opacity=1-k;m.position.y-=0.84;m.scale.setScalar(1+k*0.6);});
    if(hr>0)add(new THREE.Mesh(new THREE.SphereGeometry(hr,20,14),new THREE.MeshBasicMaterial({color:0x6cd4ff,transparent:true,opacity:0.2,depthTest:false,depthWrite:false,blending:THREE.AdditiveBlending,fog:false})),(m,k)=>{m.material.opacity=0.22*(1-k);});
  }
  hitboxes.push({o,off:off==null?0.9:off,parts,t:0});
  while(hitboxes.length>14)dropHitbox(hitboxes.shift());
}
function dropHitbox(h){h.parts.forEach(p=>{scene.remove(p.mesh);if(p.mesh.material)p.mesh.material.dispose();if(p.mesh.geometry&&p.mesh.geometry.type==='WireframeGeometry'||p.mesh.geometry&&p.mesh.geometry.type==='CircleGeometry'||p.mesh.geometry&&p.mesh.geometry.type==='SphereGeometry')p.mesh.geometry.dispose();});}
function updHitboxes(dt){
  for(let i=hitboxes.length-1;i>=0;i--){
    const h=hitboxes[i];h.t+=dt;
    if(h.t>=0.5){dropHitbox(h);hitboxes.splice(i,1);continue;}
    const k=h.t/0.5,y=h.o.y+h.off;
    h.parts.forEach(p=>{p.mesh.position.set(h.o.x,y,h.o.z);p.fn(p.mesh,k);});
  }
}
function frame(now){
  let dt=Math.min(0.05,(now-last)/1000);last=now;
  update(dt);renderer.render(scene,camera);requestAnimationFrame(frame);
}
document.querySelectorAll('[data-ico]').forEach(el=>{el.innerHTML=svg(el.dataset.ico);});
cam.fov=cam.baseFov||50;camera.fov=cam.fov;
window.__dw={lionCv,mobs:()=>mobs,sfx,aiming:()=>aiming,fps:()=>fps,forts,sols,orbs,houses,inCave:()=>inCave,chest:()=>chest,ammo:()=>ammo,sleeping:()=>sleeping,eagleCv,pos,others,slots,me:()=>me,castSlot,doAttack,cam};
requestAnimationFrame(frame);
})();
</script>
</body>
</html>
`;
