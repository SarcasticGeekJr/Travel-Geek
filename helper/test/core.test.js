import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, predictRestock, buildItems, location, decideAlerts, cleanSettings, isQuiet, clock, flightSec, speedOf, countryCode, personal } from "../src/core.js";

const H = 3600,
  M = 60;

// Feed a series of [time, qty] looks into one item.
function history(points, cost = 800000) {
  let s;
  for (const [at, qty] of points) s = observe(s, { at, qty, cost, name: "Xanax" });
  return s;
}

test("restock cycles are measured from empty to restock using the middle of each gap", () => {
  const s = history([
    [0, 100],
    [10 * M, 0], // ran out between 0 and 10 min -> 5 min
    [2 * H, 0],
    [2 * H + 10 * M, 900], // back between 2h and 2h10 -> 2h05
  ]);
  assert.equal(s.cycles.length, 1);
  assert.equal(s.cycles[0], 2 * H);
  assert.equal(s.lastRestock, 2 * H + 5 * M);
  assert.equal(s.emptySince, null);
  assert.deepEqual(s.amts, [900]);
});

test("cycles with a big unknown gap are not trusted", () => {
  const s = history([
    [0, 100],
    [3 * H, 0], // unsure by 1.5h
    [5 * H, 0],
    [5 * H + 5 * M, 500],
  ]);
  assert.equal(s.cycles.length, 0);
});

test("the first look at an empty item has no known start", () => {
  const s = history([
    [0, 0],
    [H, 0],
    [H + 4 * M, 50],
  ]);
  assert.equal(s.cycles.length, 0);
  assert.equal(s.lastRestock, H + 2 * M);
});

test("selling speed comes from drops between close looks", () => {
  const s = history([
    [0, 1000],
    [30 * M, 500],
  ]);
  assert.equal(s.rate, 1000); // 500 in 30 min
});

test("restock prediction uses recent cycles and reports confidence", () => {
  let s = { name: "X", qty: 0, cost: 1, at: 0, cycles: [2 * H, 2 * H, 2 * H + 10 * M, 2 * H - 5 * M, 2 * H], amts: [], rate: 0, emptySince: 1000 };
  let p = predictRestock(s, 1000);
  assert.equal(p.conf, "high");
  assert.equal(p.at, 1000 + 2 * H);
  assert.ok(p.from < p.at && p.to > p.at);

  s = { ...s, cycles: [H, 3 * H] };
  p = predictRestock(s, 1000);
  assert.equal(p.conf, "low");

  s = { ...s, cycles: [] };
  assert.equal(predictRestock(s, 1000).conf, "none");
  assert.equal(predictRestock({ ...s, qty: 5 }, 1000), null);
});

test("an overdue restock is flagged", () => {
  const s = { qty: 0, emptySince: 0, cycles: [H, H, H] };
  assert.equal(predictRestock(s, 3 * H).overdue, true);
});

test("flight times, country names, item speed", () => {
  assert.equal(flightSec("jap", "business"), 64 * 60);
  assert.equal(flightSec("sou", "standard"), 282 * 60);
  assert.equal(countryCode("Returning to Torn from United Arab Emirates"), "uae");
  assert.equal(countryCode("In Japan"), "jap");
  assert.equal(countryCode("Cayman Islands"), "cay");
  assert.equal(speedOf("Plushie"), "fast");
  assert.equal(speedOf("Primary"), "slow");
  assert.equal(speedOf("Enhancer"), "medium");
  assert.equal(speedOf("Weapon", "Temporary"), "fast");
  assert.equal(speedOf("Weapon", "Primary"), "slow");
  assert.equal(speedOf("Armor"), "slow");
});

test("player location from the Torn API", () => {
  assert.deepEqual(location({ status: { state: "Okay", description: "Okay" } }, 0), { where: "torn" });
  assert.equal(location({ status: { state: "Abroad", description: "In Japan" } }, 0).cc, "jap");
  const f = location({ status: { state: "Traveling", description: "Traveling to Japan" }, travel: { destination: "Japan", timestamp: 500, departed: 100 } }, 0);
  assert.equal(f.where, "flying");
  assert.equal(f.cc, "jap");
  assert.equal(f.departed, 100);
  assert.equal(location({ status: { state: "Traveling", description: "Returning to Torn from Japan" }, travel: { destination: "Torn" } }, 0).where, "returning");
  assert.equal(location({ status: { state: "Hospital" } }, 0).where, "hospital");
});

test("profit per trip uses capacity, fee and available stock", () => {
  const it = { cc: "jap", qty: 1000, cost: 800000, sell: 1000000 };
  const p = personal(it, { capacity: 22, fee: 5, method: "business" });
  assert.equal(p.units, 22);
  assert.equal(p.unit, 150000);
  assert.equal(p.trip, 3300000);
  assert.equal(p.cash, 17600000);
  assert.equal(p.flight, 64 * 60);
  assert.equal(personal({ ...it, qty: 5 }, { capacity: 22, fee: 5 }).units, 5);
});

test("quiet hours wrap around midnight and use the player's time zone", () => {
  const st = cleanSettings({ quiet: { on: true, from: 23 * 60, to: 7 * 60 }, tz: 330 }); // India, UTC+5:30
  // 18:00 UTC = 23:30 India -> quiet
  assert.equal(isQuiet(st, 18 * H), true);
  // 06:00 UTC = 11:30 India -> not quiet
  assert.equal(isQuiet(st, 6 * H), false);
  assert.equal(clock(18 * H, 330), "23:30");
});

// ------------------------------------------------------------ alert rules
const T0 = 1_800_000_000;
function world({ qty = 0, emptySince = T0 - H, cycles = [2 * H, 2 * H, 2 * H, 2 * H, 2 * H], type = "Drug", cost = 800000, sell = 1000000, rate = 0, updated = T0 - 60, lastRestock = null } = {}) {
  const countries = { jap: { update: updated, items: { 206: { name: "Xanax", qty, cost, costAvg: cost, at: updated, cycles, amts: [], rate, emptySince: qty ? null : emptySince, lastRestock } } } };
  return buildItems(countries, { 206: { mv: sell, low: sell + 5000, type } }, T0);
}
const ME = { capacity: 22, method: "business", minProfit: 1_000_000 };

test("leave-now fires when departing now lands at the predicted restock", () => {
  // Empty since T0-1h, restocks after ~2h -> expected T0+1h. Business to Japan = 64 min.
  // Leave at T0 + 1h - 2min - 64min = T0 - 6 min. So at T0 - 6 min we should hear "leave now".
  const items = world();
  const at = T0 + H - 2 * M - 64 * M;
  const r = decideAlerts({ items, st: ME, loc: { where: "torn" }, sent: {}, now: at });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, "leave");
  assert.match(r.alerts[0].title, /Leave now for Japan/);
  assert.match(r.alerts[0].message, /22 items/);
  // Not again once sent.
  const sent = { [r.alerts[0].key]: at };
  assert.equal(decideAlerts({ items, st: ME, loc: { where: "torn" }, sent, now: at + 60 }).alerts.length, 0);
});

test("get-ready fires the chosen minutes before leave time", () => {
  const items = world();
  const leaveAt = T0 + H - 2 * M - 64 * M;
  const r = decideAlerts({ items, st: { ...ME, lead: 10 }, loc: { where: "torn" }, sent: {}, now: leaveAt - 10 * M });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, "ready");
});

test("no leave alert while flying, in hospital, or when profit is too small", () => {
  const items = world();
  const at = T0 + H - 2 * M - 64 * M;
  assert.equal(decideAlerts({ items, st: ME, loc: { where: "hospital" }, sent: {}, now: at }).alerts.length, 0);
  assert.equal(decideAlerts({ items, st: { ...ME, minProfit: 10_000_000 }, loc: { where: "torn" }, sent: {}, now: at }).alerts.length, 0);
});

test("slow-selling items are skipped unless watched", () => {
  const items = world({ type: "Primary" });
  const at = T0 + H - 2 * M - 64 * M;
  assert.equal(decideAlerts({ items, st: ME, loc: { where: "torn" }, sent: {}, now: at }).alerts.length, 0);
  assert.equal(decideAlerts({ items, st: { ...ME, watch: ["jap:206"] }, loc: { where: "torn" }, sent: {}, now: at }).alerts.length, 1);
});

test("in-stock alert only when enough stock should be left when you land", () => {
  // 1,000 in stock selling 600/hour; 64 min flight -> ~360 left, fine.
  let items = world({ qty: 1000, rate: 600, lastRestock: T0 - 5 * M });
  let r = decideAlerts({ items, st: ME, loc: { where: "torn" }, sent: {}, now: T0 });
  assert.equal(r.alerts[0].type, "go");
  // Selling 2,000/hour -> gone before landing.
  items = world({ qty: 1000, rate: 2000, lastRestock: T0 - 5 * M });
  r = decideAlerts({ items, st: ME, loc: { where: "torn" }, sent: {}, now: T0 });
  assert.equal(r.alerts.length, 0);
});

test("sold-out warning while flying there", () => {
  const items = world({ emptySince: T0 - 5 * M });
  const r = decideAlerts({ items, st: ME, loc: { where: "flying", cc: "jap", departed: T0 - 20 * M }, sent: {}, now: T0 });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, "soldout");
});

test("restocked-here alert when abroad", () => {
  const items = world({ qty: 900, lastRestock: T0 - 2 * M });
  const r = decideAlerts({ items, st: ME, loc: { where: "abroad", cc: "jap" }, sent: {}, now: T0 });
  assert.equal(r.alerts.map((a) => a.type).join(), "restock");
});

test("cheap-price alert when cost drops well under its average", () => {
  const countries = { jap: { update: T0, items: { 206: { name: "Xanax", qty: 500, cost: 600000, costAvg: 800000, at: T0, cycles: [], amts: [], rate: 0, emptySince: null } } } };
  const items = buildItems(countries, { 206: { mv: 1000000, low: 1000000, type: "Drug" } }, T0);
  const r = decideAlerts({ items, st: { ...ME, types: { go: false } }, loc: { where: "torn" }, sent: {}, now: T0 });
  assert.equal(r.alerts[0].type, "cheap");
  assert.match(r.alerts[0].message, /25% under/);
});

test("quiet hours suppress alerts and mark them so they don't arrive later", () => {
  const items = world();
  const at = T0 + H - 2 * M - 64 * M;
  const r = decideAlerts({ items, st: { ...ME, quiet: { on: true, from: 0, to: 1439 } }, loc: { where: "torn" }, sent: {}, now: at });
  assert.equal(r.alerts.length, 0);
  assert.equal(r.suppressed.length, 1);
});

test("hourly limit", () => {
  const items = world();
  const at = T0 + H - 2 * M - 64 * M;
  const sent = Object.fromEntries([...Array(6)].map((_, i) => ["x" + i, at - 100]));
  assert.equal(decideAlerts({ items, st: ME, loc: { where: "torn" }, sent, now: at }).alerts.length, 0);
});

test("settings are cleaned", () => {
  const s = cleanSettings({ capacity: "22", method: "teleport", minProfit: -5, watch: ["jap:206", "bad", 5], lead: 999 });
  assert.equal(s.capacity, 22);
  assert.equal(s.method, "standard");
  assert.equal(s.minProfit, 0);
  assert.deepEqual(s.watch, ["jap:206"]);
  assert.equal(s.lead, 60);
  assert.equal(s.types.leave, true);
});

test("no in-stock alert for an item that wasn't just restocked", () => {
  const items = world({ qty: 1000, rate: 100, lastRestock: null });
  assert.equal(decideAlerts({ items, st: ME, loc: { where: "torn" }, sent: {}, now: T0 }).alerts.length, 0);
  const old = world({ qty: 1000, rate: 100, lastRestock: T0 - 2 * H });
  assert.equal(decideAlerts({ items: old, st: ME, loc: { where: "torn" }, sent: {}, now: T0 }).alerts.length, 0);
});

test("item types from the Torn API win over the price source", () => {
  const countries = { mex: { update: 1, items: { 21: { name: "Dual 92G Berettas", qty: 5, cost: 85, at: 1, cycles: [], amts: [] } } } };
  const items = buildItems(countries, { 21: { mv: 4000000, low: 0, type: "" } }, 2, { 21: { t: "Weapon", st: "Secondary" } });
  assert.equal(items[0].type, "Weapon");
  assert.equal(items[0].speed, "slow");
});
