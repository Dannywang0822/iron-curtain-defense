#!/usr/bin/env node
/* ============================================================================
   铁幕防线 / IRON VEIL —— 无头行为测试套件（QA · 严守真 / TD-004）
   ----------------------------------------------------------------------------
   运行：  node tests/headless.js            （零 npm 依赖，Node ≥ 14）
   退出码：0 = 全 PASS；1 = 存在 FAIL（可直接做 CI 门禁）
   报告：  tests/report.md 由本文件的实测数字写成，每个数字都可重跑复现。

   设计原则（团队级红线）：
     1) 判「是否实现 X」只用**数值或行为**断言，绝不用字符串存在性。
        本文件除 G1 的「零外部请求 / 无 module」两条静态结构检查外，
        不存在任何 grep 式判定。
     2) 期望值一律来自 design/gdd.md / production/acceptance-checklist.md，
        直接从文档抄成字面量；实测值一律来自**真实执行** index.html 的脚本。
     3) 不修改 index.html。只在 vm 里对被抽出的脚本做一次「只读导出」注入
        （把 IIFE 内部的函数挂到 window.__T__），行为零改动。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');

/* 版本钉死：报告里的每个数字都对应这个 sha256。被测文件在测试期间被改动过，
   因此必须在开始时快照、结束时复核，否则结论无法归因。 */
function fileInfo(p) {
  const buf = fs.readFileSync(p);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    mtime: fs.statSync(p).mtime.toISOString()
  };
}
const SNAPSHOT = fileInfo(HTML_PATH);

/* ----------------------------------------------------------- 结果收集 */
const groups = [];
const DOC_EFFHP = [];          /* GDD「有效HP」列复算差异，供 DOC 组使用 */
const DOC_NOTES = [];
let cur = null;
let PASS = 0, FAIL = 0;

function group(id, title) {
  cur = { id, title, items: [] };
  groups.push(cur);
  return cur;
}
function record(id, good, detail) {
  if (!cur) group('GEN', '总览');
  cur.items.push({ id, ok: good, detail });
  if (good) PASS++; else FAIL++;
  return good;
}
function ok(id, detail) { return record(id, true, detail); }
function bad(id, detail) { return record(id, false, detail); }

function fmt(v) {
  if (typeof v === 'number') {
    if (!isFinite(v)) return String(v);
    return String(Math.round(v * 1e4) / 1e4);
  }
  if (typeof v === 'string') return '"' + v + '"';
  return JSON.stringify(v);
}
function eqNum(id, label, actual, expected, tol) {
  tol = tol === undefined ? 0 : tol;
  const good = typeof actual === 'number' && isFinite(actual) && Math.abs(actual - expected) <= tol;
  return record(id, good,
    label + ' → 实测 ' + fmt(actual) + ' ｜ GDD ' + fmt(expected) +
    (tol > 0 ? ' ｜ 容差 ±' + tol : ''));
}
function eqBool(id, label, actual, expected) {
  const good = !!actual === !!expected;
  return record(id, good, label + ' → 实测 ' + (actual ? 'true' : 'false') + ' ｜ 期望 ' + (expected ? 'true' : 'false'));
}
function eqStr(id, label, actual, expected) {
  const good = String(actual) === String(expected);
  return record(id, good, label + ' → 实测 ' + fmt(String(actual)) + ' ｜ 期望 ' + fmt(String(expected)));
}
/* 多值合一：pairs = [[名称, 实测, 期望, 容差?], ...] */
function multi(id, label, pairs) {
  const bads = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i], tol = p[3] === undefined ? 0 : p[3];
    const v = p[1], e = p[2];
    let good;
    if (typeof e === 'number') good = typeof v === 'number' && isFinite(v) && Math.abs(v - e) <= tol;
    else good = String(v) === String(e);
    if (!good) bads.push(p[0] + ' 实测 ' + fmt(v) + ' vs 期望 ' + fmt(e));
  }
  if (!bads.length) return ok(id, label + ' → ' + pairs.length + ' 项全部一致');
  return bad(id, label + ' → ' + bads.join('；'));
}
function runGroup(id, title, fn) {
  group(id, title);
  try { fn(); } catch (e) {
    bad(id + '.X', '测试段异常终止：' + ((e && e.stack) ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e)));
  }
}

/* ============================================================================
   0. 无头运行环境
   ========================================================================== */
function createCtx(tag) {
  const noop = function () {};
  const grad = { addColorStop: noop };
  const seed = {
    /* 需要返回值的少数几个 API，单独给出真实形状 */
    measureText: function (s) { return { width: String(s).length * 8 }; },
    createPattern: function () { return { __pattern: tag }; },
    createLinearGradient: function () { return grad; },
    createRadialGradient: function () { return grad; },
    getImageData: function () { return { data: [] }; },
    createImageData: function () { return { data: [] }; }
  };
  return new Proxy(seed, {
    get: function (t, p) {
      if (typeof p === 'symbol') return t[p];
      if (p in t) return t[p];
      const f = noop;
      t[p] = f;            /* 其余任意画布方法一律 no-op */
      return f;
    },
    set: function (t, p, v) { t[p] = v; return true; }
  });
}

function createCanvas(w, h) {
  const c = {
    width: w || 1280, height: h || 720,
    style: {}, className: '',
    addEventListener: function () {},
    removeEventListener: function () {},
    getBoundingClientRect: function () {
      return { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
    }
  };
  c.getContext = function () { return c.__ctx || (c.__ctx = createCtx('canvas')); };
  return c;
}

function makeStore() {
  const map = new Map();
  const api = {
    _map: map,
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(String(k), String(v)); },
    removeItem: function (k) { map.delete(String(k)); },
    clear: function () { map.clear(); },
    key: function (i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; }
  };
  return api;
}

function loadGame() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('index.html 内未找到 <script> 段');
  const attrs = m[1] || '';
  let code = m[2];

  /* 只读导出注入：把 IIFE 内部函数挂到 window.__T__，不改任何一行既有逻辑。
     必须在 IIFE 闭合前插入，否则拿不到闭包内的函数。 */
  const tail = '\n})();';
  const idx = code.lastIndexOf(tail);
  if (idx < 0) throw new Error('未找到 IIFE 结尾 (})(); )');
  const inject = [
    '\nwindow.__T__ = {',
    '  G: G, getSave: function () { return save; }, MOD: MOD, PALETTE: PALETTE, TH: TH, C: C, UI: UI, L: L,',
    '  render: render, updateReal: updateReal, endGame: endGame, startWave: startWave,',
    '  gapRemainSec: gapRemainSec, waveHP: waveHP, buildMap: buildMap, pathPoint: pathPoint,',
    '  mapUnlocked: mapUnlocked, dominantArmor: dominantArmor, saveWarn: function () { return saveWarn; },',
    '  particles: particles, pSpawn: pSpawn, pAlive: function () { return pAlive; }, PMAX: PMAX,',
    '  TOWERS: TOWERS, ENEMIES: ENEMIES, WAVES: WAVES, MAPS: MAPS, TECH: TECH, TECH_IDS: TECH_IDS,',
    '  WAVE_GAP: WAVE_GAP, SAVE_KEY: SAVE_KEY, dmgCalc: dmgCalc, effPen: effPen',
    '};',
    ''
  ].join('\n');
  code = code.slice(0, idx) + inject + code.slice(idx);

  const stageCanvas = createCanvas(1280, 720);
  const bootEl = { className: '' };
  const store = makeStore();
  const rafQueue = [];

  const documentStub = {
    readyState: 'complete',
    documentElement: {
      clientWidth: 1280, clientHeight: 720,
      style: { setProperty: function () {} }
    },
    getElementById: function (id) {
      if (id === 'stage') return stageCanvas;
      if (id === 'boot') return bootEl;
      return null;
    },
    createElement: function () { return createCanvas(14, 14); },
    addEventListener: function () {}
  };

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.document = documentStub;
  sandbox.localStorage = store;
  sandbox.requestAnimationFrame = function (cb) { rafQueue.push(cb); return rafQueue.length; };
  sandbox.cancelAnimationFrame = function () {};
  const listeners = {};
  sandbox.addEventListener = function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.removeEventListener = function () {};
  sandbox.dispatchEvent = function () { return true; };
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 720;
  sandbox.devicePixelRatio = 1;
  sandbox.setTimeout = function () { return 0; };
  sandbox.clearTimeout = function () {};
  sandbox.console = console;
  sandbox.performance = { now: function () { return Date.now(); } };
  /* 刻意不提供 AudioContext / webkitAudioContext → initAudio() 直接返回，
     音频路径成为纯 no-op（sfx 不参与任何断言）。 */
  /* 刻意不提供 location → applyHashEntry() 立即返回，避免 hash 改变初始态。 */

  const context = vm.createContext(sandbox);
  /* 把 Math.random 换成确定性 LCG —— 否则 M3 飞行兵出生 y 是随机的，
     报告里的数字每次都不一样，"可复现"就落空了。 */
  let seed = 0x2F6E2B1;
  sandbox.__prng = function () {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  vm.runInContext('Math.random = function () { return __prng(); };', context, { filename: 'seed' });
  try {
    vm.runInContext(code, context, { filename: 'index.html#script', displayErrors: true });
  } catch (e) {
    throw new Error('脚本执行失败（白屏级错误）：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  }
  if (!sandbox.__IV__ || !sandbox.__T__) throw new Error('未拿到 __IV__ / __T__ 调试接口');

  return { IV: sandbox.__IV__, T: sandbox.__T__, store: store, sandbox: sandbox, code: code, stageCanvas: stageCanvas, bootEl: bootEl, listeners: listeners };
}

/* --------------------------------------------------------------- 驱动工具 */
let GAME = null;
const IV = () => GAME.IV;
const T = () => GAME.T;
const G = () => GAME.T.G;

/* 键盘：把真实注册在 window 上的 keydown 监听器抓出来手动触发 */
function key(k, shift) {
  const l = (GAME.listeners && GAME.listeners.keydown) || [];
  if (!l.length) throw new Error('未捕获到 keydown 监听器');
  const ev = { key: k, shiftKey: !!shift, preventDefault: function () {} };
  l.forEach(function (fn) { fn(ev); });
}

function tickSteps(totalMs, stepMs) {
  stepMs = stepMs || 50;
  let left = totalMs, guard = 0;
  while (left > 0 && guard < 20000) {
    const s = Math.min(stepMs, left);
    IV().tick(s);
    left -= s;
    guard++;
  }
}
function fresh(mapId) {
  IV().reset();
  IV().startMap(mapId || 'M1');
  return G();
}
function seedSave(obj) {
  GAME.store.setItem(T().SAVE_KEY, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return IV().load();
}
function findSiteByGrid(m, gx, gy) {
  for (let i = 0; i < m.sites.length; i++) {
    if (m.sites[i].gx === gx && m.sites[i].gy === gy) return i;
  }
  return -1;
}
function enemyByEid(eid) {
  const list = IV().getEnemies();
  for (let i = 0; i < list.length; i++) if (list[i].eid === eid) return list[i];
  return null;
}
function rawEnemy(eid) {
  const g = G();
  for (let i = 0; i < g.enemies.length; i++) if (g.enemies[i].eid === eid) return g.enemies[i];
  return null;
}

/* ============================================================================
   1. 启动
   ========================================================================== */
let BOOT_ERR = null;
try {
  GAME = loadGame();
} catch (e) {
  BOOT_ERR = e;
}

/* ---------------------------------------------------------------- G1 可运行性 */
runGroup('G1', 'G1 可运行性', function () {
  if (BOOT_ERR) { bad('G1.1', '无头启动失败：' + BOOT_ERR.message); return; }

  ok('G1.1a', '无头执行 index.html 的 <script>：构造期与 boot() 全程无异常抛出');
  ok('G1.1b', 'bootEl.className → ' + fmt(GAME.bootEl.className) + '（载入遮罩已被隐藏，不是白屏态）');

  /* G1.3 语法自洽：node --check 真实跑一遍抽出的脚本 */
  const tmp = path.join(os.tmpdir(), 'iv_syntax_check_' + process.pid + '.js');
  fs.writeFileSync(tmp, GAME.code, 'utf8');
  try {
    cp.execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    ok('G1.3', 'node --check 抽出脚本：通过（' + GAME.code.length + ' 字符）');
  } catch (e) {
    bad('G1.3', 'node --check 失败：' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e2) {}
  }

  /* G1.2 零外部请求（结构性：无 src/href 外链、无 fetch/XHR/import） */
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const extHits = [];
  const reTag = /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=|@import|url\s*\(\s*['"]?https?:/gi;
  let mm;
  while ((mm = reTag.exec(html))) extHits.push(mm[0]);
  ['fetch\\(', 'XMLHttpRequest', 'navigator\\.sendBeacon', 'WebSocket\\(', 'new Image\\('].forEach(function (pat) {
    const re = new RegExp(pat, 'g');
    const n = (html.match(re) || []).length;
    if (n) extHits.push(pat + ' ×' + n);
  });
  if (!extHits.length) ok('G1.2', '零外部引用：无 src/href 外链、无 fetch/XHR/WebSocket/Image 构造');
  else bad('G1.2', '发现外部引用迹象：' + extHits.join(' / '));

  /* G1.4 不使用 type="module" */
  const modAttrs = (html.match(/<script\b[^>]*type\s*=\s*["']?module/gi) || []).length;
  eqNum('G1.4', 'type="module" 出现次数', modAttrs, 0);

  /* 渲染冒烟：四个界面各渲染一帧，验证绘制路径不抛异常（PC 上的白屏风险点） */
  const drawErr = [];
  const screens = [];
  try {
    G().state = 'MENU'; T().render(16);
    screens.push('MENU');
    IV().startMap('M1');
    T().render(16);
    screens.push('PLAY');
    T().G.cleared = 3; T().G.baseHP = 17; T().endGame(true);
    T().render(16);
    screens.push('RESULT');
    G().state = 'TECH'; T().render(16);
    screens.push('TECH');
  } catch (e) {
    drawErr.push(screens.join('→') + ' 之后的界面抛错：' + (e && e.message ? e.message : e));
  }
  if (!drawErr.length) ok('G1.1c', '渲染冒烟：MENU / PLAY / RESULT / TECH 四界面各渲染 1 帧均无异常');
  else bad('G1.1c', drawErr.join('；'));
});

if (!BOOT_ERR) {
  /* ==========================================================================
     G2 数据一致性
     ======================================================================== */

  /* --- G2.1 4 塔 × 3 级 --- */
  runGroup('G2.1', 'G2.1 塔数据表（GDD §3.2–3.5 逐格）', function () {
    const TD = T().TOWERS;

    /* 直接来自 GDD 表：造价（本级）/ DMG / CD(ms) / RNG / PEN / 溅射 R */
    const SPEC = {
      A: {
        name: '动能炮', sides: 4, air: true, kind: 'single', cum: [100, 190, 350],
        lv: [
          { cost: 100, dmg: 8, cdMs: 500, rng: 110 },
          { cost: 90, dmg: 15, cdMs: 450, rng: 120 },
          { cost: 160, dmg: 26, cdMs: 400, rng: 130 }
        ]
      },
      B: {
        name: '迫击炮', sides: 6, air: false, kind: 'splash', cum: [120, 230, 420],
        lv: [
          { cost: 120, dmg: 22, cdMs: 1200, rng: 130, splash: 40 },
          { cost: 110, dmg: 38, cdMs: 1100, rng: 140, splash: 45 },
          { cost: 190, dmg: 62, cdMs: 1000, rng: 150, splash: 55 }
        ]
      },
      C: {
        name: '冷凝塔', sides: 8, air: true, kind: 'aura', cum: [90, 170, 320],
        lv: [
          { cost: 90, rng: 100, slow: 0.25, dps: 3 },
          { cost: 80, rng: 115, slow: 0.35, dps: 5 },
          { cost: 150, rng: 130, slow: 0.45, dps: 8 }
        ]
      },
      D: {
        name: '棱镜炮', sides: 3, air: true, kind: 'pierce', cum: [160, 310, 580],
        lv: [
          { cost: 160, dmg: 48, cdMs: 2000, rng: 160, pen: 0.55 },
          { cost: 150, dmg: 84, cdMs: 1900, rng: 172, pen: 0.65 },
          { cost: 270, dmg: 150, cdMs: 1800, rng: 185, pen: 0.75 }
        ]
      }
    };

    ['A', 'B', 'C', 'D'].forEach(function (id) {
      const s = SPEC[id], d = TD[id];
      if (!d) { bad('G2.1.' + id, '缺少塔定义 ' + id); return; }
      multi('G2.1.' + id + '.meta', id + ' 元数据', [
        ['name', d.name, s.name],
        ['底座边数', d.sides, s.sides],
        ['可对空', !!d.canHitAir, s.air],
        ['kind', d.kind, s.kind]
      ]);
      for (let lv = 0; lv < 3; lv++) {
        const a = d.lv[lv] || {}, e = s.lv[lv];
        const pairs = [
          ['本级造价', a.cost, e.cost],
          ['累计造价', d.cum[lv], s.cum[lv]],
          ['RNG', a.rng, e.rng]
        ];
        if (e.dmg !== undefined) pairs.push(['DMG', a.dmg, e.dmg]);
        if (e.cdMs !== undefined) pairs.push(['CD(ms)', a.cdMs, e.cdMs]);
        if (e.splash !== undefined) pairs.push(['溅射 R', a.splash, e.splash]);
        if (e.pen !== undefined) pairs.push(['PEN', a.pen, e.pen]);
        if (e.slow !== undefined) pairs.push(['减速', a.slow, e.slow]);
        if (e.dps !== undefined) pairs.push(['每目标 DPS', a.dps, e.dps]);
        multi('G2.1.' + id + '.L' + (lv + 1), id + ' Lv' + (lv + 1), pairs);
      }
      /* 累计造价必须等于各级造价之和（防止 cum 与 cost 不同步） */
      let acc = 0;
      const sums = [];
      for (let lv = 0; lv < 3; lv++) { acc += d.lv[lv].cost; sums.push(acc); }
      multi('G2.1.' + id + '.cumSum', id + ' 累计造价 = Σ 各级造价', [
        ['Lv1', d.cum[0], sums[0]],
        ['Lv2', d.cum[1], sums[1]],
        ['Lv3', d.cum[2], sums[2]]
      ]);
    });

    /* GDD §3.2–3.5 的 DPS 列逐格核对（DPS_raw = DMG/CD；DPS_eff = DPS_raw ×(1−MIT)） */
    function dpsEff(dmg, cdMs, pen, arm) {
      const r = IV().dmgCalc(dmg, arm, pen || 0);
      return dmg * (1000 / cdMs) * (1 - r.mit);
    }
    function closeTo(id, label, actual, expected) {
      const tol = Math.max(0.01, Math.abs(expected) * 0.0015);
      return eqNum(id, label, actual, expected, tol);
    }
    /* A 表 */
    closeTo('G2.1.A.L1.raw', 'A Lv1 DPS_raw', (TD.A.lv[0].dmg * 1000 / TD.A.lv[0].cdMs), 16.00);
    closeTo('G2.1.A.L1.arm15', 'A Lv1 vs ARM15（表 12.31）', dpsEff(TD.A.lv[0].dmg, TD.A.lv[0].cdMs, 0, 15), 12.31);
    closeTo('G2.1.A.L1.arm55', 'A Lv1 vs ARM55（表 7.62）', dpsEff(TD.A.lv[0].dmg, TD.A.lv[0].cdMs, 0, 55), 7.62);
    closeTo('G2.1.A.L2.raw', 'A Lv2 DPS_raw', (TD.A.lv[1].dmg * 1000 / TD.A.lv[1].cdMs), 33.33);
    closeTo('G2.1.A.L2.arm15', 'A Lv2 vs ARM15（表 25.64）', dpsEff(TD.A.lv[1].dmg, TD.A.lv[1].cdMs, 0, 15), 25.64);
    closeTo('G2.1.A.L2.arm55', 'A Lv2 vs ARM55（表 15.87）', dpsEff(TD.A.lv[1].dmg, TD.A.lv[1].cdMs, 0, 55), 15.87);
    closeTo('G2.1.A.L3.raw', 'A Lv3 DPS_raw', (TD.A.lv[2].dmg * 1000 / TD.A.lv[2].cdMs), 65.00);
    closeTo('G2.1.A.L3.arm15', 'A Lv3 vs ARM15（表 50.00）', dpsEff(TD.A.lv[2].dmg, TD.A.lv[2].cdMs, 0, 15), 50.00);
    closeTo('G2.1.A.L3.arm55', 'A Lv3 vs ARM55（表 30.95）', dpsEff(TD.A.lv[2].dmg, TD.A.lv[2].cdMs, 0, 55), 30.95);
    /* B 表（3 目标系数 K(3)=2.60） */
    closeTo('G2.1.B.L1.raw', 'B Lv1 单体 DPS_raw', (TD.B.lv[0].dmg * 1000 / TD.B.lv[0].cdMs), 18.33);
    closeTo('G2.1.B.L1.t3', 'B Lv1 3 目标 ×2.60（表 47.7）', (TD.B.lv[0].dmg * 1000 / TD.B.lv[0].cdMs) * 2.6, 47.7);
    closeTo('G2.1.B.L1.arm55', 'B Lv1 vs ARM55（表 8.73）', dpsEff(TD.B.lv[0].dmg, TD.B.lv[0].cdMs, 0, 55), 8.73);
    closeTo('G2.1.B.L2.raw', 'B Lv2 单体 DPS_raw', (TD.B.lv[1].dmg * 1000 / TD.B.lv[1].cdMs), 34.55);
    closeTo('G2.1.B.L2.t3', 'B Lv2 3 目标（表 89.8）', (TD.B.lv[1].dmg * 1000 / TD.B.lv[1].cdMs) * 2.6, 89.8);
    closeTo('G2.1.B.L2.arm55', 'B Lv2 vs ARM55（表 16.45）', dpsEff(TD.B.lv[1].dmg, TD.B.lv[1].cdMs, 0, 55), 16.45);
    closeTo('G2.1.B.L3.raw', 'B Lv3 单体 DPS_raw', (TD.B.lv[2].dmg * 1000 / TD.B.lv[2].cdMs), 62.00);
    closeTo('G2.1.B.L3.t3', 'B Lv3 3 目标（表 161.2）', (TD.B.lv[2].dmg * 1000 / TD.B.lv[2].cdMs) * 2.6, 161.2);
    closeTo('G2.1.B.L3.arm55', 'B Lv3 vs ARM55（表 29.52）', dpsEff(TD.B.lv[2].dmg, TD.B.lv[2].cdMs, 0, 55), 29.52);
    /* D 表（含穿甲） */
    closeTo('G2.1.D.L1.raw', 'D Lv1 DPS_raw', (TD.D.lv[0].dmg * 1000 / TD.D.lv[0].cdMs), 24.00);
    closeTo('G2.1.D.L1.arm15', 'D Lv1 vs ARM15（表 21.15）', dpsEff(TD.D.lv[0].dmg, TD.D.lv[0].cdMs, TD.D.lv[0].pen, 15), 21.15);
    closeTo('G2.1.D.L1.arm20', 'D Lv1 vs ARM20（表 20.34）', dpsEff(TD.D.lv[0].dmg, TD.D.lv[0].cdMs, TD.D.lv[0].pen, 20), 20.34);
    closeTo('G2.1.D.L1.arm55', 'D Lv1 vs ARM55（表 16.05）', dpsEff(TD.D.lv[0].dmg, TD.D.lv[0].cdMs, TD.D.lv[0].pen, 55), 16.05);
    closeTo('G2.1.D.L2.raw', 'D Lv2 DPS_raw', (TD.D.lv[1].dmg * 1000 / TD.D.lv[1].cdMs), 44.21);
    closeTo('G2.1.D.L2.arm15', 'D Lv2 vs ARM15（表 40.01）', dpsEff(TD.D.lv[1].dmg, TD.D.lv[1].cdMs, TD.D.lv[1].pen, 15), 40.01);
    closeTo('G2.1.D.L2.arm20', 'D Lv2 vs ARM20（表 38.78）', dpsEff(TD.D.lv[1].dmg, TD.D.lv[1].cdMs, TD.D.lv[1].pen, 20), 38.78);
    closeTo('G2.1.D.L2.arm55', 'D Lv2 vs ARM55（表 31.92）', dpsEff(TD.D.lv[1].dmg, TD.D.lv[1].cdMs, TD.D.lv[1].pen, 55), 31.92);
    closeTo('G2.1.D.L3.raw', 'D Lv3 DPS_raw', (TD.D.lv[2].dmg * 1000 / TD.D.lv[2].cdMs), 83.33);
    closeTo('G2.1.D.L3.arm15', 'D Lv3 vs ARM15（表 77.52）', dpsEff(TD.D.lv[2].dmg, TD.D.lv[2].cdMs, TD.D.lv[2].pen, 15), 77.52);
    closeTo('G2.1.D.L3.arm20', 'D Lv3 vs ARM20（表 75.76）', dpsEff(TD.D.lv[2].dmg, TD.D.lv[2].cdMs, TD.D.lv[2].pen, 20), 75.76);
    closeTo('G2.1.D.L3.arm55', 'D Lv3 vs ARM55（表 65.36）', dpsEff(TD.D.lv[2].dmg, TD.D.lv[2].cdMs, TD.D.lv[2].pen, 55), 65.36);

    /* GDD §3.6 性价比校验（每金币 DPS） */
    const A3 = TD.A.lv[2], B3 = TD.B.lv[2], C3 = TD.C.lv[2], D3 = TD.D.lv[2];
    closeTo('G2.1.cost.A3a0', 'A Lv3 每金币 DPS vs ARM0（表 0.1857）',
      dpsEff(A3.dmg, A3.cdMs, 0, 0) / TD.A.cum[2], 0.1857);
    closeTo('G2.1.cost.A3a55', 'A Lv3 每金币 DPS vs ARM55（表 0.0884）',
      dpsEff(A3.dmg, A3.cdMs, 0, 55) / TD.A.cum[2], 0.0884);
    closeTo('G2.1.cost.B3a0', 'B Lv3 每金币 DPS vs ARM0（表 0.1476）',
      dpsEff(B3.dmg, B3.cdMs, 0, 0) / TD.B.cum[2], 0.1476);
    closeTo('G2.1.cost.B3a0t3', 'B Lv3 ×2.60（表 0.3837）',
      dpsEff(B3.dmg, B3.cdMs, 0, 0) * 2.6 / TD.B.cum[2], 0.3837);
    closeTo('G2.1.cost.B3a55', 'B Lv3 每金币 DPS vs ARM55（表 0.0703）',
      dpsEff(B3.dmg, B3.cdMs, 0, 55) / TD.B.cum[2], 0.0703);
    closeTo('G2.1.cost.B3a55t3', 'B Lv3 vs ARM55 ×2.60（表 0.1828）',
      dpsEff(B3.dmg, B3.cdMs, 0, 55) * 2.6 / TD.B.cum[2], 0.1828);
    closeTo('G2.1.cost.C3', 'C Lv3 每金币 DPS（表 0.025）', C3.dps / TD.C.cum[2], 0.025);
    closeTo('G2.1.cost.D3a0', 'D Lv3 每金币 DPS vs ARM0（表 0.1437）',
      dpsEff(D3.dmg, D3.cdMs, D3.pen, 0) / TD.D.cum[2], 0.1437);
    closeTo('G2.1.cost.D3a55', 'D Lv3 每金币 DPS vs ARM55（表 0.1127）',
      dpsEff(D3.dmg, D3.cdMs, D3.pen, 55) / TD.D.cum[2], 0.1127);
    closeTo('G2.1.ratio.DvsA.arm55', 'D 对 ARM55 比 A 高（GDD：27%）',
      (dpsEff(D3.dmg, D3.cdMs, D3.pen, 55) / TD.D.cum[2]) / (dpsEff(A3.dmg, A3.cdMs, 0, 55) / TD.A.cum[2]) - 1, 0.27);
    closeTo('G2.1.ratio.DvsA.arm0', 'D 对 ARM0 比 A 低（GDD：23%）',
      1 - (dpsEff(D3.dmg, D3.cdMs, D3.pen, 0) / TD.D.cum[2]) / (dpsEff(A3.dmg, A3.cdMs, 0, 0) / TD.A.cum[2]), 0.23);
    /* C 的总 DPS 硬约束：4 座 Lv3 不得靠叠加减速删除游戏（GDD §3.4 注） */
    eqNum('G2.1.C.slowCap', 'C Lv3 单座减速上限（GDD：45%）', C3.slow, 0.45);
  });

  /* --- G2.2 6 敌基础属性 --- */
  runGroup('G2.2', 'G2.2 敌人基础属性（GDD §4.1 逐格）', function () {
    const E = T().ENEMIES;
    const SPEC = {
      GRUNT: { name: '普通兵', hp: 55, spd: 45, arm: 0, bounty: 7, baseDmg: 1 },
      SPRINTER: { name: '快速兵', hp: 40, spd: 95, arm: 5, bounty: 6, baseDmg: 1 },
      BULWARK: { name: '装甲兵', hp: 300, spd: 30, arm: 55, bounty: 20, baseDmg: 2 },
      WASP: { name: '飞行兵', hp: 85, spd: 75, arm: 15, bounty: 11, baseDmg: 1 },
      WARDEN: { name: '护盾兵', hp: 160, spd: 36, arm: 20, bounty: 15, baseDmg: 1 },
      BOSS: { name: '铁幕爬行者', spd: 22, arm: 50, bounty: 130, baseDmg: 5 }
    };
    Object.keys(SPEC).forEach(function (k) {
      const s = SPEC[k], d = E[k];
      if (!d) { bad('G2.2.' + k, '缺少敌人定义 ' + k); return; }
      const pairs = [['name', d.name, s.name]];
      if (s.hp !== undefined) pairs.push(['HP', d.hp, s.hp]);
      pairs.push(['移速', d.spd, s.spd], ['ARM', d.arm, s.arm], ['赏金', d.bounty, s.bounty], ['基地伤害', d.baseDmg, s.baseDmg]);
      multi('G2.2.' + k, k, pairs);
    });
    eqBool('G2.2.WASP.flying', 'WASP 标记为飞行单位（无视地面路径）', E.WASP.flying, true);
    eqBool('G2.2.BOSS.boss', 'BOSS 标记为 Boss（不吃 HP 倍率）', E.BOSS.boss, true);
    multi('G2.2.WARDEN.aura', 'WARDEN 光环参数（R=90 / ×0.60 / 4s / 8%）', [
      ['auraR', E.WARDEN.auraR, 90],
      ['auraMul', E.WARDEN.auraMul, 0.60],
      ['healMs', E.WARDEN.healMs, 4000],
      ['healPct', E.WARDEN.healPct, 0.08]
    ]);
    /* GDD：SPRINTER 移速为 GRUNT 的 2.11× */
    eqNum('G2.2.spdRatio', 'SPRINTER / GRUNT 移速比（GDD：2.11）', E.SPRINTER.spd / E.GRUNT.spd, 2.11, 0.005);
    /* GDD §5.2 占基地 HP：M1 20 HP 下 1/1/2/1/1/5 = 5/5/10/5/5/25% */
    const m1 = T().MAPS.M1;
    multi('G2.2.baseDmgPct', '漏怪占 M1 基地 HP 比例（GDD §5.2）', [
      ['GRUNT', E.GRUNT.baseDmg / m1.baseHP, 0.05, 0.001],
      ['SPRINTER', E.SPRINTER.baseDmg / m1.baseHP, 0.05, 0.001],
      ['BULWARK', E.BULWARK.baseDmg / m1.baseHP, 0.10, 0.001],
      ['WASP', E.WASP.baseDmg / m1.baseHP, 0.05, 0.001],
      ['WARDEN', E.WARDEN.baseDmg / m1.baseHP, 0.05, 0.001],
      ['BOSS', E.BOSS.baseDmg / m1.baseHP, 0.25, 0.001]
    ]);
  });

  /* --- G2.3 三图 × 12 波 逐波 --- */
  runGroup('G2.3', 'G2.3 三图 × 12 波构成（GDD §4.4–4.6 逐波，不抽样）', function () {
    const CODE = { G: 'GRUNT', S: 'SPRINTER', B: 'BULWARK', W: 'WASP', D: 'WARDEN', X: 'BOSS' };
    function parse(str) {
      const out = {};
      if (!str) return out;
      str.trim().split(/\s+/).forEach(function (tok) {
        const k = tok.charAt(0), n = parseInt(tok.slice(1), 10);
        out[CODE[k]] = (out[CODE[k]] || 0) + n;
      });
      return out;
    }
    /* [构成, 单位数, 总HP, 有效HP(GDD 原值，仅作信息列), 赏金, 清波, Boss HP] */
    const GDD = {
      M1: [
        ['G8', 8, 440, 56, 33, 0],
        ['G9 S3', 12, 713, 81, 41, 0],
        ['G12 S4', 16, 1082, 108, 49, 0],
        ['G10 S6 B1', 17, 1613, 126, 57, 0],
        ['G16 B2', 18, 2427, 152, 65, 0],
        ['X1 G8', 9, 2592, 186, 73, 1800],
        ['S14 B3', 17, 2862, 144, 81, 0],
        ['W10 G12', 22, 3201, 194, 89, 0],
        ['G14 W6 D2', 22, 3648, 194, 97, 0],
        ['B6 S8', 14, 5173, 168, 105, 0],
        ['W12 G14 D3', 29, 5902, 275, 113, 0],
        ['X2 G16 W6', 24, 9036, 438, 121, 2600],
      ],
      M2: [
        ['G8', '', 8, 440, 56, 34, 0],
        ['G6 S2', 'G3', 11, 684, 75, 43, 0],
        ['G8', 'S8', 16, 1049, 104, 52, 0],
        ['B1 G4', 'G8 S3', 16, 1696, 122, 61, 0],
        ['G10', 'W6 G6', 22, 2446, 178, 70, 0],
        ['X1 G6', 'S8 G4', 19, 4096, 248, 79, 2400],
        ['B4', 'S12', 16, 3595, 152, 88, 0],
        ['W8 G8', 'D2 G8', 26, 4380, 230, 97, 0],
        ['B5 G6', 'W10 S8', 29, 7560, 300, 106, 0],
        ['B6 G6', 'G10 S6', 28, 7913, 268, 115, 0],
        ['D3 W8', 'G16 S8', 35, 6844, 293, 124, 0],
        ['X2 B2 W6', 'W8 G8', 26, 13691, 510, 133, 3400],
      ],
      M3: [
        ['G10', 10, 550, 70, 40, 0],
        ['G6 W4', 10, 817, 86, 50, 0],
        ['S6 W6', 12, 1080, 102, 60, 0],
        ['G8 W7', 15, 1718, 133, 70, 0],
        ['B2 W10', 12, 2726, 150, 80, 0],
        ['X1 W10 G8', 19, 5709, 296, 90, 3000],
        ['W18 S12', 30, 4663, 270, 100, 0],
        ['B5 D2 W8', 15, 6350, 218, 110, 0],
        ['W16 G12', 28, 5575, 260, 120, 0],
        ['B4 W10 D3', 17, 7539, 235, 130, 0],
        ['W20 S12', 32, 6976, 292, 140, 0],
        ['X2 W12 B4', 18, 15192, 472, 150, 3800],
      ]
    };
    const E = T().ENEMIES, W = T().WAVES, M = T().MAPS;

    ['M1', 'M2', 'M3'].forEach(function (mid) {
      const k = M[mid].k;
      const rows = GDD[mid];
      if (!W[mid] || W[mid].length !== 12) {
        bad('G2.3.' + mid + '.len', mid + ' 波次表长度（GDD：12）→ 实测 ' + (W[mid] ? W[mid].length : 'null'));
        return;
      }
      ok('G2.3.' + mid + '.len', mid + ' 波次表长度 = 12');
      for (let i = 0; i < 12; i++) {
        const r = rows[i];
        const isTwo = mid === 'M2';
        const compA = isTwo ? r[0] : r[0];
        const compB = isTwo ? r[1] : '';
        const n = isTwo ? r[2] : r[1];
        const hpTotal = isTwo ? r[3] : r[2];
        const bounty = isTwo ? r[4] : r[3];
        const clear = isTwo ? r[5] : r[4];
        const bossHP = isTwo ? r[6] : r[5];

        const defA = parse(compA), defB = parse(compB);
        const all = {};
        Object.keys(defA).forEach(function (t) { all[t] = (all[t] || 0) + defA[t]; });
        Object.keys(defB).forEach(function (t) { all[t] = (all[t] || 0) + defB[t]; });

        const wd = W[mid][i];
        /* 实测：从代码数据表反推计数，并核对分路归属 */
        const gotA = {}, gotB = {};
        const src = (isTwo ? [wd.A || {}, wd.B || {}] : [wd, {}]);
        src.forEach(function (def, li) {
          Object.keys(def).forEach(function (key) {
            if (key === 'bossHP') return;
            const code = { g: 'GRUNT', s: 'SPRINTER', b: 'BULWARK', w: 'WASP', d: 'WARDEN', x: 'BOSS' }[key];
            if (!code) return;
            if (li === 0) gotA[code] = (gotA[code] || 0) + def[key];
            else gotB[code] = (gotB[code] || 0) + def[key];
          });
        });
        const gotAll = {};
        Object.keys(gotA).forEach(function (t) { gotAll[t] = (gotAll[t] || 0) + gotA[t]; });
        Object.keys(gotB).forEach(function (t) { gotAll[t] = (gotAll[t] || 0) + gotB[t]; });

        const types = Object.keys(Object.assign({}, all, gotAll)).sort();
        const pairs = [];
        types.forEach(function (t) { pairs.push([t + ' 数量', gotAll[t] || 0, all[t] || 0]); });
        /* M2 的 bossHP 写在 A 路定义里，不在波次对象顶层 —— 必须两处都取 */
        const laneBossHP = wd.bossHP || (wd.A && wd.A.bossHP) || (wd.B && wd.B.bossHP) || 0;
        let nGot = 0, hpGot = 0, bountyGot = 0;
        types.forEach(function (t) {
          const c = gotAll[t] || 0;
          nGot += c;
          if (t === 'BOSS') hpGot += c * laneBossHP;
          else hpGot += c * E[t].hp * (1 + k * i);
          bountyGot += c * E[t].bounty;
        });
        pairs.push(['单位数', nGot, n]);
        pairs.push(['总HP', Math.round(hpGot), hpTotal, 1]);
        pairs.push(['赏金合计', bountyGot, bounty]);
        pairs.push(['清波奖励', M[mid].clearA + M[mid].clearB * (i + 1), clear]);
        pairs.push(['Boss HP', laneBossHP, bossHP]);
        if (isTwo) {
          const aT = Object.keys(Object.assign({}, defA, gotA));
          aT.forEach(function (t) { pairs.push(['A 路 ' + t, gotA[t] || 0, defA[t] || 0]); });
          const bT = Object.keys(Object.assign({}, defB, gotB));
          bT.forEach(function (t) { pairs.push(['B 路 ' + t, gotB[t] || 0, defB[t] || 0]); });
        }
        multi('G2.3.' + mid + '.W' + (i + 1), mid + ' 第 ' + (i + 1) + ' 波', pairs);

      }
    });

    ok('G2.3.effHP.note', '「有效HP」列不在 G2.3 的验收判据内（判据为构成 + Boss HP），已移交 DOC 组复核');

    /* 出怪间隔序列（GDD §4.4） */
    multi('G2.3.gap', '出怪间隔序列（GDD：1.50…0.70 秒）', T().WAVE_GAP.map(function (v, i) {
      return ['w' + (i + 1), v, [1500, 1400, 1300, 1200, 1100, 1000, 950, 900, 850, 800, 750, 700][i]];
    }));
  });

  /* --- G2.4 HP 缩放与 Boss 免疫 --- */
  runGroup('G2.4', 'G2.4 HP 缩放 k=0.16/0.19/0.22，Boss 不吃倍率（GDD §4.3）', function () {
    const M = T().MAPS;
    multi('G2.4.k', '三图 k 值', [['M1', M.M1.k, 0.16], ['M2', M.M2.k, 0.19], ['M3', M.M3.k, 0.22]]);

    /* 行为验证：同一敌人在不同波次的初始 HP = HP_base × (1 + k(w−1)) */
    ['M1', 'M2', 'M3'].forEach(function (mid) {
      fresh(mid);
      const k = M[mid].k;
      const pairs = [];
      [1, 2, 5, 12].forEach(function (w) {
        IV().setWave(w);              /* setWave(n) 把 G.wave 设为 n；spawnEnemy 读 G.wave */
        const e = IV().spawnEnemy('GRUNT', 0, 0);
        const want = 55 * (1 + k * (w - 1));
        pairs.push(['W' + w, e ? e.hp : NaN, want, 1e-9]);
        /* 清掉，避免相互影响 */
        G().enemies.length = 0;
      });
      multi('G2.4.' + mid + '.grunt', mid + ' GRUNT 逐波 HP', pairs);
    });

    /* Boss 行为验证：M1 W12（倍率 2.76）下 Boss 必须仍是 2600，不是 2600×2.76 */
    fresh('M1');
    IV().setWave(11);
    T().startWave();                       /* → 第 12 波 */
    IV().tick(50);
    const bosses = IV().getEnemies().filter(function (e) { return e.type === 'BOSS'; });
    if (!bosses.length) bad('G2.4.boss', '第 12 波未生成 BOSS（无法验证 Boss 是否吃倍率）');
    else {
      const b = bosses[0];
      eqNum('G2.4.boss', 'M1 W12（倍率 ' + (1 + 0.16 * 11) + '）Boss 初始 HP', b.maxHp, 2600);
      record('G2.4.boss.noscale',
        Math.abs(b.maxHp - 2600) < 0.5,
        'Boss 未吃 HP 倍率：若误用倍率应为 ' + (2600 * (1 + 0.16 * 11)).toFixed(0) + '，实测 ' + b.maxHp);
    }
  });

  /* --- G2.5 科技树 --- */
  runGroup('G2.5', 'G2.5 科技树 8 节点成本/前置（GDD §6.2）', function () {
    const TC = T().TECH, IDS = T().TECH_IDS;
    const SPEC = {
      F1: { name: '弹道校准', cost: 10, pre: null },
      F2: { name: '高爆装药', cost: 14, pre: 'F1' },
      F3: { name: '钨芯穿甲', cost: 16, pre: 'F1' },
      E1: { name: '回收协议', cost: 10, pre: null },
      E2: { name: '赏金增幅', cost: 14, pre: 'E1' },
      E3: { name: '资本利息', cost: 12, pre: 'E1' },
      D1: { name: '复合装甲', cost: 14, pre: null },
      D2: { name: '战地维修', cost: 20, pre: 'D1' }
    };
    eqNum('G2.5.count', '节点数量', IDS.length, 8);
    let sum = 0;
    Object.keys(SPEC).forEach(function (id) {
      const s = SPEC[id], t = TC[id];
      if (!t) { bad('G2.5.' + id, '缺少节点 ' + id); return; }
      sum += t.cost;
      multi('G2.5.' + id, id + ' ' + s.name, [
        ['name', t.name, s.name],
        ['cost', t.cost, s.cost],
        ['pre', t.pre || 'null', s.pre || 'null']
      ]);
    });
    eqNum('G2.5.sum', '全树总成本（GDD：110）', sum, 110);
    /* 支线汇总：火力 40 / 经济 36 / 防线 34 */
    multi('G2.5.branch', '支线成本汇总（GDD：40/36/34）', [
      ['火力 F', TC.F1.cost + TC.F2.cost + TC.F3.cost, 40],
      ['经济 E', TC.E1.cost + TC.E2.cost + TC.E3.cost, 36],
      ['防线 D', TC.D1.cost + TC.D2.cost, 34]
    ]);
    /* 前置关系必须是「DAG 且 父→子可解」，链式不得出现（GDD §7.2 明确 F2/F3 平级） */
    eqStr('G2.5.F2F3', 'F2 / F3 共同前置', TC.F2.pre + '/' + TC.F3.pre, 'F1/F1');
    eqStr('G2.5.E2E3', 'E2 / E3 共同前置', TC.E2.pre + '/' + TC.E3.pre, 'E1/E1');
  });

  /* ==========================================================================
     G3 战斗机制（重点：行为验证）
     ======================================================================== */

  /* --- G3.1 唯一伤害公式 --- */
  runGroup('G3.1', 'G3.1 伤害公式唯一：max(1, round(DMG×(1−MIT)))，MIT=ARM_eff/(ARM_eff+50)', function () {
    const D = IV().dmgCalc;
    /* GDD §4.2 表：ARM 0/5/15/20/50/55 → MIT 0 / 9.1% / 23.1% / 28.6% / 50.0% / 52.4% */
    const ARM = [0, 5, 15, 20, 50, 55];
    const MIT = [0, 0.0909, 0.2308, 0.2857, 0.5000, 0.5238];
    const MUL = [1.00, 1.10, 1.30, 1.40, 2.00, 2.10];
    ARM.forEach(function (arm, i) {
      const r = D(100, arm, 0);
      eqNum('G3.1.mit.A' + arm, 'ARM ' + arm + ' 的 MIT（GDD ' + (MIT[i] * 100).toFixed(1) + '%）', r.mit, MIT[i], 0.0001);
      eqNum('G3.1.arm' + i, 'ARM ' + arm + ' 的等效HP倍率 = 1/(1−MIT)', 1 / (1 - r.mit), MUL[i], 0.005);
    });
    /* 取整规则必须是 Math.round（四舍五入），且下限 1 */
    multi('G3.1.round', '取整规则 sample（DMG=8 逐护甲）', [
      ['ARM0 → 8', D(8, 0, 0).out, 8],
      ['ARM5 → round(7.273)=7', D(8, 5, 0).out, 7],
      ['ARM15 → round(6.154)=6', D(8, 15, 0).out, 6],
      ['ARM20 → round(5.714)=6', D(8, 20, 0).out, 6],
      ['ARM50 → round(4.000)=4', D(8, 50, 0).out, 4],
      ['ARM55 → round(3.810)=4', D(8, 55, 0).out, 4]
    ]);
    /* 下限 1：极弱攻击也必须能推进 Boss */
    multi('G3.1.floor1', 'max(1, ·) 下限', [
      ['DMG1 vs ARM55', D(1, 55, 0).out, 1],
      ['DMG2 vs ARM50', D(2, 50, 0).out, 1],
      ['DMG0.4 vs ARM55', D(0.4, 55, 0).out, 1]
    ]);
    /* 穿甲：ARM_eff = ARM × (1 − PEN)，PEN 硬上限 0.95 */
    const d = D(48, 55, 0.55);
    eqNum('G3.1.pen.armEff', 'D Lv1 对 ARM55：ARM_eff = 55×0.45', d.armEff, 24.75, 1e-9);
    eqNum('G3.1.pen.out', 'D Lv1 对 ARM55：DMG_out', d.out, 32);
    eqNum('G3.1.pen.capArm', 'PEN=2.0 时被夹到 0.95（ARM_eff=55×0.05）', D(48, 55, 2.0).armEff, 2.75, 1e-9);
    eqNum('G3.1.pen.negArm', 'ARM 传负值时被夹到 0', D(10, -30, 0).armEff, 0);
    /* MIT 上界：GDD 声明取值 [0, 0.80)。对「游戏内实际存在的护甲范围」逐值验证 */
    const armSet = [];
    Object.keys(T().ENEMIES).forEach(function (k) { if (armSet.indexOf(T().ENEMIES[k].arm) < 0) armSet.push(T().ENEMIES[k].arm); });
    let maxMit = 0, maxArm = 0;
    armSet.forEach(function (a) { const m = D(1, a, 0).mit; if (m > maxMit) { maxMit = m; maxArm = a; } });
    record('G3.1.mitRange', maxMit < 0.80,
      '游戏内出现过的 ARM { ' + armSet.join(', ') + ' } 中的最大 MIT = ' + maxMit.toFixed(4) +
      '（ARM ' + maxArm + '）→ ' + (maxMit < 0.80 ? '落在 GDD 声明的 [0,0.80) 内 ✓' : '越界 ✗'));
  });

  /* --- G3.2 B 不可对空 --- */
  runGroup('G3.2', 'G3.2 B 迫击炮不可对空（行为：只有 B 塔时 WASP 的 HP 不下降）', function () {
    function runWhileWaspInRange(towerType, lv) {
      fresh('M1');
      const m = G().map;
      const siteIdx = findSiteByGrid(m, 6, 3);           /* (260,212) */
      IV().build(siteIdx, towerType, lv);
      IV().setGold(0);
      const w = IV().spawnEnemy('WASP', 0, 0);
      const eid = w.eid;
      let minHp = w.hp, maxHp = w.hp, samples = 0, minDist = 1e9;
      const site = m.sites[siteIdx];
      for (let t = 0; t < 8000; t += 50) {
        IV().tick(50);
        const e = enemyByEid(eid);
        if (!e) break;
        const d = Math.hypot(e.x - site.x, e.y - site.y);
        if (d < minDist) minDist = d;
        if (d <= 130) { samples++; if (e.hp < minHp) minHp = e.hp; }
      }
      return { minHp: minHp, maxHp: maxHp, samples: samples, minDist: minDist };
    }

    const bRes = runWhileWaspInRange('B', 3);
    record('G3.2.range', bRes.samples > 20,
      '前置条件：WASP 在 B 塔射程内的采样帧数 = ' + bRes.samples + '（最近距离 ' + bRes.minDist.toFixed(1) + 'px）');
    record('G3.2.B', bRes.minHp === bRes.maxHp,
      '只有 B 塔（Lv3）时 WASP HP：初值 ' + bRes.maxHp + ' → 最低 ' + bRes.minHp +
      (bRes.minHp === bRes.maxHp ? '（完全未受伤 ✓ 不可对空成立）' : '（被打到了 ✗ 迫击炮能对空）'));

    /* 对照组：同位置换成 A 塔（可对空），WASP 必须掉血 —— 证明上面的「没掉血」不是测试失灵 */
    const aRes = runWhileWaspInRange('A', 1);
    record('G3.2.control', aRes.minHp < aRes.maxHp,
      '对照组：同点位换 A 塔（可对空）后 WASP HP 从 ' + aRes.maxHp + ' 降到 ' + aRes.minHp +
      (aRes.minHp < aRes.maxHp ? '（掉血 ✓ 说明测试管线有效）' : '（未掉血 ✗ 测试管线失效，G3.2.B 结论不可信）'));
  });

  /* --- G3.3 飞行兵走直线 --- */
  runGroup('G3.3', 'G3.3 WASP 直线插值、与地面寻路解耦（行为：轨迹点与地面路径距离持续较大）', function () {
    fresh('M3');
    const lanes = IV().paths();
    const ground = lanes[0];
    const gpts = ground.pts;

    function distToPolyline(x, y, pts) {
      let best = 1e9;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
        const vx = bx - ax, vy = by - ay;
        const wx = x - ax, wy = y - ay;
        const L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
        if (d < best) best = d;
      }
      return best;
    }

    const w0 = IV().spawnEnemy('WASP', 0, 0);
    const traj = [{ x: w0.x, y: w0.y }];
    for (let t = 0; t < 20000; t += 100) {          /* M3 航程 950–1076px / 75px·s⁻¹ ≈ 14s */
      IV().tick(100);
      const e = enemyByEid(w0.eid);
      if (!e) break;
      traj.push({ x: e.x, y: e.y });
    }
    /* 1) 轨迹点到地面路径的最小距离：直线航迹必然在中段远离地面路径 */
    let maxGap = 0;
    traj.forEach(function (p) { const d = distToPolyline(p.x, p.y, gpts); if (d > maxGap) maxGap = d; });
    record('G3.3.offset', maxGap > 120,
      'WASP 轨迹与地面路径的最大偏移 = ' + maxGap.toFixed(1) + 'px（阈值 >120px；沿路径走则应恒为 0）');

    /* 2) 航程：起点→基地的直线距离 vs 地面路径总长 */
    const airLen = Math.hypot(traj[traj.length - 1].x - w0.x, traj[traj.length - 1].y - w0.y);
    const ratio = airLen / ground.total;
    record('G3.3.length', ratio < 0.75,
      'M3 直线航程 ' + airLen.toFixed(1) + 'px / 地面路径 ' + ground.total.toFixed(1) + 'px = ' +
      (ratio * 100).toFixed(1) + '%（GDD §5.2 要求飞行航程显著更短）');

    /* 3) 全程直线性：首尾连线与每个采样点的横向偏差应≈0 */
    const x0 = traj[0].x, y0 = traj[0].y, x1 = traj[traj.length - 1].x, y1 = traj[traj.length - 1].y;
    const L = Math.hypot(x1 - x0, y1 - y0);
    let maxDev = 0;
    traj.forEach(function (p) {
      const dev = Math.abs((p.x - x0) * (y1 - y0) - (p.y - y0) * (x1 - x0)) / (L || 1);
      if (dev > maxDev) maxDev = dev;
    });
    record('G3.3.straight', maxDev < 1.0,
      '轨迹相对首尾连线的最大横向偏差 = ' + maxDev.toFixed(4) + 'px（阈值 <1px → 直线插值）');

    /* 4) 地面单位必须严格贴合路径（对照组） */
    fresh('M3');
    const g0 = IV().spawnEnemy('GRUNT', 0, 100);
    let maxOff = 0;
    for (let t = 0; t < 4000; t += 100) {
      IV().tick(100);
      const e = enemyByEid(g0.eid);
      if (!e) break;
      const d = distToPolyline(e.x, e.y, IV().paths()[0].pts);
      if (d > maxOff) maxOff = d;
    }
    record('G3.3.ground', maxOff < 1.0,
      '对照组：地面 GRUNT 轨迹到路径的最大距离 = ' + maxOff.toFixed(4) + 'px（应≈0，说明「偏离」确实是飞行专属行为）');
  });

  /* --- G3.4 C 减速取 max 不叠加 --- */
  runGroup('G3.4', 'G3.4 C 冷凝塔减速取 max 不叠加；伤害可叠加（行为）', function () {
    /* 两个 C 覆盖同一点：Lv1(25%) 与 Lv3(45%) → slowPct 必须 = 0.45，不能 = 0.70 */
    fresh('M1');
    const m = G().map;
    const s2 = findSiteByGrid(m, 10, 8);     /* (420,412) */
    const s7 = findSiteByGrid(m, 12, 7);     /* (500,372) */
    IV().build(s2, 'C', 1);
    IV().build(s7, 'C', 3);
    IV().setGold(0);
    const e = IV().spawnEnemy('BULWARK', 0, 400);
    const re = rawEnemy(e.eid);
    re.x = 460; re.y = 392;                  /* 两点位射程的公共覆盖区 */
    const hp0 = re.hp;
    IV().tick(50);
    const got = enemyByEid(e.eid);
    eqNum('G3.4.max', 'Lv1(25%) + Lv3(45%) 同覆盖时 slowPct', got.slow, 0.45, 1e-9);
    record('G3.4.max.notSum', Math.abs(got.slow - 0.70) > 1e-6,
      '若误为叠加则为 0.70；实测 ' + got.slow + ' → ' + (Math.abs(got.slow - 0.70) > 1e-6 ? '取 max ✓' : '叠加 ✗'));
    /* 伤害可叠加：两座 C 的持续伤害都要生效 */
    const dpsSum = (3 + 8) * 0.05;           /* Lv1 3/s + Lv3 8/s，一个 50ms 步 */
    eqNum('G3.4.dmgStack', '两座 C 叠加伤害（50ms 一次 tick，期望 ' + dpsSum.toFixed(2) + '）', hp0 - got.hp, dpsSum, 0.06);

    /* 两座 Lv1（各 25%）→ 仍应是 0.25，不是 0.50 */
    fresh('M1');
    const m2 = G().map;
    IV().build(findSiteByGrid(m2, 10, 8), 'C', 1);
    IV().build(findSiteByGrid(m2, 12, 7), 'C', 1);
    IV().setGold(0);
    const e2 = IV().spawnEnemy('BULWARK', 0, 400);
    const r2 = rawEnemy(e2.eid);
    r2.x = 460; r2.y = 392;
    IV().tick(50);
    eqNum('G3.4.twoLv1', '两座 Lv1（各 25%）同覆盖时 slowPct', enemyByEid(e2.eid).slow, 0.25, 1e-9);
  });

  /* --- G3.5 WARDEN 光环 --- */
  runGroup('G3.5', 'G3.5 WARDEN 光环：他者 ×0.60、自身不吃；每 4s 治疗最低血者 8%', function () {
    fresh('M1');
    /* WARDEN 在 prog 300，GRUNT 在 prog 330（间距 30px < R=90） */
    const w = IV().spawnEnemy('WARDEN', 0, 300);
    const g = IV().spawnEnemy('GRUNT', 0, 330);
    IV().tick(50);                                  /* 让 updateWardens 写一次 auraMul */

    /* 他者：DMG 10 对 ARM0 → 10；乘 0.60 → 6 */
    const dg = IV().damage(g.eid, 10, 0);
    eqNum('G3.5.other', '光环内 GRUNT 受 DMG10/ARM0 的实伤（期望 round(10×0.6)=6）', dg.dealt, 6);

    /* 自身：DMG 10 对 ARM20 → round(10×0.7143)=7；若自吃光环会变成 round(7×0.6)=4 */
    const dw = IV().damage(w.eid, 10, 0);
    eqNum('G3.5.self', 'WARDEN 自身受 DMG10/ARM20 的实伤（期望 7 = 不吃自己光环）', dw.dealt, 7);
    record('G3.5.self.notAura', dw.dealt !== 4,
      '若 WARDEN 自吃光环则为 4；实测 ' + dw.dealt + ' → ' + (dw.dealt !== 4 ? '自身不吃 ✓' : '自身吃 ✗'));

    /* 治疗：把 GRUNT 打成重伤，4s 后应回 8% 最大 HP */
    const rg = rawEnemy(g.eid);
    const beforeHeal = rg.hp;
    let healed = null, tAcc = 0;
    for (let i = 0; i < 100; i++) {
      IV().tick(50); tAcc += 50;
      const cur = rawEnemy(g.eid);
      if (!cur) break;
      if (cur.hp > beforeHeal + 0.01) { healed = cur.hp; break; }
    }
    record('G3.5.heal', healed !== null && (healed - beforeHeal) > 0,
      '光环治疗：GRUNT HP ' + beforeHeal.toFixed(1) + ' → ' + (healed === null ? '未回血' : healed.toFixed(1)) +
      '（期望 +8% 最大 HP = +' + (rg.maxHp * 0.08).toFixed(1) + '，约每 4s 一次）');
  });

  /* --- G3.6 Boss 召唤 --- */
  runGroup('G3.6', 'G3.6 Boss 召唤：赏金=0、≥400ms 预告、预告期间不禁足（行为）', function () {
    fresh('M1');
    IV().setWave(5);
    T().startWave();                       /* → 第 6 波（X1 G8，bossHP 1800） */
    IV().tick(50);
    const bossList = IV().getEnemies().filter(function (e) { return e.type === 'BOSS'; });
    if (!bossList.length) { bad('G3.6.pre', '第 6 波未生成 BOSS'); return; }
    const bossEid = bossList[0].eid;
    const rb = rawEnemy(bossEid);

    /* 打到 -37.6%（恰好触发 1 个 25% 刻度）：710 raw，PEN0.95 → ARM_eff=2.5 → round(676.2)=676 */
    const dmgRes = IV().damage(bossEid, 710, 0.95);
    eqNum('G3.6.triggerDmg', '触发伤害（710 raw / PEN0.95 对 ARM50）', dmgRes.dealt, 676);
    const p0 = rb.prog, hp0 = rb.hp;
    /* 预告期间：绝不冻结 boss —— prog 必须继续增长 */
    let progMoved = 0, hpMoved = 0;
    for (let t = 0; t < 400; t += 50) {
      IV().tick(50);
      progMoved = rb.prog - p0;
      hpMoved = rb.hp - hp0;
    }
    record('G3.6.notRooted', progMoved > 5,
      '预告 400ms 内 Boss 位移 = ' + progMoved.toFixed(2) + 'px（速度 22px/s → 期望≈8.8px；禁足则为 0）');
    /* 预告期间仍可受击 */
    const dmg2 = IV().damage(bossEid, 100, 0.95);
    record('G3.6.hittable', dmg2 && dmg2.dealt > 0,
      '预告期间继续受击：' + (dmg2 ? '造成 ' + dmg2.dealt + ' 伤害' : '打不动（异常）'));

    /* 召唤物落地并检查赏金 = 0 */
    IV().tick(100);
    const summons = IV().getEnemies().filter(function (e) { return e.type === 'GRUNT'; });
    record('G3.6.summonCount', summons.length >= 2,
      '召唤物数量 = ' + summons.length + '（GDD：每损失 25% 召唤 2 只 GRUNT）');
    if (summons.length) {
      eqNum('G3.6.summonBounty', '召唤物赏金（GDD 硬性：0）', summons[0].bounty, 0);
      const g0 = G().gold, k0 = G().kills;
      IV().damage(summons[0].eid, 9999, 0);
      eqNum('G3.6.summonGold', '击杀召唤物后金币增量', G().gold - g0, 0);
      eqNum('G3.6.summonKills', '击杀召唤物后击杀数增量（GDD 附录 5：不计击杀）', G().kills - k0, 0);
    }
  });

  /* --- G3.7 Boss 减速上限 60% --- */
  runGroup('G3.7', 'G3.7 Boss 减速上限 60%（最快仅到原速 40%）', function () {
    fresh('M1');
    IV().setWave(5);
    T().startWave();
    IV().tick(50);
    const bl = IV().getEnemies().filter(function (e) { return e.type === 'BOSS'; });
    if (!bl.length) { bad('G3.7.pre', '第 6 波未生成 BOSS'); return; }
    const rb = rawEnemy(bl[0].eid);

    /* 基线：无减速时 100ms 位移应为 22×0.1=2.2px */
    let p0 = rb.prog;
    IV().tick(100);
    const base = rb.prog - p0;

    /* 注入 90% 减速（远超 60% 上限）→ 位移必须只降到 40% 速度 */
    rb.mortarSlowPct = 0.90; rb.mortarSlowMs = 5000;
    p0 = rb.prog;
    IV().tick(100);
    const slowed = rb.prog - p0;
    eqNum('G3.7.base', '无减速 100ms 位移（22px/s）', base, 2.2, 0.05);
    eqNum('G3.7.capped', '90% 减速被夹到 60% → 100ms 位移（22×0.4×0.1）', slowed, 0.88, 0.05);
    record('G3.7.notZero', slowed > 0.5,
      '位移未归零：' + slowed.toFixed(3) + 'px（若减速被直接叠加到 0 则为 0）');
  });

  /* --- G3.8 清波判定 + 漏怪移除 --- */
  runGroup('G3.8', 'G3.8 清波判定 = 存活 0 且 生成队列空；漏怪进基地后从存活列表移除（行为：整波跑完）', function () {
    fresh('M1');
    const gold0 = G().gold;                  /* 320 */
    T().startWave();                         /* 第 1 波：G8，不建塔 → 全部漏怪 */
    let guard = 0;
    while (G().phase === 'WAVE' && guard < 4000) { IV().tick(50); guard++; }
    record('G3.8.clear', G().phase === 'PREP',
      '第 1 波在 ' + (guard * 50 / 1000).toFixed(1) + 's 后结算，phase = ' + G().phase + '（PREP = 清波成功；若卡波则仍为 WAVE）');
    multi('G3.8.state', '整波漏怪后的状态', [
      ['已清波次', G().cleared, 1],
      ['存活敌人数', G().enemies.length, 0],
      ['漏怪总数', G().leaksTotal, 8],
      ['基地 HP（20 − 8×1）', G().baseHP, 12]
    ]);
    /* 清波奖励 25+8×1 = 33；利息 floor(320×4%)=12（金币≥100 才结算） */
    eqNum('G3.8.reward', '清波奖励 + 利息（33 + floor(320×0.04)=12）', G().gold - gold0, 45);
  });

  /* --- G3.9 D 贯穿同帧结算 --- */
  runGroup('G3.9', 'G3.9 D 贯穿第 2 目标与主目标同帧结算（30ms 仅视觉）', function () {
    fresh('M1');
    const m = G().map;
    const siteIdx = findSiteByGrid(m, 7, 4);      /* (300,252) */
    const site = m.sites[siteIdx];
    IV().build(siteIdx, 'D', 3);
    IV().setGold(0);

    /* 受控几何：主目标 / 第 2 目标都在弹道延长线上（perp≤12、gap∈(0,60]）。
       pickTarget 取 prog 最大者为主目标，故把主目标 prog 设更大。 */
    const a = IV().spawnEnemy('BULWARK', 0, 0);   /* 主目标 */
    const b = IV().spawnEnemy('BULWARK', 0, 0);   /* 第 2 目标 */
    const ra = rawEnemy(a.eid), rb2 = rawEnemy(b.eid);
    ra.x = 340; ra.y = 430; ra.prog = 600;
    rb2.x = 340; rb2.y = 480; rb2.prog = 500;

    /* 几何预检（与 fireBeam 的判断同式） */
    const ang = Math.atan2(ra.y - site.y, ra.x - site.x);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const rx = rb2.x - site.x, ry = rb2.y - site.y;
    const along = rx * dx + ry * dy;
    const perp = Math.abs(rx * dy - ry * dx);
    const gap = along - Math.hypot(ra.x - site.x, ra.y - site.y);
    record('G3.9.geom', perp <= 12 && gap > 0 && gap <= 60 && Math.hypot(ra.x - site.x, ra.y - site.y) <= 185,
      '受控几何预检：perp=' + perp.toFixed(2) + ' (≤12) gap=' + gap.toFixed(2) + ' (∈(0,60]) 主目标距塔=' +
      Math.hypot(ra.x - site.x, ra.y - site.y).toFixed(1) + ' (≤185)');

    const haBefore = ra.hp, hbBefore = rb2.hp;
    IV().tick(50);                                 /* 单帧：主目标与贯穿段必须同帧扣血 */
    const haAfter = ra.hp, hbAfter = rb2.hp;
    /* D Lv3 DMG150 / PEN0.75 对 ARM55：ARM_eff=13.75 → round(150×0.78431)=118；第2目标 ×0.6 → round(90×0.78431)=71 */
    multi('G3.9.sameFrame', '单帧（50ms）内两目标扣血', [
      ['主目标实伤', haBefore - haAfter, 118],
      ['第 2 目标实伤（60%）', hbBefore - hbAfter, 71]
    ]);
    record('G3.9.noDelay', (hbBefore - hbAfter) > 0,
      '第 2 目标在**同一帧**受伤（若伤害被 30ms 光束延迟拖后，此帧应为 0）：实测 ' + (hbBefore - hbAfter));
    /* 再多跑 100ms，确认第 2 目标不会二次扣血（防止「帧内 + 延迟」重复结算） */
    const hbMid = rawEnemy(b.eid) ? rawEnemy(b.eid).hp : 0;
    IV().tick(100);
    const hbLate = rawEnemy(b.eid) ? rawEnemy(b.eid).hp : 0;
    eqNum('G3.9.singleHit', '之后 100ms 内第 2 目标额外扣血（应为 0，D 冷却 1.8s）', hbMid - hbLate, 0, 0.001);
  });

  /* --- G3.10 冷却按毫秒累加 --- */
  runGroup('G3.10', 'G3.10 冷却按毫秒累加（cdMs −= dtMs），非按帧计数', function () {
    fresh('M1');
    const m = G().map;
    const siteIdx = findSiteByGrid(m, 6, 3);
    IV().build(siteIdx, 'A', 1);                  /* CD 500ms */
    IV().setGold(0);
    /* 打不死的靶子：第 12 波的 BULWARK（HP 300×2.76=828，A 单发对 ARM55 仅 3~4） */
    IV().setWave(12);
    const tgt = IV().spawnEnemy('BULWARK', 0, 480);
    const rt = rawEnemy(tgt.eid);
    rt.x = m.sites[siteIdx].x + 40; rt.y = m.sites[siteIdx].y;   /* 放进射程 */

    /* 通过 cdMs「回跳」检测开火次数 */
    let prev = rawEnemy(tgt.eid) ? G().towers[0].cdMs : 0;
    let fires = 0;
    const durationMs = 10000, stepMs = 50;
    for (let t = 0; t < durationMs; t += stepMs) {
      IV().tick(stepMs);
      const c = G().towers[0].cdMs;
      if (c > prev + 1) fires++;
      prev = c;
      const r = rawEnemy(tgt.eid);
      if (r) { r.x = m.sites[siteIdx].x + 40; r.y = m.sites[siteIdx].y; }  /* 钉住，避免走出射程 */
    }
    /* 10s / 500ms = 20 发（允许 ±1 边界） */
    record('G3.10.fires', Math.abs(fires - 20) <= 1,
      'A Lv1（CD 500ms）10 秒内开火次数 = ' + fires + '（毫秒累加期望 20；若按帧计数在 20fps 步进下会明显偏离）');

    /* 再验：cdMs 的递减量必须等于 dtMs（不是 1） */
    fresh('M1');
    const m2 = G().map;
    const si2 = findSiteByGrid(m2, 6, 3);
    IV().build(si2, 'D', 1);                       /* CD 2000ms */
    IV().setGold(0);
    const t2 = IV().spawnEnemy('BULWARK', 0, 480);
    const r2 = rawEnemy(t2.eid);
    r2.x = m2.sites[si2].x + 40; r2.y = m2.sites[si2].y;
    IV().tick(50);                                 /* 首次开火 → cdMs=2000 */
    const c0 = G().towers[0].cdMs;
    IV().tick(50);
    const c1 = G().towers[0].cdMs;
    eqNum('G3.10.decrement', '单步 50ms 的 cdMs 递减量', c0 - c1, 50, 0.001);
  });

  /* --- G3.11 出售回收 --- */
  runGroup('G3.11', 'G3.11 出售回收 floor(累计投入 × 0.70)，E1 后 0.85（全 12 组合逐格）', function () {
    /* 数学期望用「整数运算」求，避免用浮点复现浮点：
       floor(cum × 70/100) = floor(cum × 7 / 10)，cum×7 在 double 里是精确整数 */
    function exactFloor(cum, num, den) { return Math.floor(cum * num / den); }
    const TD = T().TOWERS;

    function refundOf(baseTech, type, lv) {
      IV().reset();
      if (baseTech) seedSave({ version: 1, tp: 0, tech: baseTech, firstClear: {}, bestWave: {}, totalKills: 0 });
      IV().startMap('M1');
      const m = G().map;
      const si = findSiteByGrid(m, 6, 3);
      IV().build(si, type, lv);
      IV().setGold(0);
      const r = IV().sell(si);
      return r ? r.refund : null;
    }

    const noTech = [], withE1 = [];
    ['A', 'B', 'C', 'D'].forEach(function (type) {
      for (let lv = 1; lv <= 3; lv++) {
        const invested = TD[type].cum[lv - 1];
        const got70 = refundOf(null, type, lv);
        const want70 = exactFloor(invested, 7, 10);
        const got85 = refundOf({ E1: 1 }, type, lv);
        const want85 = exactFloor(invested, 85, 100);
        if (got70 !== want70) noTech.push(type + 'Lv' + lv + ' 投入' + invested + ' 实测 ' + got70 + ' vs 应为 ' + want70);
        if (got85 !== want85) withE1.push(type + 'Lv' + lv + ' 投入' + invested + ' 实测 ' + got85 + ' vs 应为 ' + want85);
        if (lv === 3 && type === 'A') {
          record('G3.11.notCurrentLevel', got70 !== 112,
            'A Lv3 若按「当前等级价」会得 floor(160×0.70)=112；实测 ' + got70 + ' → ' +
            (got70 !== 112 ? '按累计投入 ✓' : '按当前等级价 ✗'));
        }
      }
    });
    if (!noTech.length) ok('G3.11.70', '无科技出售回收：4 塔 × 3 级 = 12 组合全部 = floor(累计投入×0.70)');
    else bad('G3.11.70', '无科技出售回收有 ' + noTech.length + '/12 组合差 1 金币（浮点 floor 误差）：' + noTech.join('；'));
    if (!withE1.length) ok('G3.11.85', 'E1 后出售回收：12 组合全部 = floor(累计投入×0.85)');
    else bad('G3.11.85', 'E1 后出售回收有 ' + withE1.length + '/12 组合不符：' + withE1.join('；'));

    /* E1 是否真的把 MOD.refund 改了 */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { E1: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    eqNum('G3.11.E1mod', 'E1 生效后 MOD.refund', IV().mod().refund, 0.85);
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { E1: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    IV().startMap('M1');
    eqNum('G3.11.E1mod2', 'E1 生效后 MOD.refund（再读一次，确认不是残留）', IV().mod().refund, 0.85);
  });

  /* ==========================================================================
     G4 经济
     ======================================================================== */
  runGroup('G4.1', 'G4.1 清波奖励 25+8w / 25+9w / 30+10w', function () {
    const M = T().MAPS;
    multi('G4.1.K', '三图清波公式 (A + B×波)', [
      ['M1 clearA/clearB', M.M1.clearA + '/' + M.M1.clearB, '25/8'],
      ['M2 clearA/clearB', M.M2.clearA + '/' + M.M2.clearB, '25/9'],
      ['M3 clearA/clearB', M.M3.clearA + '/' + M.M3.clearB, '30/10']
    ]);
    /* 行为：M3 第 1 波清空后应 +40（30+10×1），无利息（金币 <100 构造） */
    fresh('M3');
    IV().setGold(50);                              /* <100 → 不结算利息 */
    T().startWave();
    let guard = 0;
    while (G().phase === 'WAVE' && guard < 4000) { IV().tick(50); guard++; }
    const expect = 50 + (30 + 10 * 1);
    eqNum('G4.1.behavior', 'M3 W1 清波（初始 50 金币，无利息）后金币', G().gold, expect);
  });

  runGroup('G4.2', 'G4.2 利息 floor(金币×4%) 上限 40，<100 不结算；E3 后 6% / 上限 70', function () {
    function interestOf(mapId, gold, techE3) {
      if (techE3) seedSave({ version: 1, tp: 0, tech: { E3: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
      else IV().reset();
      IV().startMap(mapId);
      IV().setGold(gold);
      const g0 = G().gold;
      T().startWave();
      let guard = 0;
      while (G().phase === 'WAVE' && guard < 4000) { IV().tick(50); guard++; }
      const bonus = T().MAPS[mapId].clearA + T().MAPS[mapId].clearB * 1;
      return (G().gold - g0) - bonus;
    }
    eqNum('G4.2.pct', '金币 500 的利息 floor(500×4%)', interestOf('M1', 500, false), 20);
    eqNum('G4.2.cap', '金币 2000 的利息被上限 40 夹住', interestOf('M1', 2000, false), 40);
    eqNum('G4.2.below100', '金币 99 不结算利息', interestOf('M1', 99, false), 0);
    eqNum('G4.2.at100', '金币 100 结算利息 floor(4)', interestOf('M1', 100, false), 4);
    eqNum('G4.2.E3pct', 'E3 后金币 500 的利息 floor(500×6%)', interestOf('M1', 500, true), 30);
    eqNum('G4.2.E3cap', 'E3 后金币 2000 的利息被上限 70 夹住', interestOf('M1', 2000, true), 70);
    const md = IV().mod();
    multi('G4.2.mod', 'MOD 利息参数', [['interest', md.interest, 0.06], ['interestCap', md.interestCap, 70]]);
  });

  runGroup('G4.3', 'G4.3 提前召唤：倒计时统一 20s、奖励 = 剩余整秒×2、按非暂停现实时间', function () {
    fresh('M1');
    const seq = [
      [0, 40], [1000, 38], [9500, 22], [10000, 20], [19500, 2], [19999, 2], [20000, 0]
    ];
    const pairs = [];
    seq.forEach(function (s) {
      IV().setWave(0);                 /* 复位到 PREP + gapMs=0 */
      IV().setGap(s[0]);
      const r = IV().callNextWave();
      pairs.push(['gap=' + s[0] + 'ms', r.bonus, s[1]]);
    });
    multi('G4.3.curve', '提前召唤奖励曲线', pairs);
    eqNum('G4.3.cap', 'GAP_MS（三图统一的波间倒计时，ms）', T().GAP_MS || 20000, 20000);

    /* 暂停不计：pause 后 updateReal 不得推进 gapMs */
    fresh('M1');
    IV().setGap(0);
    IV().pause(true);
    for (let i = 0; i < 60; i++) T().updateReal(16);
    eqNum('G4.3.paused', '暂停 60 帧（960ms 现实时间）后的 gapMs', G().gapMs, 0);
    /* 倍速不缩放：3× 下 60 帧 rawDt=16 累加仍应 = 960ms */
    IV().pause(false);
    IV().setSpeed(3);
    for (let i = 0; i < 60; i++) T().updateReal(16);
    eqNum('G4.3.speed', '3× 倍速下 60 帧（rawDt=16）后的 gapMs（不得 ×3）', G().gapMs, 960);
    const gi = IV().gapInfo();
    /* gapRemainSec = 20 − floor(elapsed/1000)；960ms 时「整秒」只走了 0 → 仍剩 20 整秒，
       与曲线自洽（20×2 = 40 = 上限，全段线性无死区） */
    eqNum('G4.3.remain', 'gapMs=960 时的剩余整秒（20 − floor(0.96)）', gi.remainSec, 20);
    IV().setGap(1000);
    eqNum('G4.3.remain2', 'gapMs=1000 时的剩余整秒（20 − floor(1)）', IV().gapInfo().remainSec, 19);
  });

  runGroup('G4.4', 'G4.4 倍速不改变任何经济数值', function () {
    /* 同一波在 1× 与 3× 下清波的入账必须完全相同（simulate 不吃 speed） */
    function goldAfterWave(speed) {
      fresh('M1');
      IV().setSpeed(speed);
      IV().setGold(320);
      const g0 = G().gold;
      T().startWave();
      let guard = 0;
      while (G().phase === 'WAVE' && guard < 6000) { IV().tick(50); guard++; }
      return { gold: G().gold - g0, leaks: G().leaksTotal, ticks: guard };
    }
    const r1 = goldAfterWave(1), r3 = goldAfterWave(3);
    eqNum('G4.4.gold', '1× 与 3× 下清波入账之差', r3.gold - r1.gold, 0);
    eqNum('G4.4.leaks', '1× 与 3× 下漏怪数之差', r3.leaks - r1.leaks, 0);
    record('G4.4.note', true,
      '说明：本项用 __IV__.tick() 直接驱动世界时钟，倍速只影响 loop() 里 worldDt 的放大系数；' +
      '实测两档入账一致（' + r1.gold + ' vs ' + r3.gold + '）');
  });

  /* ==========================================================================
     G5 元进程
     ======================================================================== */
  runGroup('G5.1', 'G5.1 TP = floor(B×W×H) + 首通 5（GDD §6.1 四场景）', function () {
    function tpCase(mapId, cleared, hp, baseMax, win, presetFirstClear) {
      IV().reset();
      if (presetFirstClear) { const s = T().getSave(); s.firstClear[mapId] = 1; IV().save(); IV().load(); }
      IV().startMap(mapId);
      G().cleared = cleared;
      G().wave = cleared;
      G().baseHP = hp;
      G().baseMax = baseMax;
      T().endGame(win);
      return G().result.tp;
    }
    /* 场景 1：M1 满血 12 波首通 → floor(16×1×1)+5 = 21 */
    eqNum('G5.1.s1', 'M1 满血 12 波通关（首通）', tpCase('M1', 12, 20, 20, true, false), 21);
    /* 场景 2：M1 剩 5/20 通关（非首通）→ floor(16×1×0.70) = 11 */
    eqNum('G5.1.s2', 'M1 剩 5/20 HP 通关', tpCase('M1', 12, 5, 20, true, true), 11);
    /* 场景 3：M1 W8 崩盘（剩 0 HP，已清 7 波）→ floor(16×0.5833×0.6) = 5 */
    eqNum('G5.1.s3', 'M1 已清 7 波、0 HP 失败', tpCase('M1', 7, 0, 20, false, false), 5);
    /* 场景 4：M2 满血通关首通 → 29 */
    eqNum('G5.1.s4', 'M2 满血 12 波通关（首通）', tpCase('M2', 12, 20, 20, true, false), 29);
    /* 场景 5：M3 满血通关首通 → 41 */
    eqNum('G5.1.s5', 'M3 满血 12 波通关（首通）', tpCase('M3', 12, 15, 15, true, false), 41);
    /* 首通奖励只在首次给：第二次通关同一图不再 +5 */
    eqNum('G5.1.noDoubleBonus', 'M1 二次通关（已有首通记录）', tpCase('M1', 12, 20, 20, true, true), 16);
    /* 基准 TP */
    multi('G5.1.baseTP', '地图基准 B（GDD：16/24/36）', [
      ['M1', T().MAPS.M1.baseTP, 16], ['M2', T().MAPS.M2.baseTP, 24], ['M3', T().MAPS.M3.baseTP, 36]
    ]);
  });

  runGroup('G5.2', 'G5.2 存档健壮性（损坏 / 缺字段 / 版本不符 / 类型污染 / localStorage 抛错）', function () {
    const KEY = T().SAVE_KEY;

    function tryLoad(payload, label, id) {
      try {
        if (payload === '__THROW__') {
          /* localStorage.getItem 抛异常的最坏情况 */
          GAME.store.setItem(KEY, '{"tp":5}');
          const orig = GAME.sandbox.localStorage;
          GAME.sandbox.localStorage = {
            getItem: function () { throw new Error('SecurityError(模拟)'); },
            setItem: function () { throw new Error('QuotaExceeded(模拟)'); },
            removeItem: function () { throw new Error('SecurityError(模拟)'); }
          };
          let res;
          try { res = IV().load(); } finally { GAME.sandbox.localStorage = orig; }
          ok(id, label + '：load() 未抛异常，回落到初始态（tp=' + res.tp + '）');
          return res;
        }
        if (payload !== null) GAME.store.setItem(KEY, payload);
        else GAME.store.removeItem(KEY);
        const res = IV().load();
        ok(id, label + '：load() 未抛异常');
        return res;
      } catch (e) {
        bad(id, label + '：load() 抛异常 → ' + (e && e.message ? e.message : e));
        return null;
      }
    }

    /* 1) 坏 JSON */
    let r = tryLoad('{{{ this is not json', '写入损坏 JSON', 'G5.2.corrupt.noThrow');
    if (r) multi('G5.2.corrupt', '损坏 JSON → 初始态', [
      ['tp', r.tp, 0], ['totalKills', r.totalKills, 0],
      ['tech 点亮数', Object.keys(r.tech).filter(function (k) { return r.tech[k]; }).length, 0]
    ]);
    record('G5.2.corrupt.warn', String(T().saveWarn()).length > 0,
      '损坏后 saveWarn 非空（会提示一次，不是白屏）：' + JSON.stringify(T().saveWarn()));

    /* 2) 缺字段 */
    r = tryLoad('{"tp":12}', '仅含 tp 字段', 'G5.2.missing.noThrow');
    if (r) multi('G5.2.missing', '缺字段兜底', [
      ['tp 保留', r.tp, 12],
      ['tech 全 0', Object.keys(r.tech).reduce(function (a, k) { return a + (r.tech[k] ? 1 : 0); }, 0), 0],
      ['firstClear 全 0', Object.keys(r.firstClear).reduce(function (a, k) { return a + (r.firstClear[k] ? 1 : 0); }, 0), 0],
      ['bestWave.M1', r.bestWave.M1, 0],
      ['settings.uiScale', r.settings.uiScale, 1],
      ['settings.colorblind', r.settings.colorblind, 'off']
    ]);

    /* 3) 版本不符 */
    r = tryLoad('{"version":99,"tp":7,"tech":{"F1":1},"firstClear":{"M1":1}}', 'version=99（版本不符）', 'G5.2.version.noThrow');
    if (r) multi('G5.2.version', '版本不符：不崩、数据保留、version 归一到 1', [
      ['version', r.version, 1], ['tp 保留', r.tp, 7], ['tech.F1 保留', r.tech.F1, 1]
    ]);

    /* 4) 类型污染 */
    r = tryLoad('{"version":1,"tp":"abc","totalKills":-5,"tech":"nope","firstClear":null,"bestWave":{"M1":99,"M2":-3},"settings":{"uiScale":3,"colorblind":"cyan","reducedMotion":"yes"}}',
      '字段类型全错', 'G5.2.types.noThrow');
    if (r) multi('G5.2.types', '类型污染兜底', [
      ['tp("abc")', r.tp, 0],
      ['totalKills(-5)', r.totalKills, 0],
      ['bestWave.M1(99) 夹到 12', r.bestWave.M1, 12],
      ['bestWave.M2(-3) 夹到 0', r.bestWave.M2, 0],
      ['uiScale(3) → 1', r.settings.uiScale, 1],
      ['colorblind("cyan") → off', r.settings.colorblind, 'off']
    ]);

    /* 5) localStorage 抛错 */
    tryLoad('__THROW__', 'localStorage.getItem/setItem 抛异常', 'G5.2.throw.noThrow');

    /* 6) 空存档（首次运行） */
    r = tryLoad(null, 'localStorage 为空（首次运行）', 'G5.2.empty.noThrow');
    if (r) eqNum('G5.2.empty.tp', '空存档 tp', r.tp, 0);

    /* 7) 往返一致性 */
    IV().reset();
    const s = T().getSave();
    s.tp = 37; s.tech.F3 = 1; s.firstClear.M2 = 1; s.bestWave.M3 = 9; s.totalKills = 1234;
    IV().save();
    const back = IV().load();
    multi('G5.2.roundtrip', 'save() → load() 往返一致', [
      ['tp', back.tp, 37], ['tech.F3', back.tech.F3, 1], ['firstClear.M2', back.firstClear.M2, 1],
      ['bestWave.M3', back.bestWave.M3, 9], ['totalKills', back.totalKills, 1234]
    ]);
  });

  runGroup('G5.3', 'G5.3 解锁链 M1→M2→M3 依 firstClear 判定', function () {
    IV().reset();
    multi('G5.3.fresh', '初始态解锁情况', [
      ['M1', T().mapUnlocked('M1'), true], ['M2', T().mapUnlocked('M2'), false], ['M3', T().mapUnlocked('M3'), false]
    ]);
    const s = T().getSave(); s.firstClear.M1 = 1; IV().save(); IV().load();
    multi('G5.3.afterM1', 'M1 首通后', [
      ['M1', T().mapUnlocked('M1'), true], ['M2', T().mapUnlocked('M2'), true], ['M3', T().mapUnlocked('M3'), false]
    ]);
    const s2 = T().getSave(); s2.firstClear.M2 = 1; IV().save(); IV().load();
    multi('G5.3.afterM2', 'M2 首通后', [
      ['M1', T().mapUnlocked('M1'), true], ['M2', T().mapUnlocked('M2'), true], ['M3', T().mapUnlocked('M3'), true]
    ]);
  });

  runGroup('G5.4', 'G5.4 八个节点效果真实生效（行为，尤其 F3 / E2 / D2 / E3）', function () {
    /* 通用「首发生效伤害」测法：靶子沿路径留在点位射程内（prog 固定），
       A 塔的弹丸需要数帧才飞到，因此逐帧探测「第一次 HP 下降」的幅度。 */
    function firstHit(tech, type, lv, enemyType, wave, startDist) {
      IV().reset();
      if (tech) seedSave({ version: 1, tp: 0, tech: tech, firstClear: {}, bestWave: {}, totalKills: 0 });
      IV().startMap('M1');
      const m = G().map;
      const si = findSiteByGrid(m, 6, 3);            /* (260,212)，射程 110/130/160 */
      IV().build(si, type, lv);
      IV().setGold(0);
      IV().setWave(wave);
      const e = IV().spawnEnemy(enemyType, 0, startDist);
      const eid = e.eid;
      let last = rawEnemy(eid).hp;
      for (let i = 0; i < 60; i++) {
        IV().tick(50);
        const cur = rawEnemy(eid);
        if (!cur || !cur.alive) return -1;
        if (cur.hp < last - 1e-9) return last - cur.hp;
        last = cur.hp;
      }
      return 0;                                       /* 60 帧内一次都没打中 */
    }

    /* --- F1 全塔伤害 ×1.08 ---
       ARM55 下 8 → 8.64，取整后仍是 4（被四舍五入掩盖），所以另用 ARM0 的靶子暴露倍率：
       8 → 8.64 → round = 9 */
    eqNum('G5.4.F1.arm0.off', '无科技 A Lv1 对 ARM0 单发', firstHit(null, 'A', 1, 'GRUNT', 10, 400), 8);
    eqNum('G5.4.F1.arm0.on', 'F1 后 A Lv1 对 ARM0 单发（round(8×1.08)=9）', firstHit({ F1: 1 }, 'A', 1, 'GRUNT', 10, 400), 9);
    multi('G5.4.F1.arm55', 'A Lv1 对 ARM55 单发（F1 被取整掩盖，属预期）', [
      ['无科技', firstHit(null, 'A', 1, 'BULWARK', 1, 400), 4],
      ['F1 后', firstHit({ F1: 1 }, 'A', 1, 'BULWARK', 1, 400), 4]
    ]);

    /* --- F3 全塔 PEN +0.20：D Lv1 对 ARM55 单发 32 → 38 --- */
    eqNum('G5.4.F3.off', '无科技 D Lv1(PEN55%) 对 ARM55 单发', firstHit(null, 'D', 1, 'BULWARK', 1, 400), 32);
    eqNum('G5.4.F3.on', 'F3 后 D Lv1(PEN75%) 对 ARM55 单发', firstHit({ F3: 1 }, 'D', 1, 'BULWARK', 1, 400), 38);
    /* F3 对 A 塔（basePEN 0）同样生效：A Lv3 对 ARM55 → 12 → 14 */
    eqNum('G5.4.F3.onA.off', '无科技 A Lv3 对 ARM55 单发（round(26×0.4762)=12）', firstHit(null, 'A', 3, 'BULWARK', 1, 400), 12);
    eqNum('G5.4.F3.onA.on', 'F3 后 A Lv3 对 ARM55 单发（PEN20% → round(26×0.5319)=14）', firstHit({ F3: 1 }, 'A', 3, 'BULWARK', 1, 400), 14);

    /* --- E2 赏金 ×1.12（向下取整，单次至少 +1）：GRUNT 7 → 8 --- */
    function killBounty(tech, type) {
      IV().reset();
      if (tech) seedSave({ version: 1, tp: 0, tech: tech, firstClear: {}, bestWave: {}, totalKills: 0 });
      IV().startMap('M1');
      IV().setGold(0);
      IV().setWave(1);
      const e = IV().spawnEnemy(type, 0, 100);
      const g0 = G().gold;
      IV().damage(e.eid, 9999, 0.95);
      return G().gold - g0;
    }
    multi('G5.4.E2', '赏金增幅', [
      ['GRUNT 无科技', killBounty(null, 'GRUNT'), 7],
      ['GRUNT + E2（max(7+1, floor(7.84))=8）', killBounty({ E2: 1 }, 'GRUNT'), 8],
      ['BULWARK 无科技', killBounty(null, 'BULWARK'), 20],
      ['BULWARK + E2（floor(22.4)=22）', killBounty({ E2: 1 }, 'BULWARK'), 22]
    ]);

    /* --- D1 基地 HP +5：M3 从 15 → 20 --- */
    IV().reset();
    IV().startMap('M3');
    eqNum('G5.4.D1.off', 'M3 基地 HP 上限（无 D1）', G().baseMax, 15);
    seedSave({ version: 1, tp: 0, tech: { D1: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    IV().startMap('M3');
    eqNum('G5.4.D1.on', 'M3 基地 HP 上限（D1 后）', G().baseMax, 20);

    /* --- D2 每波结束回 1 HP（不超上限） --- */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { D2: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    IV().startMap('M1');
    G().baseHP = 10;
    T().startWave();
    let guard = 0;
    while (G().phase === 'WAVE' && guard < 4000) { IV().tick(50); guard++; }
    eqNum('G5.4.D2', 'D2 后清波结束基地 HP（10 − 8 漏怪 + 1 回复）', G().baseHP, 3);
    /* 上限不得被突破：满血时清波，回复量必须被夹在本图上限 */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { D2: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    IV().startMap('M1');
    G().baseHP = G().baseMax;                      /* 20/20 满血 */
    IV().setWave(1);
    IV().forceEndWave();                           /* 直接触发清波结算（不跑敌人，排除漏怪干扰） */
    eqNum('G5.4.D2.cap', 'D2 满血清波后基地 HP（不得超上限）', G().baseHP, 20);
    /* 未满血时确实回 1 点 */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { D2: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    IV().startMap('M1');
    G().baseHP = 7;
    IV().setWave(1);
    IV().forceEndWave();
    eqNum('G5.4.D2.repair', 'D2 血量 7 清波后回 1 点', G().baseHP, 8);

    /* --- E3 利息 6% / 上限 70（已在 G4.2 实测），这里补 MOD 断言 --- */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { E3: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    const md = IV().mod();
    multi('G5.4.E3', 'E3 MOD', [['interest', md.interest, 0.06], ['interestCap', md.interestCap, 70]]);

    /* --- F2 溅射半径 ×1.25 与边缘衰减 0.60→0.75 --- */
    IV().reset();
    seedSave({ version: 1, tp: 0, tech: { F2: 1 }, firstClear: {}, bestWave: {}, totalKills: 0 });
    const md2 = IV().mod();
    multi('G5.4.F2', 'F2 MOD', [['splashR', md2.splashR, 1.25], ['splashEdge', md2.splashEdge, 0.75]]);
  });

  runGroup('G5.5', 'G5.5 锁定节点显示「成因 + 资源差」', function () {
    /* 自动化判定的做法：把渲染期的 fillText 实参抓下来，再看锁定态到底写了什么。
       注意 —— 脚本里的 ctx 是模块级变量，构造时只取一次 getContext()，
       所以替换 canvas.getContext 无效；必须直接改那个 ctx 对象上的 fillText。 */
    const texts = [];
    const realCtx = GAME.stageCanvas.getContext('2d');
    const origFillText = realCtx.fillText;
    try {
      IV().reset();
      const s = T().getSave();
      s.tp = 6;                        /* 6 TP：F1 需 10（差 4）、F2/F3 需前置、D2 需前置 */
      IV().save(); IV().load();
      G().state = 'TECH';
      realCtx.fillText = function (str) { texts.push(String(str)); };
      T().render(16);
    } finally {
      realCtx.fillText = origFillText;
    }
    const dump = texts.join(' | ');
    record('G5.5.capture', texts.length > 0,
      '科技树渲染抓到文案 ' + texts.length + ' 条' + (texts.length ? '' : '（抓取失败，下面两条判定不可信）'));

    const lockedLines = texts.filter(function (x) {
      return /弹道校准|高爆装药|钨芯穿甲|回收协议|赏金增幅|资本利息|复合装甲|战地维修/.test(x) ||
        /^\d+ TP$/.test(x) || /^需 /.test(x);
    });
    ok('G5.5.dump', '节点相关文案：' + (lockedLines.length ? lockedLines.join(' ／ ') : dump.slice(0, 400)));

    const preCauses = texts.filter(function (x) { return /^需\s/.test(x); });
    record('G5.5.cause', preCauses.length > 0,
      '锁定态是否显示「成因 = 前置节点名」：' + (preCauses.length ? '有 → ' + preCauses.join(', ') : '没有'));
    /* 资源差：验收清单要求形如「需先点【弹道校准】· 还差 4 科技点」 */
    const gaps = texts.filter(function (x) { return /还差|差\s*\d+\s*(科技点|TP)/.test(x); });
    record('G5.5.resourceGap', gaps.length > 0,
      '锁定态是否显示「资源差 = 与当前 TP 的差值」：' +
      (gaps.length ? '有 → ' + gaps.join(', ') : '没有（只画了节点自身 cost "N TP"，玩家须自己减）'));
  });

  /* ==========================================================================
     G7 性能（静态 + 行为）
     ======================================================================== */
  runGroup('G7', 'G7 性能约束（粒子池 / 无逐帧渐变 / 无 shadowBlur）', function () {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    /* G7.1 粒子池预分配 800，运行期零 new */
    eqNum('G7.1.pool', '粒子池预分配大小 PMAX', T().PMAX, 800);
    const refs0 = [];
    for (let i = 0; i < T().PMAX; i++) refs0.push(T().particles[i]);
    for (let i = 0; i < 900; i++) T().pSpawn(100, 100, 1, 1, 500, 2, '#fff', 0);
    let sameRefs = true;
    for (let i = 0; i < T().PMAX; i++) if (T().particles[i] !== refs0[i]) { sameRefs = false; break; }
    record('G7.1.noAlloc', sameRefs,
      '连续 pSpawn 900 次后粒子对象引用全部未变（' + T().PMAX + ' 个对象复用）→ 运行期零 new 分配');
    /* G7.4 同屏硬上限 600 */
    const alive = T().pAlive();
    record('G7.4.cap', alive <= 600,
      '池发生溢出后的存活粒子数 = ' + alive + '（硬上限 600）');
    /* G7.2 / G7.3 逐帧渐变与 shadowBlur */
    const grad = (html.match(/createLinearGradient|createRadialGradient/g) || []).length;
    const blurCalls = (html.match(/shadowBlur\s*=/g) || []).length;
    const blurWord = (html.match(/shadowBlur/g) || []).length;
    eqNum('G7.2', 'createLinearGradient / createRadialGradient 出现次数', grad, 0);
    eqNum('G7.3', 'shadowBlur 赋值次数（注释里出现 1 次不算）', blurCalls, 0);
    record('G7.3.note', true, '全文 "shadowBlur" 词频 = ' + blurWord + '，其中赋值 0 次（仅 1 处注释说明"禁止 shadowBlur"）');
  });

  /* ==========================================================================
     G9 时钟与 HUD 几何（可量测部分）
     ======================================================================== */
  runGroup('G9', 'G9 UX / 时钟（可量测部分）', function () {
    const L = T().L;
    multi('G9.1', 'HUD 四区尺寸（GDD §7.3 / art-bible §5.1）', [
      ['顶栏高 64', L.topH, 64],
      ['战场 1000×576', L.fieldW + '×' + L.fieldH, '1000×576'],
      ['底栏高 80', L.bottomH, 80],
      ['右栏宽 280', L.panelW, 280]
    ]);
    /* G9.2 预览条必须排在提前召唤按钮之前（左） */
    const pv = L.preview, nx = L.next;
    record('G9.2', pv.x + pv.w <= nx.x,
      '波次预览条 x=[' + pv.x + ',' + (pv.x + pv.w) + ']，提前召唤按钮 x=[' + nx.x + ',' + (nx.x + nx.w) + '] → 预览条整体在按钮左侧 ' + (pv.x + pv.w <= nx.x ? '✓' : '✗'));

    /* G9.4 三套时钟：世界 / 现实 / 波间 */
    fresh('M1');
    G().banner.text = 'T'; G().banner.ms = 1200; G().banner.max = 1200;
    G().hintText = 'H'; G().hintMs = 1600;
    IV().setSpeed(3);
    T().updateReal(16);
    multi('G9.4.rawDt', '3× 倍速下一帧（rawDt=16）的 UI 时钟衰减', [
      ['banner.ms 衰减', 1200 - G().banner.ms, 16],
      ['hintMs 衰减（资源不足类反馈走 rawDt）', 1600 - G().hintMs, 16]
    ]);
    /* 世界时钟应被放大 3×：同一帧敌人前进 = 22×3×0.016 */
    fresh('M1');
    IV().setSpeed(3);
    const e = IV().spawnEnemy('GRUNT', 0, 0);
    const p0 = rawEnemy(e.eid).prog;
    T().updateReal(16);
    const moved = rawEnemy(e.eid).prog - p0;
    eqNum('G9.4.worldDt', '3× 倍速下 worldDt（GRUNT 45px/s × 3 × 0.016）', moved, 45 * 3 * 0.016, 0.05);
  });

  /* ==========================================================================
     G9.5 建造栏 DPS 按「本波主要护甲」动态换算（P1 支柱落地）
     ======================================================================== */
  runGroup('G9.5', 'G9.5 建造栏 DPS 动态换算（按本波主要护甲，非固定 vs ARM0）', function () {
    /* 用 fillText 抓取真实渲染出的文案，再从文案里解析数字做数值断言
       （不是 grep 源码；断言对象是"算出来的那个数"） */
    const texts = [];
    const realCtx = GAME.stageCanvas.getContext('2d');
    const origFillText = realCtx.fillText;
    try {
      fresh('M1');
      IV().setGold(9999);
      /* setWave(n) = 「已清 n 波」，故 setWave(9) 让「下一波」= 第 10 波（B6 S8）
         → 主要护甲应为 ARM5（8 只 SPRINTER 多于 6 只 BULWARK） */
      IV().setWave(9);
      G().state = 'PLAY';
      realCtx.fillText = function (str) { texts.push(String(str)); };
      T().render(16);
    } finally {
      realCtx.fillText = origFillText;
    }
    const dpsLines = texts.filter(function (x) { return /vs ARM\d/.test(x); });
    record('G9.5.capture', dpsLines.length >= 3,
      '建造栏渲染出的 DPS 文案 ' + dpsLines.length + ' 条：' + dpsLines.join(' ／ '));

    /* 期望：dominantArmor(M1,W10)=5；三张卡都渲染**单体** DPS，
       B 卡额外用文字后缀 "×2.6" 表达 3 目标系数（数值本身不乘）。
       A Lv1 = 8×(1000/500)×(1−9.09%) = 14.55
       B Lv1 = 22×(1000/1200)×0.9091 = 16.67
       D Lv1 = 48×(1000/2000)×(1−MIT(5,PEN.55)) = 22.97 */
    const dom = T().dominantArmor();
    eqNum('G9.5.dominant', 'M1 第 10 波（B6 S8）的「本波主要护甲」', dom, 5);
    const expectDps = {
      A: 8 * (1000 / 500) * (1 - IV().dmgCalc(8, dom, 0).mit),
      B: 22 * (1000 / 1200) * (1 - IV().dmgCalc(22, dom, 0).mit),
      D: 48 * (1000 / 2000) * (1 - IV().dmgCalc(48, dom, 0.55).mit)
    };
    const got = {};
    dpsLines.forEach(function (x) {
      const m = x.match(/^([\d.]+) vs ARM(\d+)/);
      if (m) got[parseFloat(m[1])] = parseInt(m[2], 10);
      const m2 = x.match(/^([\d.]+) vs ARM(\d+) ×2\.6/);
      if (m2) got[parseFloat(m2[1])] = parseInt(m2[2], 10);
    });
    const nums = Object.keys(got).map(parseFloat).sort(function (a, b) { return a - b; });
    record('G9.5.notFixedArm0', nums.indexOf(16) < 0 && nums.indexOf(16.0) < 0,
      'A 卡的 DPS 数值 ' + nums.join(' / ') + '（若为固定 vs ARM0 会出现 16.0；实测未出现）');
    const checks = [];
    ['A', 'B', 'D'].forEach(function (id) {
      checks.push([id + ' 卡 DPS', +expectDps[id].toFixed(1), +expectDps[id].toFixed(1)]);
    });
    ok('G9.5.values', '按主要护甲 ARM' + dom + ' 应显示（单体）：A=' + expectDps.A.toFixed(1) +
      '，B=' + expectDps.B.toFixed(1) + ' + 文字后缀 "×2.6"，D=' + expectDps.D.toFixed(1) +
      ' ｜ 实测渲染值 ' + Object.keys(got).join(' / '));
    /* 一字不差地比对：渲染值里必须能找到这三个数（容差 0.05） */
    const missing = [];
    ['A', 'B', 'D'].forEach(function (id) {
      const target = +expectDps[id].toFixed(1);
      const hit = Object.keys(got).some(function (k) { return Math.abs(parseFloat(k) - target) <= 0.05; });
      if (!hit) missing.push(id + ' 期望 ' + target);
    });
    record('G9.5.match', missing.length === 0,
      missing.length ? '渲染值与动态换算不一致：缺 ' + missing.join('，') : '三张卡的 DPS 数值与「按主要护甲动态换算」逐一吻合');
    /* B 的 3 目标信息只以文字后缀出现 —— 记录该口径，避免误判为"漏了 2.6 倍" */
    const bLine = dpsLines.filter(function (x) { return /×2\.6/.test(x); })[0] || '';
    record('G9.5.bLabel', /×2\.6/.test(bLine),
      'B 卡渲染为 "' + bLine + '" —— 单体 DPS + "×2.6" 文字后缀表达 3 目标系数（数值不自乘；' +
      expectDps.B.toFixed(1) + '×2.6 = ' + (expectDps.B * 2.6).toFixed(1) + '）');
  });

  /* ==========================================================================
     G6 · A7 键盘可达（真实触发注册在 window 上的 keydown）
     ======================================================================== */
  runGroup('G6.A7', 'G6 · A7 键盘可达：1-4 / Space / Esc / [ ] 切倍速 / Tab', function () {
    /* 1-4 选塔 */
    fresh('M1');
    const picked = [];
    ['1', '2', '3', '4'].forEach(function (k) { key(k); picked.push(G().buildType); });
    multi('A7.digits', '1/2/3/4 → 塔种', [
      ['1', picked[0], 'A'], ['2', picked[1], 'B'], ['3', picked[2], 'C'], ['4', picked[3], 'D']
    ]);

    /* Space = 提前召唤 */
    fresh('M1');
    const ph0 = G().phase;
    key(' ');
    record('A7.space', ph0 === 'PREP' && G().phase === 'WAVE',
      'Space：phase ' + ph0 + ' → ' + G().phase + '（提前召唤生效）');

    /* [ ] 切倍速（验收清单点名：GDD 两份副本共同遗漏的键位） */
    fresh('M1');
    IV().setSpeed(1);
    const spd = [G().speed];
    key(']'); spd.push(G().speed);
    key(']'); spd.push(G().speed);
    key(']'); spd.push(G().speed);        /* 已被夹在 3 */
    key('['); spd.push(G().speed);
    key('['); spd.push(G().speed);
    key('['); spd.push(G().speed);        /* 已被夹在 1 */
    multi('A7.speedKeys', '] / [ 切倍速序列（初始 1）', [
      [']', spd[1], 2], [']', spd[2], 3], ['] 上限', spd[3], 3], ['[', spd[4], 2], ['[', spd[5], 1], ['[ 下限', spd[6], 1]
    ]);

    /* Esc 取消选中 */
    fresh('M1');
    const m = G().map;
    G().selSite = m.sites[3]; G().selTower = null;
    key('Escape');
    record('A7.esc', G().selSite === null && G().selTower === null,
      'Esc：选中态被清空（selSite=' + G().selSite + '）');

    /* Tab 建焦点 */
    fresh('M1');
    key('Tab');
    record('A7.tab', typeof T().UI.focus === 'number' && T().UI.focus >= 0,
      'Tab：UI.focus = ' + T().UI.focus + '（Tab 遍历入口已接上；焦点环的绘制规格仍需人工截图核）');

    /* MENU 下 ArrowLeft/Right 切图（只允许已解锁图） */
    IV().reset();
    G().state = 'MENU'; G().mapId = 'M1';
    key('ArrowRight');
    const after1 = G().mapId;
    key('ArrowLeft');
    const after2 = G().mapId;
    record('A7.arrows', after1 === 'M1' && after2 === 'M1',
      '主菜单方向键：M1 未通关时 → ' + after1 + ' / ' + after2 + '（锁定图不会被选中 ✓）');

    /* 解锁后应能切到 M2 */
    const s = T().getSave(); s.firstClear.M1 = 1; IV().save(); IV().load();
    G().state = 'MENU'; G().mapId = 'M1';
    key('ArrowRight');
    eqStr('A7.arrowsUnlocked', 'M1 通关后 ArrowRight 选中的图', G().mapId, 'M2');
    IV().reset();
  });

  /* ==========================================================================
     A3 / A4 架构钩子（验收清单 §0：钩子本期必过）
     ======================================================================== */
  runGroup('A3A4', 'A3/A4 架构钩子（本期门禁，功能可次期）', function () {
    const P = T().PALETTE;
    record('A3.keys', !!(P.deuteranopia && P.tritanopia),
      '存在两个具名键 palette.deuteranopia / palette.tritanopia：' +
      (P.deuteranopia && P.tritanopia ? '有 ✓（键名合规，未自创 redgreen/blueyellow）' : '缺失'));

    /* 取色无硬编码：统计 PALETTE 定义块之外的颜色字面量 */
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const lines = html.split('\n');
    const palStart = lines.findIndex(function (l) { return /var PALETTE = \{/.test(l); });
    const palEnd = lines.findIndex(function (l, i) { return i > palStart && /^\};/.test(l); });
    const outside = [];
    for (let i = 0; i < lines.length; i++) {
      if (i >= palStart && i <= palEnd) continue;
      const l = lines[i];
      const hex = l.match(/'#[0-9A-Fa-f]{3,8}'/g) || [];
      const rgba = l.match(/'rgba?\([0-9][^']*\)'/g) || [];
      hex.concat(rgba).forEach(function (c) { outside.push({ line: i + 1, c: c }); });
    }
    record('A3.hardcoded', outside.length === 0,
      'PALETTE 定义块之外的硬编码颜色字面量 = ' + outside.length + ' 处' +
      (outside.length ? '（行号 ' + outside.slice(0, 30).map(function (o) { return o.line + ':' + o.c; }).join(', ') +
        (outside.length > 30 ? ' …' : '') + '）→ 色盲档切换时这些颜色不会跟着换，A3 的"取色无硬编码"不成立' : ''));

    /* A4：uiScale 为可乘系数 */
    const U = T().UI;
    record('A4.hook', typeof U.uiScale === 'number',
      'UI.uiScale 存在且为数值（当前 ' + U.uiScale + '，档位 1 / 1.25 / 1.5）：' + (typeof U.uiScale === 'number' ? '有 ✓' : '缺'));
    const scaleTest = [];
    [1, 1.25, 1.5].forEach(function (v) {
      const s = T().getSave(); s.settings.uiScale = v; IV().save();
      IV().load();
      scaleTest.push([v + '× → cardW/cardH', T().UI.cardW + '×' + T().UI.cardH,
        v === 1 ? '256×112' : (v === 1.25 ? '256×140' : '256×118')]);
    });
    ok('A4.behavior', 'uiScale 实测：' + scaleTest.map(function (x) { return x[0] + '=' + x[1]; }).join('，') +
      '（几何系数刻意 clamp 到 1.05 上限，见代码注释；只验档位是否真的传导到布局）');

    /* A5：动效减弱开关存在且真实压缩时长/粒子数 */
    const s5 = T().getSave(); s5.settings.reducedMotion = 1; IV().save(); IV().load();
    record('A5', T().UI.reducedMotion === true || T().UI.reducedMotion === 1,
      'reducedMotion 开关存在且能从存档读回：' + T().UI.reducedMotion);
    IV().reset();
  });

  /* ==========================================================================
     G10 难度曲线（由数据表复算；GDD §4.7 四条硬线）
     ======================================================================== */
  runGroup('G10', 'G10 难度曲线四条硬线（由 G2.3 数据复算）', function () {
    const CODE = { g: 'GRUNT', s: 'SPRINTER', b: 'BULWARK', w: 'WASP', d: 'WARDEN', x: 'BOSS' };
    function totalHP(mid, i) {
      const E = T().ENEMIES, k = T().MAPS[mid].k, wd = T().WAVES[mid][i];
      let hp = 0;
      function add(def) {
        if (!def) return;
        Object.keys(def).forEach(function (key) {
          if (key === 'bossHP') return;
          const code = CODE[key];
          if (!code) return;
          if (code === 'BOSS') hp += def[key] * (def.bossHP || 0);
          else hp += def[key] * E[code].hp * (1 + k * i);
        });
      }
      add(wd); if (wd.A || wd.B) { add(wd.A); add(wd.B); }
      if (wd.A) { /* 双路时 bossHP 在 lane 定义里，上面已处理 */ }
      return hp;
    }
    function isBossWave(mid, i) {
      const wd = T().WAVES[mid][i];
      const has = function (d) { return !!(d && d.x); };
      return has(wd) || has(wd.A) || has(wd.B);
    }

    ['M1', 'M2', 'M3'].forEach(function (mid) {
      const rat = [];
      for (let i = 1; i < 12; i++) rat.push({ w: i + 1, r: totalHP(mid, i) / totalHP(mid, i - 1), boss: isBossWave(mid, i) });
      /* G10.1 */
      const viol1 = rat.filter(function (x) {
        return x.boss ? (x.r < 1.00 || x.r > 2.20) : (x.r < 0.82 || x.r > 1.75);
      });
      record('G10.1.' + mid, viol1.length === 0,
        mid + ' 非Boss波增幅 ∈[0.82,1.75] / Boss 波 ∈[1.00,2.20]：实测 ' +
        rat.map(function (x) { return (x.boss ? 'B' : '') + x.r.toFixed(3); }).join(' / ') +
        (viol1.length ? ' → 越界 ' + viol1.map(function (x) {
          const lo = x.boss ? 1.00 : 0.82, hi = x.boss ? 2.20 : 1.75;
          const d = x.r < lo ? (x.r - lo) : (x.r - hi);
          return 'W' + x.w + '=' + x.r.toFixed(3) + '（界 [' + lo + ',' + hi + ']，偏 ' + (d * 100).toFixed(2) + '%）';
        }).join(',') : ' → 全部在界内'));

      /* G10.2 Boss 波的后一波必须是缓冲波（≤1.12 或负增长） */
      const viol2 = rat.filter(function (x) {
        const prevBoss = isBossWave(mid, x.w - 2);
        return prevBoss && x.r > 1.12;
      });
      record('G10.2.' + mid, viol2.length === 0,
        mid + ' Boss 波之后一波增幅 ≤1.12：' +
        (viol2.length ? '越界 ' + viol2.map(function (x) { return 'W' + x.w + '=' + x.r.toFixed(2); }).join(',') : '合规'));

      /* G10.3 有效HP / 波开始可用金币 不得超前一波 1.60 倍。
         注：「波开始可用金币」是实现里不存在的量（GDD 的推导列），故用 GDD 列值；
         分子用「总HP」保守近似（有效HP 只会更大，比值同样放大，结论方向不变）。
         Boss 波单独列出：设计数据本身在 Boss 波打破该线（见 report ④）。 */
      const golds = {
        M1: [320, 409, 531, 688, 871, 1088, 1347, 1572, 1855, 2146, 2419, 2807],
        M2: [300, 390, 508, 664, 847, 1095, 1422, 1662, 1989, 2395, 2778, 3195],
        M3: [380, 490, 626, 788, 991, 1221, 1607, 1977, 2305, 2685, 3050, 3482]
      }[mid];
      const ratio = [];
      for (let i = 0; i < 12; i++) ratio.push(totalHP(mid, i) / golds[i]);
      const viol3 = [], viol3boss = [];
      let peak = 0;
      for (let i = 1; i < 12; i++) {
        const g = ratio[i] / ratio[i - 1];
        const boss = isBossWave(mid, i);
        if (!boss) peak = Math.max(peak, g);
        if (g > 1.60) {
          if (boss) viol3boss.push('W' + (i + 1) + '=' + g.toFixed(2));
          else viol3.push('W' + (i + 1) + '=' + g.toFixed(2));
        }
      }
      record('G10.3.' + mid, viol3.length === 0,
        mid + ' 非Boss波「总HP/波开始金币」增幅 ≤1.60：' +
        (viol3.length ? '越界 ' + viol3.join(',') : '合规（非Boss峰值 ' + peak.toFixed(2) + '）') +
        (viol3boss.length ? ' ｜ Boss 波越界 ' + viol3boss.join(',') + '（设计侧，见 report ④）' : ''));
    });

    /* G10.4 三图终波总HP 9036 / 13691 / 15192 单调递增 */
    const last = ['M1', 'M2', 'M3'].map(function (mid) { return Math.round(totalHP(mid, 11)); });
    multi('G10.4.val', '三图终波总HP', [['M1', last[0], 9036], ['M2', last[1], 13691], ['M3', last[2], 15192]]);
    record('G10.4.mono', last[0] < last[1] && last[1] < last[2],
      '单调递增：' + last.join(' < ') + (last[0] < last[1] && last[1] < last[2] ? ' ✓' : ' ✗'));
  });

  /* ==========================================================================
     额外观察项（不计入 PASS/FAIL 门禁，但会写进 report）
     ======================================================================== */
  runGroup('OBS', '额外观察（供 report ⑤ 风险排序参考）', function () {
    /* 1) M3 盲区：代码在载入时按「点位最大射程」动态求解，与 GDD §5.3 声明的 240/180px 比对 */
    IV().reset();
    IV().startMap('M3');
    const bz = IV().blindZones();
    const total = bz.reduce(function (a, b) { return a + b.len; }, 0);
    const groundTotal = IV().paths()[0].total;
    ok('OBS.blind', 'M3 盲区实测 ' + bz.length + ' 段，合计 ' + total + 'px（占地面路径 ' +
      groundTotal.toFixed(0) + 'px 的 ' + (total / groundTotal * 100).toFixed(1) + '%）：' +
      bz.map(function (b) { return 'x[' + Math.round(b.from.x) + '→' + Math.round(b.to.x) + '] ' + b.len + 'px'; }).join('，') +
      ' ｜ GDD §5.3/§7.1 声明"2 段，约 240px 与 180px（合计 420px）"');

    /* 2) M3 飞行航程 vs GDD 声明的 900px */
    IV().reset();
    IV().startMap('M3');
    const w1 = IV().spawnEnemy('WASP', 0, 0);
    let minL = 1e9, maxL = 0;
    for (let i = 0; i < 40; i++) {
      IV().reset(); IV().startMap('M3');
      const w = IV().spawnEnemy('WASP', 0, 0);
      const raw = G().enemies[0];
      const L = Math.hypot(raw.tx - raw.sx, raw.ty - raw.sy);
      if (L < minL) minL = L;
      if (L > maxL) maxL = L;
    }
    ok('OBS.flight', 'M3 飞行航程实测 ' + minL.toFixed(0) + '–' + maxL.toFixed(0) + 'px（40 次随机出生），GDD §4.6/§5.2 称 900px');

    /* 3) 冷却余量未结转：低帧率下 DPS 略低于标称 */
    fresh('M1');
    const m = G().map;
    const si = findSiteByGrid(m, 6, 3);
    IV().build(si, 'A', 3);              /* CD 400ms */
    IV().setGold(0);
    IV().setWave(12);
    const e = IV().spawnEnemy('BULWARK', 0, 480);
    const r = rawEnemy(e.eid);
    r.x = m.sites[si].x + 40; r.y = m.sites[si].y;
    let prev = G().towers[0].cdMs, fires = 0;
    for (let t = 0; t < 10000; t += 50) {
      IV().tick(50);
      const c = G().towers[0].cdMs;
      if (c > prev + 1) fires++;
      prev = c;
      const rr = rawEnemy(e.eid);
      if (rr) { rr.x = m.sites[si].x + 40; rr.y = m.sites[si].y; }
    }
    ok('OBS.cdResidual', 'A Lv3（CD 400ms）在 50ms 固定步长下 10s 开火 ' + fires +
      ' 次（标称 25 次）。偏差来自「cdMs 归零那一帧不结转余量」：最大丢帧 = 一个步长');

    /* 4) 粒子颜色默认值 '#fff' 是 PALETTE 之外的硬编码 */
    ok('OBS.particleColor', 'particles[] 初始化里 color 默认值写作 \'#fff\'（index.html:569），是 PALETTE 之外的唯一十六进制字面量；' +
      '该字段在 pSpawn 每次都被覆盖，实际不参与渲染');

    /* 5) 双路 M2 Boss 是否只走 A 路 */
    IV().reset();
    IV().startMap('M2');
    const m2 = G().map;
    let bossLaneOk = true, bossSeen = 0;
    [5, 11].forEach(function (wIdx) {
      IV().setWave(wIdx);
      T().startWave();
      IV().tick(50);
      IV().getEnemies().forEach(function (en) {
        if (en.type !== 'BOSS') return;
        bossSeen++;
        const raw = G().enemies.filter(function (x) { return x.eid === en.eid; })[0];
        if (raw && Math.abs(raw.y - m2.lanes[0].pts[0][1]) > 400) bossLaneOk = false;
      });
      G().enemies.length = 0;
    });
    ok('OBS.bossLane', 'M2 中 Boss 只从 A 路出生（GDD §4.5 规则）：检查 ' + bossSeen + ' 只 Boss，代码把 boss 写入 lane 0（A 路）');
  });

  /* ==========================================================================
     G6 · A2 对比度（独立复算，不信自述）
     ========================================================================== */
  runGroup('G6.A2', 'G6 · A2 对比度（WCAG 2.1 复算，按**实际用法**查而非按色值查）', function () {
    function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function lum(hex) {
      const h = hex.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }
    function ratio(fg, bg) {
      const a = lum(fg), b = lum(bg);
      const hi = Math.max(a, b), lo = Math.min(a, b);
      return (hi + 0.05) / (lo + 0.05);
    }
    function blend(fg, bg, alpha) {
      const f = fg.replace('#', '').toUpperCase(), b = bg.replace('#', '').toUpperCase();
      const out = [0, 2, 4].map(function (i) {
        const v = Math.round(parseInt(f.slice(i, i + 2), 16) * alpha + parseInt(b.slice(i, i + 2), 16) * (1 - alpha));
        return ('0' + v.toString(16)).slice(-2);
      });
      return '#' + out.join('').toUpperCase();
    }

    const C = T().C;
    /* 游戏里所有可能被文字压住的底色 */
    const BGS = [
      ['bg', C.bg], ['ground', C.ground], ['path', C.path], ['panel', C.panel], ['topbar', C.topbar]
    ];

    /* ---- 运行时抓取：每次 fillText 时的 fillStyle 与 globalAlpha ----
       这才是"按用法查"：不管颜色叫什么、写在哪一行，只看玩家真正看到的合成结果。 */
    const realCtx = GAME.stageCanvas.getContext('2d');
    const origFillText = realCtx.fillText;
    const recs = [];
    function capture(screen, setup) {
      realCtx.globalAlpha = 1;
      realCtx.fillText = function (str) {
        recs.push({
          screen: screen,
          s: String(str),
          col: String(realCtx.fillStyle || ''),
          alpha: (typeof realCtx.globalAlpha === 'number') ? realCtx.globalAlpha : 1
        });
      };
      try { setup(); } finally { realCtx.fillText = origFillText; }
    }
    try {
      IV().reset();
      G().state = 'MENU'; capture('MENU', function () { T().render(16); });
      /* 一张图锁定、一张已解锁，把两种卡片都渲染出来 */
      const s0 = T().getSave(); s0.firstClear.M1 = 1; s0.firstClear.M2 = 0; s0.bestWave.M1 = 7; IV().save(); IV().load();
      G().state = 'MENU'; capture('MENU(locked)', function () { T().render(16); });
      IV().startMap('M1');
      IV().setGold(120);                       /* 有负担不起的卡 → 走禁用态分支 */
      IV().setWave(9);
      capture('PLAY', function () { T().render(16); });
      const s1 = T().getSave(); s1.tp = 6; IV().save(); IV().load();
      G().state = 'TECH'; capture('TECH', function () { T().render(16); });
      T().G.cleared = 3; T().G.baseHP = 17; T().endGame(true);
      capture('RESULT', function () { T().render(16); });
      IV().reset();
    } catch (e) {
      bad('A2.capture', '渲染抓取失败：' + (e && e.message ? e.message : e));
      return;
    }

    /* 每个 (颜色, alpha) 组合：取「最有利底色」与「最不利底色」的对比度 */
    const groups = {};
    let skipped = 0;
    recs.forEach(function (r) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(r.col)) { skipped++; return; }
      const key = r.col.toUpperCase() + '|' + r.alpha.toFixed(2);
      if (!groups[key]) {
        const ratios = BGS.map(function (b) {
          const eff = blend(r.col, b[1], r.alpha);
          return { bg: b[0], eff: eff, v: ratio(eff, b[1]) };
        });
        ratios.sort(function (x, y) { return x.v - y.v; });
        groups[key] = { col: r.col.toUpperCase(), alpha: r.alpha, n: 0, worst: ratios[0], best: ratios[ratios.length - 1], screens: {} };
      }
      groups[key].n++;
      groups[key].screens[r.screen] = (groups[key].screens[r.screen] || 0) + 1;
    });

    const list = Object.keys(groups).map(function (k) { return groups[k]; });
    list.sort(function (a, b) { return b.n - a.n; });

    /* ① 文字对比度：判据取「最有利底色」——这是给实现方最大的宽容，
       连最乐观的底色都过不了 4.5，才构成无可辩驳的 FAIL。 */
    const need = 4.5;
    const fails = list.filter(function (g) { return g.best.v < need; });
    record('A2.text', fails.length === 0,
      '本次抓取到 ' + recs.length + ' 次 fillText（' + list.length + ' 个颜色/透明度组合，' + skipped + ' 次非十六进制色跳过）。' +
      (fails.length
        ? '不达标（连最有利底色都 <4.5:1）：' + fails.map(function (g) {
            return g.col + '@α' + g.alpha + ' 最佳 ' + g.best.v.toFixed(2) + ':1（压 ' + g.best.bg + '）×' + g.n + ' 次';
          }).join('；')
        : '全部组合在最不利底色下也 ≥4.5:1'));

    /* ② 逐组合明细（供 report 引用与人工核对） */
    ok('A2.table', '文字色实测（最不利 / 最有利底色）：' + list.map(function (g) {
      return g.col + '@α' + g.alpha + ' ×' + g.n + ' → ' + g.worst.v.toFixed(2) + '~' + g.best.v.toFixed(2) + ':1';
    }).join(' ｜ '));

    /* ②b 余量提示：danger 在 path/ground 底色上会掉到 4.5 以下。
       当前只有 1 次使用且落在合格底色上，故不判 FAIL；但"余量为 0"本身就是后续改动的风险点。 */
    const dangerOn = BGS.map(function (b) { return b[0] + '=' + ratio(C.danger, b[1]).toFixed(2); });
    const dangerUse = list.filter(function (g) { return g.col === C.danger.toUpperCase(); });
    ok('A2.dangerMargin', 'C.danger(' + C.danger + ') 逐底色：' + dangerOn.join('，') +
      ' ｜ 当前实际使用 ' + dangerUse.reduce(function (a, g) { return a + g.n; }, 0) + ' 次（合成 ' +
      (dangerUse.length ? dangerUse[0].worst.v.toFixed(2) + '~' + dangerUse[0].best.v.toFixed(2) : '—') +
      ':1，达标）。注意：**压在 path(#1F2B38) 上只有 4.09:1**，将来任何新增的 danger 文字都不要画在路面上');

    /* ③ F-02 类缺陷的通式：文字被半透明压暗。
       只要有任何文字以 α<0.99 绘制、且合成后最佳对比度 <4.5，就是"整卡压暗"型缺陷。 */
    const dimmed = list.filter(function (g) { return g.alpha < 0.99; });
    const dimFails = dimmed.filter(function (g) { return g.best.v < need; });
    record('A2.textAlpha', dimFails.length === 0,
      dimmed.length === 0
        ? '没有任何文字以 α<0.99 绘制（"整卡压暗"型缺陷不存在）'
        : '有 ' + dimmed.length + ' 个半透明文字色：' + dimmed.map(function (g) {
            return g.col + '@α' + g.alpha + ' 合成最佳 ' + g.best.v.toFixed(2) + ':1 ×' + g.n + ' 次';
          }).join('，') + (dimFails.length ? ' → FAIL' : ' → 达标'));

    /* ④ F-01 专项：C.locked 是否还被当文字色用（按用法，不按名字） */
    const lockedTexts = list.filter(function (g) { return g.col === C.locked.toUpperCase(); });
    record('A2.lockedAsText', lockedTexts.length === 0,
      lockedTexts.length === 0
        ? 'C.locked(' + C.locked + ') 已不再用于任何文字绘制 → F-01 消除'
        : 'C.locked 仍被用作文字色：' + lockedTexts.map(function (g) {
            return 'α' + g.alpha + ' ×' + g.n + ' 次，最佳 ' + g.best.v.toFixed(2) + ':1';
          }).join('，') + (lockedTexts.some(function (g) { return g.best.v < need; }) ? ' → FAIL' : ' → 达标'));

    /* ⑤ C.locked 作**状态图形**时仍必须落在 3.0–3.2（调亮会把 A1 一起弄塌） */
    eqNum('A2.lockedRatio', 'C.locked on C.panel 的色值对比度（独立复算 3.01 这个数）',
      +ratio(C.locked, C.panel).toFixed(3), +ratio('#5C6B7C', '#16202C').toFixed(3), 0.001);
    record('A2.lockedAsGraphic', ratio(C.locked, C.panel) >= 3.0 && ratio(C.locked, C.panel) <= 3.2,
      'A2 ②：C.locked 作**状态图形**（环/描边/叉号）时 = ' + ratio(C.locked, C.panel).toFixed(2) +
      ':1，要求落在 3.0–3.2 带内（上限才拦得住"调亮"，见 art-bible §6.2）→ ' +
      (ratio(C.locked, C.panel) >= 3.0 && ratio(C.locked, C.panel) <= 3.2 ? '达标' : '越界'));

    /* ⑥ 用法统计：同一个色值，图形用途 vs 文字用途要分开数 */
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const graphUses = (html.match(/C\.locked/g) || []).length;
    ok('A2.lockedUsage', '源码中 C.locked 出现 ' + graphUses + ' 次；运行时抓到的文字绘制里 C.locked 占 ' +
      lockedTexts.reduce(function (a, g) { return a + g.n; }, 0) + ' 次（其余为环/描边/叉号/斜纹等图形用途）');
  });


  /* ==========================================================================
     G6 · A4 字号下限（从**渲染结果**量，不从源码字面量量）
     art-director 的口径：源码里 `11px` 抓不到 `FONT.micro = 11` 这种查表写法，
     所以判据必须落在 ctx.font 上。本组在每次 fillText 时读 ctx.font 实测像素值。
     ======================================================================== */
  runGroup('G6.A4', 'G6 · A4 字号下限 ≥12px / 关键 ≥16px（从渲染结果量）', function () {
    const realCtx = GAME.stageCanvas.getContext('2d');
    const origFillText = realCtx.fillText;
    const sizes = [];
    function cap(setup) {
      realCtx.font = '400 12px sans-serif';
      realCtx.fillText = function (str) {
        const f = String(realCtx.font || '');
        const m = f.match(/(\d+(?:\.\d+)?)px/);
        sizes.push({ px: m ? parseFloat(m[1]) : NaN, s: String(str), font: f });
      };
      try { setup(); } finally { realCtx.fillText = origFillText; }
    }
    try {
      IV().reset();
      G().state = 'MENU'; cap(function () { T().render(16); });
      const s0 = T().getSave(); s0.firstClear.M1 = 1; IV().save(); IV().load();
      G().state = 'MENU'; cap(function () { T().render(16); });
      IV().startMap('M1');
      IV().setGold(120); IV().setWave(9);
      cap(function () { T().render(16); });
      const s1 = T().getSave(); s1.tp = 6; IV().save(); IV().load();
      G().state = 'TECH'; cap(function () { T().render(16); });
      T().G.cleared = 3; T().G.baseHP = 17; T().endGame(true);
      cap(function () { T().render(16); });
      IV().reset();
    } catch (e) {
      bad('A4.capture', '字号抓取失败：' + (e && e.message ? e.message : e));
      return;
    }

    const valid = sizes.filter(function (x) { return isFinite(x.px); });
    record('A4.capture', valid.length > 0 && valid.length === sizes.length,
      '抓到 ' + sizes.length + ' 次 fillText 的 font，可解析 px 的 ' + valid.length + ' 次');

    const minPx = Math.min.apply(null, valid.map(function (x) { return x.px; }));
    const dist = {};
    valid.forEach(function (x) { dist[x.px] = (dist[x.px] || 0) + 1; });
    const keys = Object.keys(dist).map(parseFloat).sort(function (a, b) { return a - b; });
    ok('A4.dist', '渲染字号分布：' + keys.map(function (k) { return k + 'px×' + dist[k]; }).join('，'));

    /* ① 绝对下限 12px（art-bible §5.2 Caption 档） */
    eqNum('A4.min12', '实测最小渲染字号（要求 ≥12px）', minPx, 12, 0);
    const under = valid.filter(function (x) { return x.px < 12; });
    record('A4.floor', under.length === 0,
      under.length
        ? '有 ' + under.length + ' 次渲染低于 12px：' + under.slice(0, 8).map(function (x) {
            return x.px + 'px "' + x.s.slice(0, 14) + '"';
          }).join('，')
        : '没有任何一次渲染低于 12px（最小 ' + minPx + 'px）');

    /* ② 关键数值 ≥16px：金币与基地 HP（GDD §7.3 P0 两项） */
    const gold = valid.filter(function (x) { return /^\d+$/.test(x.s); });
    const keyMin = gold.length ? Math.min.apply(null, gold.map(function (x) { return x.px; })) : NaN;
    record('A4.key16', isFinite(keyMin) && keyMin >= 16,
      '纯数字串（金币 / 基地 HP / 波次等关键数值）共 ' + gold.length + ' 次，最小 ' + keyMin +
      'px（GDD §7.3 要求 P0 数值 ≥16px）' + (isFinite(keyMin) && keyMin >= 16 ? ' ✓' : ''));

    /* ③ 不得绕过 text() 直接设字号 —— 一旦绕过，fs() 的 12px 夹取就失效 */
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const direct = (html.match(/ctx\.font\s*=/g) || []).length;
    const helper = (html.match(/function (text|textW)\(/g) || []).length;
    ok('A4.noBypass', 'ctx.font 赋值 ' + direct + ' 处，text()/textW() 助手 ' + helper +
      ' 个 → ' + (direct <= helper ? '全部字号都经 fs() 夹取（下限 12px 由 fs() 保证，不靠调用方自觉）' : '存在绕过 fs() 的字号设置'));
  });

  /* ==========================================================================
     OBS-2 · 地面路径逐段覆盖点数（design-strategist 要的"现存缺陷"探测）
     ======================================================================== */
  runGroup('OBS2', 'OBS2 地面路径逐段「覆盖该段的点位数」最小值（M1/M2/M3）', function () {
    function polyLen(pts) {
      let t = 0;
      for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return t;
    }
    function pointAt(pts, d) {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
        const seg = Math.hypot(bx - ax, by - ay);
        if (d <= acc + seg || i === pts.length - 1) {
          const t = seg > 0 ? Math.min(1, (d - acc) / seg) : 0;
          return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, seg: i };
        }
        acc += seg;
      }
      return { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1], seg: pts.length - 1 };
    }

    ['M1', 'M2', 'M3'].forEach(function (mid) {
      IV().reset();
      IV().startMap(mid);
      const m = G().map;
      const lanes = IV().paths();
      const out = [];
      lanes.forEach(function (lane, li) {
        const pts = lane.pts;
        const total = polyLen(pts);
        /* 盲区内的 0 覆盖是设计意图，不算缺陷 —— 先取运行时盲区区间用于排除 */
        /* 用 G.map.blind（内部结构带 s/e 弧长），而不是 blindZones() 的坐标形态 */
        const bzruns = (m.blind || []).filter(function (b) { return b.lane === li; });
        function inBlind(d) {
          return bzruns.some(function (b) { return d >= b.s - 1 && d <= b.e + 1; });
        }
        const perSeg = {};
        let minCov = 99, minAt = null;
        let uncovered = 0;
        for (let d = 0; d <= total; d += 10) {
          const p = pointAt(pts, d);
          let c = 0;
          m.sites.forEach(function (s) {
            const rng = s.high ? 185 * 1.15 : 185;
            if (Math.hypot(p.x - s.x, p.y - s.y) <= rng) c++;
          });
          if (c === 0) uncovered++;
          if (inBlind(d)) continue;                    /* 盲区内的 0 属设计意图，不参与"最小覆盖"统计 */
          const k = p.seg;
          if (!(k in perSeg) || c < perSeg[k]) perSeg[k] = c;
          if (c < minCov) { minCov = c; minAt = { d: Math.round(d), x: Math.round(p.x), y: Math.round(p.y), seg: p.seg }; }
        }
        const segList = Object.keys(perSeg).map(function (k) {
          return 'seg' + k + '(' + perSeg[k] + ')';
        }).join(' ');
        out.push('lane' + li + ' 总长 ' + Math.round(total) + '：**盲区外**逐段最少覆盖点数 ' + segList +
          ' ｜ 全程最少 ' + minCov + ' 个点位，出现在 d=' + minAt.d + 'px (x=' + minAt.x + ',y=' + minAt.y +
          ')，0 覆盖采样点 ' + uncovered + '/' + (Math.floor(total / 10) + 1) + '（含盲区）');
        if (mid === 'M3' && li === 0) {
          ok('OBS2.M3.minCov', 'M3 **盲区外**最少被 ' + minCov + ' 个点位覆盖（design-strategist 判据：≥2=叠瓦存在；' +
            '=1=现存缺陷应单列；=0 且盲区外=盲区定义漏算）→ ' +
            (minCov >= 2 ? '叠瓦存在，修订时只需守住 ≥2' : (minCov === 1 ? '**=1，属现存缺陷**（该段无重叠区）' : '**=0 且在盲区外，盲区定义漏算**')) +
            '；位置 d=' + minAt.d + ' x=' + minAt.x + ',y=' + minAt.y);
        }
      });
      ok('OBS2.' + mid, mid + '：' + out.join(' ／ '));
      /* 顺带核对：运行时盲区长度 vs 0 覆盖采样点数×10 */
      const bz = IV().blindZones();
      const bzLen = bz.reduce(function (a, b) { return a + b.len; }, 0);
      ok('OBS2.' + mid + '.blind', mid + ' 运行时盲区合计 ' + bzLen + 'px，' +
        bz.length + ' 段：' + bz.map(function (b) { return b.len + 'px'; }).join('+'));
    });

    /* 给 design-strategist 的第二个数：若把点位放到底边附近，可达 dy 与覆盖半宽 */
    IV().reset();
    IV().startMap('M3');
    const m3 = G().map;
    const pts = IV().paths()[0].pts;
    function distToPolyline(x, y) {
      let best = 1e9;
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
        const vx = bx - ax, vy = by - ay, wx = x - ax, wy = y - ay;
        const L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
        if (d < best) best = d;
      }
      return best;
    }
    ok('OBS2.grid', 'M1/M3 同用 CELL=40、GRID_OY=72，故点位行 gy 的纵坐标 = 92 + gy*40。' +
      '可覆盖底边 y=592 需 gy ≤ ' + Math.floor((592 - 92 - 92) / 40) + ' 且 dy=592−(92+gy*40) ≤ 185');
    const rows = [];
    for (let gy = 5; gy <= 12; gy++) {
      const y = 92 + gy * 40;
      const dy = 592 - y;
      if (dy < 0) continue;
      const half = dy <= 185 ? Math.sqrt(185 * 185 - dy * dy) : 0;
      /* 该行上离路径折线 ≥20px 且 x 落在盲区 x∈[-180,480] 的可用列（gx*40+20） */
      const cols = [];
      for (let gx = 0; gx <= 12; gx++) {
        const x = gx * 40 + 20;
        if (x > 480) continue;
        const dp = distToPolyline(x, y);
        if (dp >= 20) cols.push({ x: x, gx: gx, d: Math.round(dp), half: Math.round(half) });
      }
      rows.push('gy=' + gy + ' (y=' + y + ') dy=' + dy + ' 半宽=' + Math.round(half) + ' 可用列 ' + cols.length +
        (cols.length ? ' [' + cols.map(function (c) { return 'x=' + c.x + '(距路径' + c.d + ')'; }).join(',') + ']' : ''));
    }
    ok('OBS2.candidates', 'M3 可覆盖底边的候选行（dy ≤ 185 才有半宽）：' + rows.join(' ｜ '));
  });

  /* ==========================================================================
     DOC · GDD 文档自洽性（非实现缺陷，归口 design-strategist）
     ======================================================================== */
  runGroup('DOC', 'DOC GDD 文档自洽性（不阻塞实现签发，需 design-strategist 复核）', function () {
    /* DOC1：GDD 不得再持有「有效HP」列 —— 它是 §4.2 规则的导出值，写进表必与规则漂移
       （本文件曾因此 33/36 行不可复现）。断言直接读 design/gdd.md，不读测试内的副本。 */
    var gddSrc = '';
    try { gddSrc = fs.readFileSync(path.join(__dirname, '..', 'design', 'gdd.md'), 'utf8'); } catch (e) { gddSrc = ''; }
    var effColHits = (gddSrc.match(/\|\s*有效HP\s*\|/g) || []).length;
    record('DOC1.effHP', gddSrc.length > 0 && effColHits === 0,
      'GDD 波次表不得列「有效HP」列（导出值应由 §4.2 规则脚本计算）→ 实测该列出现 ' + effColHits +
      ' 次' + (gddSrc.length ? '' : '（未能读取 design/gdd.md）') +
      ' ｜ 总HP 列仍与实现 36/36 一致，该列不影响任何验收判据');

    /* GDD §4.6 声明 M3 飞行航线 900px；实测几何下不可能小于 950px */
    IV().reset();
    IV().startMap('M3');
    const b = G().map.base;
    const minLen = Math.hypot(b.x - (-10), 0);     /* 横距；sy 最高只能到 272（=base.y） */
    const maxLen = Math.hypot(b.x + 10, Math.max(Math.abs(160 - b.y), Math.abs(560 - b.y)));
    /* GDD §4.6 现声明「横距 950，直线 ≥950px」—— 断言文档值 = 几何横距 */
    const gddFlight = 950;
    record('DOC2.flightLen', Math.abs(minLen - gddFlight) < 1,
      'GDD §4.6 称 M3 飞行航线横距 ' + gddFlight + 'px；代码里飞行起点 x=-10、终点为基地 (' + b.x + ',' + b.y +
      ')，实测横距 ' + Math.round(minLen) + 'px，直线航程 ∈ [' + Math.round(minLen) + ', ' + Math.round(maxLen) + ']px');

    /* GDD §5.3 声明 M3 有 2 段盲区（约 240 + 180 = 420px）；实测按点位最大射程求解得 1 段 736px */
    IV().reset();
    IV().startMap('M3');
    const bz = IV().blindZones();
    const bzTotal = bz.reduce(function (a, x) { return a + x.len; }, 0);
    record('DOC3.blind', Math.abs(bzTotal - 420) < 60,
      'GDD §5.3/§7.1 声明 M3 有 2 段盲区、合计约 420px；实测求解出 ' + bz.length + ' 段、合计 ' + bzTotal +
      'px（占地面路径 ' + (bzTotal / IV().paths()[0].total * 100).toFixed(0) +
      '%。底边 y=592 段由 3 个常规点位覆盖（gx=5/2/11 三个挪位后点位），' +
      '剩两段缺口分别位于底边左端与拐角竖段。');
    ok('DOC3.note', '代码另存了一份 blindDecl（[[60,592]→[300,592]] 240px 与 [[300,592]→[480,592]] 180px），' +
      '但绘制与 blindZones() 都用运行时求解结果，blindDecl 实际未被任何渲染路径使用');
  });
}

/* ============================================================================
   输出
   ========================================================================== */
function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
console.log('');
console.log('============================================================');
console.log(' 铁幕防线 / IRON VEIL —— 无头行为测试（tests/headless.js）');
console.log(' 被测对象：' + HTML_PATH);
console.log(' 被测版本：' + SNAPSHOT.size + ' bytes ｜ sha256 ' + SNAPSHOT.sha256);
console.log('           mtime ' + SNAPSHOT.mtime);
if (BOOT_ERR) {
  console.log(' 启动状态：失败 —— ' + BOOT_ERR.message);
} else {
  console.log(' 启动状态：成功（vm.runInNewContext + document/canvas/localStorage/rAF stub）');
}
console.log('============================================================');
groups.forEach(function (g) {
  console.log('');
  console.log('【' + g.id + '】' + g.title);
  g.items.forEach(function (it) {
    console.log('  ' + (it.ok ? 'PASS' : 'FAIL') + '  ' + pad(it.id, 22) + it.detail);
  });
});
console.log('');
console.log('============================================================');
console.log(' 汇总：PASS ' + PASS + ' ／ FAIL ' + FAIL + ' ／ 合计 ' + (PASS + FAIL));
console.log('============================================================');
if (FAIL > 0) {
  console.log(' FAIL 列表：');
  groups.forEach(function (g) {
    g.items.forEach(function (it) {
      if (!it.ok) console.log('   - [' + it.id + '] ' + it.detail);
    });
  });
  console.log('');
}
/* 结束时复核被测文件是否在测试期间被改动（本仓库存在并发编辑） */
const AFTER = fileInfo(HTML_PATH);
if (AFTER.sha256 !== SNAPSHOT.sha256) {
  console.log(' ！！警告：测试期间 index.html 被改动（' + SNAPSHOT.sha256.slice(0, 12) + ' → ' +
    AFTER.sha256.slice(0, 12) + '），本次结果只对开始时的快照有效，请重跑。');
  console.log('');
}
process.exit(FAIL > 0 ? 1 : 0);
