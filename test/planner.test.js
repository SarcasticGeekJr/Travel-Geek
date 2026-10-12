// Tests the trip planner inside travel-geek.user.js. The planner block is pure, so it is cut out and run here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../travel-geek.user.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("// ==planner=="), src.indexOf("// ==/planner=="));
const PLAN = new Function(block + "\nreturn PLAN;")();
const FLIGHTS = {
  mex: { standard: 24, airstrip: 17, wlt: 12, business: 7 },
  chi: { standard: 229, airstrip: 160, wlt: 114, business: 69 },
  jap: { standard: 213, airstrip: 149, wlt: 107, business: 64 },
};
const H = 3600,
  M = 60,
  NOW = 1_800_000_000;
const item = (o) => ({ key: `${o.cc}:${o.id}`, rate: 0, updated: NOW - 60, amt: 0, amtTypical: 0, type: "Plushie", ...o });
const base = (items, o = {}) => ({
  now: NOW,
  start: NOW,
  end: NOW + 4 * H,
  items,
  flights: FLIGHTS,
  method: "airstrip",
  capFor: (m) => (m === "standard" ? 17 : 22),
  extra: {},
  fee: 5,
  money: 50e6,
  tickets: 0,
  ticketValue: 5.5e6,
  sellMode: "hold",
  filter: () => true,
  ...o,
});

test("picks the trip that makes the most, and counts what you can carry", () => {
  const items = [
    item({ cc: "mex", id: 258, name: "Jaguar Plushie", qty: 500, cost: 10000, sell: 60000 }),
    item({ cc: "jap", id: 206, name: "Xanax", qty: 900, cost: 750000, sell: 900000, type: "Drug" }),
  ];
  const r = PLAN.make(base(items));
  assert.ok(r.best);
  const first = r.best.legs[0];
  assert.equal(first.buys[0].units, 22);
  // Mexico round trips are short, so several fit in 4 hours; Japan only once.
  assert.ok(r.best.exp > 0);
  assert.ok(r.best.legs.every((g) => g.back <= NOW + 4 * H), "everything back inside the window");
});

test("tailors the mix to the money you can use", () => {
  const items = [
    item({ cc: "jap", id: 206, name: "Xanax", qty: 900, cost: 750000, sell: 900000, type: "Drug" }),
    item({ cc: "jap", id: 277, name: "Cherry Blossom", qty: 900, cost: 500, sell: 20000, type: "Flower" }),
  ];
  // Japan by airstrip is 2h29m each way, so give it 6 hours.
  const rich = PLAN.make(base(items, { money: 50e6, end: NOW + 6 * H }));
  const poor = PLAN.make(base(items, { money: 5e6, end: NOW + 6 * H }));
  const x = (r) => r.best.legs[0].buys.find((b) => b.id === 206);
  assert.equal(x(rich).units, 22);
  assert.equal(x(poor).units, 6, "only 6 Xanax fit in $5m");
  assert.ok(poor.best.legs[0].cash <= 5e6);
  const blossoms = poor.best.legs[0].buys.find((b) => b.id === 277);
  assert.equal(blossoms.units, 16, "the rest of the slots go to something cheaper");
});

test("lands at a predicted restock instead of waiting abroad", () => {
  // China by airstrip is 2h40m, so a restock 5h away means leaving later.
  const pred = { at: NOW + 5 * H, from: NOW + 5 * H - 10 * M, to: NOW + 5 * H + 10 * M, conf: "high", pct: 85, avg: 2 * H };
  const items = [item({ cc: "chi", id: 274, name: "Panda Plushie", qty: 0, cost: 40000, sell: 120000, pred, amtTypical: 800, rate: 600 })];
  const r = PLAN.make(base(items, { end: NOW + 8 * H }));
  const g = r.best.legs[0];
  assert.ok(g.land >= pred.at && g.land <= pred.to, "lands inside the restock window");
  assert.ok(g.depart > NOW, "leaves later rather than now");
  assert.ok(g.sure > 0.5 && g.sure <= 0.85, "expected profit uses the learned confidence");
});

test("never plans to land before a restock", () => {
  const pred = { at: NOW + 3 * H, from: NOW + 3 * H - 5 * M, to: NOW + 3 * H + 5 * M, conf: "high", pct: 85, avg: 2 * H };
  const items = [item({ cc: "jap", id: 206, name: "Xanax", qty: 0, cost: 750000, sell: 900000, pred, amtTypical: 1000, rate: 2000 })];
  // Window too short to land after the restock and get back.
  const r = PLAN.make(base(items, { end: NOW + 3 * H }));
  assert.equal(r.best, null);
});

test("uses a Business ticket only when it pays for itself", () => {
  const items = [item({ cc: "jap", id: 206, name: "Xanax", qty: 900, cost: 750000, sell: 900000, type: "Drug" })];
  // 22 Xanax make ~$1.0m, far less than a $5.5m ticket: never worth it.
  const r = PLAN.make(base(items, { tickets: 2, end: NOW + 3 * H }));
  assert.ok(!r.best || r.best.legs.every((g) => g.method !== "business"));
  // A huge-margin item makes the ticket worth it when the normal flight can't fit in the window.
  const big = [item({ cc: "jap", id: 1, name: "Gold", qty: 900, cost: 1e6, sell: 2e6, type: "Drug" })];
  const r2 = PLAN.make(base(big, { tickets: 1, end: NOW + 2.5 * H }));
  assert.equal(r2.best.legs[0].method, "business");
  assert.equal(r2.best.legs[0].ticket, 5.5e6);
});

test("cash steps say where to get the money for each trip", () => {
  const plan = { legs: [{ cash: 10e6, buys: [] }, { cash: 4e6, buys: [] }] };
  const steps = PLAN.cashSteps(plan, 3e6, [{ name: "Vault", amount: 5e6 }, { name: "Stocks", amount: 20e6 }], "hold");
  assert.deepEqual(steps[0].take, [{ name: "Vault", amount: 5e6 }, { name: "Stocks", amount: 2e6 }]);
  assert.deepEqual(steps[1].take, [{ name: "Stocks", amount: 4e6 }]);
  assert.equal(steps[0].inHand, 3e6, "what you hold before taking money out");
  assert.equal(steps[1].short, 0);
});

test("in-stock items that sell out before you land are skipped", () => {
  const items = [item({ cc: "jap", id: 206, name: "Xanax", qty: 300, cost: 750000, sell: 900000, rate: 3000, type: "Drug" })];
  assert.equal(PLAN.make(base(items)).best, null);
});

test("fast enough for a phone", () => {
  const items = [];
  for (const cc of Object.keys(FLIGHTS))
    for (let i = 0; i < 25; i++) {
      const empty = i % 2;
      items.push(
        item({ cc, id: 1000 + i, name: "I" + i, qty: empty ? 0 : 500, cost: 10000 + i * 1000, sell: 30000 + i * 3000, rate: 200, amtTypical: 600, pred: empty ? { at: NOW + (i % 8) * 30 * M, from: NOW + (i % 8) * 30 * M - 600, to: NOW + (i % 8) * 30 * M + 600, conf: "medium", pct: 60, avg: 2 * H } : null })
      );
    }
  const t0 = Date.now();
  PLAN.make(base(items, { end: NOW + 8 * H, tickets: 2 }));
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + "ms");
});

test("plans hours ahead by projecting restock cycles (back from the UK at 10:30, 8 hours)", () => {
  // Mexico plushies sell out in ~1h and are empty ~30 min; Japan Xanax sells out in ~30 min, empty ~2h.
  const items = [
    item({ cc: "mex", id: 258, name: "Jaguar Plushie", qty: 300, cost: 10000, sell: 60000, rate: 600, amtTypical: 600, emptyAvg: 30 * M, emptyN: 8 }),
    item({ cc: "jap", id: 206, name: "Xanax", qty: 0, cost: 750000, sell: 900000, type: "Drug", rate: 2000, amtTypical: 1000, emptyAvg: 2 * H, emptyN: 8,
      pred: { at: NOW + 20 * M, from: NOW + 15 * M, to: NOW + 25 * M, conf: "high", pct: 80, avg: 2 * H } }),
  ];
  const start = NOW + 2.5 * H;
  const r = PLAN.make(base(items, { start, end: start + 8 * H, method: "standard" }));
  assert.ok(r.best, "finds a plan");
  assert.ok(r.best.legs.length >= 2, "several trips: " + r.best.legs.length);
  assert.ok(r.best.legs.every((g) => g.depart >= start && g.back <= start + 8 * H));
  // Every leg lands while stock is there, never before a projected restock.
  for (const g of r.best.legs) assert.ok(g.buys.every((b) => b.p > 0));
  // Later cycles are less certain than the next one.
  const near = PLAN.availability(items[1], NOW + 22 * M, NOW).p;
  const far = PLAN.availability(items[1], NOW + 22 * M + 3 * (2 * H + 30 * M), NOW).p;
  assert.ok(far > 0 && far < near, `near ${near} far ${far}`);
});
