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
export function speedOf(type, subType) {
  const t = String(type || "").toLowerCase();
  if (!t) return "unknown";
  if (t === "weapon" && String(subType || "").toLowerCase() === "temporary") return "fast";
  if (FAST.includes(t)) return "fast";
  if (SLOW.includes(t)) return "slow";
  return "medium";
}

// ------------------------------------------------------------------ stock history
// Provider data only says what a shop had when a player last looked, so a change happened somewhere between
// two looks. We take the middle of that gap and keep a cycle only when the gap was small enough to trust.
const MAX_EDGE_ERR = 20 * 60; // ignore an empty→restock cycle if either edge is unsure by more than this
const KEEP_CYCLES = 15;

// state: the stored per-item record (or undefined). obs: { qty, cost, name, at } from the provider.
export function observe(state, obs) {
  const s = state ? { ...state } : { name: obs.name, qty: obs.qty, cost: obs.cost, at: obs.at, cycles: [], amts: [], rate: 0, costAvg: obs.cost || 0 };
  if (!state) {
    if (obs.qty === 0) (s.emptySince = obs.at), (s.emptyErr = 9e9); // we don't know when it ran out
    return s;
  }
  if (obs.at <= state.at) return state; // nothing new
  const gap = obs.at - state.at;
  const mid = Math.round(state.at + gap / 2);
  s.name = obs.name || s.name;

  if (state.qty > 0 && obs.qty === 0) {
    s.emptySince = mid;
    s.emptyErr = gap / 2;
  } else if (state.qty === 0 && obs.qty > 0) {
    s.lastRestock = mid;
    s.restockErr = gap / 2;
    if (state.emptySince != null && (state.emptyErr || 0) <= MAX_EDGE_ERR && gap / 2 <= MAX_EDGE_ERR && mid > state.emptySince) {
      s.cycles = [...(state.cycles || []), mid - state.emptySince].slice(-KEEP_CYCLES);
    }
    s.amts = [...(state.amts || []), obs.qty].slice(-KEEP_CYCLES);
    s.emptySince = null;
    s.emptyErr = null;
  } else if (state.qty > 0 && obs.qty > state.qty) {
    s.lastRestock = mid; // topped up before running out
    s.restockErr = gap / 2;
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
  return s;
}

// Weighted quantile; newer cycles count more because Torn keeps adjusting restock timing.
function wQuantile(values, q) {
  const n = values.length;
  const pts = values.map((v, i) => ({ v, w: Math.pow(0.85, n - 1 - i) })).sort((a, b) => a.v - b.v);
  const total = pts.reduce((t, p) => t + p.w, 0);
  let acc = 0;
  for (const p of pts) {
    acc += p.w;
    if (acc >= q * total) return p.v;
  }
  return pts[pts.length - 1].v;
}

// When an empty item is expected back: { at, from, to, conf: "high"|"medium"|"low", n, overdue }.
export function predictRestock(s, now) {
  if (!s || s.qty > 0 || s.emptySince == null) return null;
  const c = s.cycles || [];
  if (!c.length) return { conf: "none", n: 0 };
  const med = wQuantile(c, 0.5);
  let lo = wQuantile(c, 0.25),
    hi = wQuantile(c, 0.75);
  lo = Math.min(lo, med - 300);
  hi = Math.max(hi, med + 300);
  const spread = (hi - lo) / Math.max(med, 1);
  const conf = c.length >= 5 && spread <= 0.35 ? "high" : c.length >= 3 ? "medium" : "low";
  const p = { at: s.emptySince + med, from: s.emptySince + lo, to: s.emptySince + hi, conf, n: c.length, avg: med };
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
        pred: predictRestock(s, now),
        type,
        speed: speedOf(type, ty.st),
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
  types: { leave: true, ready: true, go: true, soldout: true, restock: true, cheap: true },
  extraFlower: 0,
  extraPlushie: 0,
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
export function decideAlerts({ items, st, loc, sent, now }) {
  st = cleanSettings(st);
  sent = sent || {};
  const out = [];
  const add = (type, key, title, message, profit, priority) => {
    if (!st.types[type] || sent[key]) return;
    out.push({ type, key, title, message, profit, priority: priority || 3, click: TRAVEL_URL, tags: [] });
  };
  const list = candidates(items, st);
  const t = (ts) => clock(ts, st.tz);
  const tail = (it) => `Est. profit ${short(it.me.trip)} for ${it.me.units} items. Take ${short(it.me.cash)}.`;

  if (loc.where === "torn") {
    for (const it of list) {
      const c = COUNTRIES[it.cc];
      const fl = it.me.flight;
      const mins = Math.round(fl / 60);
      if (it.qty === 0 && it.pred && it.pred.at && !it.pred.overdue) {
        const land = it.pred.at - 120; // land a couple of minutes before the expected restock
        const leaveAt = land - fl;
        const why = `${it.name} restock expected ~${t(it.pred.at)} (${it.pred.conf} confidence, ${t(it.pred.from)}–${t(it.pred.to)}).`;
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

  out.sort((a, b) => RANK[a.type] - RANK[b.type] || b.profit - a.profit);
  if (isQuiet(st, now)) return { alerts: [], suppressed: out.map((a) => a.key) };
  const lastHour = Object.values(sent).filter((ts) => ts > now - 3600).length;
  const room = Math.max(0, Math.min(2, st.maxPerHour - lastHour));
  return { alerts: out.slice(0, room), suppressed: [] };
}

// Forget alert keys older than three days.
export function pruneSent(sent, now) {
  const o = {};
  for (const [k, ts] of Object.entries(sent || {})) if (ts > now - 3 * 86400) o[k] = ts;
  return o;
}
