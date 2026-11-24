// Forest Strike — browser version (three.js). Port of the Unreal Engine C++ game.
// Meters, Y up. Map X: -40..40 (Blue spawn west, Red spawn east), Z: -30..30.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const DEG = Math.PI / 180;
const angNorm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ======================================================================= settings
const Settings = {
  sens: 1, diff: 1, rounds: 7, vol: 0.8, gfx: 1,
  load() { try { Object.assign(this, JSON.parse(localStorage.getItem('fs_settings') || '{}')); } catch (e) { } },
  save() { try { localStorage.setItem('fs_settings', JSON.stringify({ sens: this.sens, diff: this.diff, rounds: this.rounds, vol: this.vol, gfx: this.gfx })); } catch (e) { } },
  diffName() { return ['Лёгкая', 'Нормальная', 'Сложная'][this.diff]; },
  reactMult() { return [1.5, 1, 0.7][this.diff]; },
  aimMult() { return [1.6, 1, 0.6][this.diff]; },
  sight() { return [42, 55, 68][this.diff]; },
};
Settings.load();

// ======================================================================= audio
const Snd = {
  ctx: null, buf: {}, master: null, L: { x: 0, y: 0, z: 0, yaw: 0 },
  init() {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination); } catch (e) { this.ctx = null; }
  },
  async load(names, prog) {
    if (!this.ctx) return;
    await Promise.all(names.map(async (n) => {
      try { const r = await fetch('sounds/' + n + '.wav'); this.buf[n] = await this.ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { console.warn('sound', n, e); }
      prog && prog();
    }));
  },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); },
  play(n, o = {}) {
    if (!this.ctx || !this.buf[n]) return;
    let g = (o.vol ?? 1) * Settings.vol, pan = 0;
    if (o.pos) {
      const dx = o.pos.x - this.L.x, dy = o.pos.y - this.L.y, dz = o.pos.z - this.L.z;
      const d = Math.hypot(dx, dy, dz);
      const att = clamp(1 - (d - 3) / (o.falloff ?? 40), 0, 1);
      g *= att * att;
      const rx = Math.sin(this.L.yaw), rz = Math.cos(this.L.yaw);
      pan = clamp((dx * rx + dz * rz) / Math.max(d, 0.001), -1, 1) * 0.8;
    }
    if (g < 0.003) return;
    const s = this.ctx.createBufferSource(); s.buffer = this.buf[n];
    s.playbackRate.value = 1 + rand(-(o.pitch ?? 0.05), o.pitch ?? 0.05);
    const gn = this.ctx.createGain(); gn.gain.value = g; s.connect(gn);
    if (this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; gn.connect(p); p.connect(this.master); } else gn.connect(this.master);
    s.start();
  },
};

// ======================================================================= map
const HALF_X = 40, HALF_Z = 30;
function heightCm(X, Y) {
  const Xm = Math.abs(X);
  let H = 38 * Math.sin(Xm * 0.0011 + 0.5) * Math.cos(Y * 0.0013) + 24 * Math.sin(Xm * 0.0023 + Y * 0.0017 + 1.3) + 10 * Math.cos(Xm * 0.0041 - Y * 0.0031);
  const RY = -2150 + 120 * Math.sin(Xm * 0.0016);
  H -= 170 * (1 - smooth01(150, 600, Math.abs(Y - RY))) * (1 - smooth01(2300, 2900, Xm));
  H = lerp(H, 0, 1 - smooth01(600, 950, Math.hypot(X / 1.25, Y)));
  H = lerp(H, 10, 1 - smooth01(500, 900, Math.hypot(Xm - 3600, Y)));
  const ex = Math.max(0, Xm - 4000), ey = Math.max(0, Math.abs(Y) - 3000), e = Math.hypot(ex, ey);
  return H + e * e * 0.0005 + e * 0.12;
}
const heightAt = (x, z) => heightCm(x * 100, z * 100) / 100;

const K = { PINE: 'SM_Pine', BIRCH: 'SM_Birch', BUSH: 'SM_Bush', GRASS: 'SM_Grass', ROCKA: 'SM_Rock_A', ROCKB: 'SM_Rock_B', LOG: 'SM_Log', STUMP: 'SM_Stump', CRATE: 'SM_Crate', WOOD: 'SM_Woodpile', FENCE: 'SM_Fence', TENT: 'SM_Tent', FIRE: 'SM_Campfire' };
const MapD = { props: [], obs: [], pathLines: [], lanes: { blue: [], red: [] }, holds: { blue: [], red: [] }, CELL: 0.5, GW: 160, GH: 120, grid: null };

function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz;
  const t = l2 > 0 ? clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}
function laneDist(x, z) {
  let b = 1e9;
  for (const L of MapD.pathLines) for (let i = 0; i + 1 < L.length; i++) b = Math.min(b, segDist(x, z, L[i][0], L[i][1], L[i + 1][0], L[i + 1][1]));
  return b;
}
const propBase = (p) => heightAt(p.x, p.z) - ((p.k === K.PINE || p.k === K.BIRCH || p.k === K.LOG) ? 0.12 : 0.04) + p.y;

function buildLayout(grassCount) {
  const P = MapD.props; P.length = 0;
  const North = [[-35, 0], [-30, 18], [-15, 22], [0, 20.5], [15, 22], [30, 18], [35, 0]];
  const Mid = [[-35, 0], [-16, 0], [-4.5, 0], [4.5, 0], [16, 0], [35, 0]];
  const South = [[-35, 0], [-30, -18], [-15, -21.5], [0, -21.5], [15, -21.5], [30, -18], [35, 0]];
  MapD.pathLines = [North, Mid, South, [[-16, 0], [-16, 22]], [[-16, 0], [-16, -21.5]], [[16, 0], [16, 22]], [[16, 0], [16, -21.5]]];
  MapD.lanes.blue = [North, Mid, South].map(L => L.map(([x, z]) => new THREE.Vector3(x, heightAt(x, z), z)));
  MapD.lanes.red = MapD.lanes.blue.map(L => L.slice().reverse());

  const add = (k, x, z, yaw, s = 1, y = 0) => P.push({ k, x, z, yaw, s, y });
  const sym = (k, x, z, yaw, s = 1, y = 0) => { add(k, x, z, yaw, s, y); if (Math.abs(x) > 0.01) add(k, -x, z, 180 - yaw, s, y); };

  add(K.CRATE, 0, 0.3, 0); add(K.CRATE, 0, 0.3, 25, 0.95, 1.1);
  sym(K.CRATE, -2.55, 1.75, 0); sym(K.CRATE, -1.5, -1.85, 15, 0.9); sym(K.CRATE, -7.7, 4.3, 15); sym(K.CRATE, -7.7, 4.3, 50, 0.85, 1.1);
  sym(K.CRATE, -15.5, -3.8, 0); sym(K.CRATE, -26, 11.5, 20); sym(K.CRATE, -4.5, 24.2, 10); sym(K.CRATE, -22.5, -12.5, 35);
  sym(K.WOOD, -14.2, 10, 0); sym(K.WOOD, -14.2, -10, 0); sym(K.WOOD, -25, -4.8, 90);
  sym(K.LOG, -10.5, 20.6, 10); sym(K.LOG, -23, -19, 30); sym(K.LOG, -29.5, 4.2, 80); sym(K.LOG, -7.5, -16.5, -20);
  sym(K.ROCKB, -20.5, 16.5, 0, 1); sym(K.ROCKB, -26.5, -0.6, 30, 1.05); sym(K.ROCKB, -30, -13.5, 0, 1.1); sym(K.ROCKB, -3.8, -22.3, 200, 0.9); add(K.ROCKB, 0, 23.8, 40, 0.85);
  sym(K.ROCKA, -17, 23.3, 30); sym(K.ROCKA, -8.2, -22.8, 0, 1.1); sym(K.ROCKA, -4.5, 18.5, 60); sym(K.ROCKA, -24.2, 20.8, 0, 0.9);
  sym(K.ROCKA, -11.5, 3, 20); sym(K.ROCKA, -31.5, 17, 0, 1.2); sym(K.ROCKA, -21, -23.2, 0); sym(K.ROCKA, -19, -3, 0, 0.8);
  sym(K.STUMP, -9, 6.8, 0); sym(K.STUMP, -20, 3.8, 40); sym(K.STUMP, -27, -22, 0); sym(K.STUMP, -13, -14, 70, 1.2); sym(K.STUMP, -3, 13, 0);
  sym(K.FENCE, -7.2, 8.2, 0); sym(K.FENCE, -7.2, -8.2, 0);
  add(K.TENT, -36.2, 7.8, 0); add(K.TENT, -36.2, -7.8, 0); add(K.FIRE, -32.3, 0, 0); add(K.CRATE, -38.5, 0, 10);
  add(K.WOOD, 36, 7.8, 90); add(K.WOOD, 36, -7.8, 90); add(K.CRATE, 32.5, 10.8, 20); add(K.CRATE, 32.5, -10.8, -20); add(K.LOG, 38.7, 0, 90);

  const R = mulberry32(2024);
  const rr = (a, b) => a + R() * (b - a);
  const bushes = [[-27, 15], [-19, 23.8], [-12.5, 17.2], [-6.2, 21.5], [-22, 7], [-18, -7], [-26.5, -15.5], [-15.5, -23.8], [-10, -19.2], [-5, -14.8], [-12.2, 5.6], [-6.4, -4.7], [-24, -24.2], [-33, 12.5], [-33, -12.5], [-1.5, 21], [-29, 22]];
  for (const [x, z] of bushes) sym(K.BUSH, x, z, rr(0, 360), rr(0.85, 1.25));

  const far = (x, z, extra) => {
    for (const p of P) {
      if (p.k === K.GRASS || p.k === K.BUSH) continue;
      const r = { [K.ROCKB]: 2.6, [K.LOG]: 2.8, [K.WOOD]: 1.7, [K.TENT]: 1.8, [K.FENCE]: 1.8 }[p.k] || 1.5;
      if (Math.hypot(x - p.x, z - p.z) < r * p.s + extra) return false;
    }
    return true;
  };
  let pts = [];
  const tooClose = (x, z, d) => pts.some(([a, b]) => (a - x) ** 2 + (b - z) ** 2 < d * d);
  for (let i = 0; i < 2500; i++) {
    const x = rr(-39, -1.8), z = rr(-29, 29);
    if (laneDist(x, z) < 3.4) continue;
    if (Math.abs(x) < 10 && Math.abs(z) < 7.2) continue;
    if (Math.hypot(x + 36, z) < 10) continue;
    if (!far(x, z, 1.2) || !far(-x, z, 1.2) || tooClose(x, z, 4.2)) continue;
    pts.push([x, z]);
    sym(R() < 0.7 ? K.PINE : K.BIRCH, x, z, rr(0, 360), rr(0.8, 1.25));
  }
  pts = [];
  for (let i = 0; i < 9000; i++) {
    const x = rr(-58, 58), z = rr(-48, 48);
    if (!(Math.abs(x) > HALF_X - 1.5 || Math.abs(z) > HALF_Z - 1.5)) continue;
    if (laneDist(x, z) < 3) continue;
    if (Math.hypot(Math.abs(x) - 36, z) < 9) continue;
    if (tooClose(x, z, 3.3)) continue;
    pts.push([x, z]);
    add(R() < 0.75 ? K.PINE : K.BIRCH, x, z, rr(0, 360), rr(0.85, 1.4));
  }
  for (let i = 0; i < grassCount; i++) {
    const x = rr(-HALF_X, HALF_X), z = rr(-HALF_Z, HALF_Z);
    if (laneDist(x, z) < 1.2 || (Math.abs(x) < 4.2 && Math.abs(z) < 3.2)) continue;
    add(K.GRASS, x, z, rr(0, 360), rr(0.8, 1.6));
  }
  const holds = [[-16.5, 10.5], [-16.5, -10.5], [-22.8, 16.5], [-9.6, 4.7], [-6.8, -22], [-13, 20.6], [-5, 0]];
  MapD.holds.blue = holds.map(([x, z]) => new THREE.Vector3(x, heightAt(x, z), z));
  MapD.holds.red = holds.map(([x, z]) => new THREE.Vector3(-x, heightAt(-x, z), z));

  // ---- obstacles (movement / bullets / bot sight)
  const O = MapD.obs; O.length = 0;
  const circ = (p, r, h, o = {}) => O.push({ box: false, x: p.x, z: p.z, r: r * p.s, h0: propBase(p) - 0.5, h1: propBase(p) + h * p.s, move: o.move ?? true, bullet: o.bullet ?? true, sight: o.sight ?? true, R: r * p.s });
  const box = (p, hx, hz, h, o = {}) => {
    const a = p.yaw * DEG, b = propBase(p);
    O.push({ box: true, x: p.x, z: p.z, hx: hx * p.s, hz: hz * p.s, cs: Math.cos(a), sn: Math.sin(a), h0: p.y > 0 ? b : b - 0.5, h1: b + h * p.s, move: true, bullet: true, sight: true, R: Math.hypot(hx, hz) * p.s });
  };
  for (const p of P) {
    switch (p.k) {
      case K.PINE: circ(p, 0.2, 9); break;
      case K.BIRCH: circ(p, 0.16, 6.5); break;
      case K.BUSH: circ(p, 0.85, 1.3, { move: false, bullet: false }); break;
      case K.ROCKA: box(p, 1.0, 0.75, 1.35); break;
      case K.ROCKB: box(p, 1.7, 1.4, 2.5); break;
      case K.LOG: box(p, 2.5, 0.38, 0.76); break;
      case K.STUMP: circ(p, 0.48, 0.6); break;
      case K.CRATE: box(p, 0.56, 0.56, 1.1); break;
      case K.WOOD: box(p, 0.8, 1.22, 1.05); break;
      case K.FENCE: box(p, 1.58, 0.08, 1.2); break;
      case K.TENT: box(p, 1.3, 1.1, 1.6); break;
      default: break;
    }
  }
  const wall = (x, z, hx, hz) => O.push({ box: true, x, z, hx, hz, cs: 1, sn: 0, h0: -1, h1: 2.85, move: true, bullet: true, sight: true, R: Math.hypot(hx, hz) });
  wall(-3.875, -1.8, 0.17, 1.22); wall(-3.875, 1.8, 0.17, 1.22); wall(3.875, -1.8, 0.17, 1.22); wall(3.875, 1.8, 0.17, 1.22);
  wall(0, 2.875, 4.0, 0.17); wall(0, -2.875, 4.0, 0.17);
  // roof (blocks bullets/sight from above only)
  O.push({ box: true, x: 0, z: 0, hx: 4.5, hz: 3.7, cs: 1, sn: 0, h0: 2.85, h1: 4.4, move: false, bullet: true, sight: true, R: 6 });

  buildGrid();
}

// ---------------------------------------------------------------- nav grid / A*
function buildGrid() {
  const { GW, GH, CELL } = MapD;
  const g = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (x < 2 || y < 2 || x >= GW - 2 || y >= GH - 2) g[y * GW + x] = 1;
  const cellC = (i) => -HALF_X + (i + 0.5) * CELL, cellCz = (i) => -HALF_Z + (i + 0.5) * CELL;
  const blockBox = (cx, cz, hx, hz, yaw, inf) => {
    const rad = Math.hypot(hx, hz) + inf, cs = Math.cos(yaw * DEG), sn = Math.sin(yaw * DEG);
    const x0 = Math.max(0, Math.floor((cx - rad + HALF_X) / CELL)), x1 = Math.min(GW - 1, Math.floor((cx + rad + HALF_X) / CELL));
    const y0 = Math.max(0, Math.floor((cz - rad + HALF_Z) / CELL)), y1 = Math.min(GH - 1, Math.floor((cz + rad + HALF_Z) / CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = cellC(x) - cx, dz = cellCz(y) - cz;
      const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
      if (Math.abs(lx) <= hx + inf && Math.abs(lz) <= hz + inf) g[y * GW + x] = 1;
    }
  };
  const blockCirc = (cx, cz, r) => blockBox(cx, cz, r * 0.75, r * 0.75, 0, r * 0.25);
  const inf = 0.42;
  for (const p of MapD.props) {
    const s = p.s;
    switch (p.k) {
      case K.PINE: case K.BIRCH: blockCirc(p.x, p.z, 0.22 * s + inf); break;
      case K.STUMP: blockCirc(p.x, p.z, 0.5 * s + inf); break;
      case K.ROCKA: blockBox(p.x, p.z, 1.05 * s, 0.8 * s, p.yaw, inf); break;
      case K.ROCKB: blockBox(p.x, p.z, 1.75 * s, 1.45 * s, p.yaw, inf); break;
      case K.LOG: blockBox(p.x, p.z, 2.5 * s, 0.38 * s, p.yaw, inf); break;
      case K.CRATE: if (p.y < 0.01) blockBox(p.x, p.z, 0.56 * s, 0.56 * s, p.yaw, inf); break;
      case K.WOOD: blockBox(p.x, p.z, 0.8 * s, 1.22 * s, p.yaw, inf); break;
      case K.FENCE: blockBox(p.x, p.z, 1.58 * s, 0.08 * s, p.yaw, inf); break;
      case K.TENT: blockBox(p.x, p.z, 1.32 * s, 1.1 * s, p.yaw, inf); break;
      default: break;
    }
  }
  const ci = 0.2;
  blockBox(-3.875, -1.8, 0.17, 1.22, 0, ci); blockBox(-3.875, 1.8, 0.17, 1.22, 0, ci); blockBox(3.875, -1.8, 0.17, 1.22, 0, ci); blockBox(3.875, 1.8, 0.17, 1.22, 0, ci);
  blockBox(0, 2.875, 4.0, 0.17, 0, ci); blockBox(0, -2.875, 4.0, 0.17, 0, ci);
  MapD.grid = g;
}
const toCell = (x, z) => [Math.floor((x + HALF_X) / MapD.CELL), Math.floor((z + HALF_Z) / MapD.CELL)];
const cellFree = (x, y) => x >= 0 && y >= 0 && x < MapD.GW && y < MapD.GH && MapD.grid[y * MapD.GW + x] === 0;
const isWalkable = (x, z) => { const [cx, cy] = toCell(x, z); return cellFree(cx, cy); };
function nearestFree(c) {
  c[0] = clamp(c[0], 0, MapD.GW - 1); c[1] = clamp(c[1], 0, MapD.GH - 1);
  if (cellFree(c[0], c[1])) return true;
  for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
    if (cellFree(c[0] + dx, c[1] + dy)) { c[0] += dx; c[1] += dy; return true; }
  }
  return false;
}
function segmentFree(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  if (len < 0.01) return true;
  const ux = dx / len, uz = dz / len, px = -uz, pz = ux;
  for (let t = 0; t <= len; t += 0.2) for (const s of [-0.2, 0, 0.2]) {
    const [cx, cy] = toCell(ax + ux * t + px * s, az + uz * t + pz * s);
    if (!cellFree(cx, cy)) return false;
  }
  return true;
}
function findPath(fx, fz, tx, tz) {
  const { GW, GH, CELL } = MapD;
  const S = toCell(fx, fz), G = toCell(tx, tz);
  if (!nearestFree(S) || !nearestFree(G)) return null;
  if (S[0] === G[0] && S[1] === G[1]) return [new THREE.Vector2(tx, tz)];
  const N = GW * GH, gs = new Float32Array(N).fill(1e9), par = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const si = S[1] * GW + S[0], gi = G[1] * GW + G[0];
  const H = (x, y) => { const dx = Math.abs(x - G[0]), dy = Math.abs(y - G[1]); return dx + dy - 0.5858 * Math.min(dx, dy); };
  const heap = []; // binary heap of [f, idx]
  const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  gs[si] = 0; push(H(S[0], S[1]), si);
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  let found = false, it = 0;
  while (heap.length && it++ < 60000) {
    const [, cur] = pop();
    if (closed[cur]) continue; closed[cur] = 1;
    if (cur === gi) { found = true; break; }
    const cx = cur % GW, cy = (cur / GW) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (!cellFree(nx, ny)) continue;
      if (k >= 4 && (!cellFree(cx + DX[k], cy) || !cellFree(cx, cy + DY[k]))) continue;
      const ni = ny * GW + nx; if (closed[ni]) continue;
      const ng = gs[cur] + (k >= 4 ? 1.4142 : 1);
      if (ng < gs[ni]) { gs[ni] = ng; par[ni] = cur; push(ng + H(nx, ny), ni); }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let i = gi; i !== -1; i = par[i]) cells.push(new THREE.Vector2(-HALF_X + ((i % GW) + 0.5) * CELL, -HALF_Z + (((i / GW) | 0) + 0.5) * CELL));
  cells.reverse();
  if (isWalkable(tx, tz)) cells[cells.length - 1] = new THREE.Vector2(tx, tz);
  const out = []; let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !segmentFree(cells[i].x, cells[i].y, cells[j].x, cells[j].y)) j--;
    out.push(cells[j]); i = j;
  }
  return out.length ? out : [new THREE.Vector2(tx, tz)];
}
function randomWalkable(cx, cz, r) {
  for (let i = 0; i < 40; i++) {
    const x = cx + rand(-r, r), z = cz + rand(-r, r);
    if (Math.abs(x) < HALF_X - 1.5 && Math.abs(z) < HALF_Z - 1.5 && isWalkable(x, z)) return new THREE.Vector3(x, heightAt(x, z), z);
  }
  return new THREE.Vector3(cx, heightAt(cx, cz), cz);
}

// ---------------------------------------------------------------- ray tests
// returns distance along unit dir or Infinity
function rayObstacle(o, ox, oy, oz, dx, dy, dz, maxT) {
  let t;
  if (!o.box) {
    const a = dx * dx + dz * dz; if (a < 1e-9) return Infinity;
    const fx = ox - o.x, fz = oz - o.z, b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - o.r * o.r;
    if (c < 0) return Infinity;
    const disc = b * b - 4 * a * c; if (disc < 0) return Infinity;
    t = (-b - Math.sqrt(disc)) / (2 * a);
  } else {
    const rx = ox - o.x, rz = oz - o.z;
    const px = rx * o.cs + rz * o.sn, pz = -rx * o.sn + rz * o.cs;
    const lx = dx * o.cs + dz * o.sn, lz = -dx * o.sn + dz * o.cs;
    let t0 = -Infinity, t1 = Infinity;
    for (const [p, d, h] of [[px, lx, o.hx], [pz, lz, o.hz]]) {
      if (Math.abs(d) < 1e-9) { if (Math.abs(p) > h) return Infinity; continue; }
      let a1 = (-h - p) / d, a2 = (h - p) / d; if (a1 > a2) [a1, a2] = [a2, a1];
      t0 = Math.max(t0, a1); t1 = Math.min(t1, a2);
    }
    if (t0 > t1 || t1 < 0) return Infinity;
    if (t0 < 0) { // inside footprint: hit when entering the height range from above
      if (oy > o.h1 && dy < 0) { const th = (o.h1 - oy) / dy; return th <= t1 && th <= maxT ? th : Infinity; }
      return Infinity;
    }
    t = t0;
  }
  if (t < 0 || t > maxT) return Infinity;
  const y = oy + dy * t;
  if (y < o.h0 || y > o.h1) {
    if (!o.box && oy > o.h1 && dy < 0) return Infinity;
    return Infinity;
  }
  return t;
}
function rayTerrain(ox, oy, oz, dx, dy, dz, maxT) {
  let prevT = 0;
  for (let t = 0.3; t <= maxT; t += 0.5) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    if (y < heightAt(x, z)) {
      let a = prevT, b = t;
      for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (oy + dy * m < heightAt(ox + dx * m, oz + dz * m)) b = m; else a = m; }
      return b;
    }
    prevT = t;
    if (y > 30 && dy > 0) break;
  }
  return Infinity;
}
function rayFighter(f, ox, oy, oz, dx, dy, dz, maxT) {
  const o = { box: false, x: f.pos.x, z: f.pos.z, r: 0.34, h0: f.pos.y, h1: f.pos.y + f.height() };
  const fx = ox - o.x, fz = oz - o.z;
  if (fx * fx + fz * fz < o.r * o.r) return Infinity;
  return rayObstacle(o, ox, oy, oz, dx, dy, dz, maxT);
}
/** kind: 'bullet' or 'sight'. Returns { t, fighter } */
function raycast(o, d, maxT, kind, ignore) {
  let best = maxT, hitF = null;
  for (const ob of MapD.obs) {
    if (kind === 'bullet' ? !ob.bullet : !ob.sight) continue;
    const ddx = ob.x - o.x, ddz = ob.z - o.z;
    // quick reject: obstacle far from the segment
    const along = ddx * d.x + ddz * d.z;
    if (along < -ob.R - 1 || along > best + ob.R + 1) continue;
    const perp = Math.abs(ddx * d.z - ddz * d.x) / Math.max(Math.hypot(d.x, d.z), 1e-6);
    if (perp > ob.R + 0.5) continue;
    const t = rayObstacle(ob, o.x, o.y, o.z, d.x, d.y, d.z, best);
    if (t < best) best = t;
  }
  const tt = rayTerrain(o.x, o.y, o.z, d.x, d.y, d.z, best);
  if (tt < best) best = tt;
  for (const f of GM.fighters) {
    if (f === ignore || f.dead) continue;
    const t = rayFighter(f, o.x, o.y, o.z, d.x, d.y, d.z, best);
    if (t < best) { best = t; hitF = f; }
  }
  return { t: best, fighter: hitF };
}

// ======================================================================= rendering
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.autoClear = false;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const SKY = 0x9fc3df;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(0xa9c2cf, 45, 150);
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 400);
camera.rotation.order = 'YXZ';
const wScene = new THREE.Scene();
const wCam = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
wScene.add(wCam);
wScene.add(new THREE.HemisphereLight(0xdde9ff, 0x4a5a32, 1.6));
const wSun = new THREE.DirectionalLight(0xfff1dc, 1.6); wSun.position.set(0.3, 1, 0.4); wScene.add(wSun);

const hemi = new THREE.HemisphereLight(0xd2e4ff, 0x3d4d28, 1.35); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0da, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 140 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun); scene.add(sun.target);
const SUN_OFF = new THREE.Vector3(-28, 46, -20);
const flashLight = new THREE.PointLight(0xffc070, 0, 9, 2); scene.add(flashLight);

function applyGfx() {
  renderer.setPixelRatio(Settings.gfx ? Math.min(window.devicePixelRatio, 1.5) : 0.75);
  renderer.shadowMap.enabled = Settings.gfx > 0;
  sun.castShadow = Settings.gfx > 0;
  scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
  resize();
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = wCam.aspect = w / h; camera.updateProjectionMatrix(); wCam.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

let MESHES = null;
const MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const MAT_GLOW = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
const geoCache = {};
function geo(name, tint) {
  const key = name + (tint ? tint.join(',') : '');
  if (geoCache[key]) return geoCache[key];
  const d = MESHES[name];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3));
  const n = d.p.length / 3, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let r = d.c[i * 4], gg = d.c[i * 4 + 1], b = d.c[i * 4 + 2];
    if (tint && d.c[i * 4 + 3] > 0.5) { r *= tint[0]; gg *= tint[1]; b *= tint[2]; }
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return (geoCache[key] = g);
}
const TINT = { blue: [0.13, 0.27, 0.75], red: [0.72, 0.12, 0.1] };

function buildWorld() {
  // terrain
  const ext = [60, 50], step = 1, NX = 121, NZ = 101;
  const pos = new Float32Array(NX * NZ * 3), col = new Float32Array(NX * NZ * 3), idx = [];
  const C = { g1: [0.19, 0.33, 0.09], g2: [0.27, 0.40, 0.11], dirt: [0.36, 0.27, 0.16], forest: [0.15, 0.21, 0.08], mud: [0.31, 0.27, 0.20] };
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
    const x = -ext[0] + ix * step, z = -ext[1] + iz * step, h = heightAt(x, z), k = iz * NX + ix;
    pos.set([x, h, z], k * 3);
    const X = x * 100, Y = z * 100;
    const noise = 0.5 + 0.5 * Math.sin(X * 0.007 + Math.cos(Y * 0.006) * 2) * Math.cos(Y * 0.0052 - X * 0.002);
    let c = mix(C.g1, C.g2, noise);
    c = mix(c, C.dirt, (1 - smooth01(0.9, 2.3, laneDist(x, z))) * 0.8);
    if (Math.abs(x) < 7.5 && Math.abs(z) < 5.6) c = mix(c, C.dirt, 0.45);
    if (h < -0.4 && Math.abs(z) < HALF_Z) c = mix(c, C.mud, smooth01(-0.4, -1.5, h) * 0.7);
    c = mix(c, C.forest, smooth01(0, 6, Math.max(Math.abs(x) - HALF_X, Math.abs(z) - HALF_Z)));
    col.set(c, k * 3);
  }
  for (let iz = 0; iz < NZ - 1; iz++) for (let ix = 0; ix < NX - 1; ix++) {
    const a = iz * NX + ix, b = a + 1, c = a + NX, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tg.setIndex(idx); tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, MAT); terrain.receiveShadow = true; scene.add(terrain);

  // props as instanced meshes
  const groups = {};
  for (const p of MapD.props) (groups[p.k] = groups[p.k] || []).push(p);
  const dummy = new THREE.Object3D();
  for (const k in groups) {
    const list = groups[k];
    const m = new THREE.InstancedMesh(geo(k), MAT, list.length);
    list.forEach((p, i) => {
      dummy.position.set(p.x, propBase(p), p.z); dummy.rotation.set(0, -p.yaw * DEG, 0); dummy.scale.setScalar(p.s); dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.castShadow = k !== K.GRASS; m.receiveShadow = true;
    m.computeBoundingSphere();
    scene.add(m);
  }
  const cabin = new THREE.Mesh(geo('SM_Cabin'), MAT); cabin.position.set(0, heightAt(0, 0) - 0.03, 0); cabin.castShadow = cabin.receiveShadow = true; scene.add(cabin);
}

// ---------------------------------------------------------------- effects
const FX = [];
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffd27a, fog: false });
function spawnTracer(from, to) {
  const g = new THREE.BufferGeometry().setFromPoints([from.clone(), from.clone()]);
  const line = new THREE.Line(g, tracerMat); scene.add(line);
  const dir = to.clone().sub(from), total = dir.length(); dir.normalize();
  FX.push({ obj: line, age: 0, update(dt) {
    this.age += dt; const tr = this.age * 320;
    const a = clamp(tr - 3, 0, total), b = clamp(tr, 0, total);
    if (a >= total - 0.01) return false;
    const p = g.attributes.position;
    p.setXYZ(0, from.x + dir.x * a, from.y + dir.y * a, from.z + dir.z * a);
    p.setXYZ(1, from.x + dir.x * b, from.y + dir.y * b, from.z + dir.z * b);
    p.needsUpdate = true; return true;
  } });
}
const puffGeo = new THREE.SphereGeometry(1, 8, 6);
function spawnPuff(at, blood) {
  const m = new THREE.Mesh(puffGeo, new THREE.MeshBasicMaterial({ color: blood ? 0x8a0a0a : 0x8b7b5e, transparent: true, opacity: 0.85 }));
  m.position.copy(at); m.scale.setScalar(0.04); scene.add(m);
  FX.push({ obj: m, age: 0, update(dt) { this.age += dt; const t = this.age / 0.35; if (t >= 1) return false; m.scale.setScalar(lerp(0.04, blood ? 0.3 : 0.24, Math.sqrt(t))); m.material.opacity = 0.85 * (1 - t); return true; } });
}
function updateFX(dt) {
  for (let i = FX.length - 1; i >= 0; i--) {
    if (!FX[i].update(dt)) { scene.remove(FX[i].obj); FX[i].obj.geometry !== puffGeo && FX[i].obj.geometry.dispose(); FX[i].obj.material !== tracerMat && FX[i].obj.material.dispose(); FX.splice(i, 1); }
  }
}

// ======================================================================= weapons
const WEAPONS = {
  rifle: { name: 'Винтовка', dmg: 30, head: 4, int: 0.1, auto: true, mag: 30, res: 90, reload: 2.3, base: 0.15, move: 4, jump: 7, rs: 0.22, rp: 0.42, ry: 0.22, range: 120, fov: 40, equip: 0.6, speed: 4.4, fp: 'SM_Rifle_FP', tp: 'SM_Rifle_TP', snd: 'S_RifleShot', off: [0.11, -0.17, -0.24], aim: [0, -0.122, -0.16], muzzle: [0.77, 0.03, 0], scope: false },
  pistol: { name: 'Пистолет', dmg: 25, head: 4, int: 0.16, auto: false, mag: 12, res: 48, reload: 1.6, base: 0.3, move: 1.6, jump: 4, rs: 0.45, rp: 0.9, ry: 0.3, range: 70, fov: 50, equip: 0.35, speed: 4.8, fp: 'SM_Pistol_FP', tp: 'SM_Pistol_TP', snd: 'S_PistolShot', off: [0.08, -0.13, -0.3], aim: [0, -0.064, -0.24], muzzle: [0.16, 0.035, 0], scope: false },
  sniper: { name: 'Снайперка', dmg: 100, head: 2.5, int: 1.4, auto: false, mag: 5, res: 20, reload: 3, base: 0.02, move: 6, jump: 10, rs: 0, rp: 3.5, ry: 0.6, range: 200, fov: 12, equip: 0.8, speed: 4.0, fp: 'SM_Sniper_FP', tp: 'SM_Sniper_TP', snd: 'S_SniperShot', off: [0.11, -0.17, -0.22], aim: [0, -0.14, -0.1], muzzle: [1.1, 0.03, 0], scope: true },
};
const BASE_FOV = 62;

// ======================================================================= fighters
class Fighter {
  constructor(team, name, isPlayer, pidx, spawn, yaw) {
    Object.assign(this, { team, name, isPlayer, pidx, yaw, pitch: 0, hp: 100, dead: false });
    this.pos = spawn.clone(); this.vel = new THREE.Vector3(); this.onGround = true;
    this.crouch = false; this.crouchT = 0; this.walk = false; this.aiming = false; this.aimAlpha = 0;
    this.weapons = ['rifle', 'pistol', 'sniper'].map(t => ({ t, mag: WEAPONS[t].mag, res: WEAPONS[t].res }));
    this.slot = 0; this.prevSlot = 1;
    this.trigger = false; this.reloading = false; this.reloadStart = 0; this.equipStart = -100; this.lastFire = -100; this.heat = 0; this.kick = 0;
    this.lastShot = -100; this.lastStep = -100; this.lastDmg = -100; this.dmgFrom = new THREE.Vector3();
    this.hitT = -100; this.hitHead = false; this.hitKill = false; this.flashEnd = 0; this.boltT = 0;
    this.legPhase = 0; this.stepAccum = 0; this.deathT = 0; this.fall = 1;
    this.wish = new THREE.Vector2(); this.jumpReq = false; this.bot = null;
    this.buildBody();
  }
  get def() { return WEAPONS[this.weapons[this.slot].t]; }
  get w() { return this.weapons[this.slot]; }
  height() { return lerp(1.84, 1.16, this.crouchT); }
  eyeY() { return this.pos.y + lerp(1.62, 0.98, this.crouchT); }
  eye() { return new THREE.Vector3(this.pos.x, this.eyeY(), this.pos.z); }
  head() { return new THREE.Vector3(this.pos.x, this.pos.y + this.height() - 0.16, this.pos.z); }
  chest() { return new THREE.Vector3(this.pos.x, this.pos.y + this.height() * 0.68, this.pos.z); }
  aimDir() { const cp = Math.cos(this.pitch); return new THREE.Vector3(Math.cos(this.yaw) * cp, Math.sin(this.pitch), -Math.sin(this.yaw) * cp); }
  forward() { return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  right() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  setPrimary(t) { this.weapons[0] = { t, mag: WEAPONS[t].mag, res: WEAPONS[t].res }; this.applyWeaponMesh(); }

  buildBody() {
    const tint = TINT[this.team];
    this.group = new THREE.Group();
    this.torso = new THREE.Group(); this.group.add(this.torso);
    const t = new THREE.Mesh(geo('SM_Soldier_Torso', tint), MAT); t.castShadow = true; this.torso.add(t);
    const mkLeg = (z) => { const p = new THREE.Group(); p.position.set(0, 0.92, z); const m = new THREE.Mesh(geo('SM_Soldier_Leg', tint), MAT); m.castShadow = true; p.add(m); this.torso.add(p); return p; };
    this.legL = mkLeg(-0.11); this.legR = mkLeg(0.11);
    this.tpw = new THREE.Mesh(geo(this.def.tp), MAT); this.tpw.castShadow = true; this.tpw.position.set(0.30, 1.235, 0.08); this.torso.add(this.tpw);
    this.tpFlash = new THREE.Mesh(geo('SM_MuzzleFlash'), MAT_GLOW); this.tpFlash.visible = false; this.tpw.add(this.tpFlash);
    this.tpFlash.position.set(...this.def.muzzle);
    this.group.visible = !this.isPlayer;
    scene.add(this.group);
  }
  applyWeaponMesh() {
    this.tpw.geometry = geo(this.def.tp);
    this.tpFlash.position.set(...this.def.muzzle);
    if (this.isPlayer) FP.setWeapon(this.def);
  }
  dispose() { scene.remove(this.group); }

  canMove() { return !this.dead && GM.state === 'live'; }
  busy() { return this.reloading || GM.time < this.equipStart + this.def.equip; }
  canShoot() { return this.canMove() && !this.busy(); }
  spread() {
    const d = this.def, sp = clamp(Math.hypot(this.vel.x, this.vel.z) / 4.4, 0, 1);
    let s = d.base + d.move * sp * sp + (this.onGround ? 0 : d.jump) + this.heat * d.rs;
    if (this.crouch) s *= 0.7;
    if (this.aiming) s *= 0.45;
    if (d.scope && this.aimAlpha < 0.85) s += 8;
    return s;
  }
  startFire() { if (this.dead) return; this.trigger = true; if (this.canShoot() && GM.time - this.lastFire >= this.def.int) this.fire(); }
  stopFire() { this.trigger = false; }
  reload() {
    if (this.dead || this.reloading) return;
    const w = this.w; if (w.mag >= this.def.mag || w.res <= 0) return;
    this.reloading = true; this.reloadStart = GM.time;
    Snd.play('S_Reload', { pos: this.pos, vol: 0.7, falloff: 18, pitch: 0 });
  }
  equip(s) {
    s = clamp(s, 0, 2); if (this.dead || s === this.slot) return;
    this.reloading = false; this.prevSlot = this.slot; this.slot = s; this.equipStart = GM.time; this.trigger = false; this.heat = 0;
    this.applyWeaponMesh();
    Snd.play('S_Equip', { pos: this.pos, vol: 0.5, falloff: 12 });
  }
  fire() {
    const d = this.def, w = this.w; this.lastFire = GM.time;
    if (w.mag <= 0) { Snd.play('S_Empty', { pos: this.pos, vol: 0.6, falloff: 15 }); this.trigger = false; if (w.res > 0) this.reload(); return; }
    if (!d.auto) this.trigger = false;
    w.mag--; this.lastShot = GM.time;
    const eye = this.eye(), aim = this.aimDir();
    // random direction inside the spread cone
    const half = this.spread() * 0.5 * DEG, a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * Math.tan(half);
    const up = Math.abs(aim.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(aim, up).normalize(), v = new THREE.Vector3().crossVectors(u, aim).normalize();
    const dir = aim.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize();
    const hit = raycast(eye, dir, d.range, 'bullet', this);
    const end = eye.clone().addScaledVector(dir, Math.min(hit.t, d.range));
    if (hit.fighter && hit.fighter.team !== this.team) {
      const V = hit.fighter, relY = end.y - V.pos.y, H = V.height();
      const head = relY > H - 0.3;
      let dmg = d.dmg * (head ? d.head : 1);
      if (relY < H * 0.35) dmg *= 0.75;
      dmg *= lerp(1, 0.75, clamp((hit.t - 20) / 40, 0, 1));
      V.applyHit(dmg, head, this, w.t, dir);
      this.hitT = GM.time; this.hitHead = head; this.hitKill = V.dead;
      if (this.isPlayer) Snd.play(head ? 'S_Headshot' : 'S_HitMarker', { vol: head ? 0.55 : 0.45 });
      spawnPuff(end, true);
    } else if (hit.t < d.range) spawnPuff(end, false);
    const muzzle = this.muzzleWorld();
    spawnTracer(muzzle, end);
    this.flashEnd = GM.time + 0.05;
    Snd.play(d.snd, { pos: muzzle, vol: this.isPlayer ? 0.8 : 1, falloff: 95, pitch: 0.04 });
    this.heat = Math.min(this.heat + 1, 12);
    this.pitch = clamp(this.pitch + d.rp * (0.7 + 0.06 * this.heat) * DEG, -1.5, 1.5);
    this.yaw += rand(-d.ry, d.ry) * DEG;
    this.kick = 1;
    if (d.scope) this.boltT = GM.time + 0.45;
    if (w.mag === 0 && w.res > 0) this.reload();
  }
  muzzleWorld() {
    if (this.isPlayer && !this.dead) return this.eye().addScaledVector(this.aimDir(), 0.6).addScaledVector(this.right(), 0.1).add(new THREE.Vector3(0, -0.08, 0));
    this.group.updateMatrixWorld(true);
    return this.tpw.localToWorld(new THREE.Vector3(...this.def.muzzle));
  }
  applyHit(dmg, head, from, weapon, dir) {
    if (this.dead || (from && from.team === this.team && from !== this)) return;
    this.hp -= dmg; this.lastDmg = GM.time; this.dmgFrom.copy(from ? from.pos : this.pos);
    if (this.isPlayer) Snd.play('S_Hurt', { vol: 0.8 });
    if (this.bot) this.bot.notifyDamaged(from);
    if (this.hp <= 0) { this.hp = 0; this.die(from, head, weapon, dir); }
  }
  die(killer, head, weapon, dir) {
    this.dead = true; this.deathT = GM.time; this.trigger = false; this.reloading = false; this.aiming = false;
    this.fall = dir.dot(this.forward()) > 0 ? -1 : 1;
    this.group.visible = true;
    if (this.isPlayer) FP.group.visible = false;
    GM.onKilled(this, killer, head, weapon);
  }

  update(dt) {
    const now = GM.time, d = this.def;
    if (this.dead) {
      const t = clamp((now - this.deathT) / 0.5, 0, 1), e = t * t;
      this.torso.rotation.z = this.fall * 1.45 * e;
      this.torso.position.y = -0.1 * e;
      return;
    }
    if (this.reloading && now - this.reloadStart >= d.reload) {
      const w = this.w, take = Math.min(d.mag - w.mag, w.res); w.mag += take; w.res -= take; this.reloading = false;
    }
    if (this.trigger && d.auto && this.canShoot() && now - this.lastFire >= d.int) this.fire();
    if (now - this.lastFire > d.int * 1.6) this.heat = Math.max(0, this.heat - dt * 12);
    if (this.boltT > 0 && now >= this.boltT) { this.boltT = 0; Snd.play('S_Bolt', { pos: this.pos, vol: 0.6, falloff: 15 }); }
    this.aimAlpha = lerp(this.aimAlpha, (this.aiming && !this.busy()) ? 1 : 0, 1 - Math.exp(-dt * (d.scope ? 9 : 14)));
    this.crouchT = lerp(this.crouchT, this.crouch ? 1 : 0, 1 - Math.exp(-dt * 12));
    this.physics(dt);
    this.animate(dt);
  }
  physics(dt) {
    const d = this.def;
    let speed = d.speed; if (this.walk) speed = 2.2; if (this.aiming) speed = Math.min(speed, 2.6); if (this.crouch) speed = this.walk ? 1.3 : 1.7;
    const f = this.forward(), r = this.right();
    let wx = 0, wz = 0;
    if (this.canMove()) { wx = f.x * this.wish.x + r.x * this.wish.y; wz = f.z * this.wish.x + r.z * this.wish.y; const l = Math.hypot(wx, wz); if (l > 1) { wx /= l; wz /= l; } }
    const acc = this.onGround ? 40 : 8, k = 1 - Math.exp(-acc * dt / 4);
    this.vel.x = lerp(this.vel.x, wx * speed, k); this.vel.z = lerp(this.vel.z, wz * speed, k);
    if (this.jumpReq && this.onGround && this.canMove() && !this.crouch) { this.vel.y = 5.3; this.onGround = false; }
    this.jumpReq = false;
    this.vel.y -= 18 * dt;
    let nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    const feet = this.pos.y, H = this.height(), rad = 0.34;
    for (let pass = 0; pass < 2; pass++) {
      for (const o of MapD.obs) {
        if (!o.move) continue;
        const dx = nx - o.x, dz = nz - o.z;
        if (dx * dx + dz * dz > (o.R + rad + 0.5) ** 2) continue;
        if (o.h1 <= feet + 0.45 || o.h0 >= feet + H) continue;
        if (!o.box) {
          const dd = Math.hypot(dx, dz), m = o.r + rad;
          if (dd < m && dd > 1e-5) { nx = o.x + dx / dd * m; nz = o.z + dz / dd * m; }
        } else {
          const lx = dx * o.cs + dz * o.sn, lz = -dx * o.sn + dz * o.cs;
          const cx = clamp(lx, -o.hx, o.hx), cz = clamp(lz, -o.hz, o.hz);
          let px = lx - cx, pz = lz - cz, dd = Math.hypot(px, pz);
          if (dd < rad) {
            let ox, oz;
            if (dd > 1e-5) { ox = px / dd * (rad - dd); oz = pz / dd * (rad - dd); }
            else { // center inside the box: push out along the shallow axis
              const ex = o.hx - Math.abs(lx), ez = o.hz - Math.abs(lz);
              if (ex < ez) { ox = Math.sign(lx || 1) * (ex + rad); oz = 0; } else { ox = 0; oz = Math.sign(lz || 1) * (ez + rad); }
            }
            nx += ox * o.cs - oz * o.sn; nz += ox * o.sn + oz * o.cs;
          }
        }
      }
    }
    nx = clamp(nx, -HALF_X + 0.5, HALF_X - 0.5); nz = clamp(nz, -HALF_Z + 0.5, HALF_Z - 0.5);
    // ground: terrain or the top of a low obstacle we stand on
    let ground = heightAt(nx, nz);
    if (Math.abs(nx) < 3.75 && Math.abs(nz) < 2.75) ground = Math.max(ground, heightAt(0, 0) + 0.09);
    for (const o of MapD.obs) {
      if (!o.move || o.h1 > feet + 0.45) continue;
      const dx = nx - o.x, dz = nz - o.z;
      if (dx * dx + dz * dz > (o.R + 0.3) ** 2) continue;
      let inside;
      if (!o.box) inside = Math.hypot(dx, dz) < o.r + 0.15;
      else { const lx = dx * o.cs + dz * o.sn, lz = -dx * o.sn + dz * o.cs; inside = Math.abs(lx) < o.hx + 0.15 && Math.abs(lz) < o.hz + 0.15; }
      if (inside) ground = Math.max(ground, o.h1);
    }
    let ny = this.pos.y + this.vel.y * dt;
    if (ny <= ground || (this.onGround && this.vel.y <= 0 && ny - ground < 0.5)) { ny = ground; this.vel.y = 0; this.onGround = true; }
    else this.onGround = false;
    this.pos.set(nx, ny, nz);
    // footsteps
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && sp > 1.2) {
      this.stepAccum += sp * dt;
      if (this.stepAccum > 2.1) {
        this.stepAccum = 0;
        if (!this.walk && !this.crouch && sp > 3) { this.lastStep = GM.time; Snd.play('S_Footstep', { pos: this.pos, vol: this.isPlayer ? 0.3 : 0.9, falloff: 24, pitch: 0.15 }); }
      }
    } else this.stepAccum = 0;
  }
  animate(dt) {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const drop = 0.42 * this.crouchT;
    this.torso.position.y = -drop;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.legPhase += dt * sp * 2.1;
    const amp = this.onGround ? clamp(sp / 4.4, 0, 1) * 32 * DEG : 18 * DEG, sw = Math.sin(this.legPhase) * amp, bend = 62 * DEG * this.crouchT;
    this.legL.rotation.z = sw + bend; this.legR.rotation.z = -sw + bend * 0.8;
    const flash = GM.time < this.flashEnd;
    this.tpFlash.visible = flash;
    if (flash) this.tpFlash.rotation.x = Math.random() * 1.6;
  }
}

// ---------------------------------------------------------------- first person weapon
const FP = {
  group: new THREE.Group(), mesh: null, flash: null, sway: new THREE.Vector2(), swayIn: new THREE.Vector2(), bob: 0,
  init() {
    wCam.add(this.group);
    this.mesh = new THREE.Mesh(geo('SM_Rifle_FP', TINT.blue), MAT); this.mesh.rotation.y = Math.PI / 2; this.group.add(this.mesh);
    this.flash = new THREE.Mesh(geo('SM_MuzzleFlash'), MAT_GLOW); this.flash.visible = false; this.mesh.add(this.flash);
  },
  setWeapon(d) { this.mesh.geometry = geo(d.fp, TINT.blue); this.flash.position.set(...d.muzzle); },
  update(f, dt) {
    const d = f.def, a = f.aimAlpha;
    const base = new THREE.Vector3(...d.off).lerp(new THREE.Vector3(...d.aim), a);
    const sp = Math.hypot(f.vel.x, f.vel.z), sf = clamp(sp / 4.4, 0, 1) * (f.onGround ? 1 : 0), bs = sf * (1 - a * 0.85);
    this.bob += dt * (3 + 8 * sf);
    base.x += Math.sin(this.bob) * 0.008 * bs; base.y += (Math.abs(Math.cos(this.bob)) - 0.5) * 0.009 * bs;
    this.sway.lerp(new THREE.Vector2(clamp(-this.swayIn.x * 0.0006, -0.03, 0.03), clamp(this.swayIn.y * 0.0006, -0.03, 0.03)).multiplyScalar(1 - a * 0.7), 1 - Math.exp(-dt * 9));
    this.swayIn.set(0, 0);
    base.x += this.sway.x; base.y += this.sway.y;
    f.kick = lerp(f.kick, 0, 1 - Math.exp(-dt * 16));
    base.z += f.kick * (d.auto ? 0.025 : d.scope ? 0.07 : 0.04);
    let rx = f.kick * (d.auto ? 2 : d.scope ? 11 : 7) * DEG, rz = 0;
    if (f.reloading) { const p = Math.sin(clamp((GM.time - f.reloadStart) / d.reload, 0, 1) * Math.PI); base.y -= 0.09 * p; base.z += 0.04 * p; rz -= 28 * DEG * p; rx += 8 * DEG * p; }
    const e = clamp((GM.time - f.equipStart) / d.equip, 0, 1);
    if (e < 1) { const inv = (1 - e) * (1 - e); base.y -= 0.2 * inv; rx -= 35 * DEG * inv; }
    this.group.position.copy(base);
    this.group.rotation.set(rx, 0, rz + Math.sin(this.bob) * 1.2 * DEG * bs);
    this.group.visible = !f.dead && !(d.scope && a > 0.8);
    const flash = GM.time < f.flashEnd; this.flash.visible = flash;
    if (flash) { this.flash.rotation.x = Math.random() * 1.6; this.flash.scale.setScalar(rand(0.8, 1.3)); }
    flashLight.intensity = flash ? 12 : 0;
    if (flash) flashLight.position.copy(f.eye().addScaledVector(f.aimDir(), 0.8));
  },
};

// ======================================================================= bots
class Bot {
  constructor(f, lane) { this.f = f; f.bot = this; this.lane = lane; this.laneIdx = 1; this.target = null; this.lastSeen = -100; this.lastSeenPos = new THREE.Vector3(); this.nextPerc = 0;
    Object.assign(this, { acq: 0, react: 0.4, aimHead: false, aimErr: new THREE.Vector3(), errT: 0, burstEnd: 0, pauseEnd: 0, strafe: 0, strafeT: 0, crouchFight: false,
      goal: null, hasGoal: false, holding: false, didHold: false, holdArrived: false, holdDur: 0, holdUntil: 0, holdLook: new THREE.Vector3(), alertUntil: 0,
      inv: false, invPos: new THREE.Vector3(), invPri: 0, invUntil: 0, lookAround: 0, lookPt: new THREE.Vector3(), lookUntil: 0,
      path: [], pathIdx: 0, pathGoal: new THREE.Vector2(1e9, 1e9), repath: 0, stuck: 0, lastJump: 0, side: new THREE.Vector2(), sideUntil: 0 }); }
  enemies() { return GM.fighters.filter(e => !e.dead && e.team !== this.f.team); }
  canSee(e) {
    const f = this.f, eye = f.eye(), to = e.chest().sub(eye), dist = to.length();
    if (dist > Settings.sight()) return false;
    if (dist > 3.5 && to.clone().divideScalar(dist).dot(f.aimDir()) < 0.42) return false;
    const revealed = GM.time - e.lastShot < 1 || dist < 5;
    for (const p of [e.head(), e.chest()]) {
      const dir = p.clone().sub(eye), len = dir.length(); dir.divideScalar(len);
      const hit = raycast(eye, dir, len + 0.5, revealed ? 'bullet' : 'sight', f);
      if (hit.fighter === e || hit.t >= len - 0.05) return true;
    }
    return false;
  }
  lookToward(p, dt, speed) {
    const f = this.f, e = f.eye(), dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z;
    const dyaw = Math.atan2(-dz, dx), dpitch = Math.atan2(dy, Math.hypot(dx, dz));
    const max = 7.3 * dt, k = clamp(dt * speed, 0, 1);
    f.yaw += clamp(angNorm(dyaw - f.yaw) * k, -max, max);
    f.pitch += clamp((dpitch - f.pitch) * k, -max, max);
  }
  investigate(p, pri) { if (this.inv && pri < this.invPri && GM.time < this.invUntil) return; this.inv = true; this.invPos.copy(p); this.invPri = pri; this.invUntil = GM.time + 12; this.holding = false; }
  notifyDamaged(from) { if (!from) return; this.lookPt.copy(from.pos); this.lookUntil = GM.time + 1.2; this.alertUntil = GM.time + 2.5; if (!this.target) this.investigate(from.pos, 4); }
  listen() {
    for (const e of this.enemies()) {
      const d = e.pos.distanceTo(this.f.pos);
      if (GM.time - e.lastShot < 0.25 && d < 65) { this.lookPt.copy(e.pos); this.lookUntil = GM.time + 1.2; this.investigate(e.pos.clone().add(new THREE.Vector3(rand(-1, 1) * d * 0.08, 0, rand(-1, 1) * d * 0.08)), 3); }
      else if (GM.time - e.lastStep < 0.25 && d < 15) { this.lookPt.copy(e.pos); this.lookUntil = GM.time + 1.5; if (Math.random() < 0.5) this.investigate(e.pos, 2); }
    }
  }
  update(dt) {
    const f = this.f; if (f.dead) { f.stopFire(); return; }
    f.wish.set(0, 0);
    if (GM.state !== 'live') {
      f.stopFire();
      if (GM.state === 'freeze') { const L = MapD.lanes[f.team][this.lane]; this.lookToward(L[1].clone().add(new THREE.Vector3(0, 1.5, 0)), dt, 3); }
      return;
    }
    const now = GM.time;
    if (now >= this.nextPerc) {
      this.nextPerc = now + 0.1;
      let seen = null, best = 1e9;
      for (const e of this.enemies()) { if (!this.canSee(e)) continue; const d = e.pos.distanceTo(f.pos); if (d < best) { best = d; seen = e; } }
      if (seen) {
        if (seen !== this.target) {
          const tracking = now - this.lastSeen < 1.2 && seen.pos.distanceTo(this.lastSeenPos) < 6;
          this.target = seen; this.acq = now;
          this.react = rand(0.28, 0.6) + (best > 30 ? 0.15 : 0);
          if (tracking || now < this.alertUntil) this.react *= 0.5;
          this.react *= Settings.reactMult(); if (f.def.scope) this.react += 0.35;
          this.aimHead = Math.random() < 0.3; this.crouchFight = best > 22 && Math.random() < 0.35; this.errT = 0; this.burstEnd = this.pauseEnd = 0;
        }
        this.lastSeen = now; this.lastSeenPos.copy(seen.pos);
      } else this.listen();
    }
    if (this.target && this.target.dead) { this.target = null; f.stopFire(); }
    if (this.target && now - this.lastSeen < 0.35) { this.engage(dt, this.target); return; }
    f.stopFire(); f.aiming = false;
    if (this.crouchFight || f.crouch) { f.crouch = false; this.crouchFight = false; }
    if (this.target) { this.investigate(this.lastSeenPos, 2.5); this.target = null; }
    this.roam(dt);
  }
  engage(dt, T) {
    const f = this.f, now = GM.time, eye = f.eye(), dist = eye.distanceTo(T.pos);
    this.holding = false; this.inv = false; f.walk = false;
    if (now >= this.errT) {
      this.errT = now + rand(0.18, 0.32);
      const track = clamp((now - this.acq) / 1.3, 0, 1);
      let err = lerp(0.7 + dist * 0.03, 0.08 + dist * 0.012, track);
      if (Math.hypot(f.vel.x, f.vel.z) > 1) err *= 1.25;
      err *= Settings.aimMult();
      this.aimErr.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(err * rand(0.3, 1));
    }
    const aimPt = (this.aimHead ? T.head() : T.chest()).add(this.aimErr);
    this.lookToward(aimPt, dt, 10);
    const want = aimPt.clone().sub(eye).normalize();
    const ang = Math.acos(clamp(want.dot(f.aimDir()), -1, 1)) / DEG;
    const tol = Math.max(3, Math.atan(0.7 / Math.max(dist, 0.01)) / DEG);
    const ready = now - this.acq >= this.react && ang < tol;
    const w = f.w;
    if (w.mag === 0 && !f.busy()) { f.stopFire(); if (w.res > 0) f.reload(); else if (f.slot === 0) f.equip(1); }
    if (ready && !f.busy() && w.mag > 0) {
      const d = f.def;
      if (d.auto) {
        if (now < this.burstEnd) f.startFire();
        else if (now < this.pauseEnd) f.stopFire();
        else { this.burstEnd = now + (dist < 12 ? rand(0.5, 1.1) : dist < 28 ? rand(0.25, 0.5) : rand(0.12, 0.25)); this.pauseEnd = this.burstEnd + rand(0.15, 0.4); f.startFire(); }
      } else if (now - f.lastFire > d.int + rand(0.05, 0.25)) { f.startFire(); f.stopFire(); }
    } else if (!ready) f.stopFire();
    f.aiming = f.def.scope ? dist > 7 : dist > 25;
    if (this.crouchFight) { f.crouch = true; return; }
    if (now >= this.strafeT) { this.strafeT = now + rand(0.35, 0.9); const r = Math.random(); this.strafe = r < 0.4 ? -1 : r < 0.8 ? 1 : 0; }
    if (this.strafe) {
      const rv = f.right();
      if (!isWalkable(f.pos.x + rv.x * this.strafe * 1.2, f.pos.z + rv.z * this.strafe * 1.2)) this.strafe = -this.strafe;
      else f.wish.set(0, this.strafe * 0.9);
    }
  }
  planNext() {
    const f = this.f, L = MapD.lanes[f.team][this.lane], late = GM.timeLeft() < 35;
    if (this.laneIdx < L.length) {
      if (this.laneIdx === 2 && !this.didHold && !late && Math.random() < 0.5) {
        const H = MapD.holds[f.team]; let bi = -1, bd = 1e9;
        H.forEach((h, i) => { const d = Math.hypot(h.x - L[1].x, h.z - L[1].z) + rand(0, 6); if (d < bd) { bd = d; bi = i; } });
        if (bi >= 0) { Object.assign(this, { didHold: true, holding: true, holdArrived: false, holdDur: rand(5, 12), holdUntil: GM.time + 30, goal: H[bi].clone(), hasGoal: true }); this.holdLook.copy(L[Math.min(this.laneIdx + 1, L.length - 1)]).y += 1.5; return; }
      }
      const p = L[this.laneIdx++]; this.goal = randomWalkable(p.x, p.z, 1.8); this.hasGoal = true; return;
    }
    const enemyX = f.team === 'blue' ? 36 : -36;
    this.goal = randomWalkable(enemyX * rand(0.2, 0.9), rand(-22, 22), 9); this.hasGoal = true;
  }
  moveTo(goal, dt, accept) {
    const f = this.f, now = GM.time;
    if (Math.hypot(f.pos.x - goal.x, f.pos.z - goal.z) < accept) return true;
    if (Math.hypot(this.pathGoal.x - goal.x, this.pathGoal.y - goal.z) > 1 || now > this.repath || this.pathIdx >= this.path.length) {
      this.pathGoal.set(goal.x, goal.z); this.repath = now + 2; this.pathIdx = 0;
      this.path = findPath(f.pos.x, f.pos.z, goal.x, goal.z) || [new THREE.Vector2(goal.x, goal.z)];
    }
    while (this.pathIdx < this.path.length - 1 && Math.hypot(f.pos.x - this.path[this.pathIdx].x, f.pos.z - this.path[this.pathIdx].y) < 0.8) this.pathIdx++;
    const nx = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    let dx = nx.x - f.pos.x, dz = nx.y - f.pos.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (Math.hypot(f.vel.x, f.vel.z) < 0.5) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 0.7 && now - this.lastJump > 1.2) { f.jumpReq = true; this.lastJump = now; }
    if (this.stuck > 1.6) { const s = Math.random() < 0.5 ? 1 : -1; this.side.set(-dz * s, dx * s); this.sideUntil = now + 0.6; this.stuck = 0; this.repath = 0; }
    if (now < this.sideUntil) { dx = dx * 0.3 + this.side.x; dz = dz * 0.3 + this.side.y; const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m; }
    // world direction -> local wish (forward/right)
    const fw = f.forward(), rt = f.right();
    f.wish.set(dx * fw.x + dz * fw.z, dx * rt.x + dz * rt.z);
    if (now < this.lookUntil) this.lookToward(this.lookPt.clone().add(new THREE.Vector3(0, 0.6, 0)), dt, 7);
    else this.lookToward(f.eye().add(new THREE.Vector3(dx * 10, 0, dz * 10)), dt, 5);
    return false;
  }
  roam(dt) {
    const f = this.f, now = GM.time, w = f.w;
    if (!f.busy() && w.mag < f.def.mag * 0.5 && w.res > 0 && now - this.lastSeen > 1.5) f.reload();
    if (f.slot === 1 && !f.busy() && f.weapons[0].mag + f.weapons[0].res > 0) f.equip(0);
    f.aiming = false;
    if (now < this.lookAround) { f.yaw += 1.9 * dt; f.pitch = lerp(f.pitch, 0, 0.1); return; }
    if (this.inv) {
      if (now > this.invUntil) this.inv = false;
      else {
        f.walk = Math.hypot(f.pos.x - this.invPos.x, f.pos.z - this.invPos.z) < 14 && this.invPri < 4;
        if (this.moveTo(this.invPos, dt, 1.6)) { this.inv = false; this.lookAround = now + rand(1, 2); f.walk = false; }
        return;
      }
    }
    f.walk = false;
    if (this.holding) {
      if (!this.holdArrived) {
        if (this.moveTo(this.goal, dt, 0.9)) { this.holdArrived = true; this.holdUntil = now + this.holdDur; if (Math.random() < 0.4) f.crouch = true; }
        if (now > this.holdUntil) this.holding = false;
        return;
      }
      if (now > this.holdUntil || GM.timeLeft() < 35) { this.holding = false; this.hasGoal = false; f.crouch = false; }
      else { const look = this.holdLook.clone().add(new THREE.Vector3(Math.sin(now * 0.7) * 5, 0, Math.cos(now * 0.5) * 5)); this.lookToward(now < this.lookUntil ? this.lookPt : look, dt, 3); return; }
    }
    if (!this.hasGoal) this.planNext();
    if (this.moveTo(this.goal, dt, 2)) this.hasGoal = false;
  }
}

// ======================================================================= game mode
const GM = {
  state: 'loading', time: 0, stateEnd: 0, round: 0, sb: 0, sr: 0, fighters: [], bots: [], feed: [],
  parts: [{ name: 'Вы', team: 'blue', me: true }, { name: 'Сокол', team: 'blue' }, { name: 'Кабан', team: 'red' }, { name: 'Волк', team: 'red' }].map(p => ({ ...p, k: 0, d: 0 })),
  center: { t: '', s: '', color: '#fff', until: 0 }, playerDeathT: -1, killedBy: '', spec: null, winner: null, paused: false,
  FREEZE: 4, ROUND: 105, POST: 5,
  timeLeft() { return Math.max(0, this.stateEnd - this.time); },
  inMatch() { return this.state === 'freeze' || this.state === 'live' || this.state === 'post'; },
  player() { return this.fighters.find(f => f.isPlayer); },
  alive(team) { return this.fighters.filter(f => f.team === team && !f.dead).length; },
  show(t, s, color, dur) { this.center = { t, s, color, until: this.time + dur }; },
  clear() { for (const f of this.fighters) f.dispose(); this.fighters = []; this.bots = []; },
  spawn(team, slot, pidx, isPlayer) {
    const side = team === 'blue' ? -1 : 1, x = 36 * side, z = (slot === 0 ? -2.6 : 2.6) * -side;
    const f = new Fighter(team, this.parts[pidx].name, isPlayer, pidx, new THREE.Vector3(x, heightAt(x, z), z), team === 'blue' ? 0 : Math.PI);
    this.fighters.push(f);
    return f;
  },
  startMatch() { this.sb = this.sr = 0; this.round = 0; this.winner = null; this.feed = []; this.parts.forEach(p => { p.k = 0; p.d = 0; }); UI.hideMatchEnd(); this.startRound(); },
  startRound() {
    this.clear(); this.round++; this.playerDeathT = -1; this.killedBy = ''; this.spec = null;
    const me = this.spawn('blue', 0, 0, true);
    const ally = this.spawn('blue', 1, 1, false), e1 = this.spawn('red', 0, 2, false), e2 = this.spawn('red', 1, 3, false);
    for (const b of [ally, e1, e2]) if (Math.random() < 0.3) b.setPrimary('sniper');
    const l1 = Math.floor(Math.random() * 3), l2 = (l1 + 1 + Math.floor(Math.random() * 2)) % 3;
    this.bots = [new Bot(ally, Math.floor(Math.random() * 3)), new Bot(e1, l1), new Bot(e2, l2)];
    me.applyWeaponMesh(); FP.group.visible = true;
    this.state = 'freeze'; this.stateEnd = this.time + this.FREEZE;
    this.show('РАУНД ' + this.round, `Синие ${this.sb} : ${this.sr} Красные  •  до ${Settings.rounds} побед`, '#fff', this.FREEZE);
  },
  onKilled(v, killer, head, weapon) {
    this.parts[v.pidx].d++;
    if (killer && killer !== v && killer.team !== v.team) this.parts[killer.pidx].k++;
    this.feed.push({ k: killer ? killer.name : '', kt: killer ? killer.team : '', v: v.name, vt: v.team, head, w: weapon, t: this.time });
    if (this.feed.length > 6) this.feed.shift();
    UI.feedDirty = true;
    if (v.isPlayer) { this.playerDeathT = this.time; this.killedBy = killer ? killer.name : ''; }
    const b = this.alive('blue'), r = this.alive('red');
    if (b === 0 || r === 0) this.endRound(b === 0 && r === 0 ? null : b === 0 ? 'red' : 'blue', 'Команда противника уничтожена');
  },
  endRound(win, reason) {
    if (this.state !== 'live') return;
    if (win === 'blue') this.sb++; if (win === 'red') this.sr++;
    this.fighters.forEach(f => f.stopFire());
    if (this.sb >= Settings.rounds || this.sr >= Settings.rounds) {
      this.state = 'matchover'; this.winner = this.sb >= Settings.rounds ? 'blue' : 'red';
      const w = this.winner === 'blue';
      this.show(w ? 'ПОБЕДА!' : 'ПОРАЖЕНИЕ', `Итог матча  ${this.sb} : ${this.sr}`, w ? '#7dff8a' : '#ff6a5a', 1e9);
      Snd.play(w ? 'S_RoundWin' : 'S_RoundLose', { vol: 0.8 });
      UI.showMatchEnd();
      return;
    }
    this.state = 'post'; this.stateEnd = this.time + this.POST;
    const title = win ? (win === 'blue' ? 'СИНИЕ' : 'КРАСНЫЕ') + ' ВЗЯЛИ РАУНД' : 'НИЧЬЯ';
    this.show(title, reason, win === 'blue' ? '#6fa3ff' : win === 'red' ? '#ff6a5a' : '#fff', this.POST);
    if (win) Snd.play(win === 'blue' ? 'S_RoundWin' : 'S_RoundLose', { vol: 0.6 });
  },
  update(dt) {
    if (this.state === 'freeze' && this.time >= this.stateEnd) { this.state = 'live'; this.stateEnd = this.time + this.ROUND; this.show('В БОЙ!', '', '#ffd152', 1.2); Snd.play('S_RoundStart', { vol: 0.6 }); }
    else if (this.state === 'live' && this.time >= this.stateEnd) {
      const b = this.alive('blue'), r = this.alive('red'); let w = null;
      if (b !== r) w = b > r ? 'blue' : 'red';
      else { let hb = 0, hr = 0; this.fighters.forEach(f => { if (!f.dead) f.team === 'blue' ? hb += f.hp : hr += f.hp; }); if (Math.abs(hb - hr) > 1) w = hb > hr ? 'blue' : 'red'; }
      this.endRound(w, 'Время вышло');
    } else if (this.state === 'post' && this.time >= this.stateEnd) this.startRound();
    if (this.feed.length && this.time - this.feed[0].t > 8) { this.feed.shift(); UI.feedDirty = true; }
    const p = this.player();
    if (p && p.dead && this.playerDeathT >= 0 && this.time - this.playerDeathT > 2.5 && (!this.spec || this.spec.dead)) {
      this.spec = this.fighters.find(f => !f.dead && f.team === 'blue') || this.fighters.find(f => !f.dead) || null;
    }
  },
};

// ======================================================================= input
const Input = { keys: {}, locked: false, mdx: 0, mdy: 0 };
document.addEventListener('pointerlockchange', () => {
  Input.locked = document.pointerLockElement === canvas;
  if (!Input.locked && GM.inMatch() && UI.menu === 'none') UI.open('pause');
  $('clickhint').classList.toggle('hidden', Input.locked || UI.menu !== 'none' || !GM.inMatch());
});
function lockPointer() {
  const fail = () => { if (GM.inMatch() && UI.menu === 'none') $('clickhint').classList.remove('hidden'); };
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(fail); } catch (e) { fail(); }
}
canvas.addEventListener('click', () => { if (GM.inMatch() && UI.menu === 'none' && !Input.locked) lockPointer(); });
$('clickhint').addEventListener('click', () => lockPointer());
document.addEventListener('mousemove', (e) => { if (!Input.locked) return; Input.mdx += e.movementX; Input.mdy += e.movementY; });
document.addEventListener('mousedown', (e) => {
  Snd.resume();
  const p = GM.player(); if (!Input.locked || !p) return;
  if (e.button === 0) p.startFire(); if (e.button === 2) p.aiming = true;
});
document.addEventListener('mouseup', (e) => { const p = GM.player(); if (!p) return; if (e.button === 0) p.stopFire(); if (e.button === 2) p.aiming = false; });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => { const p = GM.player(); if (Input.locked && p) p.equip(p.prevSlot); }, { passive: true });
document.addEventListener('keydown', (e) => {
  Input.keys[e.code] = true;
  if (e.code === 'Tab') e.preventDefault();
  const p = GM.player(); if (!p || !Input.locked) return;
  switch (e.code) {
    case 'KeyR': p.reload(); break;
    case 'Digit1': p.equip(0); break; case 'Digit2': p.equip(1); break; case 'Digit3': p.equip(2); break;
    case 'KeyQ': p.equip(p.prevSlot); break;
    case 'Space': p.jumpReq = true; e.preventDefault(); break;
  }
});
document.addEventListener('keyup', (e) => { Input.keys[e.code] = false; });
window.addEventListener('blur', () => { Input.keys = {}; const p = GM.player(); if (p) { p.stopFire(); p.aiming = false; } });

function playerInput(p, dt) {
  const k = Input.keys;
  const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0), rt = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
  p.wish.set(fwd, rt);
  p.walk = !!(k.ShiftLeft || k.ShiftRight);
  p.crouch = !!(k.KeyC || k.ControlLeft) && !p.dead;
  if (Input.locked && !p.dead) {
    const fovK = lerp(1, Math.max(0.18, p.def.fov / BASE_FOV * 1.1), p.aimAlpha);
    const s = 0.0022 * Settings.sens * fovK;
    p.yaw -= Input.mdx * s; p.pitch = clamp(p.pitch - Input.mdy * s, -1.5, 1.5);
    FP.swayIn.set(Input.mdx, -Input.mdy);
  }
  Input.mdx = Input.mdy = 0;
}

// ======================================================================= UI
const UI = {
  menu: 'none', back: 'main', feedDirty: true, last: {}, boardT: 0,
  set(id, v) { if (this.last[id] !== v) { this.last[id] = v; $(id).textContent = v; } },
  open(m) {
    this.menu = m;
    for (const id of ['menu', 'settings', 'pause']) $(id).classList.add('hidden');
    if (m === 'main') $('menu').classList.remove('hidden');
    if (m === 'settings') { $('settings').classList.remove('hidden'); this.refreshSettings(); }
    if (m === 'pause') $('pause').classList.remove('hidden');
    GM.paused = m === 'pause' || (m === 'settings' && this.back === 'pause');
    const p = GM.player(); if (p && m !== 'none') { p.stopFire(); p.aiming = false; }
    if (m !== 'none' && document.pointerLockElement) document.exitPointerLock();
    $('clickhint').classList.add('hidden');
    $('menuinfo').textContent = `до ${Settings.rounds} побед  •  сложность: ${Settings.diffName()}`;
  },
  close() { this.open('none'); this.menu = 'none'; GM.paused = false; lockPointer(); },
  refreshSettings() {
    $('v-sens').textContent = Settings.sens.toFixed(1);
    $('v-diff').textContent = Settings.diffName();
    $('v-rounds').textContent = Settings.rounds;
    $('v-vol').textContent = Math.round(Settings.vol * 100) + '%';
    $('v-gfx').textContent = Settings.gfx ? 'Высокая' : 'Низкая (для слабых ПК)';
  },
  showMatchEnd() { $('matchend').classList.remove('hidden'); if (document.pointerLockElement) document.exitPointerLock(); this.menu = 'matchend'; $('clickhint').classList.add('hidden'); },
  hideMatchEnd() { $('matchend').classList.add('hidden'); if (this.menu === 'matchend') this.menu = 'none'; },
  action(a) {
    Snd.resume(); Snd.play('S_Equip', { vol: 0.4 });
    switch (a) {
      case 'play': case 'again': case 'restart': this.hideMatchEnd(); this.open('none'); this.menu = 'none'; GM.paused = false; $('hud').classList.remove('hidden'); GM.startMatch(); lockPointer(); break;
      case 'settings': this.back = this.menu; this.open('settings'); break;
      case 'back': Settings.save(); this.open(this.back); break;
      case 'resume': this.close(); break;
      case 'mainmenu': this.hideMatchEnd(); GM.clear(); GM.state = 'menu'; GM.paused = false; $('hud').classList.add('hidden'); this.open('main'); break;
    }
  },
  init() {
    document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => this.action(b.dataset.act)));
    document.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
      Snd.resume(); const d = +b.dataset.d, k = b.dataset.set;
      if (k === 'sens') Settings.sens = clamp(Math.round((Settings.sens + d * 0.1) * 10) / 10, 0.2, 3);
      if (k === 'diff') Settings.diff = (Settings.diff + d + 3) % 3;
      if (k === 'rounds') { const o = [3, 5, 7, 10]; Settings.rounds = o[(o.indexOf(Settings.rounds) + d + 4) % 4] || 7; }
      if (k === 'vol') Settings.vol = clamp(Math.round((Settings.vol + d * 0.1) * 10) / 10, 0, 1);
      if (k === 'gfx') { Settings.gfx = Settings.gfx ? 0 : 1; applyGfx(); }
      Settings.save(); this.refreshSettings(); Snd.play('S_HitMarker', { vol: 0.4 });
    }));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.menu === 'settings') this.action('back');
    });
    const sl = $('slots'); sl.innerHTML = ['1  Винтовка', '2  Пистолет', '3  Снайперка'].map(t => `<div>${t}</div>`).join('');
  },
  hud(p) {
    const t = GM.time, st = GM.state;
    this.set('sb', String(GM.sb)); this.set('sr', String(GM.sr));
    const pip = (id, team) => { const n = GM.alive(team); const key = id + n; if (this.last[id] !== key) { this.last[id] = key; $(id).querySelectorAll('i').forEach((el, i) => el.style.background = i < n ? (team === 'blue' ? 'var(--blue)' : 'var(--red)') : '#444'); } };
    pip('pb', 'blue'); pip('pr', 'red');
    let timer = '--:--', tc = '#fff';
    if (st === 'live') { const s = Math.ceil(GM.timeLeft()); timer = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (GM.timeLeft() < 15) tc = '#ff6a5a'; }
    else if (st === 'freeze') { timer = '0:' + String(Math.ceil(GM.timeLeft())).padStart(2, '0'); tc = 'var(--gold)'; }
    this.set('timer', timer); $('timer').style.color = tc;
    this.set('round', 'РАУНД ' + GM.round);

    const alive = p && !p.dead;
    $('hp').classList.toggle('hidden', !alive); $('ammo').classList.toggle('hidden', !alive); $('slots').classList.toggle('hidden', !alive);
    if (alive) {
      const hp = Math.ceil(p.hp), hc = hp > 50 ? '#7dff8a' : hp > 25 ? '#ffcc4d' : '#ff5a48';
      this.set('hpv', String(hp)); $('hpbar').style.width = hp + '%'; $('hpbar').style.background = hc; document.querySelector('#hp .plus').style.color = hc;
      const d = p.def, w = p.w;
      this.set('wname', d.name); this.set('mag', String(w.mag)); this.set('res', '/ ' + w.res);
      const low = w.mag <= Math.max(1, d.mag / 4);
      $('mag').style.color = w.mag === 0 ? '#ff5a48' : low ? '#ffcc4d' : '#fff';
      this.set('astatus', p.reloading ? 'ПЕРЕЗАРЯДКА' : (w.mag === 0 && w.res === 0) ? 'НЕТ ПАТРОНОВ' : low ? '[R] перезарядка' : '');
      $('rbar').style.width = p.reloading ? (clamp((t - p.reloadStart) / d.reload, 0, 1) * 100) + '%' : '0';
      if (this.last.slot !== p.slot) { this.last.slot = p.slot; [...$('slots').children].forEach((el, i) => el.classList.toggle('on', i === p.slot)); }
    }
    // crosshair / scope
    const scoped = alive && p.def.scope && p.aimAlpha > 0.8;
    $('scope').classList.toggle('hidden', !scoped);
    $('cross').classList.toggle('hidden', !alive || scoped);
    if (alive && !scoped) {
      const px = Math.tan(p.spread() * 0.5 * DEG) / Math.tan(camera.fov * 0.5 * DEG) * (window.innerHeight * 0.5);
      $('cross').style.setProperty('--g', (6 + px).toFixed(1) + 'px');
      $('cross').style.opacity = String(1 - p.aimAlpha * 0.5);
    }
    const ht = t - (p ? p.hitT : -100);
    $('hit').style.opacity = ht < 0.25 ? String(1 - ht / 0.25) : '0';
    if (p && ht < 0.25) $('hit').style.color = p.hitKill ? '#ff2a14' : p.hitHead ? '#ffd152' : '#fff';
    // damage
    const dt = p ? t - p.lastDmg : 9;
    $('dmg').style.opacity = dt < 0.7 ? String(1 - dt / 0.7) : '0';
    if (p && alive && dt < 0.7) {
      const to = p.dmgFrom.clone().sub(p.pos), rel = Math.atan2(-to.z, to.x) - p.yaw;
      const R = 150, x = window.innerWidth / 2 - Math.sin(rel) * R, y = window.innerHeight / 2 - Math.cos(rel) * R;
      Object.assign($('dmgdir').style, { left: (x - 12) + 'px', top: (y - 12) + 'px', opacity: String(1 - dt / 0.7) });
    } else $('dmgdir').style.opacity = '0';
    // center text, freeze
    const c = GM.center, show = t < c.until && c.t;
    $('center').style.opacity = show ? String(clamp(c.until - t, 0, 1)) : '0';
    if (show) { this.set('ctitle', c.t); this.set('csub', c.s); $('ctitle').style.color = c.color; }
    $('count').textContent = st === 'freeze' ? String(Math.ceil(GM.timeLeft())) : '';
    $('hints').classList.toggle('hidden', st !== 'freeze');
    // death / spectate
    const dead = p && p.dead && st === 'live';
    $('death').classList.toggle('hidden', !dead);
    if (dead) this.set('killer', GM.killedBy ? 'Вас убил: ' + GM.killedBy : '');
    this.set('spec', dead && GM.spec ? `Наблюдение: ${GM.spec.name}  (${Math.ceil(GM.spec.hp)} HP)` : '');
    // feed
    if (this.feedDirty) {
      this.feedDirty = false;
      const wn = { rifle: 'Винтовка', pistol: 'Пистолет', sniper: 'Снайперка' };
      $('feed').innerHTML = GM.feed.map(e => `<div><span class="${e.kt === 'blue' ? 'b' : 'r'}">${e.k}</span> <span class="w">[${wn[e.w]}${e.head ? ', в голову' : ''}]</span> <span class="${e.vt === 'blue' ? 'b' : 'r'}">${e.v}</span></div>`).join('');
    }
    // scoreboard
    const board = (Input.keys.Tab && UI.menu === 'none') || st === 'matchover';
    $('board').classList.toggle('hidden', !board);
    if (board && performance.now() - this.boardT > 250) {
      this.boardT = performance.now();
      let h = `<h2>СЧЁТ МАТЧА &nbsp; ${GM.sb} : ${GM.sr}</h2><table><tr class="th"><td>Игрок</td><td class="n">Убийства</td><td class="n">Смерти</td></tr>`;
      for (const team of ['blue', 'red']) {
        h += `<tr class="tm"><td style="color:var(--${team})">${team === 'blue' ? 'СИНИЕ' : 'КРАСНЫЕ'}</td><td></td><td></td></tr>`;
        for (const q of GM.parts.filter(q => q.team === team)) h += `<tr class="${q.me ? 'me' : ''}"><td>&nbsp;&nbsp;${q.name}</td><td class="n">${q.k}</td><td class="n">${q.d}</td></tr>`;
      }
      $('board').innerHTML = h + '</table>';
    }
    this.radar(p);
  },
  radar(p) {
    const cv = $('radar'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const tx = (x) => (x + HALF_X) / (2 * HALF_X) * W, tz = (z) => (z + HALF_Z) / (2 * HALF_Z) * H;
    g.fillStyle = 'rgba(140,100,60,.9)'; g.fillRect(tx(-4), tz(-3), tx(4) - tx(-4), tz(3) - tz(-3));
    g.fillStyle = 'rgba(76,140,255,.4)'; g.fillRect(tx(-36) - 10, tz(0) - 10, 20, 20);
    g.fillStyle = 'rgba(255,90,72,.4)'; g.fillRect(tx(36) - 10, tz(0) - 10, 20, 20);
    for (const f of GM.fighters) {
      if (f.dead) continue;
      const me = f === p, friend = f.team === 'blue', heard = GM.time - f.lastShot < 1.5;
      if (!friend && !heard) continue;
      const x = tx(f.pos.x), y = tz(f.pos.z), s = me ? 14 : 12;
      g.fillStyle = me ? '#fff' : friend ? '#4c8cff' : '#ff5a48';
      g.fillRect(x - s / 2, y - s / 2, s, s);
      if (friend) { g.strokeStyle = g.fillStyle; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(f.yaw) * 20, y - Math.sin(f.yaw) * 20); g.stroke(); }
    }
  },
};

// ======================================================================= camera
let menuAngle = 0.6;
function updateCamera(dt) {
  const p = GM.player();
  if (GM.state === 'menu' || !p) {
    menuAngle += dt * 0.045;
    const x = Math.cos(menuAngle) * 33, z = Math.sin(menuAngle) * 25;
    camera.position.set(x, heightAt(x, z) + 6.5, z);
    camera.lookAt(0, 1.2, 0);
    camera.fov = 55; camera.updateProjectionMatrix();
    return;
  }
  if (p.dead && GM.spec && GM.time - GM.playerDeathT > 2.5) {
    const s = GM.spec, f = s.forward(), r = s.right(), piv = s.pos.clone().add(new THREE.Vector3(0, 1.5, 0));
    const pitch = clamp(s.pitch, -0.4, 0.35) - 0.14;
    const back = new THREE.Vector3(Math.cos(s.yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(s.yaw) * Math.cos(pitch));
    const pos = piv.clone().addScaledVector(back, -2.4).addScaledVector(r, 0.45);
    pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 0.4);
    camera.position.lerp(pos, 1 - Math.exp(-dt * 10));
    camera.lookAt(piv.clone().addScaledVector(back, 10));
    camera.fov = BASE_FOV; camera.updateProjectionMatrix();
    return;
  }
  const eye = p.dead ? p.eye().add(new THREE.Vector3(0, -0.6 * clamp((GM.time - p.deathT) / 0.6, 0, 1), 0)) : p.eye();
  camera.position.copy(eye);
  camera.rotation.set(p.pitch, p.yaw - Math.PI / 2, 0);
  const fov = lerp(BASE_FOV, p.def.fov, p.aimAlpha);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ======================================================================= loop
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  tick(dt, true);
}
function tick(dt, draw) {
  if (GM.state !== 'loading') {
    if (!GM.paused) {
      GM.time += dt;
      const p = GM.player();
      if (p) playerInput(p, dt);
      for (const b of GM.bots) b.update(dt);
      for (const f of GM.fighters) f.update(dt);
      if (GM.inMatch()) GM.update(dt);
      updateFX(dt);
      if (p) FP.update(p, dt);
    }
    updateCamera(dt);
    const p = GM.player();
    Snd.L.x = camera.position.x; Snd.L.y = camera.position.y; Snd.L.z = camera.position.z; Snd.L.yaw = p ? p.yaw : 0;
    sun.position.copy(camera.position).add(SUN_OFF); sun.target.position.copy(camera.position);
    if (draw && (GM.inMatch() || GM.state === 'matchover')) UI.hud(p);
  }
  if (!draw) return;
  renderer.clear();
  renderer.render(scene, camera);
  const p = GM.player();
  if (p && !p.dead && GM.state !== 'menu') { renderer.clearDepth(); renderer.render(wScene, wCam); }
}

// ======================================================================= boot
async function boot() {
  const bar = $('loadbar'), txt = $('loadtxt');
  const sounds = ['S_RifleShot', 'S_PistolShot', 'S_SniperShot', 'S_Bolt', 'S_Reload', 'S_Empty', 'S_Equip', 'S_HitMarker', 'S_Headshot', 'S_Footstep', 'S_RoundStart', 'S_RoundWin', 'S_RoundLose', 'S_Hurt'];
  let done = 0; const total = sounds.length + 1, step = () => { done++; bar.style.width = (done / total * 100) + '%'; };
  try {
    MESHES = await (await fetch('meshes.json')).json(); step();
    Snd.init(); await Snd.load(sounds, step);
    txt.textContent = 'строим лес…';
    await new Promise(r => setTimeout(r, 30));
    buildLayout(Settings.gfx ? 1800 : 600);
    buildWorld();
    FP.init();
    UI.init();
    applyGfx();
    GM.state = 'menu';
    $('loading').classList.add('hidden');
    UI.open('main');
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    txt.textContent = 'Ошибка загрузки: ' + e.message;
  }
}
boot();
// debug hook: simulate n ticks without drawing (used for automated checks)
window.__fs = { GM, UI, Settings, camera, step(n, dt = 1 / 30) { for (let i = 0; i < n; i++) tick(dt, false); tick(0, true); } };
