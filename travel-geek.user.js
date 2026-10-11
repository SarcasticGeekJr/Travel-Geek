// ==UserScript==
// @name         Travel Geek
// @namespace    https://github.com/SarcasticGeekJr/Travel-Geek
// @version      1.0.2
// @description  Best things to buy abroad right now for your own setup, when to leave so you land at the restock, and phone alerts (ntfy) even when Torn PDA is closed. Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      yata.yt
// @connect      api.prombot.co.uk
// @connect      weav3r.dev
// @connect      api.torn.com
// @connect      workers.dev
// @connect      raw.githubusercontent.com
// @run-at       document-end
// @homepageURL  https://github.com/SarcasticGeekJr/Travel-Geek
// @supportURL   https://github.com/SarcasticGeekJr/Travel-Geek/issues
// @updateURL    https://raw.githubusercontent.com/SarcasticGeekJr/Travel-Geek/main/travel-geek.user.js
// @downloadURL  https://raw.githubusercontent.com/SarcasticGeekJr/Travel-Geek/main/travel-geek.user.js
// ==/UserScript==

/*
 * Data sources
 *   - Abroad stock: YATA (yata.yt) and Prometheus, which collect what players see in shops abroad.
 *   - Selling prices: TornW3B (weav3r.dev) market value and cheapest bazaar.
 *   - Restock predictions and phone alerts: the Travel Geek helper (a small Cloudflare Worker),
 *     which watches stock every minute and keeps restock history.
 *   - Official Torn API, your own key: basic (status), perks (to work out your capacity), travel.
 *
 * Rules: this script only reads data, shows it and sends you notifications.
 * It never flies, buys or clicks anything for you.
 */

(function () {
  "use strict";

  if (window.__travelGeekLoaded) return;
  window.__travelGeekLoaded = true;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
  const VERSION = "1.0.2"; // keep in sync with @version above
  const UPDATE_URL = "https://raw.githubusercontent.com/SarcasticGeekJr/Travel-Geek/main/travel-geek.user.js";
  const DEFAULT_HELPER = "https://travel-geek.sakthiramkumar12.workers.dev";
  const YATA = "https://yata.yt/api/v1/travel/export/";
  const PROM = "https://api.prombot.co.uk/api/travel";
  const W3B = "https://weav3r.dev/api/marketplace";
  const TORN = "https://api.torn.com";
  const TRAVEL_URL = "https://www.torn.com/page.php?sid=travel";
  const MIN = 60 * 1000;

  // One-way flight minutes (same table as Torn PDA, from the Torn wiki after patch #438).
  const COUNTRIES = {
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
  const METHOD_LABEL = { standard: "Standard", airstrip: "Airstrip", wlt: "Private jet (WLT)", business: "Business class" };
  // Base items you can carry: 10, or 15 with an airstrip, the WLT benefit or a Business class ticket (Torn wiki).
  const BASE_CAP = { standard: 10, airstrip: 15, wlt: 15, business: 15 };
  // Item types come from the Torn API (weapons are "Weapon" with a sub_type such as "Temporary").
  const FAST = ["plushie", "flower", "drug", "medical", "booster", "candy", "alcohol", "energy drink", "temporary"];
  const SLOW = ["weapon", "primary", "secondary", "melee", "defensive", "armor", "clothing", "jewelry", "collectible", "artifact", "car"];
  const speedOf = (type, sub) => {
    const t = String(type || "").toLowerCase();
    if (t === "weapon" && String(sub || "").toLowerCase() === "temporary") return "fast";
    return !t ? "unknown" : FAST.includes(t) ? "fast" : SLOW.includes(t) ? "slow" : "medium";
  };

  const DEFAULTS = {
    apiKey: "",
    helper: "",
    capOverride: 0, // 0 = work it out from perks
    method: "auto", // auto | standard | airstrip | wlt | business
    extraFlower: 0,
    extraPlushie: 0,
    fee: 5, // Item Market sales fee, %
    tab: "now", // now | soon | all
    fastOnly: true,
    sort: "hour", // hour | trip
    country: "",
    watch: [], // "jap:206"
    hidden: [],
    // phone alerts
    alertsOn: false,
    topic: "",
    minProfit: 1000000,
    watchOnly: false,
    lead: 10,
    maxPerHour: 6,
    quiet: { on: false, from: 23 * 60, to: 7 * 60 },
    types: { leave: true, ready: true, go: true, soldout: true, restock: true, cheap: true },
    fab: null,
  };

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("tg_" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("tg_" + k, JSON.stringify(v));
      } catch {}
    },
  };
  const S = Object.assign({}, DEFAULTS, store.get("settings", {}));
  S.types = Object.assign({}, DEFAULTS.types, S.types);
  S.quiet = Object.assign({}, DEFAULTS.quiet, S.quiet);
  const save = () => store.set("settings", S);
  const apiKey = () => (S.apiKey || (PDA_KEY.includes("#") ? "" : PDA_KEY)).trim();
  const helperUrl = () => (S.helper || DEFAULT_HELPER).trim().replace(/\/+$/, "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowS = () => Math.floor(Date.now() / 1000);

  // ---------------------------------------------------------------- http
  function httpGet(url) {
    if (typeof window.PDA_httpGet === "function") return pdaGet(url);
    if (typeof GM_xmlhttpRequest === "function") return gmReq("GET", url);
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function httpSend(method, url, data) {
    const body = JSON.stringify(data);
    const headers = { "Content-Type": "application/json" };
    if (method === "POST" && typeof window.PDA_httpPost === "function") return window.PDA_httpPost(url, headers, body).then(parsePda);
    if (method === "DELETE" && typeof window.PDA_httpDelete === "function") return window.PDA_httpDelete(url, headers).then(parsePda);
    if (typeof GM_xmlhttpRequest === "function") return gmReq(method, url, body, headers);
    return fetch(url, { method, headers, body }).then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || "HTTP " + r.status)))));
  }
  function parsePda(r) {
    if (!r || r.status == null) throw new Error("Torn PDA didn't return a response");
    let j = {};
    try {
      j = JSON.parse(r.responseText);
    } catch {}
    if (+r.status < 200 || +r.status >= 300) throw new Error(j.error || "HTTP " + r.status);
    return j;
  }
  function gmReq(method, url, body, headers) {
    return new Promise((res, rej) =>
      GM_xmlhttpRequest({
        method,
        url,
        data: body,
        headers,
        timeout: 20000,
        onload: (r) => {
          let j;
          try {
            j = JSON.parse(r.responseText);
          } catch (e) {
            return rej(new Error("HTTP " + r.status));
          }
          if (r.status < 200 || r.status >= 300) return rej(new Error((j && j.error) || "HTTP " + r.status));
          res(j);
        },
        onerror: () => rej(new Error("Network error")),
        ontimeout: () => rej(new Error("Timed out")),
      })
    );
  }
  // Torn PDA silently drops a GET for a URL it already fetched in the last 2s and resolves with
  // undefined, so wait out that window and try again instead of treating it as a response.
  async function pdaGet(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await window.PDA_httpGet(url, {});
      if (r && r.status != null) {
        const status = +r.status;
        if (status < 200 || status >= 300) throw new Error("HTTP " + status);
        return JSON.parse(r.responseText);
      }
      await sleep(2100);
    }
    throw new Error("Torn PDA didn't return a response");
  }
  const memo = new Map(); // url -> { t, p, done }
  function cached(url, ttl, force) {
    const hit = memo.get(url);
    if (hit && (!hit.done || (!force && Date.now() - hit.t < ttl))) return hit.p;
    const entry = { t: Date.now(), done: false };
    entry.p = httpGet(url).then(
      (d) => ((entry.done = true), d),
      (e) => {
        if (memo.get(url) === entry) memo.delete(url);
        throw e;
      }
    );
    memo.set(url, entry);
    return entry.p;
  }
  async function torn(path, ttl, force) {
    const key = apiKey();
    if (!key) throw new Error("no API key");
    const url = `${TORN}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}&comment=TravelGeek`;
    const d = await cached(url, ttl, force);
    if (d && d.error) {
      memo.delete(url);
      const e = new Error(d.error.error || "Torn API error " + d.error.code);
      e.code = d.error.code;
      throw e;
    }
    return d;
  }

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
  const short = (n) => {
    if (n == null || !isFinite(n)) return "—";
    const a = Math.abs(n),
      s = n < 0 ? "-$" : "$";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
    if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return s + Math.round(a);
  };
  const num = (n) => Math.round(n || 0).toLocaleString("en-US");
  const ago = (sec) => {
    if (!sec) return "?";
    const d = Math.max(0, nowS() - sec);
    if (d < 60) return "<1m";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h " + (Math.floor(d / 60) % 60) + "m";
    return Math.floor(d / 86400) + "d";
  };
  const dur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600),
      m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const parseMoney = (s) => {
    s = String(s || "").toLowerCase().replace(/[$,\s]/g, "");
    const m = s.match(/^(\d*\.?\d+)([kmb])?$/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
  };
  const hm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  const parseHm = (s) => {
    const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
  };
  const img = (id) => `https://www.torn.com/images/items/${id}/medium.png`;
  const marketUrl = (id) => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`;
  const CONF = { high: "High", medium: "Medium", low: "Low", none: "Unknown" };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------- your setup (capacity + ticket)
  // The Torn API has no "how many items can I carry" field, so add it up from your perks.
  // Perk text looks like "+ 2 travel items" or "+ 10 travel item capacity"; flower/plushie-only perks are kept apart.
  function capacityFromPerks(perks) {
    const parts = [],
      extra = { flower: 0, plushie: 0 };
    let airstrip = false,
      wlt = false;
    for (const [group, list] of Object.entries(perks || {})) {
      if (!/_perks$/.test(group) || !Array.isArray(list)) continue;
      for (const raw of list) {
        const p = String(typeof raw === "string" ? raw : (raw && (raw.text || raw.description)) || "");
        if (/airstrip/i.test(p)) airstrip = true;
        if (/private jet/i.test(p)) wlt = true;
        if (!/travel|traveling|travelling/i.test(p) || !/item|capacit|carry/i.test(p)) continue;
        const n = +((p.match(/\+\s*(\d+)/) || p.match(/(\d+)/) || [])[1] || 0);
        if (!n) continue;
        if (/flower/i.test(p)) extra.flower += n;
        else if (/plushie/i.test(p)) extra.plushie += n;
        else parts.push({ n, text: p.trim(), group: group.replace(/_perks$/, "") });
      }
    }
    return { parts, extra, airstrip, wlt };
  }
  const METHOD_FROM_API = { standard: "standard", airstrip: "airstrip", private: "wlt", business: "business" };

  let me = store.get("me", null); // { at, name, id, status, travel, perks: {...}, err }
  async function loadMe(force) {
    if (!apiKey()) return null;
    try {
      let d,
        perksOk = true;
      try {
        d = await torn("/user/?selections=basic,perks,travel", 2 * MIN, force);
      } catch (e) {
        if (e.code !== 16) throw e;
        perksOk = false; // key level too low for perks/travel
        d = await torn("/user/?selections=basic", 2 * MIN, force);
      }
      const cap = perksOk ? capacityFromPerks(d) : null;
      const lastMethod = d.travel && METHOD_FROM_API[String(d.travel.method || "").toLowerCase()];
      me = {
        at: nowS(),
        name: d.name,
        id: d.player_id,
        status: d.status || {},
        travel: d.travel || null,
        cap,
        lastMethod: lastMethod || (me && me.lastMethod) || null,
        perksOk,
      };
      store.set("me", me);
      syncSoon(); // capacity or ticket may have changed
    } catch (e) {
      me = Object.assign({}, me || {}, { err: e.message });
    }
    return me;
  }
  // The ticket you fly with: your choice, else the one from your last trip, else the best your perks allow.
  function myMethod() {
    if (S.method !== "auto") return S.method;
    if (me && me.lastMethod) return me.lastMethod;
    if (me && me.cap) return me.cap.wlt ? "wlt" : me.cap.airstrip ? "airstrip" : "standard";
    return "standard";
  }
  function myCapacity() {
    if (S.capOverride > 0) return { total: S.capOverride, manual: true, parts: [], base: S.capOverride };
    const method = myMethod();
    const base = BASE_CAP[method] || 10;
    const parts = (me && me.cap && me.cap.parts) || [];
    return { total: base + parts.reduce((t, p) => t + p.n, 0), base, parts, manual: false, known: !!(me && me.cap) };
  }
  const extraFor = (type) => {
    const t = String(type || "").toLowerCase();
    const ex = (me && me.cap && me.cap.extra) || {};
    return (t === "flower" ? (S.extraFlower || ex.flower || 0) : 0) + (t === "plushie" ? (S.extraPlushie || ex.plushie || 0) : 0);
  };
  const flightSec = (cc, method) => ((COUNTRIES[cc] && COUNTRIES[cc].min[method || myMethod()]) || 0) * 60;

  // Where you are now, from your status.
  function myLoc() {
    if (!me || !me.status) return null;
    const st = me.status,
      desc = String(st.description || ""),
      tr = me.travel || {};
    const cc = (t) => Object.keys(COUNTRIES).find((k) => String(t || "").toLowerCase().includes(COUNTRIES[k].name.toLowerCase())) || (/arab emirates/i.test(t || "") ? "uae" : null);
    if (st.state === "Traveling") {
      const arrive = tr.timestamp || (tr.time_left ? me.at + tr.time_left : st.until || 0);
      if (/^returning/i.test(desc)) return { where: "returning", cc: cc(desc), arrive };
      return { where: "flying", cc: cc(tr.destination) || cc(desc), arrive };
    }
    if (st.state === "Abroad") return { where: "abroad", cc: cc(desc) };
    if (st.state === "Okay") return { where: "torn" };
    return { where: String(st.state || "other").toLowerCase(), desc, until: st.until };
  }

  // ---------------------------------------------------------------- stock data
  let data = store.get("data", null); // { at, fromHelper, items: [...], updates, source }
  async function loadData(force) {
    const h = helperUrl();
    if (h) {
      try {
        const d = await cached(h + "/api/state", 50 * 1000, force);
        data = { at: nowS(), fromHelper: true, items: d.items || [], updates: d.updates || {}, source: d.source || "", tickAt: d.tickAt, pricesAt: d.pricesAt };
        store.set("data", data);
        return data;
      } catch (e) {
        if (!data || !data.items) data = null;
        // fall through to reading the sources directly
      }
    }
    const [y, p, w] = await Promise.allSettled([cached(YATA, 50 * 1000, force), cached(PROM, 50 * 1000, force), cached(W3B, 10 * MIN, false)]);
    const ys = y.status === "fulfilled" && y.value && y.value.stocks;
    const ps = p.status === "fulfilled" && p.value && p.value.stocks;
    if (!ys && !ps) {
      if (data) return data; // keep what we had
      throw new Error("couldn't reach YATA or Prometheus");
    }
    const prices = {};
    if (w.status === "fulfilled") for (const i of w.value.items || []) prices[i.item_id] = i;
    const items = [],
      updates = {};
    for (const cc of Object.keys(COUNTRIES)) {
      const a = ys && ys[cc],
        b = ps && ps[cc];
      const c = a && b ? ((a.update || 0) >= (b.update || 0) ? a : b) : a || b;
      if (!c) continue;
      updates[cc] = c.update || 0;
      for (const s of c.stocks || []) {
        const pr = prices[s.id] || {};
        const sell = Math.min(...[pr.market_price, pr.lowest_price].filter((v) => v > 0), Infinity);
        items.push({
          key: `${cc}:${s.id}`,
          cc,
          id: s.id,
          name: s.name,
          qty: s.quantity,
          cost: s.cost,
          costAvg: s.cost,
          updated: c.update,
          rate: 0,
          emptySince: null,
          lastRestock: null,
          pred: null,
          type: pr.type || "",
          speed: speedOf(pr.type),
          mv: pr.market_price || 0,
          low: pr.lowest_price || 0,
          sell: isFinite(sell) ? sell : 0,
        });
      }
    }
    data = { at: nowS(), fromHelper: false, items, updates, source: [ys && "YATA", ps && "Prometheus"].filter(Boolean).join("+") };
    store.set("data", data);
    return data;
  }

  // Item types, once a day with your own key, for items the stock data didn't label.
  let types = store.get("types", null); // { at, map: { id: [type, sub_type] } }
  async function loadTypes() {
    if (!apiKey() || (types && nowS() - types.at < 86400)) return;
    try {
      const d = await torn("/v2/torn/items", 60 * MIN);
      const map = {};
      for (const i of d.items || []) map[i.id] = [i.type || "", i.sub_type || ""];
      types = { at: nowS(), map };
      store.set("types", types);
    } catch {}
  }
  function labelTypes() {
    if (!data || !types) return;
    for (const it of data.items) {
      const t = types.map[it.id];
      if (!it.type && t) (it.type = t[0]), (it.speed = speedOf(t[0], t[1]));
    }
  }

  // Your numbers for one item.
  function personal(it) {
    const cap = myCapacity().total + extraFor(it.type);
    const units = it.qty > 0 ? Math.min(cap, it.qty) : cap;
    const net = Math.floor(it.sell * (1 - (+S.fee || 0) / 100));
    const unit = it.sell ? net - it.cost : 0;
    const flight = flightSec(it.cc);
    const trip = unit * units;
    return { cap, units, net, unit, trip, perHour: flight ? Math.round(trip / ((2 * flight) / 3600)) : 0, cash: units * it.cost, flight };
  }

  // What to do about one item: { kind, text, leaveAt?, land? }.
  function plan(it, p) {
    const t = nowS(),
      fl = p.flight;
    if (it.qty > 0) {
      const sold = ((it.rate || 0) / 3600) * (fl + Math.max(0, t - it.updated));
      const left = Math.floor(it.qty - sold);
      if (it.rate && left < p.units)
        return { kind: "late", text: `Probably sold out before you land (selling ~${num(it.rate)}/hour, you'd need ${dur(fl)}).` };
      return { kind: "go", text: `Leave now → land ${clock(t + fl)}${it.rate ? ` with ~${num(Math.max(0, left))} left` : ""}.`, land: t + fl };
    }
    const pr = it.pred;
    if (!pr || !pr.at || pr.conf === "none")
      return { kind: "unknown", text: data && data.fromHelper ? "Empty. Not enough restock history yet to predict." : "Empty. Restock predictions need the helper (⚙ → Phone alerts)." };
    if (pr.overdue) return { kind: "overdue", text: `Empty. Restock is overdue (usually after ${dur(pr.avg || 0)}), so it could be back any time.` };
    const land = pr.at - 120;
    const leaveAt = land - fl;
    if (leaveAt <= t) {
      if (t + fl < pr.to) return { kind: "go", text: `Leave now → land ${clock(t + fl)}. Restock expected ~${clock(pr.at)}.`, land: t + fl };
      return { kind: "late", text: `Too late for this restock (expected ~${clock(pr.at)}).` };
    }
    return { kind: "wait", text: `Leave at ${clock(leaveAt)} (in ${dur(leaveAt - t)}) → land ${clock(land + 0)} for the restock ~${clock(pr.at)}.`, leaveAt, land };
  }

  // ---------------------------------------------------------------- helper sign-up / sync
  function alertSettings() {
    const cap = myCapacity();
    return {
      capacity: cap.total,
      method: myMethod(),
      fee: S.fee,
      minProfit: S.minProfit,
      watch: S.watch,
      hidden: S.hidden,
      watchOnly: S.watchOnly,
      fastOnly: S.fastOnly,
      lead: S.lead,
      maxPerHour: S.maxPerHour,
      quiet: S.quiet,
      tz: -new Date().getTimezoneOffset(),
      types: S.types,
      extraFlower: S.extraFlower || ((me && me.cap && me.cap.extra.flower) || 0),
      extraPlushie: S.extraPlushie || ((me && me.cap && me.cap.extra.plushie) || 0),
    };
  }
  const newTopic = () => "travelgeek-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  let syncT = 0,
    syncState = store.get("sync", null); // { at, ok, err, name, sig }
  function syncSoon() {
    if (!S.alertsOn || !helperUrl() || !apiKey()) return;
    clearTimeout(syncT);
    syncT = setTimeout(() => sync(false), 1500);
  }
  async function sync(manual) {
    const body = { key: apiKey(), topic: S.topic, settings: alertSettings() };
    const sig = JSON.stringify(body);
    if (!manual && syncState && syncState.ok && syncState.sig === sig) return syncState; // nothing changed
    try {
      const r = await httpSend("POST", helperUrl() + "/api/user", body);
      syncState = { at: nowS(), ok: true, name: r.name, sig, last: r.last || [], loc: r.loc };
    } catch (e) {
      syncState = { at: nowS(), ok: false, err: e.message, sig: "" };
    }
    store.set("sync", syncState);
    if (view.name === "alerts") renderAlerts();
    return syncState;
  }

  // ---------------------------------------------------------------- PDA reminder
  const canRemind = () => !!(window.flutter_inappwebview && window.flutter_inappwebview.callHandler);
  async function remind(it, leaveAt) {
    const c = COUNTRIES[it.cc];
    const at = Math.max(nowS() + 30, leaveAt - 2 * 60);
    let id = 0;
    for (const ch of it.key) id = (id * 31 + ch.charCodeAt(0)) % 9000;
    const r = await window.flutter_inappwebview.callHandler("scheduleNotification", {
      title: `🛫 Leave for ${c.name} at ${clock(leaveAt)}`,
      subtitle: `${it.name}: land at the restock. Travel Geek`,
      id: 1000 + id,
      timestamp: at * 1000,
      overwriteID: true,
      launchNativeToast: false,
      urlCallback: TRAVEL_URL,
    });
    if (r && r.status === "error") throw new Error(r.message);
    return at;
  }

  // ---------------------------------------------------------------- UI shell
  const host = document.createElement("div");
  host.id = "travel-geek";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" data-act="toggle" title="Travel Geek (drag to move)"><span class="fab-ico">✈️</span><span class="fab-badge" hidden></span></button>
    <div class="scrim" data-act="close" hidden></div>
    <section class="panel" hidden role="dialog" aria-label="Travel Geek">
      <header class="top">
        <button class="ib" data-act="back" title="Back" hidden>‹</button>
        <div class="title">Travel Geek</div>
        <button class="ib" data-act="refresh" title="Refresh">⟳</button>
        <button class="ib" data-act="settings" title="Settings">⚙</button>
        <button class="ib" data-act="close" title="Close">✕</button>
      </header>
      <div class="body"></div>
    </section>
    <div class="toast" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  const view = { name: "home", key: "", stack: [], loading: false, err: null };
  const isOpen = () => !$(".panel").hidden;
  function open() {
    $(".panel").hidden = false;
    $(".scrim").hidden = false;
    render();
    refresh(false);
  }
  function close() {
    $(".panel").hidden = true;
    $(".scrim").hidden = true;
  }
  let toastT = 0;
  function toast(msg, kind, ms = 2400) {
    const t = $(".toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastT);
    if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
  }
  function go(name, key, noPush) {
    if (!noPush && (view.name !== name || view.key !== key)) view.stack.push({ name: view.name, key: view.key });
    if (view.stack.length > 20) view.stack.shift();
    view.name = name;
    view.key = key || "";
    render();
    body().scrollTop = 0;
  }
  function back() {
    const p = view.stack.pop() || { name: "home" };
    go(p.name, p.key, true);
  }
  function render() {
    $("[data-act=back]").hidden = view.name === "home";
    const it = view.name === "item" && findItem(view.key);
    $(".title").textContent = { settings: "Settings", alerts: "Phone alerts", setup: "Your setup" }[view.name] || (it ? it.name : "Travel Geek");
    ({ home: renderHome, item: renderItem, settings: renderSettings, alerts: renderAlerts, setup: renderSetup })[view.name]();
  }
  const findItem = (key) => data && data.items.find((i) => i.key === key);

  let refreshing = false;
  async function refresh(force) {
    if (refreshing) return;
    refreshing = true;
    $("[data-act=refresh]").classList.add("spinning");
    view.err = null;
    try {
      await Promise.all([loadData(force), loadMe(force), loadTypes()]);
      labelTypes();
    } catch (e) {
      view.err = e.message;
    }
    refreshing = false;
    $("[data-act=refresh]").classList.remove("spinning");
    if (isOpen() && ["home", "item"].includes(view.name)) render();
    updateBadge();
  }

  // ---------------------------------------------------------------- home
  function statusCard() {
    const loc = myLoc();
    const cap = myCapacity();
    const m = myMethod();
    let where = "";
    if (!apiKey()) where = `<span class="a">Add your Torn API key in ⚙ to see your status and capacity.</span>`;
    else if (!loc) where = me && me.err ? `<span class="r">Torn API: ${esc(me.err)}</span>` : "Checking where you are…";
    else if (loc.where === "torn") where = "📍 In Torn";
    else if (loc.where === "flying") where = `✈️ Flying to ${loc.cc ? COUNTRIES[loc.cc].flag + " " + COUNTRIES[loc.cc].name : "?"}${loc.arrive ? ` · lands ${clock(loc.arrive)}` : ""}`;
    else if (loc.where === "returning") where = `✈️ Flying back to Torn${loc.arrive ? ` · lands ${clock(loc.arrive)}` : ""}`;
    else if (loc.where === "abroad") where = `${loc.cc ? COUNTRIES[loc.cc].flag + " In " + COUNTRIES[loc.cc].name : "Abroad"}`;
    else where = `⛔ ${esc(loc.desc || loc.where)}`;
    const alerts = S.alertsOn && helperUrl() ? (syncState && syncState.ok ? `<span class="g">🔔 Phone alerts on</span>` : `<span class="r">🔔 Alerts not connected</span>`) : `<span class="muted">🔕 Phone alerts off</span>`;
    return `<div class="card status">
      <div class="st-row"><b>${where}</b></div>
      <button class="st-row link2" data-act="setup">${cap.total} items · ${esc(METHOD_LABEL[m])}${cap.manual ? " (set by you)" : S.method === "auto" ? " (auto)" : ""} ✏️</button>
      <button class="st-row link2" data-act="alerts">${alerts} ›</button>
    </div>`;
  }

  function rows() {
    if (!data) return [];
    const hidden = new Set(S.hidden),
      watch = new Set(S.watch);
    return data.items
      .filter((it) => it.cost > 0 && !hidden.has(it.key) && (!S.country || it.cc === S.country))
      .map((it) => {
        const p = personal(it);
        return { it, p, pl: plan(it, p), watched: watch.has(it.key) };
      })
      .filter((r) => r.watched || ((!S.fastOnly || r.it.speed === "fast") && r.p.unit > 0))
      .filter((r) => {
        if (S.tab === "now") return r.it.qty > 0;
        if (S.tab === "soon") return r.it.qty === 0;
        return true;
      })
      .sort((a, b) => b.watched - a.watched || (S.sort === "trip" ? b.p.trip - a.p.trip : b.p.perHour - a.p.perHour));
  }

  function renderHome() {
    const list = data ? rows().slice(0, 80) : [];
    const loc = myLoc();
    const tabs = [
      ["now", "In stock"],
      ["soon", "Coming back"],
      ["all", "All"],
    ];
    body().innerHTML = `
      ${statusCard()}
      ${loc && loc.where === "abroad" && loc.cc ? `<button class="ctx" data-act="country" data-cc="${loc.cc}">You're in ${COUNTRIES[loc.cc].name}: show only items here →</button>` : ""}
      <div class="sorts">${tabs.map(([k, t]) => `<button class="seg ${S.tab === k ? "on" : ""}" data-act="tab" data-k="${k}">${t}</button>`).join("")}</div>
      <div class="filters">
        <select class="f-country"><option value="">All countries</option>${Object.entries(COUNTRIES)
          .map(([cc, c]) => `<option value="${cc}" ${S.country === cc ? "selected" : ""}>${c.flag} ${esc(c.name)} · ${dur(flightSec(cc))}</option>`)
          .join("")}</select>
        <select class="f-sort"><option value="hour" ${S.sort === "hour" ? "selected" : ""}>Best per hour</option><option value="trip" ${S.sort === "trip" ? "selected" : ""}>Best per trip</option></select>
      </div>
      <label class="tog slim"><input type="checkbox" class="f-fast" ${S.fastOnly ? "checked" : ""}><span>Only items that sell fast (no guns or armour)</span></label>
      <div class="count muted small">${
        data ? `${list.length} items · stock seen ${data.fromHelper ? "by the helper" : "via " + esc(data.source)} · updated ${ago(data.at)} ago` : view.err ? "" : "Loading…"
      }</div>
      ${view.err && !data ? `<p class="err">Couldn't load stock (${esc(view.err)}). <button class="link" data-act="refresh">Retry</button></p>` : ""}
      <div class="list">${list.length ? list.map(row).join("") : data ? `<p class="muted hint">${S.tab === "soon" ? "Nothing empty right now. " : ""}Nothing here with your filters. Try “All”, another country, or turn off “sell fast”.</p>` : `<div class="spin"></div>`}</div>
      <p class="foot muted">Profit = (sell price − ${+S.fee || 0}% fee − cost) × what you can carry. Sell price is the lower of market value and the cheapest bazaar. Stock comes from players visiting shops, so it can be a few minutes old.<br>Travel Geek v${VERSION}</p>`;
    $(".f-country").addEventListener("change", (e) => {
      S.country = e.target.value;
      save();
      renderHome();
    });
    $(".f-sort").addEventListener("change", (e) => {
      S.sort = e.target.value;
      save();
      renderHome();
    });
    $(".f-fast").addEventListener("change", (e) => {
      S.fastOnly = e.target.checked;
      save();
      renderHome();
      syncSoon();
    });
  }

  const SPEED = { fast: `<span class="pill good">sells fast</span>`, slow: `<span class="pill bad">sells slowly</span>`, medium: `<span class="pill even">sells OK</span>`, unknown: "" };
  function row({ it, p, pl, watched }) {
    const c = COUNTRIES[it.cc];
    const stock = it.qty > 0 ? `${num(it.qty)} in stock · ${ago(it.updated)} ago` : `<span class="a">Empty</span>${it.pred && it.pred.at && !it.pred.overdue ? ` · back ~${clock(it.pred.at)} (${CONF[it.pred.conf].toLowerCase()})` : it.pred && it.pred.overdue ? " · overdue" : ""}`;
    const tag = pl.kind === "go" ? `<span class="g">Go now</span>` : pl.kind === "wait" ? `<span class="acc">Leave ${clock(pl.leaveAt)}</span>` : pl.kind === "late" ? `<span class="r">Too late</span>` : "";
    return `<button class="row" data-act="item" data-key="${it.key}">
      <img src="${img(it.id)}" alt="" loading="lazy">
      <span class="nm">${watched ? "⭐ " : ""}${esc(it.name)}<small>${c.flag} ${esc(c.name)} · ${stock}</small><small>${SPEED[it.speed] || ""} ${tag}</small></span>
      <span class="rt"><b class="${p.trip > 0 ? "g" : "r"}">${short(p.trip)}</b><small>${short(p.perHour)}/hr</small></span>
    </button>`;
  }

  // ---------------------------------------------------------------- item
  function renderItem() {
    const it = findItem(view.key);
    if (!it) return void (body().innerHTML = `<p class="muted hint">This item isn't in the latest stock data.</p>`);
    const c = COUNTRIES[it.cc];
    const p = personal(it);
    const pl = plan(it, p);
    const watched = S.watch.includes(it.key);
    const pr = it.pred;
    const cheap = it.costAvg && it.cost < it.costAvg * 0.95 ? `<small class="g">${Math.round((1 - it.cost / it.costAvg) * 100)}% under usual ${short(it.costAvg)}</small>` : it.costAvg && it.cost > it.costAvg * 1.05 ? `<small class="r">above usual ${short(it.costAvg)}</small>` : "";
    body().innerHTML = `
      <div class="ihead">
        <img src="${img(it.id)}" alt="">
        <div class="grow"><div class="iname">${esc(it.name)}</div><div class="muted small">${c.flag} ${esc(c.name)} · ${esc(it.type || "?")} ${SPEED[it.speed] || ""}</div></div>
        <button class="ib star ${watched ? "on" : ""}" data-act="watch" title="Watch: always show and always alert">${watched ? "★" : "☆"}</button>
      </div>
      <div class="plan ${pl.kind}"><b>${pl.kind === "go" ? "✅ Go now" : pl.kind === "wait" ? "⏳ Wait" : pl.kind === "late" ? "❌ Not this time" : "❔ Unsure"}</b><div>${esc(pl.text)}</div>
        ${pl.kind === "wait" && pl.leaveAt ? (canRemind() ? `<button class="btn sm" data-act="remind" data-at="${pl.leaveAt}">⏰ Remind me at ${clock(pl.leaveAt - 120)}</button>` : `<div class="muted small">Tip: in Torn PDA you can set a reminder here. Phone alerts (⚙) work everywhere.</div>`) : ""}
      </div>
      <div class="stats">
        <div class="stat"><span>Buy abroad</span><b>${money(it.cost)}</b>${cheap}</div>
        <div class="stat"><span>Sell here</span><b>${it.sell ? money(it.sell) : "—"}</b><small>MV ${short(it.mv || null)} · bazaar ${short(it.low || null)}</small></div>
        <div class="stat"><span>Profit per item</span><b class="${p.unit > 0 ? "g" : "r"}">${money(p.unit)}</b><small>after ${+S.fee || 0}% fee</small></div>
        <div class="stat"><span>Profit per trip</span><b class="${p.trip > 0 ? "g" : "r"}">${short(p.trip)}</b><small>${p.units} items${p.units < p.cap ? ` (only ${num(it.qty)} left)` : ""}</small></div>
        <div class="stat"><span>Per hour of flying</span><b>${short(p.perHour)}</b><small>${dur(2 * p.flight)} round trip</small></div>
        <div class="stat"><span>Cash to take</span><b>${short(p.cash)}</b><button class="mini" data-act="copy" data-v="${p.cash}">copy</button></div>
      </div>
      <h3>Stock</h3>
      <div class="card small">
        <div>${it.qty > 0 ? `<b>${num(it.qty)}</b> in stock` : `<b class="a">Empty</b>${it.emptySince ? ` since ${clock(it.emptySince)} (${ago(it.emptySince)} ago)` : ""}`} · seen ${ago(it.updated)} ago</div>
        <div class="muted">Selling speed: ${it.rate ? `~${num(it.rate)}/hour` : "unknown"}${it.amt ? ` · last restock brought ~${num(it.amt)}` : ""}${it.lastRestock ? ` · last restock ${clock(it.lastRestock)}` : ""}</div>
        ${
          pr && pr.at
            ? `<div>Next restock: <b>~${clock(pr.at)}</b> (between ${clock(pr.from)} and ${clock(pr.to)}) · ${CONF[pr.conf]} confidence${pr.overdue ? " · <span class='a'>overdue</span>" : ""}</div><div class="muted">Usually empty for ${dur(pr.avg || 0)} · based on ${pr.n} restock${pr.n === 1 ? "" : "s"} the helper saw</div>`
            : it.qty === 0
              ? `<div class="muted">${data.fromHelper ? "Not enough restock history yet. It improves the longer the helper runs." : "Restock predictions need the helper."}</div>`
              : ""
        }
      </div>
      <h3>Flight</h3>
      <div class="card small">${Object.keys(COUNTRIES[it.cc].min)
        .map((m) => `<div class="${m === myMethod() ? "" : "muted"}">${m === myMethod() ? "▸ " : ""}${METHOD_LABEL[m]}: ${dur(flightSec(it.cc, m))} one way</div>`)
        .join("")}</div>
      <div class="btns">
        <a class="btn ghost" href="${TRAVEL_URL}">Travel agency</a>
        <a class="btn ghost" href="${marketUrl(it.id)}">Item Market</a>
        <button class="btn ghost" data-act="hide">${S.hidden.includes(it.key) ? "Unhide" : "Hide this item"}</button>
      </div>
      <p class="foot muted">Predictions are estimates. Torn changed restocks in December 2025, so nobody can predict them exactly.</p>`;
  }

  // ---------------------------------------------------------------- setup
  function renderSetup() {
    const cap = myCapacity();
    const auto = S.capOverride ? null : cap;
    const ex = (me && me.cap && me.cap.extra) || { flower: 0, plushie: 0 };
    body().innerHTML = `
      <div class="form">
        <h3>Items you can carry</h3>
        <div class="card">
          <div class="big">${cap.total} items</div>
          ${
            auto
              ? `<div class="small muted">${auto.known ? "Worked out from your perks:" : apiKey() ? "Couldn't read your perks yet (needs a Limited or Full key)." : "Add your API key to work this out."}</div>
                 <div class="small">Base ${auto.base} (${esc(METHOD_LABEL[myMethod()])})</div>
                 ${auto.parts.map((p) => `<div class="small">${esc(/^\+/.test(p.text) ? p.text : `+${p.n} · ${p.text}`)} <span class="muted">(${esc(p.group)})</span></div>`).join("")}`
              : `<div class="small muted">Set by you.</div>`
          }
          ${ex.flower || ex.plushie ? `<div class="small muted">Plus ${ex.flower ? `${ex.flower} extra flowers` : ""}${ex.flower && ex.plushie ? " and " : ""}${ex.plushie ? `${ex.plushie} extra plushies` : ""} from your job.</div>` : ""}
        </div>
        <label class="tog">Fix it myself (0 = automatic)<input class="num" data-n="capOverride" type="number" min="0" max="300" inputmode="numeric" value="${S.capOverride || 0}"></label>
        <p class="muted small">Only needed if the number above is wrong. If it is, tell SarcasticGeekJr what it should be so the automatic count can be fixed.</p>

        <h3>Ticket</h3>
        <label class="blk"><select class="method">
          <option value="auto" ${S.method === "auto" ? "selected" : ""}>Automatic${me && me.lastMethod ? ` (your last trip: ${METHOD_LABEL[me.lastMethod]})` : ""}</option>
          ${Object.entries(METHOD_LABEL).map(([k, v]) => `<option value="${k}" ${S.method === k ? "selected" : ""}>${v}</option>`).join("")}
        </select></label>
        <p class="muted small">Automatic uses the ticket from your last trip, or the best one your perks allow. Flight times and the base capacity follow this.</p>
        <button class="btn ghost" data-act="reloadMe">Re-check my perks</button>
      </div>`;
    $(".method").addEventListener("change", (e) => {
      S.method = e.target.value;
      save();
      renderSetup();
      syncSoon();
    });
    bindNums(renderSetup);
  }
  function bindNums(after) {
    $$("[data-n]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.n] = Math.max(0, parseFloat(el.value) || 0);
        save();
        toast("Saved");
        syncSoon();
        if (after) after();
      })
    );
  }

  // ---------------------------------------------------------------- phone alerts
  function renderAlerts() {
    const h = helperUrl();
    const ok = syncState && syncState.ok;
    const tog = (k, label) => `<label class="tog"><input type="checkbox" data-t="${k}" ${S.types[k] ? "checked" : ""}><span>${label}</span></label>`;
    body().innerHTML = `
      <div class="form">
        ${!h ? `<p class="a">The alert helper isn't set up yet. Ask SarcasticGeekJr for the helper address and paste it under “Advanced” below.</p>` : ""}
        <label class="tog big"><input type="checkbox" class="on" ${S.alertsOn ? "checked" : ""} ${!h || !apiKey() ? "disabled" : ""}><b>Send alerts to my phone</b></label>
        ${!apiKey() ? `<p class="a small">Needs your Torn API key (⚙ Settings).</p>` : ""}
        ${
          S.alertsOn
            ? `<div class="card small">${ok ? `<span class="g">✓ Connected as ${esc(syncState.name || "you")}</span>` : syncState && syncState.err ? `<span class="r">Not connected: ${esc(syncState.err)}</span> <button class="link small" data-act="sync">Try again</button>` : "Connecting…"}</div>
        <h3>1. Get the ntfy app</h3>
        <p class="small">Free, no account: <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy">Android</a> · <a href="https://apps.apple.com/app/ntfy/id1625396347">iPhone</a></p>
        <h3>2. Subscribe to your private channel</h3>
        <p class="small">In ntfy tap <b>+</b>, type this name exactly, then <b>Subscribe</b>:</p>
        <div class="topic"><code>${esc(S.topic)}</code><button class="btn sm ghost" data-act="copyTopic">Copy</button></div>
        <p class="muted small">Keep it to yourself: anyone with the name can read your alerts.</p>
        <h3>3. Test it</h3>
        <button class="btn" data-act="test" ${ok ? "" : "disabled"}>Send a test alert</button>

        <h3>What to alert me about</h3>
        ${tog("leave", "🛫 <b>Leave now</b>: you'd land right at a predicted restock")}
        ${tog("ready", "⏰ <b>Get ready</b>: a few minutes before “leave now”")}
        <label class="tog">Minutes of warning<input class="num" data-a="lead" type="number" min="0" max="60" inputmode="numeric" value="${S.lead}"></label>
        ${tog("go", "✅ <b>Just restocked</b> and there'll still be stock when you land")}
        ${tog("soldout", "⚠️ <b>Sold out</b> while you're flying there (with a backup pick)")}
        ${tog("restock", "🔔 <b>Restocked here</b> while you're abroad")}
        ${tog("cheap", "💸 <b>Cheap</b>: an item is 15%+ under its usual price abroad")}

        <h3>Which items</h3>
        <label class="tog">Only if profit per trip is at least<input class="num wide" data-m="minProfit" inputmode="decimal" value="${short(S.minProfit).slice(1)}"></label>
        <label class="tog"><input type="checkbox" data-s="fastOnly" ${S.fastOnly ? "checked" : ""}><span>Only items that sell fast</span></label>
        <label class="tog"><input type="checkbox" data-s="watchOnly" ${S.watchOnly ? "checked" : ""}><span>Only my ⭐ watched items (${S.watch.length})</span></label>
        <label class="tog">Most alerts per hour<input class="num" data-a="maxPerHour" type="number" min="1" max="30" inputmode="numeric" value="${S.maxPerHour}"></label>

        <h3>Quiet hours</h3>
        <label class="tog"><input type="checkbox" class="q-on" ${S.quiet.on ? "checked" : ""}><span>No alerts between</span></label>
        <div class="filters two"><input class="q-from" type="time" value="${hm(S.quiet.from)}"><input class="q-to" type="time" value="${hm(S.quiet.to)}"></div>

        ${
          ok && syncState.last && syncState.last.length
            ? `<h3>Recent alerts</h3>${syncState.last.map((a) => `<div class="small">${clock(a.at)} · ${esc(a.title)}</div>`).join("")}`
            : ""
        }`
            : `<p class="muted small">Alerts come from a small helper that checks stock every minute, day and night, so they reach you even when Torn PDA is closed. It needs your API key (see below).</p>`
        }

        <h3>Your API key and the helper</h3>
        <p class="muted small">When alerts are on, your key is stored on the Travel Geek helper (Cloudflare) and used about once a minute to read your status and travel (where you are and when you land). It isn't shared or used for anything else. Turning alerts off deletes it from the helper. A <b>Limited</b> key is best; a Public key works but can't see your flight details.</p>

        <h3>Advanced</h3>
        <label class="blk">Helper address<input class="helper" type="url" placeholder="https://travel-geek.….workers.dev" value="${esc(S.helper)}"></label>
        ${S.alertsOn ? `<button class="btn ghost" data-act="newTopic">Make a new channel name</button>` : ""}
      </div>`;
    const on = $(".on");
    on.addEventListener("change", async () => {
      if (on.checked) {
        if (!S.topic) S.topic = newTopic();
        S.alertsOn = true;
        save();
        renderAlerts();
        await sync(true);
      } else {
        S.alertsOn = false;
        save();
        try {
          await httpSend("DELETE", helperUrl() + "/api/user", { key: apiKey() });
          toast("Alerts off. Your key was removed from the helper.", "ok");
        } catch (e) {
          toast("Alerts off here, but the helper didn't answer: " + e.message, "bad", 4000);
        }
        syncState = null;
        store.set("sync", null);
        renderAlerts();
      }
    });
    $$("[data-t]").forEach((el) => el.addEventListener("change", () => ((S.types[el.dataset.t] = el.checked), save(), syncSoon())));
    $$("[data-s]").forEach((el) => el.addEventListener("change", () => ((S[el.dataset.s] = el.checked), save(), syncSoon())));
    $$("[data-a]").forEach((el) => el.addEventListener("change", () => ((S[el.dataset.a] = Math.max(0, parseInt(el.value) || 0)), save(), syncSoon(), toast("Saved"))));
    $$("[data-m]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.m] = parseMoney(el.value);
        save();
        syncSoon();
        toast(`Saved: ${short(S[el.dataset.m])}`);
      })
    );
    const qOn = $(".q-on");
    if (qOn) {
      const saveQuiet = () => {
        S.quiet = { on: qOn.checked, from: parseHm($(".q-from").value) ?? S.quiet.from, to: parseHm($(".q-to").value) ?? S.quiet.to };
        save();
        syncSoon();
      };
      [qOn, $(".q-from"), $(".q-to")].forEach((el) => el.addEventListener("change", saveQuiet));
    }
    $(".helper").addEventListener("change", (e) => {
      S.helper = e.target.value.trim();
      save();
      memo.clear();
      toast("Saved");
      renderAlerts();
      if (S.alertsOn) sync(true);
    });
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    const key = apiKey();
    body().innerHTML = `
      <div class="form">
        <label class="blk">Torn API key <small class="muted">(Limited is best)</small>
          <input class="key" type="password" autocomplete="off" placeholder="${!S.apiKey && key ? "using Torn PDA key" : "16 characters"}" value="${esc(S.apiKey)}">
        </label>
        <p class="muted small">Used to read your status, perks (to work out what you can carry) and travel. Stored on this device and sent to api.torn.com, and to the alert helper only if you turn phone alerts on.${PDA_KEY.includes("#") ? "" : " In Torn PDA your key is used automatically if this is empty."}</p>
        <button class="btn ghost" data-act="setup">Your setup: ${myCapacity().total} items · ${esc(METHOD_LABEL[myMethod()])} ›</button>
        <button class="btn ghost" data-act="alerts">Phone alerts: ${S.alertsOn ? "on" : "off"} ›</button>

        <h3>Selling</h3>
        <label class="tog col"><span class="feerow"><b>Item Market sales fee</b><input class="num" data-n="fee" type="number" min="0" max="50" step="0.5" inputmode="decimal" value="${S.fee}"><b>%</b></span>
          <small class="muted">Torn's standard fee since June 2025. Set 0 if you sell in your bazaar.</small></label>

        <h3>Hidden items</h3>
        ${S.hidden.length ? `<div class="chips">${S.hidden.map((k) => `<button class="chip" data-act="unhide" data-key="${k}">${esc((findItem(k) || {}).name || k)} ✕</button>`).join("")}</div>` : `<p class="muted small">None.</p>`}

        <h3>Other</h3>
        <button class="btn ghost" data-act="resetFab">Reset ✈️ button position</button>
        <p class="muted small">Tip: drag the ✈️ button to move it.</p>

        <h3>About</h3>
        <div class="about">
          <div><b>Travel Geek v${VERSION}</b></div>
          <div class="small muted">Stock: YATA and Prometheus. Prices: TornW3B. Flight times: Torn wiki (as used by Torn PDA).</div>
          <button class="btn ghost" data-act="checkUpdate">Check for updates</button>
          <div class="upd small muted"></div>
        </div>
      </div>`;
    $(".key").addEventListener("change", (e) => {
      S.apiKey = e.target.value.trim();
      save();
      memo.clear();
      toast("Saved");
      loadMe(true).then(() => syncSoon());
    });
    bindNums();
  }

  // ---------------------------------------------------------------- actions
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case "toggle":
        if (fabDragged) return;
        return isOpen() ? close() : open();
      case "close":
        return close();
      case "back":
        return back();
      case "settings":
      case "alerts":
      case "setup":
        return go(act);
      case "item":
        return go("item", el.dataset.key);
      case "refresh":
        toast("Refreshing…", "busy", 1200);
        return refresh(true);
      case "tab":
        S.tab = el.dataset.k;
        save();
        return renderHome();
      case "country":
        S.country = el.dataset.cc;
        S.tab = "all";
        save();
        return renderHome();
      case "watch": {
        const k = view.key;
        S.watch = S.watch.includes(k) ? S.watch.filter((x) => x !== k) : [...S.watch, k];
        save();
        syncSoon();
        toast(S.watch.includes(k) ? "Watching: always shown and always alerted" : "Not watching");
        return renderItem();
      }
      case "hide": {
        const k = view.key;
        S.hidden = S.hidden.includes(k) ? S.hidden.filter((x) => x !== k) : [...S.hidden, k];
        save();
        syncSoon();
        toast(S.hidden.includes(k) ? "Hidden from the list and alerts" : "Shown again");
        return renderItem();
      }
      case "unhide":
        S.hidden = S.hidden.filter((x) => x !== el.dataset.key);
        save();
        syncSoon();
        return renderSettings();
      case "copy":
        return toast((await copyText(el.dataset.v)) ? `Copied ${money(+el.dataset.v)}` : "Couldn't copy", "ok", 1500);
      case "copyTopic":
        return toast((await copyText(S.topic)) ? "Copied. Paste it in ntfy." : "Couldn't copy", "ok", 2000);
      case "remind": {
        const it = findItem(view.key);
        try {
          const at = await remind(it, +el.dataset.at);
          toast(`Reminder set for ${clock(at)}`, "ok", 3000);
        } catch (er) {
          toast("Couldn't set the reminder: " + er.message, "bad", 4000);
        }
        return;
      }
      case "sync":
        return sync(true);
      case "test":
        try {
          await httpSend("POST", helperUrl() + "/api/test", { key: apiKey() });
          toast("Sent! Check your phone.", "ok", 3000);
        } catch (er) {
          toast("Test failed: " + er.message, "bad", 4000);
        }
        return;
      case "newTopic":
        S.topic = newTopic();
        save();
        renderAlerts();
        await sync(true);
        return toast("New channel name. Subscribe to it in ntfy.", "ok", 3000);
      case "reloadMe":
        await loadMe(true);
        toast(me && me.err ? "Torn API: " + me.err : "Updated", me && me.err ? "bad" : "ok");
        return renderSetup();
      case "resetFab":
        S.fab = null;
        save();
        placeFab();
        return toast("Button moved back");
      case "checkUpdate": {
        const out = $(".upd");
        out.className = "upd small muted";
        out.textContent = "Checking…";
        try {
          const url = UPDATE_URL + "?t=" + Date.now();
          let text;
          if (typeof window.PDA_httpGet === "function") text = (await window.PDA_httpGet(url, {}))?.responseText;
          else if (typeof GM_xmlhttpRequest === "function")
            text = await new Promise((res, rej) => GM_xmlhttpRequest({ method: "GET", url, onload: (r) => res(r.responseText), onerror: rej }));
          else text = await (await fetch(url)).text();
          const latest = ((text || "").match(/@version\s+(\S+)/) || [])[1];
          if (!latest) throw new Error("couldn't read the latest version");
          const newer = latest.split(".").map(Number).reduce((r, n, i) => r || (n > (+VERSION.split(".")[i] || 0) ? 1 : n < (+VERSION.split(".")[i] || 0) ? -1 : 0), 0) > 0;
          out.className = "upd small " + (newer ? "a" : "g");
          out.textContent = newer ? `Version ${latest} is available. Close and reopen Torn PDA, or go to Settings → Userscripts and check for updates.` : `You're up to date (latest is ${latest}).`;
        } catch (er) {
          out.className = "upd small r";
          out.textContent = "Couldn't check: " + er.message;
        }
        return;
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // ---------------------------------------------------------------- draggable button
  let fabDragged = false;
  function placeFab() {
    const fab = $(".fab");
    const p = S.fab;
    if (!p) {
      fab.style.right = "14px";
      fab.style.bottom = "146px"; // above Bazaar Plus's 🛒
      return;
    }
    fab.style.right = Math.min(Math.max(4, p.right), innerWidth - 56) + "px";
    fab.style.bottom = Math.min(Math.max(4, p.bottom), innerHeight - 56) + "px";
  }
  function setupDrag() {
    const fab = $(".fab");
    let start = null;
    fab.addEventListener("pointerdown", (e) => {
      const r = fab.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      fabDragged = false;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 8) return;
      start.moved = true;
      S.fab = { right: start.right - dx, bottom: start.bottom - dy };
      placeFab();
    });
    const end = () => {
      if (start && start.moved) {
        fabDragged = true;
        setTimeout(() => (fabDragged = false), 50);
        save();
      }
      start = null;
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", end);
    addEventListener("resize", placeFab);
    placeFab();
  }

  // Badge: how many good runs you could start right now.
  function updateBadge() {
    const b = $(".fab-badge");
    if (!data) return (b.hidden = true);
    const n = data.items.filter((it) => {
      if (!it.cost || S.hidden.includes(it.key)) return false;
      if (!S.watch.includes(it.key) && (S.watchOnly || (S.fastOnly && it.speed !== "fast"))) return false;
      const p = personal(it);
      return p.trip >= S.minProfit && plan(it, p).kind === "go";
    }).length;
    b.hidden = !n;
    b.textContent = n;
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    document.body.appendChild(host);
    setupDrag();
    labelTypes();
    updateBadge();
    refresh(false).then(() => syncSoon());
    setInterval(() => {
      if (document.hidden) return;
      refresh(false);
    }, 2 * MIN);
    // Keep "leave in 12m" and similar text current while the panel is open.
    setInterval(() => isOpen() && ["home", "item"].includes(view.name) && !root.activeElement && render(), 30 * 1000);
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);

  // ---------------------------------------------------------------- styles
  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
button { font: inherit; cursor: pointer; }
[hidden] { display: none !important; }
:host {
  --bg: #1d1f22; --bg2: #26292d; --bg3: #30343a; --line: #3a3f46; --text: #e9ecef; --muted: #9aa3ad;
  --acc: #74c0fc; --g: #7fdc6f; --r: #ff8787; --amber: #ffd43b;
}
.fab { position: fixed; right: 14px; bottom: 146px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--bg2); color: var(--text); box-shadow: 0 4px 14px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; font-size: 24px; -webkit-tap-highlight-color: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.fab:active { transform: scale(.95); }
.fab-badge { position: absolute; top: -6px; right: -6px; min-width: 22px; padding: 2px 6px; border-radius: 11px;
  font-size: 11px; font-weight: 700; background: var(--g); color: #0b260f; white-space: nowrap; }
.scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); }
.panel { position: fixed; z-index: 2147483002; left: 0; right: 0; bottom: 0; height: 88vh; height: 88dvh;
  background: var(--bg); color: var(--text); border-radius: 16px 16px 0 0; border: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,.5); font-size: 14px; line-height: 1.35; }
@media (min-width: 760px) { .panel { left: auto; top: 0; height: 100vh; width: 440px; border-radius: 0; } }
.top { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; border-bottom: 1px solid var(--line); }
.title { flex: 1; font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ib { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; min-width: 36px; height: 36px; font-size: 17px; padding: 0 8px; }
.ib.star.on { color: var(--amber); }
.ib.spinning { animation: sp .8s linear infinite; opacity: .7; }
.body { flex: 1; overflow-y: auto; padding: 12px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 16px 2px 8px; }
.muted { color: var(--muted); } .small { font-size: 12px; } .g { color: var(--g); } .r { color: var(--r); } .a { color: var(--amber); } .acc { color: var(--acc); } .err { color: var(--r); }
.hint { padding: 8px 4px; } .foot { font-size: 11px; margin-top: 18px; text-align: center; }
a { color: var(--acc); }
input, select { font: inherit; font-size: 16px; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; width: 100%; outline: none; }
input:focus, select:focus { border-color: var(--acc); }
input[type=checkbox] { width: 20px; height: 20px; flex: none; padding: 0; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; display: grid; gap: 3px; }
.card .big { font-size: 20px; font-weight: 800; }
.status { gap: 6px; }
.st-row { display: block; text-align: left; }
.link2 { background: none; border: 0; padding: 0; color: var(--text); font-size: 13px; }
.ctx { display: block; width: 100%; margin: 8px 0 0; padding: 10px; border-radius: 12px; border: 1px dashed var(--acc); background: transparent; color: var(--acc); text-align: left; }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--bg2); border: 1px solid var(--line);
  color: var(--text); border-radius: 12px; padding: 8px 10px; }
.row img { width: 42px; height: 30px; object-fit: contain; flex: none; }
.row .nm { flex: 1; min-width: 0; font-weight: 600; }
.row small { display: block; font-weight: 400; font-size: 11px; color: var(--muted); margin-top: 1px; }
.row .rt { text-align: right; flex: none; }
.row .rt b { font-size: 15px; }
.pill { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; vertical-align: middle; }
.pill.good { background: rgba(127,220,111,.15); color: var(--g); } .pill.bad { background: rgba(255,135,135,.15); color: var(--r); }
.pill.even { background: var(--bg3); color: var(--muted); }
.sorts { display: flex; gap: 4px; margin-top: 10px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.seg { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 7px 4px; font-size: 13px; }
.seg.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.filters { display: grid; grid-template-columns: 1.4fr 1fr; gap: 8px; margin-top: 8px; }
.filters.two { grid-template-columns: 1fr 1fr; }
.filters select, .filters input { padding: 7px 8px; font-size: 14px; }
.count { margin: 8px 2px 6px; }
.tog { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.tog.slim { padding: 6px 0; border: 0; font-size: 13px; }
.tog.big { font-size: 15px; }
.tog input.num { width: 90px; margin-left: auto; }
.tog input.num.wide { width: 110px; }
.tog.col { flex-direction: column; align-items: stretch; gap: 3px; }
.tog.col > span { display: flex; align-items: center; gap: 10px; }
.tog .feerow input.num { margin-left: auto; }
.form .blk { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
.ihead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ihead img { width: 60px; height: 44px; object-fit: contain; flex: none; }
.grow { flex: 1; min-width: 0; }
.iname { font-weight: 700; font-size: 17px; }
.plan { border-radius: 12px; padding: 10px; border: 1px solid var(--line); background: var(--bg2); display: grid; gap: 6px; margin-bottom: 10px; }
.plan.go { border-color: rgba(127,220,111,.6); } .plan.wait { border-color: rgba(116,192,252,.6); } .plan.late { border-color: rgba(255,135,135,.5); }
.plan .btn { justify-self: start; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; min-width: 0; }
.stat > span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.stat b { font-size: 17px; margin-right: 4px; }
.stat small { display: block; font-size: 11px; color: var(--muted); }
.mini { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; font-size: 10px; padding: 0 5px; vertical-align: middle; }
.btns { display: flex; flex-wrap: wrap; margin-top: 12px; }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 10px; border: 0;
  background: var(--acc); color: #0b1a26; font-weight: 700; text-decoration: none; font-size: 14px; }
.btn:disabled { opacity: .5; }
.btn.sm { height: 30px; padding: 0 10px; font-size: 13px; }
.btn.ghost { background: var(--bg2); color: var(--text); border: 1px solid var(--line); margin: 0 6px 6px 0; }
.form > .btn.ghost { display: flex; width: 100%; justify-content: space-between; margin: 8px 0 0; }
.link { background: none; border: 0; color: var(--acc); padding: 0; text-decoration: underline; }
.topic { display: flex; align-items: center; gap: 8px; }
.topic code { flex: 1; font-family: ui-monospace, Menlo, monospace; font-size: 15px; background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 8px; word-break: break-all; }
.topic .btn.ghost { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 6px 12px; font-size: 13px; }
.about { display: grid; gap: 6px; justify-items: start; }
.about .btn.ghost { margin: 0; }
.spin { width: 28px; height: 28px; margin: 30px auto; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--acc); animation: sp .8s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ib.spinning, .spin { animation-duration: 3s; } }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483005; background: var(--bg3); color: var(--text);
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line); font-size: 13px; max-width: calc(100vw - 32px); }
.toast.busy { color: var(--acc); border-color: var(--acc); }
.toast.ok { color: var(--g); border-color: var(--g); }
.toast.bad { color: var(--r); border-color: var(--r); }
`;
  }
})();
