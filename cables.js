// Cables for the connection map. Each connection is a smooth curve from its source's
// port to its repository's port: it leaves and enters a port level, and passes through
// any tie in the tie's own direction, so tied cables lie side by side like a ribbon.
//
// Ties are the moving parts. Drag across two or more cables on an empty part of the map
// to tie them; drag a tie to slide it along its bundle; double-click it to cut it. Each
// tie is a small mass on springs that keeps its place between its neighbours along the
// cables, so when the layout shifts it swings after its cables, overshoots and settles.
// A cable with no tie carries one invisible weight in its middle, so it swings too.
// Ties are kept in the browser (through the store passed in), per signed-in user.

const SVGNS = "http://www.w3.org/2000/svg";
const DT = 1 / 120;
const SPACING = 4.2;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BOUNCE = reduce ? [14, 1] : [13, 0.3]; // natural frequency (rad/s), damping ratio
const HOLD = [30, 0.9];

const el = (name, cls) => {
  const e = document.createElementNS(SVGNS, name);
  if (cls) e.setAttribute("class", cls);
  return e;
};
const f1 = (v) => v.toFixed(1);

function bez(p, c1, c2, q, s) {
  const u = 1 - s, a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
  return { x: a * p.x + b * c1.x + c * c2.x + d * q.x, y: a * p.y + b * c1.y + c * c2.y + d * q.y };
}
function spring(o, gx, gy, [w0, z]) {
  o.vx += (w0 * w0 * (gx - o.x) - 2 * z * w0 * o.vx) * DT;
  o.vy += (w0 * w0 * (gy - o.y) - 2 * z * w0 * o.vy) * DT;
  o.x += o.vx * DT; o.y += o.vy * DT;
}
function intersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (!d) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * map: the element the cables are drawn over (coordinates are relative to it).
 * svg: an <svg> filling it. store: { get(key), set(key, value) }.
 * Returns { update(links), midpoint(id), setStoreKey(key), onDraw }.
 */
export function createCables(map, svg, store) {
  const gCables = el("g"), gTies = el("g"), gRunners = el("g"), gCut = el("g");
  svg.prepend(gCables, gTies, gRunners, gCut);
  const hint = document.createElement("div");
  hint.className = "cut-hint";
  hint.hidden = true;
  map.append(hint);

  const cables = new Map(); // id -> cable
  let ties = [];
  let storeKey = null;
  let pending = []; // saved ties waiting for their cables to load
  let running = false, last = 0, acc = 0;
  let drag = null, lastTap = { t: 0, tie: null };
  const api = { onDraw: null };

  // ------------------------------------------------------------ geometry
  const portAnchor = (p) => ({ x: p[0], y: p[1], tx: 1, ty: 0, port: true });
  const slot = (m) => ({ x: m.t.x + m.t.nx * m.off, y: m.t.y + m.t.ny * m.off, tx: m.t.tx * m.dir, ty: m.t.ty * m.dir, m });
  /** The points a cable is held at, in order: its two ports and every tie between them. */
  function anchorsOf(c) {
    const mid = c.ties.length ? c.ties.map(slot) : [{ x: c.sway.x, y: c.sway.y, tx: c.sway.tx, ty: c.sway.ty }];
    return [portAnchor(c.a), ...mid, portAnchor(c.b)];
  }
  /** How far a tie's handles reach on one side. Every cable in a tie shares it, so the
      cables leave the tie side by side before they part. */
  function reach(a, leaving) {
    const m = a.m, toQ = leaving === m.dir > 0;
    return (toQ ? m.t.reachQ : m.t.reachP) * 0.42;
  }
  /** Bezier handles between two anchors: long and level at a port, shared at a tie, and
      never past the cable's own next point, or it would loop. */
  function handles(p, q) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    const hp = p.port ? Math.max(28, d * 0.45) : p.m ? Math.min(reach(p, true), d * 0.4) : d * 0.36;
    const hq = q.port ? Math.max(28, d * 0.45) : q.m ? Math.min(reach(q, false), d * 0.4) : d * 0.36;
    return [{ x: p.x + p.tx * hp, y: p.y + p.ty * hp }, { x: q.x - q.tx * hq, y: q.y - q.ty * hq }];
  }
  /** The middle of an untied cable's plain curve, and its heading there. */
  function swayRest(c) {
    const p = portAnchor(c.a), q = portAnchor(c.b), [c1, c2] = handles(p, q);
    const m = bez(p, c1, c2, q, 0.5), m1 = bez(p, c1, c2, q, 0.45), m2 = bez(p, c1, c2, q, 0.55);
    const l = Math.hypot(m2.x - m1.x, m2.y - m1.y) || 1;
    return { x: m.x, y: m.y, tx: (m2.x - m1.x) / l, ty: (m2.y - m1.y) / l };
  }
  /** A tied cable's neighbours either side of the tie, ordered along the tie's direction. */
  function around(m) {
    const list = anchorsOf(m.c), k = list.findIndex((a) => a.m === m);
    return m.dir > 0 ? [list[k - 1], list[k + 1]] : [list[k + 1], list[k - 1]];
  }
  /** Where a tie keeps a cable: a fraction of the way between its neighbours, and a little
      to one side of the straight line, both relative to that line. */
  function placeOf(m) {
    const [p, q] = around(m), dx = q.x - p.x, dy = q.y - p.y;
    return { x: p.x + dx * m.f - dy * m.side, y: p.y + dy * m.f + dx * m.side, dx, dy };
  }
  /** Remember where a cable sits between its neighbours, so the tie keeps that place. */
  function settleMember(m) {
    const [p, q] = around(m), s = slot(m), dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
    m.f = Math.max(0.15, Math.min(0.85, ((s.x - p.x) * dx + (s.y - p.y) * dy) / l2));
    m.side = ((s.y - p.y) * dx - (s.x - p.x) * dy) / l2;
  }
  function measureReach(t) {
    let rp = 0, rq = 0;
    for (const m of t.members) {
      const [p, q] = around(m), s = slot(m);
      rp += Math.hypot(p.x - s.x, p.y - s.y); rq += Math.hypot(q.x - s.x, q.y - s.y);
    }
    t.reachP = rp / t.members.length; t.reachQ = rq / t.members.length;
  }
  /** Where a tie's cables want it, and the way its bundle runs. */
  function goal(t) {
    let gx = 0, gy = 0, ax = 0, ay = 0;
    for (const m of t.members) {
      const g = placeOf(m), l = Math.hypot(g.dx, g.dy) || 1;
      gx += g.x - t.nx * m.off; gy += g.y - t.ny * m.off;
      ax += g.dx / l; ay += g.dy / l;
    }
    const n = t.members.length, al = Math.hypot(ax, ay) || 1;
    return { x: gx / n, y: gy / n, tx: ax / al, ty: ay / al };
  }

  // ------------------------------------------------------------ simulation
  function step() {
    for (const c of cables.values()) if (!c.ties.length) {
      const r = swayRest(c);
      spring(c.sway, r.x, r.y, BOUNCE);
      c.sway.tx = r.tx; c.sway.ty = r.ty;
    }
    for (const t of ties) {
      const g = goal(t);
      t.tx += (g.tx - t.tx) * 0.15; t.ty += (g.ty - t.ty) * 0.15;
      const tl = Math.hypot(t.tx, t.ty) || 1; t.tx /= tl; t.ty /= tl;
      t.nx = -t.ty; t.ny = t.tx;
      if (t.held) spring(t, t.cx, t.cy, HOLD);
      else spring(t, g.x, g.y, BOUNCE);
      measureReach(t);
    }
  }

  function pointAt(c, f) {
    const S = c.samples;
    if (!c.lens) {
      c.lens = [0];
      for (let i = 1; i < S.length; i++) c.lens.push(c.lens[i - 1] + Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y));
    }
    const target = f * c.lens[S.length - 1];
    let i = 1;
    while (i < S.length - 1 && c.lens[i] < target) i++;
    const k = (target - c.lens[i - 1]) / ((c.lens[i] - c.lens[i - 1]) || 1);
    return { x: S[i - 1].x + (S[i].x - S[i - 1].x) * k, y: S[i - 1].y + (S[i].y - S[i - 1].y) * k };
  }

  function draw(now) {
    for (const c of cables.values()) {
      const list = anchorsOf(c);
      let d = `M${f1(list[0].x)},${f1(list[0].y)}`;
      const samples = [];
      for (let k = 0; k < list.length - 1; k++) {
        const p = list[k], q = list[k + 1], [c1, c2] = handles(p, q);
        d += `C${f1(c1.x)},${f1(c1.y)} ${f1(c2.x)},${f1(c2.y)} ${f1(q.x)},${f1(q.y)}`;
        for (let s = 0; s < 16; s++) samples.push({ ...bez(p, c1, c2, q, s / 16), gap: k });
      }
      const end = list[list.length - 1];
      samples.push({ x: end.x, y: end.y, gap: list.length - 2 });
      c.samples = samples;
      c.lens = null;
      if (c.d !== d) { c.casing.setAttribute("d", d); c.core.setAttribute("d", d); c.d = d; }
      // Moving dots: one slow one on a healthy connection, three quick ones while it syncs.
      c.runners.forEach((dot, i) => {
        const dur = c.st === "busy" ? 1800 : 3600;
        const f = ((now / dur) + i / c.runners.length) % 1;
        const p = pointAt(c, f);
        dot.setAttribute("cx", f1(p.x)); dot.setAttribute("cy", f1(p.y));
        dot.setAttribute("opacity", Math.min(1, f / 0.12, (1 - f) / 0.12).toFixed(2));
      });
    }
    for (const t of ties) {
      const len = t.members.length * SPACING + 5, th = 5.5;
      const ang = Math.atan2(t.ny, t.nx) * 180 / Math.PI;
      t.el.setAttribute("transform", `translate(${f1(t.x)},${f1(t.y)}) rotate(${ang.toFixed(1)})`);
      const r = t.el.firstChild, s = t.el.lastChild;
      r.setAttribute("x", -len / 2); r.setAttribute("y", -th / 2); r.setAttribute("width", len); r.setAttribute("height", th);
      s.setAttribute("x1", -len / 2 + 2); s.setAttribute("x2", len / 2 - 2); s.setAttribute("y1", -th / 2 + 1.2); s.setAttribute("y2", -th / 2 + 1.2);
    }
    api.onDraw?.();
  }

  const visible = () => map.offsetParent !== null && getComputedStyle(svg).display !== "none";
  function frame(now) {
    if (!visible()) { running = false; return; }
    acc += Math.min(0.05, Math.max(0, now - last) / 1000);
    last = now;
    while (acc >= DT) { step(); acc -= DT; }
    draw(now);
    requestAnimationFrame(frame);
  }
  function wake() {
    if (running || !visible()) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ ties
  function addTieEl(t) {
    t.el = el("g", "tie");
    t.el.innerHTML = '<rect class="tie-body" rx="1.6"></rect><line class="tie-shine"></line>';
    gTies.append(t.el);
  }
  /** Cables crossed by the segment s-e: where, which stretch of the cable, and its heading. */
  function crossings(s, e) {
    const out = [];
    for (const c of cables.values()) {
      const S = c.samples;
      for (let j = 0; j < S.length - 1; j++) {
        const hit = intersect(s, e, S[j], S[j + 1]);
        if (!hit) continue;
        const dx = S[j + 1].x - S[j].x, dy = S[j + 1].y - S[j].y, l = Math.hypot(dx, dy) || 1;
        out.push({ c, gap: S[j].gap, x: hit.x, y: hit.y, dx: dx / l, dy: dy / l });
        break;
      }
    }
    return out;
  }
  function makeTie(hits) {
    if (hits.length < 2) return;
    const x = hits.reduce((s, h) => s + h.x, 0) / hits.length;
    const y = hits.reduce((s, h) => s + h.y, 0) / hits.length;
    // The bundle's direction: cables point their own way, so flip each to agree with the first.
    let tx = 0, ty = 0;
    const dirs = hits.map((h) => {
      const dir = h.dx * hits[0].dx + h.dy * hits[0].dy < 0 ? -1 : 1;
      tx += h.dx * dir; ty += h.dy * dir;
      return dir;
    });
    const l = Math.hypot(tx, ty) || 1;
    const t = { x, y, vx: 0, vy: 0, tx: tx / l, ty: ty / l, members: [] };
    t.nx = -t.ty; t.ny = t.tx;
    hits.map((h, i) => ({ h, dir: dirs[i], s: (h.x - x) * t.nx + (h.y - y) * t.ny }))
      .sort((a, b) => a.s - b.s)
      .forEach((o, k, all) => {
        const m = { c: o.h.c, t, dir: o.dir, off: (k - (all.length - 1) / 2) * SPACING, f: 0.5, side: 0 };
        t.members.push(m);
        o.h.c.ties.splice(Math.min(o.h.gap, o.h.c.ties.length), 0, m);
      });
    t.members.forEach(settleMember);
    measureReach(t);
    addTieEl(t);
    ties.push(t);
    save();
  }
  function removeTie(t, quiet) {
    t.el.remove();
    ties = ties.filter((x) => x !== t);
    for (const m of t.members) {
      const s = slot(m), i = m.c.ties.indexOf(m);
      if (i >= 0) m.c.ties.splice(i, 1);
      // A cable let loose swings back from where the tie held it.
      if (!m.c.ties.length) m.c.sway = { ...swayRest(m.c), x: s.x, y: s.y, vx: 0, vy: 0 };
    }
    if (!quiet) save();
  }
  const tieAt = (p) => ties.find((t) => {
    const dx = p.x - t.x, dy = p.y - t.y;
    return Math.abs(dx * t.nx + dy * t.ny) < t.members.length * SPACING / 2 + 8 && Math.abs(dx * t.tx + dy * t.ty) < 9;
  });
  /** The line a held tie slides along: between its neighbours, through the tie's centre. */
  function rail(t) {
    let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    for (const m of t.members) {
      const [p, q] = around(m);
      x0 += p.x - t.nx * m.off; y0 += p.y - t.ny * m.off;
      x1 += q.x - t.nx * m.off; y1 += q.y - t.ny * m.off;
    }
    const n = t.members.length;
    return [{ x: x0 / n, y: y0 / n }, { x: x1 / n, y: y1 / n }];
  }

  // ------------------------------------------------------------ keeping ties
  function save() {
    if (!storeKey) return;
    const data = ties.map((t) => ({
      tx: t.tx, ty: t.ty,
      members: t.members.map((m) => ({ id: m.c.id, dir: m.dir, off: m.off, f: m.f, side: m.side, at: m.c.ties.indexOf(m) })),
    }));
    // Saved ties still waiting for their cables to load are kept too.
    store.set(storeKey, JSON.stringify([...data, ...pending]));
  }
  /** Rebuild the saved ties whose cables are all on the map; the rest keep waiting, as
      the map's connections load in turn. */
  function restore() {
    const waiting = [];
    const back = [];
    for (const s of pending) {
      if (!s.members.every((m) => cables.has(m.id))) { waiting.push(s); continue; }
      const t = { x: 0, y: 0, vx: 0, vy: 0, tx: s.tx, ty: s.ty, nx: -s.ty, ny: s.tx, members: [] };
      for (const sm of s.members) {
        const m = { c: cables.get(sm.id), t, dir: sm.dir, off: sm.off, f: sm.f, side: sm.side };
        t.members.push(m);
        m.c.ties.splice(Math.min(sm.at, m.c.ties.length), 0, m);
      }
      addTieEl(t);
      ties.push(t);
      back.push(t);
    }
    pending = waiting;
    // Put each tie straight where its cables want it, without swinging in from nowhere.
    for (let i = 0; i < 4; i++) for (const t of back) { const g = goal(t); t.x = g.x; t.y = g.y; measureReach(t); }
  }

  // ------------------------------------------------------------ pointer
  const toMap = (e) => {
    const r = map.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const busyTarget = (e) => e.target.closest(".mnode, .mlabel, button, a, input, select, label, form");

  map.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !visible() || busyTarget(e)) return;
    const p = toMap(e);
    const t = tieAt(p);
    if (t) {
      e.preventDefault();
      const now = performance.now();
      if (lastTap.tie === t && now - lastTap.t < 380) { removeTie(t); lastTap = { t: 0, tie: null }; wake(); return; }
      lastTap = { t: now, tie: t };
      t.el.classList.add("hot");
      t.held = true; t.cx = t.x; t.cy = t.y;
      drag = { type: "tie", t, dx: p.x - t.x, dy: p.y - t.y };
    } else if (cables.size >= 2) {
      e.preventDefault();
      drag = { type: "cut", s: p, e: p };
      gCut.innerHTML = '<line class="cut-line"></line>';
      map.classList.add("cutting");
    } else return;
    map.setPointerCapture(e.pointerId);
    wake();
  });
  map.addEventListener("pointermove", (e) => {
    const p = toMap(e);
    if (!drag) {
      if (!busyTarget(e)) map.classList.toggle("over-tie", Boolean(tieAt(p)));
      return;
    }
    if (drag.type === "tie") {
      // Along the bundle it slides, cinching the cables up behind it; pulled sideways it
      // gives only a little.
      const [a, b] = rail(drag.t), dx = b.x - a.x, dy = b.y - a.y;
      const gx = p.x - drag.dx, gy = p.y - drag.dy;
      const u = Math.max(0.15, Math.min(0.85, ((gx - a.x) * dx + (gy - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const rx = a.x + dx * u, ry = a.y + dy * u;
      drag.t.cx = rx + (gx - rx) * 0.3; drag.t.cy = ry + (gy - ry) * 0.3;
      return;
    }
    drag.e = p;
    const line = gCut.firstChild;
    line.setAttribute("x1", drag.s.x); line.setAttribute("y1", drag.s.y); line.setAttribute("x2", p.x); line.setAttribute("y2", p.y);
    const hits = crossings(drag.s, p);
    gCut.querySelectorAll(".cut-mark").forEach((m) => m.remove());
    for (const h of hits) {
      const c = el("circle", "cut-mark");
      c.setAttribute("r", 2.2); c.setAttribute("cx", h.x); c.setAttribute("cy", h.y);
      gCut.append(c);
    }
    if (Math.hypot(p.x - drag.s.x, p.y - drag.s.y) > 8) {
      hint.hidden = false;
      hint.textContent = hits.length >= 2 ? `Tie ${hits.length} cables` : "Drag across two or more cables";
      hint.style.left = p.x + "px"; hint.style.top = p.y + "px";
    }
  });
  const end = () => {
    if (!drag) return;
    if (drag.type === "tie") {
      drag.t.el.classList.remove("hot");
      drag.t.held = false;
      drag.t.members.forEach(settleMember);
      save();
    } else {
      makeTie(crossings(drag.s, drag.e));
      gCut.innerHTML = "";
      hint.hidden = true;
      map.classList.remove("cutting");
    }
    drag = null;
  };
  map.addEventListener("pointerup", end);
  map.addEventListener("pointercancel", end);

  // ------------------------------------------------------------ the app's side
  /** links: [{ id, a: [x, y], b: [x, y], kind, st }], the map's connections as laid out now. */
  api.update = (links) => {
    const seen = new Set();
    for (const l of links) {
      seen.add(l.id);
      let c = cables.get(l.id);
      if (!c) {
        c = { id: l.id, ties: [], samples: [], runners: [], casing: el("path", "casing"), core: el("path", "core") };
        gCables.append(c.casing, c.core);
        cables.set(l.id, c);
      }
      const fresh = !c.a;
      c.a = l.a; c.b = l.b;
      if (fresh) c.sway = { ...swayRest(c), vx: 0, vy: 0 };
      if (c.kind !== l.kind || c.st !== l.st) {
        c.kind = l.kind; c.st = l.st;
        c.core.setAttribute("class", `core k-${l.kind}${l.st === "" ? " idle" : l.st === "err" ? " err" : ""}`);
        const n = l.st === "busy" ? 3 : l.st === "ok" ? 1 : 0;
        c.runners.forEach((d) => d.remove());
        c.runners = Array.from({ length: n }, () => {
          const dot = el("circle", "runner-dot" + (l.st === "busy" ? " busy" : ""));
          dot.setAttribute("r", 3);
          dot.setAttribute("opacity", "0");
          gRunners.append(dot);
          return dot;
        });
      }
    }
    // Connections that are gone take their place in any tie with them.
    let changed = false;
    for (const [id, c] of cables) {
      if (seen.has(id)) continue;
      for (const m of [...c.ties]) {
        const t = m.t;
        t.members = t.members.filter((x) => x !== m);
        if (t.members.length < 2) removeTie(t, true);
      }
      c.casing.remove(); c.core.remove(); c.runners.forEach((d) => d.remove());
      cables.delete(id);
      changed = true;
    }
    if (pending.length) restore();
    if (changed) save();
    if (!running) draw(performance.now());
    wake();
  };
  /** Where a label can sit on a connection's cable, best first: around its middle, or
      once it is tied, around the middle of its free ends (the longer first), so labels
      stay clear of ties and bundles. */
  api.labelSpots = (id) => {
    const c = cables.get(id);
    if (!c?.samples.length) return [];
    const at = [0.5, 0.38, 0.62, 0.26, 0.74];
    if (!c.ties.length) return at.map((f) => pointAt(c, f));
    const S = c.samples, lastGap = S[S.length - 1].gap;
    pointAt(c, 0);
    const total = c.lens[S.length - 1] || 1;
    let first = 0, last = 0;
    for (let i = 1; i < S.length; i++) {
      if (S[i - 1].gap === 0) first = c.lens[i];
      if (S[i - 1].gap === lastGap) last += c.lens[i] - c.lens[i - 1];
    }
    const ends = [(f) => (first * f) / total, (f) => 1 - (last * (1 - f)) / total];
    if (last > first) ends.reverse();
    return ends.flatMap((end) => at.map((f) => pointAt(c, end(f))));
  };
  /** Whose ties to show: ties are kept per signed-in user. */
  api.setStoreKey = (key) => {
    if (key === storeKey) return;
    storeKey = key;
    [...ties].forEach((t) => removeTie(t, true));
    try { pending = JSON.parse(store.get(key) || "[]"); } catch { pending = []; }
    if (!Array.isArray(pending)) pending = [];
    if (cables.size) restore();
  };
  return api;
}
