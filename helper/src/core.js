// Travel Geek helper: the pure logic (no network, no storage), so it can be tested in Node.
// All times are Unix seconds unless a name says otherwise.

// One-way flight minutes from Torn City, per ticket type. Same table as Torn PDA
// (lib/utils/travel/travel_times.dart, "from the Torn wiki, last checked after patch #438").
export const COUNTRIES = {
  mex: { name: "Mexico", flag: "🇲🇽", min: { standard: 24, airstrip: 17, wlt: 12, business: 7 } },
  cay: { name: "Cayman Islands", flag: "🇰🇾", min: { standard: 33, airstrip: 23, wlt: 17, business: 10 } },
  can: { name: "Canada", flag: "🇨🇦", min: { standard: 39, airstrip: 27, wlt: 19, business: 12 } },
  haw: { name: "Hawaii", flag: "🌺", min: { standard: 127, airstrip: 89, wlt: 63, business: 38 } },
  uni: { name: "United Kingdom", flag: "🇬🇧", min: { standard: 151, airstrip: 106, wlt: 75, business: 45 } },
  arg: { name: "Argentina", flag: "🇦🇷", min: { standard: 158, airstrip: 111, wlt: 79, business: 47 } },
  swi: { name: "Switzerland", flag: "🇨🇭", min: { standard: 166, airstrip: 116, wlt: 83, business: 50 } },
  jap: { name: "Japan", flag: "🇯🇵", min: { standard: 213, airstrip: 149, wlt: 107, business: 64 } },
  chi: { name: "China", flag: "🇨🇳", min: { standard: 229, airstrip: 160, wlt: 114, business: 69 } },
  uae: { name: "UAE", flag: "🇦🇪", min: { standard: 257, airstrip: 180, wlt: 128, business: 77 } },
  sou: { name: "South Africa", flag: "🇿🇦", min: { standard: 282, airstrip: 197, wlt: 141, business: 85 } },
};
export const METHODS = ["standard", "airstrip", "wlt", "business"];
export const METHOD_LABEL = { standard: "Standard", airstrip: "Airstrip", wlt: "Private jet", business: "Business" };

// Torn writes country names a few ways ("UAE", "United Arab Emirates", "In Japan", "Returning to Torn from Japan").
const NAME_TO_CODE = Object.fromEntries(Object.entries(COUNTRIES).map(([cc, c]) => [c.name.toLowerCase(), cc]));
NAME_TO_CODE["united arab emirates"] = "uae";
NAME_TO_CODE["cayman"] = "cay";
NAME_TO_CODE["uk"] = "uni";
export function countryCode(text) {
  const t = String(text || "").toLowerCase();
  for (const [name, cc] of Object.entries(NAME_TO_CODE)) if (t.includes(name)) return cc;
  return null;
}
export const flightSec = (cc, method) => ((COUNTRIES[cc] && COUNTRIES[cc].min[method]) || (COUNTRIES[cc] && COUNTRIES[cc].min.standard) || 0) * 60;

// How quickly an item usually sells, from its Torn item type. Guns and armour are cheap abroad but slow to sell.
// Types come from the Torn API (v2 torn/items): weapons are "Weapon" with a sub_type such as "Temporary".
const FAST = ["plushie", "flower", "drug", "medical", "booster", "candy", "alcohol", "energy drink", "temporary"];
const SLOW = ["weapon", "primary", "secondary", "melee", "defensive", "armor", "clothing", "jewelry", "collectible", "artifact", "car"];
// For other types (contraband, materials…), how many bazaars sell it tells how busy its market is:
// easy sellers like Xanax and plushies are in 300–900 bazaars, rarely traded items in under 80.
export const BUSY_BAZAARS = 200,
  QUIET_BAZAARS = 80;
export function speedOf(type, subType, bazaars) {
  const t = String(type || "").toLowerCase();
  if (t === "weapon" && String(subType || "").toLowerCase() === "temporary") return "fast";
  if (FAST.includes(t)) return "fast";
  if (SLOW.includes(t)) return "slow";
  if (bazaars >= BUSY_BAZAARS) return "fast";
  if (bazaars > 0 && bazaars < QUIET_BAZAARS) return "slow";
  return t ? "medium" : "unknown";
}

// ------------------------------------------------------------------ stock history
// Provider data only says what a shop had when a player last looked, so a change happened somewhere between
// two looks. We take the middle of that gap and keep a cycle only when the gap was small enough to trust.
// A look reported by a player standing in the shop (precise: true) is exact.
const MAX_EDGE_ERR = 20 * 60; // ignore an empty→restock cycle if either edge is unsure by more than this
const KEEP_CYCLES = 60; // accuracy kept improving with more history (61% after 3-5 restocks, 95% after 21+)
const KEEP_ERRS = 20;
const HIT = 10 * 60; // a prediction within 10 minutes counts as a hit
const KEEP_TRACK = 8; // last predictions vs what happened, shown on each item
const KEEP_TOPS = 20;

// How many restocks an empty spell of length v really was: 2 or 3 when a small, fast-selling restock
// (gone in under 15 minutes) could have come and gone unseen and v is about 2x or 3x the usual.
export function smallFast(state) {
  const amts = (state.amts || []).slice(-10);
  return (state.cycles || []).length >= 4 && state.rate > 0 && amts.length > 0 && Math.max(...amts) / state.rate < 0.25;
}
export function hiddenRestocks(state, v) {
  if (!smallFast(state)) return 1; // restocks last a while: we'd have seen them
  const m = wQuantile(state.cycles, 0.5);
  const k = Math.round(v / m);
  return k >= 2 && k <= 5 && Math.abs(v - k * m) < 0.15 * k * m ? k : 1;
}

// state: the stored per-item record (or undefined). obs: { qty, cost, name, at, precise } from a provider or a player.
export function observe(state, obs) {
  const s = state ? { ...state } : { name: obs.name, qty: obs.qty, cost: obs.cost, at: obs.at, cycles: [], starts: [], amts: [], errs: [], rate: 0, costAvg: obs.cost || 0 };
  if (!state) {
    if (obs.qty === 0) (s.emptySince = obs.at), (s.emptyErr = 9e9); // we don't know when it ran out
    return s;
  }
  if (obs.at <= state.at) return state; // nothing new
  const gap = obs.at - state.at;
  const mid = obs.precise ? obs.at : Math.round(state.at + gap / 2);
  const edgeErr = obs.precise ? 0 : gap / 2;
  s.name = obs.name || s.name;

  if (state.qty > 0 && obs.qty === 0) {
    s.emptySince = mid;
    s.emptyErr = edgeErr;
  } else if (state.qty === 0 && obs.qty > 0) {
    s.lastRestock = mid;
    s.restockErr = edgeErr;
    const trusted = state.emptySince != null && (state.emptyErr || 0) <= MAX_EDGE_ERR && edgeErr <= MAX_EDGE_ERR && mid > state.emptySince;
    if (trusted) {
      const cycles = [...(state.cycles || [])];
      const starts = [...(state.starts || cycles.map(() => null))];
      const v = mid - state.emptySince;
      // Hidden restocks: a small restock can arrive and sell out between two looks, so the shop seems to stay
      // empty two or three times as long as usual. Count those as the restocks they were.
      const k = hiddenRestocks(state, v);
      for (let j = 0; j < k; j++) {
        cycles.push(v / k);
        starts.push(state.emptySince + (j * v) / k);
      }
      if (k > 1) s.hidden = (state.hidden || 0) + k - 1;
      s.cycles = cycles.slice(-KEEP_CYCLES);
      s.starts = starts.slice(-KEEP_CYCLES);
      if (state.pending && state.pending.at) {
        // Score the prediction against the restock it was about. If that one came unseen, it was right.
        let e = mid - state.pending.at;
        if (k > 1) e = mid - (state.pending.at + ((k - 1) * v) / k);
        s.errs = [...(state.errs || []), e].slice(-KEEP_ERRS);
        s.track = [...(state.track || []), [state.pending.at, mid, k > 1 ? k - 1 : 0]].slice(-KEEP_TRACK);
      }
      s.method = bestMethod(s.cycles, s.starts);
    }
    s.amts = [...(state.amts || []), obs.qty].slice(-KEEP_CYCLES);
    s.emptySince = null;
    s.emptyErr = null;
    s.pending = null;
  } else if (state.qty > 0 && obs.qty > state.qty) {
    s.lastRestock = mid; // topped up before running out
    s.restockErr = edgeErr;
    // Real top-ups, not players selling a few back (up to 100 each): learn how often big shops are refilled.
    if (obs.qty - state.qty >= Math.max(150, state.qty * 0.1) && edgeErr <= MAX_EDGE_ERR) s.tops = [...(state.tops || []), mid].slice(-KEEP_TOPS);
  }

  // Selling speed: units that disappeared between two looks an hour or less apart.
  if (state.qty > 0 && obs.qty < state.qty && gap >= 60 && gap <= 3600) {
    const perHour = ((state.qty - obs.qty) / gap) * 3600;
    s.rate = state.rate ? Math.round(state.rate * 0.7 + perHour * 0.3) : Math.round(perHour);
  }
  if (obs.cost > 0) s.costAvg = state.costAvg ? Math.round(state.costAvg * 0.9 + obs.cost * 0.1) : obs.cost;
  s.qty = obs.qty;
  s.cost = obs.cost || s.cost;
  s.at = obs.at;
  if (state.qty > 0 && obs.qty === 0) {
    // Remember what we predict now, so we can score it when the restock really happens.
    const p = predictRestock(s, obs.at);
    s.pending = p && p.at ? { at: p.at, method: p.method } : null;
  }
  return s;
}

// Weighted quantile; newer cycles count more because Torn keeps adjusting restock timing.
function wQuantile(values, q, decay = 0.85) {
  const n = values.length;
  const pts = values.map((v, i) => ({ v, w: Math.pow(decay, n - 1 - i) })).sort((a, b) => a.v - b.v);
  const total = pts.reduce((t, p) => t + p.w, 0);
  let acc = 0;
  for (const p of pts) {
    acc += p.w;
    if (acc >= q * total) return p.v;
  }
  return pts[pts.length - 1].v;
}
const quant = (values, q) => wQuantile(values, q, 1);

// Ways to guess how long an item stays empty. Each item uses whichever has guessed its own past restocks best.
const hourOf = (ts) => Math.floor(ts / 3600) % 24;
const hourGap = (a, b) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
export const METHODS_PREDICT = {
  recent: (c) => wQuantile(c, 0.5),
  median: (c) => quant(c, 0.5),
  last3: (c) => Math.round(c.slice(-3).reduce((t, v) => t + v, 0) / Math.min(3, c.length)),
  timeOfDay: (c, starts, start) => {
    if (start == null) return null;
    const near = c.filter((_, i) => starts[i] != null && hourGap(hourOf(starts[i]), hourOf(start)) <= 2);
    return near.length >= 3 ? quant(near, 0.5) : null;
  },
};
const METHOD_LABEL_PREDICT = { recent: "recent restocks", median: "all restocks", last3: "last 3 restocks", timeOfDay: "same time of day" };

// Replay the history: for each past cycle, guess it from the ones before and see which method was closest.
export function bestMethod(cycles, starts) {
  const n = cycles.length;
  if (n < 5) return "recent";
  const score = {},
    counts = {};
  for (const m of Object.keys(METHODS_PREDICT)) {
    const errs = [];
    for (let i = Math.max(3, n - 10); i < n; i++) {
      const g = METHODS_PREDICT[m](cycles.slice(0, i), (starts || []).slice(0, i), starts && starts[i]);
      if (g != null) errs.push(Math.abs(g - cycles[i]));
    }
    if (errs.length >= 2) score[m] = quant(errs, 0.5);
    counts[m] = errs.length;
  }
  // Tested on 955 real restocks: always using "recent" beat switching on small differences (78% vs 77%
  // within 10 min), so only switch when another method is clearly better on enough restocks.
  let best = "recent";
  for (const m of Object.keys(score)) if (m !== "recent" && counts[m] >= 6 && score[m] + 180 < (score[best] ?? Infinity)) best = m;
  return best;
}

// When an empty item is expected back:
// { at, from, to, conf, pct, n, scored, err, method, avg, overdue }.
// pct is a confidence % learned from how often past predictions for this item landed within 10 minutes.
export function predictRestock(s, now) {
  if (!s || s.qty > 0 || s.emptySince == null) return null;
  const c = s.cycles || [];
  if (!c.length) return { conf: "none", pct: 0, n: 0, scored: 0 };
  const method = s.method && METHODS_PREDICT[s.method] ? s.method : "recent";
  const guess = METHODS_PREDICT[method](c, s.starts || [], s.emptySince) ?? METHODS_PREDICT.recent(c);
  const errs = (s.errs || []).map(Math.abs);
  let lo, hi;
  if (errs.length >= 3) {
    // The window comes from how far off we've actually been.
    const e = Math.max(300, quant(errs, 0.75));
    lo = guess - e;
    hi = guess + e;
  } else {
    lo = Math.min(wQuantile(c, 0.25), guess - 300);
    hi = Math.max(wQuantile(c, 0.75), guess + 300);
  }
  let pct;
  if (errs.length >= 3) {
    const hits = errs.filter((e) => e <= HIT).length;
    pct = Math.round(((hits + 1) / (errs.length + 2)) * 100);
  } else {
    const spread = (hi - lo) / Math.max(guess, 1);
    pct = c.length >= 5 && spread <= 0.35 ? 70 : c.length >= 3 ? 50 : 30;
  }
  const conf = pct >= 70 ? "high" : pct >= 45 ? "medium" : "low";
  const p = {
    at: s.emptySince + guess,
    from: s.emptySince + lo,
    to: s.emptySince + hi,
    conf,
    pct,
    n: c.length,
    scored: errs.length,
    err: errs.length ? Math.round(quant(errs, 0.5)) : null,
    hits: errs.filter((e) => e <= HIT).length,
    method,
    methodLabel: METHOD_LABEL_PREDICT[method],
    avg: guess,
  };
  // Tiny restocks often come and go between two looks. Once the window has passed with nothing seen,
  // expect the next one in the cycle instead of calling it late for hours.
  if (now > p.to && smallFast(s) && guess > 0) {
    const k = Math.min(5, Math.ceil((now - p.to) / guess));
    if (k >= 1) {
      p.unseen = k;
      p.missedAt = p.at;
      for (const f of ["at", "from", "to"]) p[f] += k * guess;
    }
  }
  if (now > p.to + 15 * 60) p.overdue = true;
  return p;
}

// ------------------------------------------------------------------ prices and profit
// prices: item id -> { mv, low, type }. Sell price assumes the cheaper of market value and the cheapest bazaar.
export function sellPrice(p) {
  if (!p) return 0;
  const c = [p.mv, p.low].filter((v) => v > 0);
  return c.length ? Math.min(...c) : 0;
}

// The personal numbers for one item: how many you'd bring, profit, cash to take, flight.
export function personal(item, st) {
  const cap = Math.max(1, st.capacity || 10) + (item.extraCap || 0);
  const units = item.qty > 0 ? Math.min(cap, item.qty) : cap;
  const net = Math.floor(item.sell * (1 - (st.fee ?? 5) / 100));
  const unit = item.sell ? net - item.cost : 0;
  const flight = flightSec(item.cc, st.method || "standard");
  const trip = unit * units;
  return { units, unit, trip, perHour: flight ? Math.round(trip / ((2 * flight) / 3600)) : 0, cash: units * item.cost, flight };
}

export function extraCapFor(type, st) {
  const t = String(type || "").toLowerCase();
  return (t === "flower" ? st.extraFlower || 0 : 0) + (t === "plushie" ? st.extraPlushie || 0 : 0);
}

// Combine stored stock states and prices into one list for the script and the alert rules.
// types: item id -> { t: type, st: sub_type } from the Torn API (TornW3B no longer sends types).
export function buildItems(countries, prices, now, types) {
  const out = [];
  for (const [cc, c] of Object.entries(countries || {})) {
    if (!COUNTRIES[cc] || !c || !c.items) continue;
    for (const [id, s] of Object.entries(c.items)) {
      const p = prices && prices[id];
      const ty = (types && types[id]) || {};
      const type = ty.t || (p && p.type) || "";
      out.push({
        key: `${cc}:${id}`,
        cc,
        id: +id,
        name: s.name,
        qty: s.qty,
        cost: s.cost,
        costAvg: s.costAvg || s.cost,
        updated: s.at,
        rate: s.rate || 0,
        emptySince: s.emptySince ?? null,
        lastRestock: s.lastRestock ?? null,
        amt: s.amts && s.amts.length ? s.amts[s.amts.length - 1] : 0,
        amtTypical: s.amts && s.amts.length ? quant(s.amts.slice(-10), 0.5) : 0,
        amtMax: s.amts && s.amts.length ? Math.max(...s.amts.slice(-10)) : 0, // restocks seen late look smaller
        // How long it usually stays empty, also while it's in stock, so plans can look several restocks ahead.
        emptyAvg: s.cycles && s.cycles.length ? quant(s.cycles.slice(-10), 0.5) : 0,
        emptyN: (s.cycles || []).length,
        track: s.track || [], // [predicted, actual, hidden restocks] for the last few restocks
        hidden: s.hidden || 0,
        topEvery: s.tops && s.tops.length >= 3 ? quant(s.tops.slice(1).map((t, i) => t - s.tops[i]), 0.5) : 0,
        lastTop: s.tops && s.tops.length ? s.tops[s.tops.length - 1] : 0,
        pred: predictRestock(s, now),
        type,
        speed: speedOf(type, ty.st, p && p.bz),
        bz: (p && p.bz) || 0,
        mv: (p && p.mv) || 0,
        low: (p && p.low) || 0,
        sell: sellPrice(p),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ where the player is
// From Torn API v1 user?selections=basic,travel.
export function location(d, now) {
  const st = (d && d.status) || {};
  const tr = (d && d.travel) || {};
  const state = String(st.state || "");
  const desc = String(st.description || "");
  if (state === "Traveling") {
    const arriveAt = tr.timestamp || (tr.time_left ? now + tr.time_left : 0);
    if (/^returning/i.test(desc) || /^torn$/i.test(tr.destination || "")) return { where: "returning", arriveAt, cc: countryCode(desc) };
    return { where: "flying", cc: countryCode(tr.destination) || countryCode(desc), arriveAt, departed: tr.departed || 0, method: tr.method };
  }
  if (state === "Abroad") return { where: "abroad", cc: countryCode(desc) || countryCode(tr.destination) };
  if (state === "Okay") return { where: "torn" };
  if (state === "Hospital" || state === "Jail" || state === "Federal") return { where: state.toLowerCase(), until: st.until || 0 };
  return { where: "other" };
}

// ------------------------------------------------------------------ alert rules
export const DEFAULT_SETTINGS = {
  capacity: 10,
  method: "standard",
  fee: 5,
  minProfit: 1_000_000,
  watch: [],
  hidden: [],
  watchOnly: false,
  fastOnly: true,
  lead: 10, // minutes of warning before "leave now"
  maxPerHour: 6,
  quiet: { on: false, from: 23 * 60, to: 7 * 60 },
  tz: 0, // minutes to add to UTC for local time (−Date#getTimezoneOffset)
  types: { leave: true, ready: true, go: true, soldout: true, restock: true, cheap: true, land: true, cash: true },
  cashLimit: 1_000_000, // Cash Guard: warn when this much cash is on hand while flying or landing
  extraFlower: 0,
  extraPlushie: 0,
  crowdShare: false, // let others see (without a name) where and when I land
  crowdWarn: false, // tell me when others land at the same shop around the same time
};

const clampInt = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
const keyList = (a) => (Array.isArray(a) ? a.filter((k) => typeof k === "string" && /^[a-z]{3}:\d{1,6}$/.test(k)).slice(0, 200) : []);
export function cleanSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  const types = {};
  for (const k of Object.keys(d.types)) types[k] = r.types && typeof r.types[k] === "boolean" ? r.types[k] : d.types[k];
  const q = r.quiet || {};
  return {
    capacity: clampInt(r.capacity, 1, 300, d.capacity),
    method: METHODS.includes(r.method) ? r.method : d.method,
    fee: Math.min(50, Math.max(0, Number.isFinite(+r.fee) ? +r.fee : d.fee)),
    minProfit: clampInt(r.minProfit, 0, 1e12, d.minProfit),
    watch: keyList(r.watch),
    hidden: keyList(r.hidden),
    watchOnly: !!r.watchOnly,
    fastOnly: r.fastOnly == null ? d.fastOnly : !!r.fastOnly,
    lead: clampInt(r.lead, 0, 60, d.lead),
    maxPerHour: clampInt(r.maxPerHour, 1, 30, d.maxPerHour),
    quiet: { on: !!q.on, from: clampInt(q.from, 0, 1439, d.quiet.from), to: clampInt(q.to, 0, 1439, d.quiet.to) },
    tz: clampInt(r.tz, -840, 840, 0),
    types,
    extraFlower: clampInt(r.extraFlower, 0, 50, 0),
    extraPlushie: clampInt(r.extraPlushie, 0, 50, 0),
    cashLimit: clampInt(r.cashLimit, 0, 1e12, d.cashLimit),
    crowdShare: !!r.crowdShare,
    crowdWarn: !!r.crowdWarn,
  };
}

export function isQuiet(st, now) {
  if (!st.quiet || !st.quiet.on) return false;
  const m = (((Math.floor(now / 60) + st.tz) % 1440) + 1440) % 1440;
  const { from, to } = st.quiet;
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

const pad = (n) => String(n).padStart(2, "0");
export function clock(ts, tz) {
  const m = (((Math.floor(ts / 60) + (tz || 0)) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
export function short(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n),
    s = n < 0 ? "-$" : "$";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
  if (a >= 1e3) return s + Math.round(a / 1e3) + "k";
  return s + Math.round(a);
}
const num = (n) => Math.round(n).toLocaleString("en-US");

const TRAVEL_URL = "https://www.torn.com/page.php?sid=travel";
const VAULT_URL = "https://www.torn.com/properties.php#/p=options&tab=vault";
const RANK = { leave: 0, soldout: 1, restock: 2, go: 3, ready: 4, cheap: 5 };
const FRESH = 45 * 60; // stock seen longer ago than this is too old to send someone flying
const JUST_RESTOCKED = 30 * 60;

// Which items this person cares about right now.
export function candidates(items, st) {
  const watch = new Set(st.watch),
    hidden = new Set(st.hidden);
  return items
    .map((it) => {
      const extraCap = extraCapFor(it.type, st);
      const x = { ...it, extraCap };
      return { ...x, me: personal(x, st), watched: watch.has(it.key) };
    })
    .filter((it) => {
      if (hidden.has(it.key) || !it.cost || !it.sell) return false;
      if (it.watched) return it.me.unit > 0;
      if (st.watchOnly) return false;
      if (st.fastOnly && it.speed !== "fast") return false;
      return it.me.trip >= st.minProfit;
    });
}

// Decide what to send now. sent: { alertKey: unix seconds } of what this person already got.
// Returns { alerts: [...], suppressed: [...keys] }; at most 2 alerts per minute.
// plan: a trip plan the player chose to follow ({ legs: [{ cc, depart, land, buy, cash }] }), or null.
// cash: cash on hand right now (or null if unknown). prevLoc: where they were on the previous check.
export function decideAlerts({ items, st, loc, sent, now, plan, crowd, selfH, cash, prevLoc }) {
  st = cleanSettings(st);
  sent = sent || {};
  const out = [];
  const following = activePlan(plan, now);
  const add = (type, key, title, message, profit, priority) => {
    if (!st.types[type] || sent[key]) return;
    out.push({ type, key, title, message, profit, priority: priority || 3, click: TRAVEL_URL, tags: [] });
  };
  const list = candidates(items, st);
  const t = (ts) => clock(ts, st.tz);
  const tail = (it) => `Est. profit ${short(it.me.trip)} for ${it.me.units} items. Take ${short(it.me.cash)}.`;

  if (following) {
    // While following a plan, its departures replace the general leave/get-ready/restocked alerts.
    const legs = following.legs;
    legs.forEach((g, i) => {
      const c = COUNTRIES[g.cc];
      if (!c) return;
      const step = `trip ${i + 1} of ${legs.length}`;
      const what = `${g.buy ? g.buy + ". " : ""}${g.cash ? `Take ${short(g.cash)}. ` : ""}Land ${t(g.land)}.${st.crowdWarn ? crowdText(crowdNear(crowd, g.cc, g.land, selfH)) : ""}`;
      if (loc.where === "torn" && now >= g.depart - 60 && now < g.depart + 5 * 60)
        add("leave", `planleave:${g.cc}:${g.depart}`, `🛫 Leave now for ${c.name} (${step})`, what, 1e15, 5);
      const early = g.depart - st.lead * 60;
      if (st.lead > 0 && now >= early - 60 && now < early + 3 * 60)
        add("ready", `planready:${g.cc}:${g.depart}`, `⏰ Get ready: ${c.name} at ${t(g.depart)} (${step})`, what, 1e15, 4);
    });
  }

  if (loc.where === "torn" && !following) {
    for (const it of list) {
      const c = COUNTRIES[it.cc];
      const fl = it.me.flight;
      const mins = Math.round(fl / 60);
      if (it.qty === 0 && it.pred && it.pred.at && !it.pred.overdue) {
        const land = it.pred.at - 120; // land a couple of minutes before the expected restock
        const leaveAt = land - fl;
        const why = `${it.name} restock expected ~${t(it.pred.at)} (${it.pred.pct != null ? it.pred.pct + "% sure" : it.pred.conf + " confidence"}, ${t(it.pred.from)}–${t(it.pred.to)}).${st.crowdWarn ? crowdText(crowdNear(crowd, it.cc, land + 120, selfH)) : ""}`;
        if (now >= leaveAt - 60 && now < leaveAt + 5 * 60 && now + fl < it.pred.to)
          add("leave", `leave:${it.key}:${it.emptySince}`, `🛫 Leave now for ${c.name}`, `${why} Flight ${mins} min → land ${t(now + fl)}. ${tail(it)}`, it.me.trip, 5);
        const early = leaveAt - st.lead * 60;
        if (st.lead > 0 && now >= early - 60 && now < early + 3 * 60)
          add("ready", `ready:${it.key}:${it.emptySince}`, `⏰ Get ready: leave for ${c.name} at ${t(leaveAt)}`, `${why} Flight ${mins} min. ${tail(it)}`, it.me.trip, 4);
      } else if (it.qty > 0 && now - it.updated <= FRESH && it.lastRestock && now - it.lastRestock <= JUST_RESTOCKED) {
        // Only right after a restock: items that are simply in stock all day are on the list in the script.
        const sold = (it.rate / 3600) * (fl + (now - it.updated));
        const left = Math.floor(it.qty - sold);
        if (left >= it.me.units * 1.5)
          add(
            "go",
            `go:${it.key}:${it.lastRestock}`,
            `✅ Restocked: ${c.name} · ${it.name} (${num(it.qty)})`,
            `Leave now → land ${t(now + fl)}${it.rate ? ` with ~${num(left)} left` : ""}. ${tail(it)}`,
            it.me.trip,
            4
          );
      }
    }
  }

  if (loc.where === "flying" && loc.cc) {
    const here = list.filter((it) => it.cc === loc.cc);
    for (const it of here) {
      if (it.qty === 0 && it.emptySince && it.emptySince >= (loc.departed || now - it.me.flight)) {
        const alt = here.filter((x) => x.qty > 0 && x.key !== it.key).sort((a, b) => b.me.trip - a.me.trip)[0];
        add(
          "soldout",
          `sold:${it.key}:${it.emptySince}`,
          `⚠️ ${COUNTRIES[it.cc].name} · ${it.name} sold out`,
          `It ran out while you're flying.${alt ? ` Best other buy there: ${alt.name} (${num(alt.qty)} in stock, ${short(alt.me.trip)}).` : ""}${it.pred && it.pred.at ? ` Next restock ~${t(it.pred.at)}.` : ""}`,
          it.me.trip,
          4
        );
      }
    }
  }

  if (loc.where === "abroad" && loc.cc) {
    for (const it of list.filter((x) => x.cc === loc.cc)) {
      if (it.qty > 0 && it.lastRestock && now - it.lastRestock <= 10 * 60)
        add("restock", `rs:${it.key}:${it.lastRestock}`, `🔔 Restocked here: ${it.name} (${num(it.qty)})`, `${COUNTRIES[it.cc].name}. ${tail(it)}`, it.me.trip, 5);
    }
  }

  if (loc.where === "torn" || loc.where === "abroad") {
    for (const it of list) {
      if (it.qty > 0 && it.costAvg && it.cost <= it.costAvg * 0.85 && now - it.updated <= FRESH) {
        const off = Math.round((1 - it.cost / it.costAvg) * 100);
        add("cheap", `cheap:${it.key}:${Math.floor(now / 86400)}`, `💸 Cheap: ${COUNTRIES[it.cc].name} · ${it.name} ${short(it.cost)}`, `${off}% under its usual ${short(it.costAvg)}. ${tail(it)}`, it.me.trip, 3);
      }
    }
  }

  // ---- Cash Guard: muggers watch for players landing with bazaar money on hand.
  const guard = [];
  const addG = (type, key, title, message, priority) => {
    if (!st.types[type] || sent[key]) return;
    guard.push({ type, key, title, message, priority, click: type === "land" ? TRAVEL_URL : VAULT_URL, tags: [], guard: true });
  };
  const risky = cash != null && st.cashLimit > 0 && cash >= st.cashLimit;
  const onHand = cash != null ? ` · ${short(cash)} on hand` : "";
  if ((loc.where === "flying" || loc.where === "returning") && loc.arriveAt > now) {
    const place = loc.where === "returning" ? "Torn" : COUNTRIES[loc.cc] ? COUNTRIES[loc.cc].name : "abroad";
    const left = loc.arriveAt - now;
    const tip = risky ? "Deposit it the moment you land: muggers watch landings." : "Be online when you land.";
    if (left > 120 && left <= 240) addG("land", `land3:${loc.arriveAt}`, `🛬 Landing in ${place} in ~${Math.round(left / 60)} min${onHand}`, tip, risky ? 5 : 4);
    if (left > 0 && left <= 120) addG("land", `land1:${loc.arriveAt}`, `🛬 Landing in ${place} in about a minute${onHand}`, tip, risky ? 5 : 4);
    if (risky)
      addG(
        "cash",
        `cash:${loc.arriveAt}:${Math.floor(Math.log2(cash / st.cashLimit))}`, // again each time it doubles
        `💰 ${short(cash)} on hand while you're flying`,
        `Bazaar sales add to your cash on hand, and you can't bank in the air. You land in ${place} at ${t(loc.arriveAt)}. Deposit right after landing.`,
        5
      );
  }
  if (prevLoc && (prevLoc.where === "flying" || prevLoc.where === "returning") && (loc.where === "torn" || loc.where === "abroad") && risky)
    addG("cash", `landed:${prevLoc.arriveAt || now}`, `🛬 You landed with ${short(cash)} on hand`, loc.where === "torn" ? "Deposit it now (vault, bank or faction)." : "You're abroad: keep it safe until you're home.", 5);

  out.sort((a, b) => RANK[a.type] - RANK[b.type] || b.profit - a.profit);
  if (isQuiet(st, now)) return { alerts: [], suppressed: [...out, ...guard].map((a) => a.key) };
  const lastHour = Object.values(sent).filter((ts) => ts > now - 3600).length;
  const room = Math.max(0, Math.min(2, st.maxPerHour - lastHour));
  // Cash Guard alerts don't count against the hourly limit: they protect your money.
  return { alerts: [...guard, ...out.slice(0, room)], suppressed: [] };
}

// ---------------------------------------------------------------- crowd warning
// Only players who turned on sharing are counted, by country and landing time, never by name.
export function crowdHash(id, now) {
  let h = 2166136261;
  for (const ch of `${id}:${Math.floor(now / 86400)}:tg`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}
// Where sharing players will land: their current flight and their followed plan's trips.
export function crowdEntries(users, now) {
  const out = [];
  for (const u of users) {
    if (!u.settings || !u.settings.crowdShare || u.off) continue;
    const h = crowdHash(u.id, now);
    if (u.loc && u.loc.where === "flying" && u.loc.cc && u.loc.arriveAt > now - 600) out.push({ h, cc: u.loc.cc, land: u.loc.arriveAt });
    for (const g of (activePlan(u.plan, now) || { legs: [] }).legs) if (g.land > now - 600 && !out.some((x) => x.h === h && x.cc === g.cc && Math.abs(x.land - g.land) < 900)) out.push({ h, cc: g.cc, land: g.land });
  }
  return out;
}
export function crowdNear(crowd, cc, land, selfH) {
  return (crowd || []).filter((x) => x.h !== selfH && x.cc === cc && Math.abs(x.land - land) <= 600).length;
}
const crowdText = (n) => (n ? ` ⚠️ ${n} other Travel Geek player${n > 1 ? "s" : ""} land there around then.` : "");

// A followed plan counts until its last trip is back in Torn.
export function activePlan(plan, now) {
  if (!plan || !Array.isArray(plan.legs) || !plan.legs.length) return null;
  const last = plan.legs[plan.legs.length - 1];
  return now <= (last.back || last.land || last.depart) + 600 ? plan : null;
}
export function cleanPlan(raw) {
  const legs = (raw && Array.isArray(raw.legs) ? raw.legs : [])
    .slice(0, 12)
    .map((g) => ({
      cc: COUNTRIES[g && g.cc] ? g.cc : null,
      depart: Math.round(+g.depart || 0),
      land: Math.round(+g.land || 0),
      back: Math.round(+g.back || 0),
      cash: Math.max(0, Math.round(+g.cash || 0)),
      buy: String((g && g.buy) || "").slice(0, 120),
    }))
    .filter((g) => g.cc && g.depart > 0);
  return legs.length ? { legs, made: Math.round(+raw.made || 0) } : null;
}

// Forget alert keys older than three days.
export function pruneSent(sent, now) {
  const o = {};
  for (const [k, ts] of Object.entries(sent || {})) if (ts > now - 3 * 86400) o[k] = ts;
  return o;
}
