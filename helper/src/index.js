// Travel Geek helper: a Cloudflare Worker that runs every minute.
//   - reads foreign stock (YATA, falling back to Prometheus) and selling prices (TornW3B)
//   - keeps its own restock history to predict the next restock
//   - checks where each signed-up player is (Torn API) and pushes alerts to their ntfy topic
// It only reads data and sends notifications. It never acts in the game.

import { DurableObject } from "cloudflare:workers";
import { COUNTRIES, buildItems, observe, location, decideAlerts, pruneSent, cleanSettings } from "./core.js";

const VERSION = "1.0.2";
const PRICES_EVERY = 10 * 60; // seconds
const TYPES_EVERY = 24 * 3600;
const MAX_USERS = 40; // keeps a tick under the free plan's 50 outgoing requests

const now = () => Math.floor(Date.now() / 1000);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function getJSON(url, ms = 12000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "TravelGeek/" + VERSION } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (new URL(req.url).pathname === "/tick") return json({ error: "not found" }, 404); // only the schedule may run a tick
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    return hub.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    ctx.waitUntil(hub.fetch("https://hub/tick", { method: "POST" }));
  },
};

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.url = {
      yata: env.YATA_URL || "https://yata.yt/api/v1/travel/export/",
      prom: env.PROM_URL || "https://api.prombot.co.uk/api/travel",
      w3b: env.W3B_URL || "https://weav3r.dev/api/marketplace",
      torn: env.TORN_URL || "https://api.torn.com",
      ntfy: env.NTFY_URL || "https://ntfy.sh",
    };
  }

  async fetch(req) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/tick" && req.method === "POST") return json(await this.tick());
      if (u.pathname === "/api/state" && req.method === "GET") return json(await this.state(), 200, { "Cache-Control": "public, max-age=30" });
      if (u.pathname === "/api/user" && req.method === "POST") return json(await this.upsertUser(await req.json()));
      if (u.pathname === "/api/user" && req.method === "DELETE") return json(await this.deleteUser(await req.json()));
      if (u.pathname === "/api/test" && req.method === "POST") return json(await this.test(await req.json()));
      if (u.pathname === "/" || u.pathname === "/api") return json({ name: "Travel Geek helper", version: VERSION, ok: true });
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 400);
    }
  }

  // ---------------------------------------------------------------- data
  async countries() {
    const m = await this.ctx.storage.get(Object.keys(COUNTRIES).map((cc) => "c:" + cc));
    const o = {};
    for (const cc of Object.keys(COUNTRIES)) o[cc] = m.get("c:" + cc) || { update: 0, items: {} };
    return o;
  }

  async state() {
    const t = now();
    const [countries, prices, meta, report, types] = await Promise.all([
      this.countries(),
      this.ctx.storage.get("prices"),
      this.ctx.storage.get("meta"),
      this.ctx.storage.get("report"),
      this.ctx.storage.get("types"),
    ]);
    const items = buildItems(countries, prices && prices.items, t, types && types.map);
    const updates = Object.fromEntries(Object.entries(countries).map(([cc, c]) => [cc, c.update || 0]));
    return { version: VERSION, now: t, report: report || null, tickAt: (meta && meta.tickAt) || 0, source: (meta && meta.source) || "", pricesAt: (prices && prices.at) || 0, updates, items };
  }

  async readStocks() {
    const [y, p] = await Promise.allSettled([getJSON(this.url.yata), getJSON(this.url.prom)]);
    const ys = y.status === "fulfilled" && y.value && y.value.stocks;
    const ps = p.status === "fulfilled" && p.value && p.value.stocks;
    if (!ys && !ps) {
      const e = new Error("no stock source answered");
      e.details = { YATA: y.status === "rejected" ? y.reason.message : "no stocks in reply", Prometheus: p.status === "rejected" ? p.reason.message : "no stocks in reply" };
      throw e;
    }
    // For each country, use whichever source looked at it most recently.
    const out = {};
    for (const cc of Object.keys(COUNTRIES)) {
      const a = ys && ys[cc],
        b = ps && ps[cc];
      const pick = a && b ? ((a.update || 0) >= (b.update || 0) ? a : b) : a || b;
      if (pick && pick.update) out[cc] = pick;
    }
    return { stocks: out, source: [ys && "YATA", ps && "Prometheus"].filter(Boolean).join("+") };
  }

  async tick() {
    const t = now();
    const report = { at: t, countries: 0, users: 0, sent: 0, errors: [] };
    let countries = await this.countries();

    try {
      const { stocks, source } = await this.readStocks();
      const writes = {};
      for (const [cc, c] of Object.entries(stocks)) {
        const prev = countries[cc];
        if (c.update <= (prev.update || 0)) continue;
        const items = { ...prev.items };
        for (const s of c.stocks || []) {
          if (!s || !s.id) continue;
          items[s.id] = observe(items[s.id], { qty: +s.quantity || 0, cost: +s.cost || 0, name: s.name, at: c.update });
        }
        countries[cc] = { update: c.update, items };
        writes["c:" + cc] = countries[cc];
        report.countries++;
      }
      writes.meta = { tickAt: t, source };
      await this.ctx.storage.put(writes);
    } catch (e) {
      report.errors.push("stocks: " + e.message);
      for (const [name, err] of Object.entries(e.details || {})) report.errors.push(`${name}: ${err}`);
    }

    let prices = await this.ctx.storage.get("prices");
    if (!prices || t - prices.at >= PRICES_EVERY) {
      try {
        const d = await getJSON(this.url.w3b, 20000);
        const wanted = new Set(Object.values(countries).flatMap((c) => Object.keys(c.items || {})));
        const items = {};
        for (const i of d.items || []) if (wanted.has(String(i.item_id))) items[i.item_id] = { mv: i.market_price || 0, low: i.lowest_price || 0, type: i.type || "" };
        prices = { at: t, items };
        await this.ctx.storage.put("prices", prices);
      } catch (e) {
        report.errors.push("prices: " + e.message);
      }
    }

    const users = (await this.ctx.storage.get("users")) || {};
    const active = Object.values(users).filter((u) => !u.off).slice(0, MAX_USERS);

    // Item types (to tell fast sellers from guns and armour), once a day, with a signed-up player's key.
    let types = await this.ctx.storage.get("types");
    if (active.length && (!types || t - types.at >= TYPES_EVERY)) {
      try {
        const u = active[Math.floor(t / 60) % active.length];
        const d = await this.torn("/v2/torn/items", u.key);
        const wanted = new Set(Object.values(countries).flatMap((c) => Object.keys(c.items || {})));
        const map = {};
        for (const i of d.items || []) if (wanted.has(String(i.id))) map[i.id] = { t: i.type || "", st: i.sub_type || "" };
        if (Object.keys(map).length) await this.ctx.storage.put("types", (types = { at: t, map }));
      } catch (e) {
        report.errors.push("types: " + e.message);
      }
    }
    const items = buildItems(countries, prices && prices.items, t, types && types.map);
    await Promise.all(active.map((u) => this.checkUser(u, items, t, report)));
    // Someone may have signed up or changed settings while we were waiting on the network:
    // re-read and only write back what this tick learned.
    const fresh = (await this.ctx.storage.get("users")) || {};
    for (const u of active) {
      const f = fresh[u.id];
      if (!f) continue;
      const changed = (f.updated || 0) > t;
      Object.assign(f, { loc: u.loc, sent: u.sent, last: u.last, err: changed ? null : u.err, errs: changed ? 0 : u.errs, off: changed ? f.off : u.off });
    }
    await this.ctx.storage.put("users", fresh);
    await this.ctx.storage.put("report", report); // shown in /api/state so problems are visible
    return report;
  }

  async torn(path, key) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await getJSON(`${this.url.torn}${path}${sep}key=${encodeURIComponent(key)}&comment=TravelGeek`);
    if (d && d.error) {
      const e = new Error(d.error.error || "Torn API error");
      e.code = d.error.code;
      throw e;
    }
    return d;
  }

  async checkUser(u, items, t, report) {
    report.users++;
    let d;
    try {
      try {
        d = await this.torn("/user/?selections=basic,travel", u.key);
      } catch (e) {
        if (e.code !== 16) throw e;
        d = await this.torn("/user/?selections=basic", u.key); // a Public key can't read travel; status is enough
      }
      u.err = null;
      u.errs = 0;
    } catch (e) {
      u.err = e.message;
      u.errs = (u.errs || 0) + 1;
      // Keys that are wrong, deleted, paused or too limited won't fix themselves: stop and say so once.
      if ([2, 10, 13, 18].includes(e.code)) {
        u.off = true;
        await this.push(u.topic, { title: "Travel Geek alerts stopped", message: `Torn says: ${e.message}. Open Travel Geek in Torn PDA (⚙ → Phone alerts) to turn them back on.`, priority: 4, tags: ["warning"] });
      }
      report.errors.push(`user ${u.id}: ${e.message}`);
      return;
    }
    const loc = location(d, t);
    u.loc = { ...loc, at: t };
    const sent = pruneSent(u.sent, t);
    const { alerts, suppressed } = decideAlerts({ items, st: u.settings, loc, sent, now: t });
    for (const k of suppressed) sent[k] = t;
    for (const a of alerts) {
      try {
        await this.push(u.topic, a);
        sent[a.key] = t;
        report.sent++;
      } catch (e) {
        report.errors.push(`ntfy ${u.id}: ${e.message}`);
      }
    }
    u.sent = sent;
    u.last = alerts.length ? [...alerts.map((a) => ({ at: t, title: a.title })), ...(u.last || [])].slice(0, 10) : u.last;
  }

  async push(topic, a) {
    const r = await fetch(this.url.ntfy, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title: a.title, message: a.message, priority: a.priority || 3, tags: a.tags || [], click: a.click || undefined }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
  }

  // ---------------------------------------------------------------- sign-up
  async upsertUser(b) {
    const key = String((b && b.key) || "").trim();
    const topic = String((b && b.topic) || "").trim();
    if (!/^[A-Za-z0-9]{16}$/.test(key)) throw new Error("That doesn't look like a Torn API key (16 letters and numbers).");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(topic)) throw new Error("The alert channel name must be 8–64 letters, numbers, - or _.");
    const me = await this.torn("/user/?selections=basic", key);
    const users = (await this.ctx.storage.get("users")) || {};
    const prev = users[me.player_id] || {};
    if (!prev.id && Object.keys(users).length >= MAX_USERS) throw new Error("This helper is full. Ask the owner to raise the limit.");
    users[me.player_id] = {
      ...prev,
      id: me.player_id,
      name: me.name,
      key,
      topic,
      settings: cleanSettings(b.settings),
      off: false,
      err: null,
      errs: 0,
      created: prev.created || now(),
      updated: now(),
    };
    await this.ctx.storage.put("users", users);
    const u = users[me.player_id];
    return { ok: true, id: u.id, name: u.name, loc: u.loc || null, last: u.last || [] };
  }

  async deleteUser(b) {
    const key = String((b && b.key) || "").trim();
    const users = (await this.ctx.storage.get("users")) || {};
    const id = Object.keys(users).find((id) => users[id].key === key);
    if (!id) return { ok: true, removed: false };
    delete users[id];
    await this.ctx.storage.put("users", users);
    return { ok: true, removed: true };
  }

  async test(b) {
    const key = String((b && b.key) || "").trim();
    const users = (await this.ctx.storage.get("users")) || {};
    const u = Object.values(users).find((x) => x.key === key);
    if (!u) throw new Error("Turn phone alerts on first.");
    if (u.lastTest && now() - u.lastTest < 20) throw new Error("Wait a few seconds before testing again.");
    u.lastTest = now();
    await this.ctx.storage.put("users", users);
    await this.push(u.topic, {
      title: "✈️ Travel Geek test",
      message: `Hi ${u.name}! Alerts reach this phone. Where you are now: ${u.loc ? u.loc.where : "checking within a minute"}.`,
      priority: 4,
      tags: [],
      click: "https://www.torn.com/page.php?sid=travel",
    });
    return { ok: true };
  }
}
