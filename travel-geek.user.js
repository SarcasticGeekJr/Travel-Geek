// ==UserScript==
// @name         Travel Geek
// @namespace    https://github.com/SarcasticGeekJr/Travel-Geek
// @version      1.6.2
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

  const VERSION = "1.6.2"; // keep in sync with @version above
  // Only one copy runs per page. If another copy got here first (usually an old one that was pasted in or
  // installed twice), say so, because otherwise updates seem to do nothing.
  if (window.__travelGeekLoaded) {
    const other = window.__travelGeekLoaded;
    if (other !== VERSION && document.body) {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;left:8px;right:8px;bottom:70px;z-index:2147483647;background:#7a1f1f;color:#fff;font:14px/1.4 sans-serif;padding:10px 12px;border-radius:10px;box-shadow:0 4px 16px #0008";
      d.innerHTML = "<b>Travel Geek: two copies are installed.</b> An older copy" + (typeof other === "string" ? " (v" + other + ")" : "") + " is running, so v" + VERSION + " can&rsquo;t. In Torn PDA go to Settings &rarr; Userscripts, delete the old Travel Geek and keep the one with the remote link. <u>Close</u>";
      d.addEventListener("click", () => d.remove());
      document.body.appendChild(d);
    }
    return;
  }
  window.__travelGeekLoaded = VERSION;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
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
  // Other types (contraband, materials…): a busy market (sold in 200+ bazaars, like Xanax or plushies) sells fast,
  // a quiet one (under 80) slowly. Guns and armour stay slow either way.
  const speedOf = (type, sub, bazaars) => {
    const t = String(type || "").toLowerCase();
    if (t === "weapon" && String(sub || "").toLowerCase() === "temporary") return "fast";
    if (FAST.includes(t)) return "fast";
    if (SLOW.includes(t)) return "slow";
    if (bazaars >= 200) return "fast";
    if (bazaars > 0 && bazaars < 80) return "slow";
    return t ? "medium" : "unknown";
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
    types: { leave: true, ready: true, go: true, soldout: true, restock: true, cheap: true, land: true, cash: true },
    // Cash Guard
    cashGuard: true,
    landAlarm: true,
    cashLimit: 1000000,
    flight: null, // { arrive, to } of the current flight
    landedAt: 0,
    landings: [], // recent landing times, to spot mugs right after landing
    alarmFor: 0,
    fab: null,
    // trip planner
    page: "plan", // plan | items
    planHours: 4, // 0 = until planUntil
    planUntil: null, // minutes after midnight, local time
    planStart: null, // null = now, else minutes after midnight, local time
    sellMode: "hold", // hold = don't sell between trips, sell = sell between trips
    prefer: "steady", // steady = best on average, bold = bigger wins (pays more when it works)
    minTrip: 200000, // trips making less than this on average are left out
    pin: null, // plan around this item key
    planOpts: false, // plan options folded open
    tickets: 0, // Business Class Tickets you have
    money: { wallet: true, vault: true, faction: true, stocks: true, points: false, limit: 0, manual: 0 },
    moneyOrder: ["vault", "faction", "stocks", "points"],
    capSeen: {}, // ticket -> { cap, at }, read from the foreign shop
    follow: null, // the plan sent to the helper for alerts
    crowdShare: false, // let other Travel Geek players see (without your name) where and when you land
    crowdWarn: false, // show when others land at the same shop around the same time
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
  S.money = Object.assign({}, DEFAULTS.money, S.money);
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
      lines = [], // every travel-looking perk, shown in Your setup so wrong counts can be fixed
      extra = { flower: 0, plushie: 0 };
    let airstrip = false,
      wlt = false;
    for (const [group, list] of Object.entries(perks || {})) {
      if (!/_perks$/.test(group) || !Array.isArray(list)) continue;
      for (const raw of list) {
        const p = String(typeof raw === "string" ? raw : (raw && (raw.text || raw.description)) || "");
        if (/travel|abroad|suitcase|luggage|airstrip|jet|carry|capacit/i.test(p)) lines.push(`${group.replace(/_perks$/, "")}: ${p.trim()}`);
        if (/airstrip/i.test(p)) airstrip = true;
        if (/private jet/i.test(p)) wlt = true;
        if (!/travel|abroad|suitcase|luggage/i.test(p) || !/item|capacit|carry|suitcase|luggage/i.test(p)) continue;
        const n = +((p.match(/\+\s*(\d+)/) || p.match(/(\d+)/) || [])[1] || 0);
        if (!n) continue;
        if (/flower/i.test(p)) extra.flower += n;
        else if (/plushie/i.test(p)) extra.plushie += n;
        else parts.push({ n, text: p.trim(), group: group.replace(/_perks$/, "") });
      }
    }
    return { parts, extra, airstrip, wlt, lines: lines.slice(0, 30) };
  }
  const METHOD_FROM_API = { standard: "standard", airstrip: "airstrip", private: "wlt", business: "business" };

  let me = store.get("me", null); // { at, name, id, status, travel, perks: {...}, err }
  async function loadMe(force) {
    if (!apiKey()) return null;
    try {
      let d,
        perksOk = true;
      try {
        d = await torn("/user/?selections=basic,perks,travel,money", 2 * MIN, force);
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
        money: Object.assign({}, me && me.money, {
          wallet: +(d.money_onhand ?? (d.money && d.money.wallet) ?? (me && me.money && me.money.wallet) ?? 0),
          vault: +(d.vault_amount ?? (d.money && d.money.vault) ?? (me && me.money && me.money.vault) ?? 0),
          walletAt: d.money_onhand != null ? nowS() : me && me.money && me.money.walletAt,
        }),
      };
      // Your faction balance comes with the money selection too ("faction": { money, points }).
      const fb = d.faction && typeof d.faction === "object" && !("faction_id" in d.faction) ? d.faction : null;
      if (fb && fb.money != null) Object.assign(me.money, { faction: +fb.money || 0, factionOk: true, factionErr: "", factionAt: nowS() });
      store.set("me", me);
      syncSoon(); // capacity or ticket may have changed
    } catch (e) {
      me = Object.assign({}, me || {}, { err: e.message });
    }
    return me;
  }
  // Money in other places: stocks and points from your networth, and your faction balance. Every 5 minutes.
  async function loadMoney(force) {
    if (!apiKey() || !me || (!force && me.money && nowS() - (me.money.otherAt || 0) < 300)) return;
    const m = Object.assign({}, me.money);
    try {
      const d = await torn("/v2/user/personalstats?cat=networth", 4 * MIN, force);
      const find = (o) => (o && typeof o === "object" ? ("stock_market" in o ? o : Object.values(o).map(find).find(Boolean)) : null);
      const nw = find(d);
      if (nw) Object.assign(m, { stocks: +nw.stock_market || 0, pointsValue: +nw.points || 0, vaultNw: +nw.vaults || 0, nwOk: true });
    } catch (e) {
      m.nwErr = e.message;
    }
    // Faction balance: read with your money (see loadMe). Only ask separately if that didn't have it.
    if (!(m.factionAt && nowS() - m.factionAt < 600)) {
      let err = "";
      // Torn API 6.13+: /v2/user/money has { money: { wallet, vault, points, faction, ... } }.
      // Older keys/servers: /v2/user/factionbalance. Accept a number or { money } either way.
      for (const path of ["/v2/user/money", "/v2/user/factionbalance", "/v2/user/?selections=factionbalance"]) {
        try {
          const f = await torn(path, 4 * MIN, force);
          const fm = f.money && typeof f.money === "object" ? f.money.faction : undefined;
          const b = fm !== undefined ? (typeof fm === "number" ? { money: fm } : fm) : f.factionBalance || f.balance || f.faction_balance;
          if (b === null) Object.assign(m, { faction: 0, factionOk: true, factionErr: "" }); // not in a faction
          else if (b && b.money != null) Object.assign(m, { faction: +b.money || 0, factionOk: true, factionErr: "" });
          else continue;
          err = "";
          break;
        } catch (e) {
          err = err || e.message;
        }
      }
      if (err) m.factionErr = err;
    }
    m.otherAt = nowS();
    me.money = m;
    store.set("me", me);
  }
  // Money the planner may use, and where it is. Wallet first; the rest in your chosen order.
  function usableMoney() {
    const m = (me && me.money) || {};
    const pick = S.money;
    const names = { vault: "Vault", faction: "Faction", stocks: "Stocks", points: "Points" };
    const amounts = { vault: m.vault || m.vaultNw || 0, faction: m.faction || 0, stocks: m.stocks || 0, points: m.pointsValue || 0 };
    const sources = S.moneyOrder.filter((k) => pick[k] && amounts[k] > 0).map((k) => ({ key: k, name: names[k], amount: amounts[k] }));
    const wallet = pick.wallet ? m.wallet || 0 : 0;
    let total = wallet + sources.reduce((t, x) => t + x.amount, 0);
    const manual = pick.manual > 0;
    if (manual) total = pick.manual;
    const budget = pick.limit > 0 ? Math.min(total, pick.limit) : total;
    return { wallet, sources: manual ? [] : sources, total, budget, manual, amounts, known: !!(me && me.money && me.money.walletAt) };
  }
  // The Business Class Ticket's market price, so the planner knows what using one costs.
  let ticketValue = store.get("ticketValue", { v: 5500000, at: 0 });
  async function loadTicketValue() {
    if (nowS() - ticketValue.at < 3600) return;
    try {
      const d = await cached(W3B, 10 * MIN);
      const t = (d.items || []).find((i) => /^business class ticket$/i.test(i.item_name || ""));
      const v = t && (t.market_price || t.lowest_price);
      if (v) (ticketValue = { v, at: nowS() }), store.set("ticketValue", ticketValue);
    } catch {}
  }

  // The ticket you fly with: your choice, else the one from your last trip, else the best your perks allow.
  // Automatic: the best ticket your perks allow, or your last trip's if that was better (Business is
  // never assumed, it's a one-off ticket). A last trip flown before you bought an airstrip doesn't count.
  const METHOD_RANK = { standard: 0, airstrip: 1, wlt: 2 };
  function autoMethod() {
    const perk = me && me.cap ? (me.cap.wlt ? "wlt" : me.cap.airstrip ? "airstrip" : "standard") : null;
    const last = me && me.lastMethod && me.lastMethod !== "business" ? me.lastMethod : null;
    if (perk && last) return METHOD_RANK[last] > METHOD_RANK[perk] ? last : perk;
    return perk || last || "standard";
  }
  function myMethod() {
    return S.method !== "auto" ? S.method : autoMethod();
  }
  // Your normal ticket for planning: Business only through the tickets you say you have.
  function planMethod() {
    return S.method !== "auto" && S.method !== "business" ? S.method : autoMethod();
  }
  // World Tourism Day (once a year, around 27 September): capacity is doubled for 48 hours from your own start time.
  const tourismOn = () => !!(me && me.tourism && me.tourism.until > nowS() && me.tourism.from <= nowS());
  const perkCap = (method) => ((BASE_CAP[method] || 10) + ((me && me.cap && me.cap.parts) || []).reduce((t, p) => t + p.n, 0)) * (tourismOn() ? 2 : 1);
  // Torn's calendar lists Tourism Day as one day; each player picks a start time and gets 48 hours from the day
  // before at that time (same reading as other travel tools). Only asked for near the date.
  async function loadTourism(force) {
    const d = new Date(nowS() * 1000);
    if (d.getUTCMonth() !== 8 || d.getUTCDate() < 25 || d.getUTCDate() > 29) return;
    if (!force && me && me.tourism && nowS() - (me.tourism.at || 0) < 3600) return;
    try {
      const cal = await torn("/v2/torn/calendar", 60 * MIN, force);
      const ev = ((cal.calendar && cal.calendar.events) || []).find((e) => /^(world\s+)?tourism day$/i.test(String(e.title || "").trim()));
      let from = 0,
        until = 0;
      if (ev && ev.end > ev.start) {
        from = ev.start;
        until = ev.end;
        if (ev.fixed_start_time !== true) {
          const u = await torn("/v2/user/calendar", 60 * MIN, force);
          const m = /^(\d{1,2}):(\d{2})/.exec(String((u.calendar && u.calendar.start_time) || "").trim());
          if (m) {
            const day = new Date(ev.start * 1000);
            day.setUTCHours(+m[1], +m[2], 0, 0);
            if (ev.end - ev.start <= 86400) {
              from = day.getTime() / 1000 - 86400;
              until = from + 2 * 86400;
            } else {
              const off = day.getTime() / 1000 - ev.start;
              from = ev.start + off;
              until = ev.end + off;
            }
          }
        }
      }
      me.tourism = { at: nowS(), from, until };
      store.set("me", me);
    } catch (e) {
      if (me) me.tourism = Object.assign({}, me.tourism, { at: nowS(), err: e.message });
    }
  }
  // What the foreign shop showed is exact, but only until your perks change (new airstrip, job, faction, book...).
  // Then the count from perks is used until the shop shows the new number.
  function shopCap(method) {
    const seen = S.capSeen && S.capSeen[method];
    if (!seen || !seen.cap) return null;
    if (!(me && me.cap)) return seen;
    const now = perkCap(method);
    if (seen.perks != null ? seen.perks === now : seen.cap >= now) return seen;
    return null;
  }
  // Capacity for a ticket: what the foreign shop showed you beats the count from perks.
  function capFor(method) {
    if (S.capOverride > 0) return S.capOverride;
    const seen = shopCap(method);
    if (seen) return seen.cap;
    return perkCap(method);
  }
  function myCapacity() {
    if (S.capOverride > 0) return { total: S.capOverride, manual: true, parts: [], base: S.capOverride };
    const method = myMethod();
    const seen = shopCap(method);
    if (seen) return { total: seen.cap, seen: true, seenAt: seen.at, parts: [], base: seen.cap, manual: false, known: true };
    const base = BASE_CAP[method] || 10;
    const parts = (me && me.cap && me.cap.parts) || [];
    return { total: perkCap(method), base, parts, manual: false, known: !!(me && me.cap) };
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
        data = { at: nowS(), fromHelper: true, items: d.items || [], updates: d.updates || {}, source: d.source || "", tickAt: d.tickAt, pricesAt: d.pricesAt, crowd: d.crowd || [] };
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
          speed: speedOf(pr.type, null, pr.total_bazaars),
          bz: pr.total_bazaars || 0,
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

  // ==planner== (pure: no page, storage or network; tested on its own)
  // Plans a chain of round trips (Torn → country → Torn, the only way flights work) that makes the most
  // expected profit in a time window, within the money you can use and the slots you can carry.
  const PLAN = (() => {
    const SHOP_TIME = 120; // seconds spent buying before flying home
    // How many one restock brings. The helper sees a restock some time after it lands, when people may
    // have bought some already, so the largest recent one is closer to the truth than the middle one.
    const restockSize = (it) => it.amtMax || Math.max(it.amtTypical || 0, it.amt || 0);
    const FRESH = 45 * 60;
    const BEAM = 30;
    // Standard ticket prices (Torn wiki). Airstrip and the WLT jet fly free; Business uses a ticket.
    const TICKET = { mex: 6500, cay: 10000, can: 9000, haw: 11000, uni: 18000, arg: 21000, swi: 27000, jap: 32000, chi: 35000, uae: 32000, sou: 40000 };

    // Shops cycle: stock sells out, stays empty for a while, restocks, sells out again. Project that forward
    // so trips hours from now still know roughly when each item will be back.
    // Returns { first, cycle, size, perSec, sure, window } or null when there isn't enough history.
    function cycleOf(it, now) {
      const perSec = (it.rate || 0) / 3600;
      const pr = it.pred;
      const emptyFor = it.emptyAvg || (pr && pr.avg) || 0;
      const size = restockSize(it);
      const sure = pr && pr.pct ? pr.pct / 100 : it.emptyN >= 3 ? 0.5 : 0.3;
      const window = pr && pr.to && pr.at ? Math.max(300, pr.to - pr.at) : 900;
      let first = 0;
      if (it.qty > 0) {
        if (!perSec || !emptyFor) return null;
        first = it.updated + it.qty / perSec + emptyFor; // sells out, then usually back after this long
      } else if (pr && pr.at && !pr.overdue && !(pr.to && now > pr.to)) first = pr.at;
      else return null;
      const sellOut = perSec && size ? size / perSec : 0;
      return { first, cycle: sellOut && emptyFor ? sellOut + emptyFor : 0, size, perSec, sure, window };
    }

    // Chance that the item is in stock when we land at time a, and how many should be left.
    // Never waiting abroad means we only count stock that is there when we land.
    function availability(it, a, now) {
      const perSec = (it.rate || 0) / 3600;
      if (it.qty > 0) {
        const stale = now - it.updated > FRESH;
        const left = it.qty - perSec * Math.max(0, a - it.updated);
        if (left >= 1) return { avail: Math.floor(left), p: stale ? 0.6 : 0.95 };
      } else {
        const pr = it.pred;
        if (pr && (pr.overdue || (pr.to && now > pr.to))) return { avail: restockSize(it) || 100, p: 0.2 };
      }
      const c = cycleOf(it, now);
      if (!c) return { avail: 0, p: 0 };
      // Which restock would we land after? The first one, or a later one if the shop keeps cycling.
      let k = 0;
      if (c.cycle && a > c.first + c.cycle) k = Math.floor((a - c.first) / c.cycle);
      const r = c.first + k * c.cycle;
      const spread = c.window * (1 + k); // later restocks are less certain
      // Projected to be empty when we land. For shops that are stocked most of the time that projection
      // is too unsure to rule them out, so count about half a restock at a lower chance.
      if (a < r - spread) return share(c) > 0.5 ? { avail: Math.floor(c.size / 2), p: share(c) * 0.8 } : { avail: 0, p: 0 };
      const frac = Math.min(1, (a - (r - spread)) / (2 * spread));
      const sold = c.perSec * Math.max(0, a - r);
      const avail = c.size ? Math.floor(c.size - sold) : 999; // unknown size: assume enough
      if (avail < 1) return { avail: 0, p: 0 };
      return { avail, p: Math.max(share(c), c.sure * Math.pow(0.8, k) * (0.15 + 0.85 * frac)) };
    }
    // How sure we can be that a shop has the item at a random moment: the part of each cycle it is in stock.
    // Big shops that take hours to sell out are almost always stocked; a restock of 3 that sells out in
    // two minutes almost never is. Capped at 90%, since the cycle itself is an estimate.
    function share(c) {
      const sellOut = c.perSec && c.size ? c.size / c.perSec : 0;
      const empty = c.cycle ? c.cycle - sellOut : 0;
      return sellOut && empty > 0 ? (0.9 * sellOut) / (sellOut + empty) : 0;
    }

    // Best mix to buy in one country: fills the carrying slots, within the budget.
    // Flower/plushie-only slots are filled with those first. Tries two orders and keeps the better.
    function mix(cands, cap, extra, budget) {
      const run = (order) => {
        let slots = cap,
          money = budget;
        const ex = { ...extra };
        const buys = [];
        for (const c of order) {
          const t = String(c.it.type || "").toLowerCase();
          let room = slots + (ex[t] || 0);
          let n = Math.min(c.avail, room, c.it.cost > 0 ? Math.floor(money / c.it.cost) : room);
          if (n <= 0) continue;
          const fromExtra = Math.min(n, ex[t] || 0);
          if (ex[t]) ex[t] -= fromExtra;
          slots -= n - fromExtra;
          money -= n * c.it.cost;
          buys.push({ ...c, units: n });
        }
        const best = buys.reduce((t, b) => t + b.units * b.unit, 0);
        const exp = buys.reduce((t, b) => t + b.units * b.unit * b.p, 0);
        return { buys, best, exp, cash: budget - money };
      };
      const bySlot = [...cands].sort((x, y) => y.unit * y.p - x.unit * x.p);
      const byMoney = [...cands].sort((x, y) => (y.unit * y.p) / y.it.cost - (x.unit * x.p) / x.it.cost);
      const a = run(bySlot),
        b = run(byMoney);
      return b.exp > a.exp ? b : a;
    }

    // One round trip to cc leaving at `depart`.
    function leg(ctx, cc, depart, method, budget, used) {
      const fl = (ctx.flights[cc] && ctx.flights[cc][method]) * 60;
      if (!fl) return null;
      const land = depart + fl;
      const back = land + SHOP_TIME + fl;
      const cands = [];
      for (const it of ctx.byCountry[cc] || []) {
        const unit = Math.floor(it.sell * (1 - ctx.fee / 100)) - it.cost;
        if (!(unit > 0) || !it.cost) continue;
        const { avail, p } = availability(it, land, ctx.now);
        if (avail <= 0 || p <= 0) continue;
        // The same item again: fine when the shop has plenty (our last buy hardly dented it),
        // otherwise only after the shop has had time to sell out and restock.
        if (used.has(it.key)) {
          const c = cycleOf(it, ctx.now);
          const cycled = c && c.cycle && land >= used.get(it.key) + c.cycle * 0.9;
          const plenty = avail >= 200 || (c && share(c) > 0.5);
          if (!cycled && !plenty) continue;
        }
        cands.push({ it, unit, avail, p });
      }
      if (!cands.length) return null;
      const ticket = method === "business" ? ctx.ticketValue : method === "standard" ? TICKET[cc] || 0 : 0;
      const ticketCash = method === "standard" ? TICKET[cc] || 0 : 0;
      const m = mix(cands, ctx.cap(method), ctx.extra, Math.max(0, budget - ticketCash));
      if (!m.buys.length) return null;
      return {
        cc,
        method,
        depart,
        land,
        back,
        buys: m.buys.map((b) => ({ key: b.it.key, id: b.it.id, name: b.it.name, units: b.units, cost: b.it.cost, unit: b.unit, p: b.p, pred: b.it.pred, qty: b.it.qty })),
        cash: m.cash + ticketCash,
        best: m.best - ticket,
        exp: m.exp - ticket,
        ticket,
        sure: m.best > 0 ? m.exp / m.best : 0,
      };
    }

    // Departure times worth trying for a country after time t: now, and the times that land at each
    // projected restock (this one and the following cycles) inside the window.
    function departures(ctx, cc, method, t, end) {
      const fl = ctx.flights[cc][method] * 60;
      const out = new Set([t]);
      const fits = (d) => d >= t && d + 2 * fl + SHOP_TIME <= end;
      for (const it of ctx.byCountry[cc] || []) {
        const c = cycleOf(it, ctx.now);
        if (!c) continue;
        for (let k = 0, r = c.first; r - fl <= end && k < 12; k++, r += c.cycle) {
          const w = c.window * (1 + k);
          for (const f of [0, 0.25, 0.5, 1]) {
            const d = Math.round((r + f * w - fl) / 60) * 60;
            if (fits(d)) out.add(d);
          }
          if (!c.cycle) break;
        }
      }
      return [...out].filter((d) => d + 2 * fl + SHOP_TIME <= end).sort((x, y) => x - y).slice(0, 8);
    }

    function search(ctx, start, end, money, tickets, sellMode, seed) {
      const score = ctx.score || ((s) => s.exp);
      let beam = [seed || { t: start, money, tickets, used: new Map(), legs: [], best: 0, exp: 0 }];
      const done = [];
      for (let depth = 0; depth < 16 && beam.length; depth++) {
        const next = [];
        for (const st of beam) {
          done.push(st);
          for (const cc of Object.keys(ctx.flights)) {
            const methods = [ctx.method];
            if (st.tickets > 0 && ctx.method !== "business") methods.push("business");
            for (const method of methods) {
              for (const d of departures(ctx, cc, method, st.t, end)) {
                const g = leg(ctx, cc, d, method, st.money, st.used);
                if (!g || g.exp <= 0 || (ctx.legOk && !ctx.legOk(g))) continue;
                const used = new Map(st.used);
                g.buys.forEach((b) => used.set(b.key, g.land));
                const sales = g.buys.reduce((t, b) => t + b.units * b.cost, 0) + Math.max(0, g.exp + g.ticket);
                next.push({
                  t: g.back,
                  money: sellMode === "sell" ? st.money - g.cash + sales : st.money - g.cash,
                  tickets: st.tickets - (method === "business" ? 1 : 0),
                  used,
                  legs: [...st.legs, g],
                  best: st.best + g.best,
                  exp: st.exp + g.exp,
                });
              }
            }
          }
        }
        // Keep the plans with the most expected profit, plus some that earn fastest, so short good trips survive.
        const seen = new Set();
        const uniq = next.filter((s) => {
          const k = s.legs.map((g) => g.cc + g.depart).join("|");
          return !seen.has(k) && seen.add(k);
        });
        const byTotal = [...uniq].sort((a, b) => score(b) - score(a)).slice(0, BEAM - 10);
        const byRate = [...uniq].sort((a, b) => score(b) / (b.t - start + 1) - score(a) / (a.t - start + 1)).slice(0, 10);
        beam = [...new Set([...byTotal, ...byRate])];
      }
      done.push(...beam);
      return done.filter((s) => s.legs.length && !(seed && s === seed)).sort((a, b) => score(b) - score(a));
    }
    const sigOf = (p) => (p ? p.legs.map((g) => g.cc + "@" + Math.round(g.depart / 600)).join("|") : "");

    // A plan that must include one item (e.g. "Plan around Xanax"): try its best trips, fill the time before
    // and after with the best other trips.
    function planAround(ctx, input, key) {
      const it = Object.values(ctx.byCountry).flat().find((x) => x.key === key);
      if (!it) return null;
      const score = ctx.score;
      const cands = [];
      const fl = ctx.flights[it.cc][ctx.method] * 60;
      const times = new Set(departures(ctx, it.cc, ctx.method, input.start, input.end));
      for (const w of itemWindows(it, input.start, input.end, fl, ctx.now).slice(0, 3)) for (let d = w.from; d <= w.to; d += 600) times.add(d);
      for (const d of [...times].sort((x, y) => x - y)) {
        const g = leg(ctx, it.cc, d, ctx.method, input.money, new Map());
        if (g && g.buys.some((b) => b.key === key)) cands.push(g);
      }
      // The trip for that item at its best time (most likely to find it), the earliest if equal.
      const val = (g) => g.buys.filter((b) => b.key === key).reduce((t, b) => t + b.units * b.unit * b.p, 0);
      cands.sort((a, b) => val(b) - val(a) || a.depart - b.depart);
      let best = null;
      for (const g of cands.slice(0, 1)) {
        const before = search(ctx, input.start, g.depart, input.money, input.tickets || 0, input.sellMode)[0];
        const legs0 = before ? before.legs : [];
        const used = new Map((before && before.used) || []);
        g.buys.forEach((b) => used.set(b.key, g.land));
        const spent = legs0.reduce((t, x) => t + x.cash, 0) + g.cash;
        const seed = { t: g.back, money: input.money - spent, tickets: input.tickets || 0, used, legs: [...legs0, g], best: legs0.reduce((t, x) => t + x.best, 0) + g.best, exp: legs0.reduce((t, x) => t + x.exp, 0) + g.exp };
        const after = search(ctx, g.back, input.end, seed.money, seed.tickets, input.sellMode, seed)[0] || seed;
        if (!best || score(after) > score(best)) best = after;
      }
      return best;
    }

    // When an item could be bought: leave-time windows in which it should be there when you land.
    // [{ from, to, p, avail }] (leave times), best chance first.
    function itemWindows(it, start, end, flightSec, now) {
      const runs = [];
      let cur = null;
      for (let t = start; t + 2 * flightSec + SHOP_TIME <= end; t += 300) {
        const a = availability(it, t + flightSec, now);
        if (a.p > 0 && a.avail > 0) {
          if (!cur) runs.push((cur = { from: t, to: t, p: a.p }));
          cur.to = t;
          cur.p = Math.max(cur.p, a.p);
        } else cur = null;
      }
      return runs.sort((a, b) => b.p - a.p);
    }

    // input: { now, start, end, items, flights, method, capFor(method), extra, fee, money, tickets, ticketValue, sellMode, filter(it) }
    function make(input) {
      const items = input.items.filter((it) => it.sell > 0 && it.cost > 0 && input.filter(it));
      const byCountry = {};
      for (const it of items) (byCountry[it.cc] = byCountry[it.cc] || []).push(it);
      const ctx = { now: input.now, flights: input.flights, method: input.method, cap: input.capFor, extra: input.extra || {}, fee: input.fee, ticketValue: input.ticketValue || 0, byCountry };
      // Steady: most profit on average. Bigger wins: most profit when it works, as long as it works at least
      // about 1 time in 3. Trips under minLeg (on average) aren't worth the bother.
      const bold = input.prefer === "bold";
      ctx.score = bold ? (s) => s.best : (s) => s.exp;
      ctx.legOk = (g) => g.exp >= (input.minLeg || 0) && (!bold || g.sure >= 0.35);
      const all = search(ctx, input.start, input.end, input.money, input.tickets || 0, input.sellMode);
      let best = all[0] || null;
      // Calmer updates: keep the plan already shown unless the new one is clearly (10%) better.
      let kept = false,
        prevGone = false;
      if (input.keepSig && best && sigOf(best) !== input.keepSig) {
        const prev = all.find((p) => sigOf(p) === input.keepSig);
        if (prev && ctx.score(prev) * 1.1 >= ctx.score(best)) (best = prev), (kept = true);
        else if (!prev) prevGone = true;
      }
      const pinned = input.pin ? planAround(ctx, input, input.pin) : null;
      // Other good plans that start differently, and the most reliable one.
      const alts = [];
      for (const s of all.slice(1)) {
        if (alts.length >= 2) break;
        if (best && s.legs[0].cc === best.legs[0].cc) continue;
        if (alts.some((a) => a.legs[0].cc === s.legs[0].cc)) continue;
        alts.push(s);
      }
      const reliable = all.filter((s) => s.legs.every((g) => g.sure >= 0.7))[0] || null;
      return { best, alts, reliable: reliable && best && reliable !== best ? reliable : null, kept, prevGone, pinned, sig: sigOf(best), score: ctx.score };
    }

    // Where the cash for each trip comes from: wallet first, then the sources in the order given.
    function cashSteps(plan, wallet, sources, sellMode) {
      let w = wallet;
      const left = sources.map((s) => ({ ...s }));
      return plan.legs.map((g) => {
        const take = [];
        const inHand = w;
        let need = Math.max(0, g.cash - w);
        for (const s of left) {
          if (need <= 0) break;
          const n = Math.min(need, s.amount);
          if (n > 0) take.push({ name: s.name, amount: n }), (s.amount -= n), (need -= n), (w += n);
        }
        const step = { inHand, take, short: need };
        w -= Math.min(w, g.cash);
        if (sellMode === "sell") w += g.buys.reduce((t, b) => t + b.units * (b.cost + b.unit), 0);
        return step;
      });
    }

    return { make, cashSteps, availability, mix, restockSize, itemWindows, sigOf, TICKET };
  })();
  // ==/planner==

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
      if (!it.type && t) (it.type = t[0]), (it.speed = speedOf(t[0], t[1], it.bz));
    }
  }

  // Your numbers for one item.
  function personal(it) {
    const cap = myCapacity().total + extraFor(it.type);
    // Sold out: you can only buy what one restock brings (some bring just a handful).
    const restock = PLAN.restockSize(it);
    const units = it.qty > 0 ? Math.min(cap, it.qty) : restock > 0 ? Math.min(cap, restock) : cap;
    const net = Math.floor(it.sell * (1 - (+S.fee || 0) / 100));
    const unit = it.sell ? net - it.cost : 0;
    const flight = flightSec(it.cc);
    const trip = unit * units;
    return { cap, units, restock: it.qty > 0 ? 0 : restock, net, unit, trip, perHour: flight ? Math.round(trip / ((2 * flight) / 3600)) : 0, cash: units * it.cost, flight };
  }

  // The last few predictions next to what really happened, so you can see it learning.
  function trackHtml(it) {
    const tr = (it.track || []).slice(-4).reverse();
    if (!tr.length) return "";
    const one = ([p, a, h]) => {
      const d = Math.round((a - p) / 60);
      const off = h ? "probably came, sold out before anyone saw it" : Math.abs(d) <= 1 ? "on time" : `${Math.abs(d)}m ${d > 0 ? "late" : "early"}`;
      return `${clock(p)} → ${h ? clock(p) : clock(a)} <span class="${h || Math.abs(d) <= 10 ? "g" : "r"}">(${off})</span>`;
    };
    return `<div class="muted small">Last predictions: ${tr.map(one).join(" · ")}</div>`;
  }
  // Big shops that never sell out get topped up; say how often.
  const topLine = (it) => (it.topEvery ? `<div class="muted">Topped up about every ${dur(it.topEvery)}${it.lastTop ? ` · last ${clock(it.lastTop)}` : ""}.</div>` : "");

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
    // Window over and still empty: say so now (the helper only flags it as overdue 15 minutes later).
    if (pr.overdue || (pr.to && t > pr.to)) {
      const size = PLAN.restockSize(it);
      const sellOut = it.rate > 0 && size ? (size / it.rate) * 3600 : Infinity;
      const so = it.emptySince ? ` Empty for ${dur(t - it.emptySince)}, usually ${dur(it.emptyAvg || pr.avg || 0)}.` : "";
      if (sellOut < 30 * 60) {
        // A small restock sells out in minutes, so it may already have come and gone between two looks.
        // Then the next one is about one usual cycle after the expected time: give that as a guess.
        const cyc = sellOut + (it.emptyAvg || pr.avg || 0);
        const unseen = sellOut < 15 * 60 ? ` A restock of ~${num(size)} can sell out between checks, so it may have come and gone unseen.` : "";
        let next = pr.at + cyc;
        while (next - 120 - fl <= t && cyc > 0) next += cyc;
        const nLand = next - 120,
          nLeave = nLand - fl;
        if (cyc > 0 && nLeave - t < 4 * 3600)
          return { kind: "wait", text: `Restock is late: expected ~${clock(pr.at)}.${unseen || so} Next one is a guess, ~${clock(next)}: leave at ${clock(nLeave)} (in ${dur(nLeave - t)}) → land ${clock(nLand)}.`, leaveAt: nLeave, land: nLand };
        return { kind: "late", text: `Restock is late: expected ~${clock(pr.at)}, still empty.${so}${unseen}` };
      }
      return { kind: "go", text: `Restock is late: expected ~${clock(pr.at)}, still empty.${so} It should be back by the time you land: leave now → land ${clock(t + fl)}.`, land: t + fl };
    }
    const land = pr.at - 120;
    const leaveAt = land - fl;
    if (leaveAt <= t) {
      // Landing after the restock only works if the stock lasts that long. A big restock lasts hours;
      // a restock of 3 selling ~100 an hour is gone in about 2 minutes.
      const size = PLAN.restockSize(it);
      const sellOut = it.rate > 0 && size ? (size / it.rate) * 3600 : Infinity;
      const lasts = pr.at + Math.max(sellOut, 10 * 60);
      if (t + fl < pr.to && t + fl <= lasts) return { kind: "go", text: `Leave now → land ${clock(t + fl)}. Restock expected ~${clock(pr.at)}.`, land: t + fl };
      const why = isFinite(sellOut) ? ` A restock brings ~${num(size)} and they sell out in about ${dur(Math.max(60, sellOut))}.` : "";
      // The restock after that: sell-out time plus how long it usually stays empty. Less sure, so said as a guess.
      const empty = it.emptyAvg || pr.avg || 0;
      if (isFinite(sellOut) && empty) {
        const next = pr.at + sellOut + empty;
        const nLand = next - 120,
          nLeave = nLand - fl;
        if (nLeave > t)
          return { kind: "wait", text: `Too late for the restock ~${clock(pr.at)}: you'd land ${clock(t + fl)}.${why} Next one is a guess, ~${clock(next)}: leave at ${clock(nLeave)} (in ${dur(nLeave - t)}) → land ${clock(nLand)}.`, leaveAt: nLeave, land: nLand };
      }
      return { kind: "late", text: `Too late for this restock (expected ~${clock(pr.at)}).${why}` };
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
      crowdShare: S.crowdShare,
      crowdWarn: S.crowdWarn,
      cashLimit: S.cashLimit,
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
      syncState = { at: nowS(), ok: true, name: r.name, sig, last: r.last || [], loc: r.loc, h: r.h };
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
    <div class="toast" hidden></div>
    <div class="guard" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  const view = { name: "home", key: "", stack: [], loading: false, err: null };
  const isOpen = () => !$(".panel").hidden;
  function open() {
    $(".guard").hidden = true;
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
    $(".title").textContent = { settings: "Settings", alerts: "Phone alerts", setup: "Your setup", money: "Money I can use", accuracy: "How accurate?", guard: "🛡 Cash Guard" }[view.name] || (it ? it.name : "Travel Geek");
    ({ home: renderHome, item: renderItem, settings: renderSettings, alerts: renderAlerts, setup: renderSetup, money: renderMoney, accuracy: renderAccuracy, guard: renderGuard })[view.name]();
  }
  const findItem = (key) => data && data.items.find((i) => i.key === key);

  let refreshing = false;
  async function refresh(force) {
    if (refreshing) return;
    refreshing = true;
    $("[data-act=refresh]").classList.add("spinning");
    view.err = null;
    try {
      await Promise.all([loadData(force), loadMe(force).then(() => loadTourism(force)), loadTypes(), loadTicketValue()]);
      await loadMoney(force);
      labelTypes();
      runPlan();
    } catch (e) {
      view.err = e.message;
    }
    refreshing = false;
    $("[data-act=refresh]").classList.remove("spinning");
    if (isOpen() && ["home", "item"].includes(view.name)) render();
    updateBadge();
    guardTick();
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
      ${S.cashGuard && me && me.money && me.money.wallet >= (S.cashLimit || 0) && me.money.wallet ? `<button class="st-row link2" data-act="guard"><span class="r">💰 ${short(me.money.wallet)} on hand</span> · 🛡 Cash Guard ›</button>` : ""}
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
    return S.page === "items" ? renderItems() : renderPlan();
  }
  function renderItems() {
    const list = data ? rows().slice(0, 80) : [];
    const loc = myLoc();
    const tabs = [
      ["now", "In stock"],
      ["soon", "Coming back"],
      ["all", "All"],
    ];
    body().innerHTML = `
      ${statusCard()}
      ${navTabs()}
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
      <div class="list">${list.length ? list.map(row).join("") : data ? `<p class="muted hint">${S.tab === "soon" ? "Nothing empty right now. " : ""}Nothing here with your filters. Try &ldquo;All&rdquo;, another country, or turn off &ldquo;sell fast&rdquo;.</p>` : `<div class="spin"></div>`}</div>
      <p class="foot muted">Profit = (sell price − ${+S.fee || 0}% fee − cost) × what you can carry. Sell price is the lower of market value and the cheapest bazaar. Stock comes from players visiting shops, so it can be a few minutes old.<br>Travel Geek v${VERSION}</p>`;
    $(".f-country").addEventListener("change", (e) => {
      S.country = e.target.value;
      save();
      renderItems();
    });
    $(".f-sort").addEventListener("change", (e) => {
      S.sort = e.target.value;
      save();
      renderItems();
    });
    $(".f-fast").addEventListener("change", (e) => {
      S.fastOnly = e.target.checked;
      save();
      planOut = null;
      renderItems();
      syncSoon();
    });
  }

  const SPEED = { fast: `<span class="pill good">sells fast</span>`, slow: `<span class="pill bad">sells slowly</span>`, medium: `<span class="pill even">sells OK</span>`, unknown: "" };
  function row({ it, p, pl, watched }) {
    const c = COUNTRIES[it.cc];
    const stock = it.qty > 0 ? `${num(it.qty)} in stock · ${ago(it.updated)} ago` : `<span class="a">Empty</span>${it.pred && it.pred.at && !it.pred.overdue && !(it.pred.to && nowS() > it.pred.to) ? ` · back ~${clock(it.pred.at)} (${it.pred.pct != null ? it.pred.pct + "%" : CONF[it.pred.conf].toLowerCase()})` : it.pred && it.pred.at ? " · late" : ""}`;
    const tag = pl.kind === "go" ? `<span class="g">Go now</span>` : pl.kind === "wait" ? `<span class="acc">Leave ${clock(pl.leaveAt)}</span>` : pl.kind === "late" ? `<span class="r">Too late</span>` : "";
    return `<button class="row" data-act="item" data-key="${it.key}">
      <img src="${img(it.id)}" alt="" loading="lazy">
      <span class="nm">${watched ? "⭐ " : ""}${esc(it.name)}<small>${c.flag} ${esc(c.name)} · ${stock}</small><small>${SPEED[it.speed] || ""} ${tag}</small></span>
      <span class="rt"><b class="${p.trip > 0 ? "g" : "r"}">${short(p.trip)}</b><small>${short(p.perHour)}/hr</small></span>
    </button>`;
  }

  // ---------------------------------------------------------------- trip planner screen
  const todayAt = (mins) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) + mins * 60;
  };
  const timeVal = (mins) => (mins == null ? "" : hm(mins));
  // When planning can start (you may be abroad or flying) and when it has to end.
  function planWindow() {
    const now = nowS();
    const loc = myLoc() || { where: "torn" };
    let t0 = now,
      note = "";
    const name = (cc) => (cc && COUNTRIES[cc] ? COUNTRIES[cc].name : "abroad");
    if (loc.where === "flying" && loc.arrive) {
      t0 = loc.arrive + 120 + flightSec(loc.cc, (me && me.lastMethod) || planMethod());
      note = `Starts when you're back from ${name(loc.cc)} (~${clock(t0)}).`;
    } else if (loc.where === "abroad") {
      t0 = now + 120 + flightSec(loc.cc, planMethod());
      note = `Starts when you're back from ${name(loc.cc)} (~${clock(t0)}).`;
    } else if (loc.where === "returning" && loc.arrive) {
      t0 = loc.arrive;
      note = `Starts when you land in Torn (${clock(t0)}).`;
    } else if (["hospital", "jail", "federal"].includes(loc.where) && loc.until > now) {
      t0 = loc.until;
      note = `Starts when you're out of ${loc.where} (${clock(t0)}).`;
    }
    let start = t0;
    if (S.planStart != null) {
      let at = todayAt(S.planStart);
      if (at < now - 300) at += 86400;
      start = Math.max(t0, at);
    }
    let end = start + (S.planHours || 4) * 3600;
    if (!S.planHours && S.planUntil != null) {
      end = todayAt(S.planUntil);
      while (end <= start) end += 86400;
    }
    return { start, end, note };
  }

  let planOut = null,
    planPrev = "",
    planChanged = "";
  const planFilter = (it) => !S.hidden.includes(it.key) && (S.watch.includes(it.key) || !S.fastOnly || it.speed === "fast");
  function runPlan() {
    if (!data || !data.items) return (planOut = null);
    const w = planWindow();
    const money = usableMoney();
    const unknownMoney = !money.manual && !money.known;
    const budget = unknownMoney ? 1e12 : money.budget;
    const flights = Object.fromEntries(Object.entries(COUNTRIES).map(([cc, c]) => [cc, c.min]));
    const input = {
      now: nowS(),
      start: w.start,
      end: w.end,
      items: data.items,
      flights,
      method: planMethod(),
      capFor,
      extra: { flower: extraFor("flower"), plushie: extraFor("plushie") },
      fee: +S.fee || 0,
      money: budget,
      tickets: +S.tickets || 0,
      ticketValue: ticketValue.v,
      sellMode: S.sellMode,
      filter: planFilter,
      prefer: S.prefer,
      minLeg: +S.minTrip || 0,
      keepSig: planPrev || null,
      pin: S.pin || null,
    };
    const out = PLAN.make(input);
    out.window = w;
    out.money = money;
    out.unknownMoney = unknownMoney;
    out.at = nowS();
    if (out.best) out.steps = PLAN.cashSteps(out.best, money.manual ? budget : money.wallet, money.sources, S.sellMode);
    if (out.best && !unknownMoney) {
      const rich = PLAN.make({ ...input, money: 1e12 }).best;
      if (rich && rich.exp > out.best.exp * 1.05 + 250000) {
        const need = S.sellMode === "sell" ? Math.max(...rich.legs.map((g) => g.cash)) : rich.legs.reduce((t, g) => t + g.cash, 0);
        out.richer = { more: rich.exp - out.best.exp, need };
      }
    }
    // Calmer updates: the plan only changes when the new one is clearly better or the old one stopped working.
    const g = out.best && out.best.legs[0];
    if (planPrev && out.sig && out.sig !== planPrev && g) {
      planChanged = out.prevGone
        ? `Plan changed: the earlier plan no longer works (new stock or restock data). Next is now ${COUNTRIES[g.cc].name} at ${clock(g.depart)}.`
        : `Plan changed: a plan starting with ${COUNTRIES[g.cc].name} at ${clock(g.depart)} is now at least 10% better.`;
    }
    planPrev = out.sig;
    return (planOut = out);
  }

  const cdText = (ts) => {
    const d = ts - nowS();
    if (d <= -300) return "";
    if (d <= 0) return "now!";
    const h = Math.floor(d / 3600),
      m = Math.floor((d % 3600) / 60),
      s = d % 60;
    return "in " + (h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`);
  };
  // Other sharing players landing in the same country within 10 minutes of this trip (never yourself).
  function crowdFor(g) {
    if (!S.crowdWarn || !data || !data.crowd) return 0;
    let list = data.crowd.filter((x) => x.cc === g.cc && Math.abs(x.land - g.land) <= 600 && !(syncState && x.h === syncState.h));
    // Your own followed trip is in the list too if you share; drop it even after the daily id changes.
    if (S.crowdShare && S.follow && S.follow.legs.some((f) => f.cc === g.cc && Math.abs(f.depart - g.depart) < 90)) {
      const i = list.findIndex((x) => Math.abs(x.land - g.land) < 90);
      if (i >= 0) list = list.filter((_, j) => j !== i);
    }
    return list.length;
  }
  const buyText = (g) => g.buys.map((b) => `${b.units} × ${b.name}`).join(" + ");
  function legHtml(g, i, step) {
    const c = COUNTRIES[g.cc];
    const lines = g.buys
      .map((b) => {
        // Stock now or the next restock only mean something for trips landing soon after them.
        const soon = g.land - nowS() < 90 * 60;
        const nearRestock = b.pred && b.pred.at && Math.abs(g.land - b.pred.at) < 90 * 60;
        const when = b.qty > 0 && soon ? `in stock (${num(b.qty)})` : nearRestock ? `restock ~${clock(b.pred.at)}` : b.qty > 0 || !soon ? "should be in stock then" : "restock expected";
        return `<div class="buy"><b>${b.units} × ${esc(b.name)}</b> <span class="muted">· ${when} · ${chanceWord(b.p)}</span></div>`;
      })
      .join("");
    const moneyLine = moneyLineOf(step);
    return `<div class="leg">
      <div class="leg-h"><span class="n">${i + 1}</span> ${c.flag} <b>${esc(c.name)}</b> · leave <b>${clock(g.depart)}</b> → land ${clock(g.land)} <span class="cd" data-cd="${g.depart}">${cdText(g.depart)}</span></div>
      <div class="muted small">Back in Torn ${clock(g.back)} · ${esc(METHOD_LABEL[g.method])}${g.method === "business" ? ` (uses 1 ticket, worth ${short(g.ticket)})` : ""}</div>
      ${lines}
      <div class="small">Take <b>${short(g.cash)}</b> · likely <b class="g">+${short(g.exp)}</b> <span class="muted">(up to +${short(g.best)})</span></div>
      ${moneyLine}
      ${crowdLine(g)}
    </div>`;
  }
  // Where the cash for a trip comes from, when the wallet isn't enough.
  function moneyLineOf(step) {
    if (!step) return "";
    if (step.short > 0) return `<div class="r small">Short by ${short(step.short)} for this trip.</div>`;
    if (!step.take.length) return "";
    return `<div class="a small">${step.inHand > 0 ? `You'll have ${short(step.inHand)} in hand → get` : "Get"} ${short(step.take.reduce((t, x) => t + x.amount, 0))} first: ${step.take.map((x) => `${x.name} ${short(x.amount)}`).join(", ")}</div>`;
  }
  function crowdLine(g) {
    const n = crowdFor(g);
    if (!n) return "";
    const tight = g.buys.some((b) => {
      const it = findItem(b.key);
      const size = it ? (it.qty > 0 ? it.qty : PLAN.restockSize(it)) : 0;
      return size && size < (n + 1) * b.units;
    });
    return `<div class="a small">⚠️ ${n} other Travel Geek player${n > 1 ? "s" : ""} land in ${esc(COUNTRIES[g.cc].name)} within 10 min of you.${tight ? " There may not be enough stock for everyone." : ""}</div>`;
  }
  function planSummary(p, label) {
    const back = p.legs[p.legs.length - 1].back;
    return `<b>${label}</b> · likely <b class="g">+${short(p.exp)}</b> <span class="muted">(up to +${short(p.best)})</span> · ${p.legs.length} trip${p.legs.length > 1 ? "s" : ""} · back ${clock(back)}`;
  }
  // Chances in words: easier to read than a percent.
  const chanceWord = (p) => (p >= 0.8 ? `<span class="g">very likely</span>` : p >= 0.6 ? "likely" : p >= 0.4 ? `<span class="a">coin flip</span>` : `<span class="r">long shot</span>`);
  // The plan on screen: the one built around a chosen item, or the best one.
  const shownPlan = () => (planOut ? (S.pin && planOut.pinned) || planOut.best : null);
  // Free time between trips (or until the end), so gaps aren't filled with tiny trips.
  function freeLine(from, to) {
    return to - from >= 30 * 60 ? `<div class="free muted small">☕ Free ${clock(from)} – ${clock(to)} · nothing worth ${short(+S.minTrip || 0)}+ fits</div>` : "";
  }
  // "Why not …?" for the item that pays most per trip but isn't in the plan.
  function whyNot(p, w) {
    if (!data || !p) return "";
    const inPlan = new Set(p.legs.flatMap((g) => g.buys.map((b) => b.key)));
    const method = planMethod();
    const cands = data.items
      .filter((it) => planFilter(it) && !inPlan.has(it.key) && it.sell > it.cost)
      .map((it) => ({ it, pt: personal(it) }))
      .filter((x) => x.pt.trip > p.legs[0].best && 2 * flightSec(x.it.cc, method) <= w.end - w.start)
      .sort((a, b) => b.pt.trip - a.pt.trip);
    if (!cands.length) return "";
    // Of the big earners, explain the one that comes closest on average (it has a real chance in your time).
    const scored = cands.slice(0, 6).map((c) => {
      const wins = PLAN.itemWindows(c.it, w.start, w.end, flightSec(c.it.cc, method), nowS());
      return { ...c, wins, avg: wins[0] ? c.pt.trip * wins[0].p : 0 };
    });
    const x = scored.filter((c) => c.avg > 0).sort((a, b) => b.avg - a.avg)[0] || scored[0];
    const fl = flightSec(x.it.cc, method);
    const wins = x.wins;
    const top = wins[0];
    const avg = x.avg;
    const first = p.legs[0];
    const name = `${esc(x.it.name)} (${esc(COUNTRIES[x.it.cc].name)})`;
    const body = top
      ? `${name} pays <b>${short(x.pt.trip)}</b> a trip when it's there, but it's often sold out when you'd land. Best chance in your time: leave <b>${clock(top.from)}–${clock(top.to)}</b> → land ${clock(top.from + fl)}–${clock(top.to + fl)} (${chanceWord(top.p)}).${wins[1] ? ` Also ${clock(wins[1].from)}–${clock(wins[1].to)}.` : ""}<br>On average about <b>${short(avg)}</b>, against <b>${short(first.exp)}</b> for ${esc(COUNTRIES[first.cc].name)}.`
      : `${name} pays <b>${short(x.pt.trip)}</b> a trip when it's there, but it shouldn't be in stock at any landing time in your window.`;
    return `<details class="why"><summary>Why not ${name}?</summary><div class="small">${body}</div>${top ? `<button class="btn ghost sm" data-act="pin" data-k="${esc(x.it.key)}">Plan around ${esc(x.it.name)}</button>` : ""}</details>`;
  }

  function renderPlan() {
    if (!planOut || nowS() - (planOut.at || 0) > 60) runPlan();
    const o = planOut;
    const m = usableMoney();
    const hoursOpts = [1, 2, 4, 6, 8, 12, 24].map((h) => `<option value="${h}" ${S.planHours === h ? "selected" : ""}>${h === 24 ? "24 hours (whole day)" : h + " hour" + (h > 1 ? "s" : "")}</option>`).join("");
    const moneyTxt = m.manual
      ? `<b>${short(m.total)}</b> ✏️<small class="muted">your own number</small>`
      : !m.known
        ? `<span class="a">unknown: add your API key</span> ✏️`
        : `<b>${short(m.budget)}</b> ✏️<small class="muted">${[m.wallet ? `wallet ${short(m.wallet)}` : "", ...m.sources.map((x) => `${x.name.toLowerCase()} ${short(x.amount)}`)].filter(Boolean).join(" · ")}</small>`;
    let res = "";
    const b = shownPlan();
    if (!data) res = `<div class="spin"></div>`;
    else if (!o || !b)
      res = `<div class="card next"><div class="next-h">${o && o.window && o.window.note ? esc(o.window.note) + " " : ""}Nothing worth ${short(+S.minTrip || 0)}+ fits ${o && o.window ? `between ${clock(o.window.start)} and ${clock(o.window.end)}` : "right now"}.</div><div class="muted small">☕ Free until ${o && o.window ? clock(o.window.end) : "later"}. For more choices: play longer, lower &ldquo;Skip trips under&rdquo; in Plan options, or switch Prefer.</div>${S.pin ? `<button class="link small" data-act="pin" data-k="">Back to the best plan</button>` : ""}</div>`;
    else {
      const g0 = b.legs[0];
      const c0 = COUNTRIES[g0.cc];
      const cashAll = S.sellMode === "sell" ? Math.max(...b.legs.map((g) => g.cash)) : b.legs.reduce((t, g) => t + g.cash, 0);
      const following = S.follow && S.follow.sig === b.legs.map((g) => g.cc + g.depart).join("|");
      const steps = b === o.best ? o.steps : PLAN.cashSteps(b, m.manual ? m.budget : m.wallet, m.sources, S.sellMode);
      const step0 = steps && steps[0];
      const pinItem = S.pin && findItem(S.pin);
      // Full day: every trip, with free time between them shown instead of tiny filler trips.
      let day = "";
      b.legs.forEach((g, i) => {
        if (i) day += freeLine(b.legs[i - 1].back, g.depart);
        day += legHtml(g, i, steps && steps[i]);
      });
      day += freeLine(b.legs[b.legs.length - 1].back, o.window.end);
      res = `
        ${planChanged ? `<div class="card changed small">🔄 ${esc(planChanged)}</div>` : ""}
        <div class="card next">
          ${pinItem ? `<div class="pinbar small">📌 Planned around ${esc(pinItem.name)}${o.best ? ` · best plan: likely +${short(o.best.exp)}` : ""} · <button class="link" data-act="pin" data-k="">back to best plan</button></div>` : ""}
          <div class="next-k">NEXT</div>
          <div class="next-h">leave <b>${clock(g0.depart)}</b> <span class="cd" data-cd="${g0.depart}">${cdText(g0.depart)}</span> → ${c0.flag} <b>${esc(c0.name)}</b> · land ${clock(g0.land)}</div>
          <div>Buy <b>${esc(buyText(g0))}</b> · take <b>${short(g0.cash)}</b></div>
          <div>Likely <b class="g">+${short(g0.exp)}</b> <span class="muted">(up to +${short(g0.best)})</span> · ${chanceWord(g0.sure)} · back ${clock(g0.back)}</div>
          ${moneyLineOf(step0)}
          ${crowdLine(g0)}
          <div class="btns">${canRemind() ? `<button class="btn" data-act="planRemind">⏰ Remind me</button>` : ""}${
            S.alertsOn && helperUrl()
              ? following
                ? `<button class="btn ghost" data-act="planUnfollow">🔔 Following ✓ · stop</button>`
                : `<button class="btn ghost" data-act="planFollow">🔔 Follow this plan</button>`
              : ""
          }</div>
        </div>
        ${S.pin ? "" : whyNot(b, o.window)}
        <details class="full" ${S.planFull ? "open" : ""}><summary>See full day · ${b.legs.length} trip${b.legs.length > 1 ? "s" : ""} · likely <b class="g">+${short(b.exp)}</b> <span class="muted">(up to +${short(b.best)})</span> · back ${clock(b.legs[b.legs.length - 1].back)}</summary>
          <div class="small muted">Cash needed: ${short(cashAll)} ${S.sellMode === "sell" ? "(biggest single trip, selling in between)" : "(all trips, not selling in between)"}${o.window.note ? ` · ${esc(o.window.note)}` : ""}</div>
          ${day}
          ${o.richer ? `<div class="small">💰 With ${short(o.richer.need)} you'd make about <b>+${short(o.richer.more)}</b> more.</div>` : ""}
          ${o.alts.length || (o.reliable && o.reliable !== b) ? `<h3>Other plans</h3>` : ""}
          ${o.reliable && o.reliable !== b ? `<details class="alt"><summary>${planSummary(o.reliable, "Most reliable")}</summary>${o.reliable.legs.map((g, i) => legHtml(g, i)).join("")}</details>` : ""}
          ${o.alts.map((a) => `<details class="alt"><summary>${planSummary(a, `Starts with ${COUNTRIES[a.legs[0].cc].name}`)}</summary>${a.legs.map((g, i) => legHtml(g, i)).join("")}</details>`).join("")}
        </details>`;
    }
    const optsLine = [m.known || m.manual ? short(m.budget) : "money ?", `${capFor(planMethod())} items`, METHOD_LABEL[planMethod()], `skip under ${short(+S.minTrip || 0)}`].join(" · ");
    body().innerHTML = `
      ${statusCard()}
      ${navTabs()}
      ${res}
      <div class="card controls">
        <div class="ctl"><span>I can leave from</span>
          <select class="p-start"><option value="now" ${S.planStart == null ? "selected" : ""}>Now</option><option value="at" ${S.planStart != null ? "selected" : ""}>A time…</option></select>
          <input class="p-start-at" type="time" value="${timeVal(S.planStart)}" ${S.planStart == null ? "hidden" : ""}>
        </div>
        <div class="ctl"><span>Play for</span>
          <select class="p-hours">${hoursOpts}<option value="0" ${!S.planHours ? "selected" : ""}>Until a time…</option></select>
          <input class="p-until" type="time" value="${timeVal(S.planUntil)}" ${S.planHours ? "hidden" : ""}>
        </div>
        <div class="ctl"><span>Prefer</span>
          <div class="sorts slim">${[
            ["steady", "Steady"],
            ["bold", "Bigger wins"],
          ]
            .map(([k, t]) => `<button class="seg ${(S.prefer || "steady") === k ? "on" : ""}" data-act="prefer" data-k="${k}">${t}</button>`)
            .join("")}</div>
        </div>
        <div class="muted small">${S.prefer === "bold" ? "Bigger wins: trips that pay most when they work (at least about 1 in 3)." : "Steady: the most money on average."}</div>
        <details class="opts" ${S.planOpts ? "open" : ""}><summary>⚙ Plan options · ${esc(optsLine)}</summary>
          <div class="ctl"><span>I carry</span><button class="link2" data-act="setup">${capFor(planMethod())} items${extraFor("flower") ? ` +${extraFor("flower")} flowers` : ""}${extraFor("plushie") ? ` +${extraFor("plushie")} plushies` : ""} · ${esc(METHOD_LABEL[planMethod()])}${tourismOn() ? " · Tourism Day ×2" : ""} ✏️</button></div>
          <div class="ctl"><span>Money I can use</span><button class="link2 money" data-act="money">${moneyTxt}</button></div>
          <div class="ctl"><span>Between trips</span>
            <div class="sorts slim">${[
              ["hold", "Don't sell"],
              ["sell", "Sell"],
            ]
              .map(([k, t]) => `<button class="seg ${S.sellMode === k ? "on" : ""}" data-act="sellMode" data-k="${k}">${t}</button>`)
              .join("")}</div>
          </div>
          <div class="ctl"><span>Business tickets I have</span><input class="num p-tickets" type="number" min="0" max="50" inputmode="numeric" value="${+S.tickets || 0}"></div>
          <div class="ctl"><span>Skip trips under</span><select class="p-min">${[0, 100000, 200000, 500000, 1000000].map((v) => `<option value="${v}" ${(+S.minTrip || 0) === v ? "selected" : ""}>${v ? short(v) : "Don't skip"}</option>`).join("")}</select></div>
        </details>
      </div>
      <p class="foot muted">Plans are round trips (Torn → country → Torn) that land at a restock instead of waiting abroad. &ldquo;Likely&rdquo; counts how often predictions have really been right. <button class="link small" data-act="accuracy">How accurate are predictions?</button><br>Travel Geek v${VERSION}</p>`;
    for (const [sel, key] of [[".full", "planFull"], [".opts", "planOpts"]]) {
      const d = $(sel);
      if (d) d.addEventListener("toggle", () => ((S[key] = d.open), save()));
    }
    const pm = $(".p-min");
    if (pm)
      pm.addEventListener("change", (e) => {
        S.minTrip = +e.target.value || 0;
        planPrev = "";
        planChanged = "";
        save();
        runPlan();
        renderPlan();
      });
    const re = () => {
      save();
      planPrev = "";
      planChanged = "";
      runPlan();
      renderPlan();
    };
    $(".p-start").addEventListener("change", (e) => {
      if (e.target.value === "now") (S.planStart = null), re();
      else {
        const d = new Date(Date.now() + 30 * MIN);
        S.planStart = d.getHours() * 60 + Math.floor(d.getMinutes() / 5) * 5;
        re();
      }
    });
    $(".p-start-at").addEventListener("change", (e) => {
      const v = parseHm(e.target.value);
      if (v != null) (S.planStart = v), re();
    });
    $(".p-hours").addEventListener("change", (e) => {
      S.planHours = +e.target.value;
      if (!S.planHours && S.planUntil == null) {
        const d = new Date(Date.now() + 4 * 3600 * 1000);
        S.planUntil = d.getHours() * 60;
      }
      re();
    });
    $(".p-until").addEventListener("change", (e) => {
      const v = parseHm(e.target.value);
      if (v != null) (S.planUntil = v), re();
    });
    $(".p-tickets").addEventListener("change", (e) => {
      S.tickets = Math.max(0, parseInt(e.target.value) || 0);
      re();
    });
  }
  function navTabs() {
    return `<div class="sorts nav">${[
      ["plan", "🧭 Trip planner"],
      ["items", "📋 All items"],
    ]
      .map(([k, t]) => `<button class="seg ${S.page === k ? "on" : ""}" data-act="page" data-k="${k}">${t}</button>`)
      .join("")}</div>`;
  }
  // Countdowns tick every second without redrawing the screen.
  function tickCountdowns() {
    if (!isOpen()) return;
    $$("[data-cd]").forEach((el) => (el.textContent = cdText(+el.dataset.cd)));
  }

  // ---------------------------------------------------------------- money screen
  function renderMoney() {
    const m = usableMoney();
    const mm = (me && me.money) || {};
    const row = (k, label, amount, note) =>
      `<label class="tog"><input type="checkbox" data-mk="${k}" ${S.money[k] ? "checked" : ""}><span><b>${label}</b> ${amount != null ? short(amount) : "—"}${note ? `<small class="muted">${note}</small>` : ""}</span></label>`;
    body().innerHTML = `
      <div class="form">
        <div class="card"><div class="big">${m.manual ? short(m.total) : m.known ? short(m.budget) : "—"}</div><div class="small muted">money the planner may use${m.manual ? " (your own number)" : ""}</div></div>
        <h3>Count money from</h3>
        ${row("wallet", "Wallet", mm.wallet, "Cash in hand right now.")}
        ${row("vault", "Vault", mm.vault || mm.vaultNw, "Withdraw any time.")}
        ${row("faction", "Faction", mm.factionOk ? mm.faction : null, mm.factionErr ? "Couldn't read: " + esc(mm.factionErr) : "Untick if only leaders can hand it out in your faction.")}
        ${row("stocks", "Stocks", mm.nwOk ? mm.stocks : null, mm.nwErr ? "Couldn't read: " + esc(mm.nwErr) : "Sells instantly (small fee). From your networth, which Torn may update with a delay.")}
        ${row("points", "Points", mm.nwOk ? mm.pointsValue : null, "Only if you'll sell points first.")}
        <p class="muted small">Not counted: city bank (locked until the term ends), Cayman bank (only usable in Cayman), items and property.</p>
        <h3>Get money from (in order)</h3>
        <div class="chips">${S.moneyOrder.map((k, i) => `<button class="chip" data-act="moneyUp" data-k="${k}">${i + 1}. ${{ vault: "Vault", faction: "Faction", stocks: "Stocks", points: "Points" }[k]}${i ? " ↑" : ""}</button>`).join("")}</div>
        <p class="muted small">Tap one to move it up. Plans tell you where to take cash from before each trip, in this order. It never moves money for you.</p>
        <h3>Limits</h3>
        <label class="tog">Don't spend more than<input class="num wide" data-mm="limit" inputmode="decimal" placeholder="no limit" value="${S.money.limit ? short(S.money.limit).slice(1) : ""}"></label>
        <label class="tog">Use my own number instead<input class="num wide" data-mm="manual" inputmode="decimal" placeholder="off" value="${S.money.manual ? short(S.money.manual).slice(1) : ""}"></label>
        <button class="btn ghost" data-act="reloadMoney">Re-check my money</button>
      </div>`;
    $$("[data-mk]").forEach((el) => el.addEventListener("change", () => ((S.money[el.dataset.mk] = el.checked), save(), (planOut = null), renderMoney())));
    $$("[data-mm]").forEach((el) =>
      el.addEventListener("change", () => {
        S.money[el.dataset.mm] = parseMoney(el.value);
        save();
        planOut = null;
        renderMoney();
      })
    );
  }

  // ---------------------------------------------------------------- accuracy screen
  function renderAccuracy() {
    const items = ((data && data.items) || []).filter((it) => it.pred && it.pred.n).sort((a, b) => (b.pred.scored || 0) - (a.pred.scored || 0) || b.pred.n - a.pred.n);
    const scored = items.filter((it) => it.pred.scored);
    const hits = scored.reduce((t, it) => t + (it.pred.hits || 0), 0),
      total = scored.reduce((t, it) => t + it.pred.scored, 0);
    body().innerHTML = `
      <div class="card"><div class="big">${total ? Math.round((hits / total) * 100) + "%" : "—"}</div><div class="small muted">${total ? `of ${total} checked predictions landed within 10 minutes` : "No predictions checked yet. Each restock the helper sees is compared with what it predicted."}</div></div>
      <p class="muted small">Only items that are empty right now have a prediction, so this list changes as stock comes and goes.</p>
      <div class="list">${
        items.length
          ? items
              .map((it) => {
                const p = it.pred;
                return `<button class="row" data-act="item" data-key="${it.key}"><span class="nm">${COUNTRIES[it.cc].flag} ${esc(it.name)}<small>${p.scored ? `${p.hits} of ${p.scored} within 10 min · usually off by ${dur(p.err || 0)}` : `${p.n} restock${p.n > 1 ? "s" : ""} seen, not checked yet`} · uses ${esc(p.methodLabel || "recent restocks")}</small></span><span class="rt"><b class="${p.pct >= 70 ? "g" : p.pct >= 45 ? "a" : "r"}">${p.pct}%</b><small>${CONF[p.conf]}</small></span></button>`;
              })
              .join("")
          : `<p class="muted hint">Nothing yet. Give the helper a day or so.</p>`
      }</div>`;
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
        <div class="stat"><span>Sell here</span><b>${it.sell ? money(it.sell) : "—"}</b><small>MV ${short(it.mv || null)} · bazaar ${short(it.low || null)}${it.bz ? ` · in ${num(it.bz)} bazaars` : ""}</small></div>
        <div class="stat"><span>Profit per item</span><b class="${p.unit > 0 ? "g" : "r"}">${money(p.unit)}</b><small>after ${+S.fee || 0}% fee</small></div>
        <div class="stat"><span>Profit per trip</span><b class="${p.trip > 0 ? "g" : "r"}">${short(p.trip)}</b><small>${p.units} items${p.units < p.cap ? (p.restock ? ` (a restock brings ~${num(p.restock)})` : ` (only ${num(it.qty)} left)`) : ""}</small></div>
        <div class="stat"><span>Per hour of flying</span><b>${short(p.perHour)}</b><small>${dur(2 * p.flight)} round trip</small></div>
        <div class="stat"><span>Cash to take</span><b>${short(p.cash)}</b><button class="mini" data-act="copy" data-v="${p.cash}">copy</button></div>
      </div>
      <h3>Stock</h3>
      <div class="card small">
        <div>${it.qty > 0 ? `<b>${num(it.qty)}</b> in stock` : `<b class="a">Empty</b>${it.emptySince ? ` since ${clock(it.emptySince)} (${ago(it.emptySince)} ago)` : ""}`} · seen ${ago(it.updated)} ago</div>
        <div class="muted">Selling speed: ${it.rate ? `~${num(it.rate)}/hour` : "unknown"}${it.amt ? ` · last restock brought ~${num(it.amt)}` : ""}${it.lastRestock ? ` · last restock ${clock(it.lastRestock)}` : ""}</div>
        ${
          pr && pr.at
            ? `${pr.overdue || (pr.to && nowS() > pr.to)
              ? `<div>Next restock: <b class="a">late</b> · expected ~${clock(pr.at)} (between ${clock(pr.from)} and ${clock(pr.to)}), still empty. Could be back any minute.</div><div class="muted">When it comes, the helper checks how far off this was and learns from it.</div>`
              : `<div>Next restock: <b>~${clock(pr.at)}</b> (between ${clock(pr.from)} and ${clock(pr.to)}) · <b>${pr.pct != null ? pr.pct + "% sure" : CONF[pr.conf] + " confidence"}</b></div>${pr.unseen ? `<div class="muted">Nothing seen at the expected ~${clock(pr.missedAt)}${pr.unseen > 1 ? ` or the ${pr.unseen - 1} after it` : ""}: a restock of ~${num(PLAN.restockSize(it))} can come and sell out between checks, so this is the next one in its usual ${dur(pr.avg || 0)} cycle.</div>` : ""}`}${trackHtml(it)}<div class="muted">Usually empty for ${dur(pr.avg || 0)} · ${pr.n} restock${pr.n === 1 ? "" : "s"} seen${it.hidden ? ` (${it.hidden} more probably came and sold out before anyone saw them)` : ""}${pr.scored ? ` · last ${pr.scored} predictions: ${pr.hits} within 10 min, usually off by ${dur(pr.err || 0)}` : ""}${pr.methodLabel ? ` · based on ${esc(pr.methodLabel)}` : ""}</div>`
            : it.qty === 0
              ? `<div class="muted">${data.fromHelper ? "Not enough restock history yet. It improves the longer the helper runs." : "Restock predictions need the helper."}</div>`
              : `${trackHtml(it)}${topLine(it)}`
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
              ? auto.seen
                ? `<div class="small muted">Read from the foreign shop (&ldquo;purchased X / ${auto.total}&rdquo;) on ${new Date(auto.seenAt * 1000).toLocaleDateString()}. This is exact.</div>`
                : `<div class="small muted">${auto.known ? "Worked out from your perks:" : apiKey() ? "Couldn't read your perks yet (needs a Limited or Full key)." : "Add your API key to work this out."}</div>
                 <div class="small">Base ${auto.base} (${esc(METHOD_LABEL[myMethod()])})</div>
                 ${tourismOn() ? `<div class="small g">×2 for World Tourism Day, until ${clock(me.tourism.until)}</div>` : ""}
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

        <h3>What Torn told me</h3>
        <div class="card small">${diagLines().map((l) => `<div>${esc(l)}</div>`).join("")}</div>
        <button class="btn ghost" data-act="copyDiag">Copy this for SarcasticGeekJr</button>
      </div>`;
    $(".method").addEventListener("change", (e) => {
      S.method = e.target.value;
      save();
      renderSetup();
      syncSoon();
    });
    bindNums(renderSetup);
  }
  function diagLines() {
    if (!apiKey()) return ["No API key yet."];
    if (!me) return ["Not checked yet. Tap Re-check my perks."];
    const out = [`Travel Geek v${VERSION}`, me.err ? `Torn API error: ${me.err}` : "Torn API: OK"];
    out.push(me.perksOk === false ? "Perks: your key can't read them (needs a Limited or Full key)" : "Perks: readable");
    out.push(`Last trip ticket from Torn: ${(me.travel && me.travel.method) || "not given"}`);
    const lines = (me.cap && me.cap.lines) || [];
    out.push(lines.length ? "Travel perks found:" : "Travel perks found: none");
    return out.concat(lines.map((l) => "• " + l));
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
        ${!h ? `<p class="a">The alert helper isn't set up yet. Ask SarcasticGeekJr for the helper address and paste it under &ldquo;Advanced&rdquo; below.</p>` : ""}
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
        ${tog("ready", "⏰ <b>Get ready</b>: a few minutes before &ldquo;leave now&rdquo;")}
        <label class="tog">Minutes of warning<input class="num" data-a="lead" type="number" min="0" max="60" inputmode="numeric" value="${S.lead}"></label>
        ${tog("go", "✅ <b>Just restocked</b> and there'll still be stock when you land")}
        ${tog("soldout", "⚠️ <b>Sold out</b> while you're flying there (with a backup pick)")}
        ${tog("restock", "🔔 <b>Restocked here</b> while you're abroad")}
        ${tog("cheap", "💸 <b>Cheap</b>: an item is 15%+ under its usual price abroad")}

        <h3>Crowd warning (optional)</h3>
        <label class="tog"><input type="checkbox" data-s="crowdShare" ${S.crowdShare ? "checked" : ""}><span>Share where and when I land<small class="muted">Other players see only the country and time, never your name.</small></span></label>
        <label class="tog"><input type="checkbox" data-s="crowdWarn" ${S.crowdWarn ? "checked" : ""}><span>Warn me when others land at the same shop<small class="muted">Counts only players who share, landing within 10 minutes of you.</small></span></label>

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
        <button class="btn ghost" data-act="guard">🛡 Cash Guard: ${S.cashGuard ? "on" : "off"} · who mugged me ›</button>

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
      case "money":
      case "accuracy":
        return go(act);
      case "page":
        S.page = el.dataset.k;
        save();
        return renderHome();
      case "prefer":
      case "pin":
        if (act === "prefer") S.prefer = el.dataset.k;
        else S.pin = el.dataset.k || null;
        save();
        planPrev = "";
        planChanged = "";
        runPlan();
        if (act === "pin" && S.pin && !(planOut && planOut.pinned)) toast("Couldn't fit a trip for it in your time", "bad", 3000);
        return renderPlan();
      case "sellMode":
        S.sellMode = el.dataset.k;
        save();
        planPrev = "";
        planChanged = "";
        runPlan();
        return renderPlan();
      case "moneyUp": {
        const i = S.moneyOrder.indexOf(el.dataset.k);
        if (i > 0) [S.moneyOrder[i - 1], S.moneyOrder[i]] = [S.moneyOrder[i], S.moneyOrder[i - 1]];
        save();
        return renderMoney();
      }
      case "reloadMoney":
        if (me) me.money = Object.assign({}, me.money, { otherAt: 0 });
        await loadMe(true);
        await loadMoney(true);
        planOut = null;
        toast(me && me.err ? "Torn API: " + me.err : "Updated", me && me.err ? "bad" : "ok");
        return renderMoney();
      case "planRemind": {
        const b = shownPlan();
        if (!b) return;
        let n = 0;
        for (const [i, g] of b.legs.entries()) {
          if (g.depart - 120 <= nowS()) continue;
          try {
            await window.flutter_inappwebview.callHandler("scheduleNotification", {
              title: `🛫 Leave for ${COUNTRIES[g.cc].name} at ${clock(g.depart)} (trip ${i + 1} of ${b.legs.length})`,
              subtitle: `${buyText(g)}. Take ${short(g.cash)}. Travel Geek`,
              id: 2000 + i,
              timestamp: (g.depart - 120) * 1000,
              overwriteID: true,
              launchNativeToast: false,
              urlCallback: TRAVEL_URL,
            });
            n++;
          } catch {}
        }
        return toast(n ? `${n} reminder${n > 1 ? "s" : ""} set, 2 minutes before each departure` : "Nothing left to remind", n ? "ok" : "", 3000);
      }
      case "planFollow":
      case "planUnfollow": {
        const b = shownPlan();
        const follow = act === "planFollow" && b;
        try {
          await httpSend("POST", helperUrl() + "/api/plan", {
            key: apiKey(),
            plan: follow ? { made: nowS(), legs: b.legs.map((g) => ({ cc: g.cc, depart: g.depart, land: g.land, back: g.back, cash: g.cash, buy: buyText(g) })) } : null,
          });
          S.follow = follow ? { sig: b.legs.map((g) => g.cc + g.depart).join("|"), made: nowS(), legs: b.legs.map((g) => ({ cc: g.cc, depart: g.depart, back: g.back, buys: g.buys.map((x) => ({ id: x.id, units: x.units })) })) } : null;
          save();
          toast(follow ? "Following: you'll get an alert before each departure" : "Stopped following", "ok", 3000);
        } catch (er) {
          toast("Couldn't reach the helper: " + er.message, "bad", 4000);
        }
        return renderPlan();
      }
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
      case "guard":
        mugLog = null;
        return go("guard");
      case "guardClose": {
        guardHidden = $(".guard").dataset.key || "";
        $(".guard").hidden = true;
        return;
      }
      case "copyDiag":
        return toast((await copyText(diagLines().join("\n") + `\nShown: ${myCapacity().total} items, ${METHOD_LABEL[myMethod()]}`)) ? "Copied. Paste it in the chat." : "Couldn't copy", "ok", 2500);
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

  // ---------------------------------------------------------------- foreign shop (while abroad)
  // Reads the shop the same way Torn PDA does (rows inside "stockTableWrapper"), reports the exact stock to the
  // helper so restock times are learned precisely, learns your real capacity from "purchased X / Y", and adds a
  // Fill button next to Buy that types an amount into the buy box. You still press Buy yourself.
  let shopReportAt = 0;
  const shopCountry = () => {
    const h4 = document.querySelector("[class*='titleContainer'] h4") || document.querySelector(".content-title > h4");
    const t = h4 ? h4.textContent.trim() : "";
    const code = t.slice(0, 3).toLowerCase();
    if (COUNTRIES[code]) return code;
    const loc = myLoc();
    return (loc && loc.where === "abroad" && loc.cc) || null;
  };
  function shopRows() {
    const rows = [];
    document.querySelectorAll('div[class*="stockTableWrapper"] div[class*="row___"]').forEach((el) => {
      const img = el.querySelector("img.torn-item") || el.querySelector("img[src*='/images/items/']");
      const id = img ? +(((img.getAttribute("src") || "").match(/\/items\/(\d+)\//) || [])[1] || 0) : 0;
      if (!id) return;
      let cost = 0,
        qty = -1;
      el.querySelectorAll("span").forEach((sp) => {
        const t = sp.textContent.trim();
        if (t.includes("$") && sp.getAttribute("aria-hidden") !== "true") cost = parseMoney(t) || +t.replace(/[^0-9]/g, "") || cost;
        if (/stock/i.test(t) && sp.parentElement) qty = +sp.parentElement.textContent.replace(/[^0-9]/g, "") || 0;
      });
      rows.push({ id, cost, qty: qty < 0 ? 0 : qty, el });
    });
    return rows;
  }
  // "You have purchased 3 / 22 items" (wide layout) or a "3 / 22" counter (narrow layout).
  function shopCapacity() {
    for (const el of document.querySelectorAll('[class*="messageContent___"], [class*="items-"]')) {
      const m = el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      if (m && +m[2] > 0 && +m[2] < 500) return { used: +m[1], cap: +m[2] };
    }
    return null;
  }
  const walletOnPage = () => {
    const el = document.querySelector("#user-money") || document.querySelector("[data-currency-money]");
    if (!el) return null;
    const v = +String(el.getAttribute("data-money") || el.textContent).replace(/[^0-9]/g, "");
    return Number.isFinite(v) ? v : null;
  };
  // Units the followed plan wants of this item here, if any.
  function plannedUnits(cc, id) {
    const f = S.follow;
    if (!f || !f.legs) return null;
    const g = f.legs.find((x) => x.cc === cc && x.depart <= nowS() + 600 && x.back + 1800 >= nowS());
    const b = g && g.buys.find((x) => x.id === id);
    return b ? b.units : null;
  }
  function fillAmount(row, cc) {
    const capInfo = shopCapacity();
    const capLeft = capInfo ? capInfo.cap - capInfo.used : capFor(myMethod());
    const money = walletOnPage();
    const afford = money != null && row.cost > 0 ? Math.floor(money / row.cost) : Infinity;
    const planned = plannedUnits(cc, row.id);
    const n = Math.min(planned != null ? planned : capLeft, capLeft, row.qty > 0 ? row.qty : Infinity, afford);
    return { n: Math.max(0, n), planned };
  }
  // Types a value into Torn's box the way a person would, so the page notices. Nothing is submitted.
  function typeInto(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    if (input._valueTracker) input._valueTracker.setValue("");
    for (const type of ["input", "change", "keyup"]) input.dispatchEvent(new Event(type, { bubbles: true }));
  }
  function shopTick() {
    const rows = shopRows();
    if (!rows.length) return;
    const cc = shopCountry();
    // 1. Your real capacity for this ticket.
    const capInfo = shopCapacity();
    const method = (me && me.travel && METHOD_FROM_API[String(me.travel.method || "").toLowerCase()]) || myMethod();
    if (capInfo && (!S.capSeen[method] || S.capSeen[method].cap !== capInfo.cap || (me && me.cap && S.capSeen[method].perks !== perkCap(method)))) {
      S.capSeen[method] = { cap: capInfo.cap, at: nowS(), perks: me && me.cap ? perkCap(method) : null };
      save();
      syncSoon();
    }
    // 2. Exact stock to the helper, at most about once a minute.
    if (cc && helperUrl() && apiKey() && nowS() - shopReportAt > 70) {
      shopReportAt = nowS();
      httpSend("POST", helperUrl() + "/api/report", { key: apiKey(), cc, items: rows.filter((r) => r.cost > 0).map((r) => ({ id: r.id, qty: r.qty, cost: r.cost })) }).catch(() => {});
    }
    // 3. Fill buttons next to each Buy button, and a green outline on items in your plan.
    for (const r of rows) {
      const li = r.el.closest("li") || r.el;
      if (cc && plannedUnits(cc, r.id) != null) r.el.style.outline = "2px solid #7fdc6f";
      li.querySelectorAll('button.torn-btn[type="submit"]').forEach((buy) => {
        let fb = buy.parentElement && buy.parentElement.querySelector(".tg-fill");
        if (!fb) {
          fb = document.createElement("button");
          fb.type = "button";
          fb.className = "torn-btn tg-fill";
          fb.style.cssText = "margin-left:5px;padding:0 8px;height:30px;font-size:11px;background:#2f6f3a;color:#fff;border-radius:4px;";
          fb.title = "Travel Geek: type the amount into the box. You still press Buy.";
          fb.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const row = shopRows().find((x) => x.id === r.id) || r;
            const { n } = fillAmount(row, shopCountry());
            const form = buy.form || li.querySelector("form");
            const input = (form && form.querySelector("input.input-money")) || li.querySelector('input.input-money, input[type="number"], input[type="text"]');
            if (!input) return toast("Open this item's buy box first, then tap Fill", "bad", 3000);
            if (!n) return toast("Nothing to fill: no room, no stock or not enough cash", "bad", 3000);
            typeInto(input, n);
            toast(`Typed ${n}. Check it, then press Buy yourself.`, "ok", 2500);
          });
          buy.insertAdjacentElement("afterend", fb);
        }
        const { n, planned } = fillAmount(r, cc);
        fb.textContent = planned != null ? `Fill ${n} (plan)` : `Fill ${n}`;
      });
    }
  }

  // ---------------------------------------------------------------- Cash Guard
  // Muggers watch big bazaar sellers, see them flying (sales pile up as cash on hand, and nobody can bank in
  // the air), work out the landing time and attack the moment they land. Cash Guard warns before you fly,
  // sets landing alarms by itself, and says how much is on hand when you land. It never moves money for you.
  const VAULT_URL = "https://www.torn.com/properties.php#/p=options&tab=vault";
  const BANK_URL = "https://www.torn.com/bank.php";
  const BAZAAR_URL = "https://www.torn.com/bazaar.php#/manage";
  const walletNow = () => {
    const page = walletOnPage();
    return page != null ? page : me && me.money ? me.money.wallet || 0 : 0;
  };
  // PDA phone alarms 3 minutes and 1 minute before every landing, set automatically (no tap needed).
  async function guardAlarms() {
    if (!S.landAlarm || !canRemind()) return;
    const loc = myLoc();
    if (!loc || !["flying", "returning"].includes(loc.where) || !loc.arrive || loc.arrive <= nowS()) return;
    if (S.alarmFor === loc.arrive) return;
    const place = loc.where === "returning" ? "Torn" : (COUNTRIES[loc.cc] || {}).name || "abroad";
    try {
      for (const [id, before, label] of [[3001, 180, "in 3 minutes"], [3002, 60, "in 1 minute"]]) {
        if (loc.arrive - before <= nowS() + 5) continue;
        await window.flutter_inappwebview.callHandler("scheduleNotification", {
          title: `🛬 Landing in ${place} ${label}`,
          subtitle: "Cash Guard: deposit your cash as soon as you land. Travel Geek",
          id,
          timestamp: (loc.arrive - before) * 1000,
          overwriteID: true,
          launchNativeToast: false,
          urlCallback: loc.where === "returning" ? VAULT_URL : TRAVEL_URL,
        });
      }
      S.alarmFor = loc.arrive;
      save();
    } catch {}
  }
  // Remember the latest flight so we can tell "just landed" (and when, for the mug log).
  function guardTrack() {
    const loc = myLoc();
    if (!loc) return;
    if (["flying", "returning"].includes(loc.where) && loc.arrive) {
      if (!S.flight || S.flight.arrive !== loc.arrive) (S.flight = { arrive: loc.arrive, to: loc.where === "returning" ? "torn" : loc.cc }), save();
    } else if (S.flight) {
      // Torn says we're no longer flying, so we've landed (trust that over the expected time).
      const at = Math.min(nowS(), S.flight.arrive);
      S.landings = [at, ...(S.landings || []).filter((x) => Math.abs(x - at) > 60)].slice(0, 30);
      S.landedAt = at;
      S.flight = null;
      save();
    }
  }
  let myBazaar = null; // { t, items, value }
  async function loadMyBazaar() {
    if (!apiKey() || (myBazaar && nowS() - myBazaar.t < 120)) return myBazaar;
    try {
      const d = await torn("/user/?selections=bazaar", 2 * MIN);
      const list = Array.isArray(d.bazaar) ? d.bazaar : Object.values(d.bazaar || {});
      const items = list.reduce((t, x) => t + +(x.quantity ?? x.amount ?? 1), 0);
      const value = list.reduce((t, x) => t + +(x.quantity ?? x.amount ?? 1) * +(x.price ?? x.cost ?? 0), 0);
      myBazaar = { t: nowS(), items, value };
    } catch {
      myBazaar = { t: nowS(), items: 0, value: 0, err: true };
    }
    return myBazaar;
  }
  const onTravelPage = () => /sid=travel/i.test(location.search) || /travelagency\.php/i.test(location.pathname);
  const onVaultPage = () => /properties\.php/i.test(location.pathname) && /vault/i.test(location.hash);
  let guardHidden = "";
  async function guardBanner() {
    const el = $(".guard");
    // Hidden while the panel is open (the panel shows cash on hand too), so it never covers its buttons.
    if (!S.cashGuard || !apiKey() || !me || isOpen() || onVaultPage() || /bank\.php/i.test(location.pathname)) return (el.hidden = true);
    const loc = myLoc();
    const cash = walletNow();
    const limit = S.cashLimit || 0;
    let html = "",
      key = "";
    if (loc && loc.where === "torn" && onTravelPage()) {
      const bz = await loadMyBazaar();
      const openBazaar = bz && bz.items > 0;
      if (cash >= limit || openBazaar) {
        key = `fly:${Math.round(cash / 1e5)}:${bz ? bz.items : 0}`;
        html = `<div class="g-txt">⚠️ <b>Before you fly:</b> ${cash ? `${short(cash)} on hand` : ""}${cash && openBazaar ? " and " : ""}${openBazaar ? `${num(bz.items)} item${bz.items > 1 ? "s" : ""} in your bazaar (${short(bz.value)})` : ""}.<small>${openBazaar ? "Bazaar sales go to your cash on hand, and you can't bank in the air. Muggers watch for that and wait for your landing. " : ""}Deposit first${openBazaar ? " or close your bazaar" : ""}.</small></div>
          <div class="g-btns"><a class="btn sm" href="${VAULT_URL}">Vault</a><a class="btn sm ghost" href="${BANK_URL}">Bank</a>${openBazaar ? `<a class="btn sm ghost" href="${BAZAAR_URL}">Bazaar</a>` : ""}<button class="ib sm" data-act="guardClose">✕</button></div>`;
      }
    } else if (loc && (loc.where === "torn" || loc.where === "abroad") && S.landedAt && nowS() - S.landedAt < 15 * 60 && cash >= limit && cash > 0) {
      key = `landed:${S.landedAt}`;
      html = `<div class="g-txt">🛬 <b>You landed with ${short(cash)} on hand.</b><small>${loc.where === "torn" ? "Deposit it now: muggers wait for landings." : "You're abroad: keep it safe until you're home."}</small></div>
        <div class="g-btns">${loc.where === "torn" ? `<a class="btn sm" href="${VAULT_URL}">Vault</a><a class="btn sm ghost" href="${BANK_URL}">Bank</a>` : ""}<button class="ib sm" data-act="guardClose">✕</button></div>`;
    } else if (loc && ["flying", "returning"].includes(loc.where) && cash >= limit && cash > 0) {
      key = `air:${loc.arrive}:${Math.floor(Math.log2(Math.max(1, cash / Math.max(1, limit))))}`;
      html = `<div class="g-txt">💰 <b>${short(cash)} on hand while flying.</b><small>You land ${loc.arrive ? `at ${clock(loc.arrive)} (${cdText(loc.arrive)})` : "soon"}. Be online and deposit straight away.</small></div><div class="g-btns"><button class="ib sm" data-act="guardClose">✕</button></div>`;
    }
    if (!html || key === guardHidden) return (el.hidden = true);
    el.dataset.key = key;
    el.innerHTML = html;
    el.hidden = false;
  }
  // On the vault page: a Fill button that types your cash on hand into the deposit box. You press Deposit.
  function guardVault() {
    if (!S.cashGuard || !onVaultPage()) return;
    document.querySelectorAll("input.input-money, input[name*='deposit' i], input[type='text'][class*='money']").forEach((inp) => {
      const box = inp.closest("form") || inp.parentElement;
      if (!box) return;
      // Only the deposit box: its button (or the box itself) says Deposit, not Withdraw.
      const btn = box.querySelector("button, input[type=submit]");
      const label = ((btn && (btn.textContent || btn.value)) || box.textContent || "").toLowerCase();
      if (!label.includes("deposit") || (btn && /withdraw/.test((btn.textContent || btn.value || "").toLowerCase()))) return;
      if (box.querySelector(".tg-fill")) return;
      const fb = document.createElement("button");
      fb.type = "button";
      fb.className = "torn-btn tg-fill";
      fb.style.cssText = "margin-left:5px;padding:0 8px;height:30px;font-size:11px;background:#2f6f3a;color:#fff;border-radius:4px;";
      fb.textContent = "Fill all cash";
      fb.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cash = walletNow();
        if (!cash) return toast("No cash on hand", "bad");
        typeInto(inp, cash);
        toast(`Typed ${money(cash)}. Check it, then press Deposit yourself.`, "ok", 3000);
      });
      inp.insertAdjacentElement("afterend", fb);
    });
  }
  async function guardTick() {
    guardTrack();
    guardAlarms();
    guardVault();
    await guardBanner();
  }

  // ---------------------------------------------------------------- mug log
  // Who mugged you, when and for how much, from your attacks and events (Limited key).
  let mugLog = null;
  async function loadMugs(force) {
    if (!apiKey()) return (mugLog = { err: "Needs your Torn API key." });
    try {
      const [a, ev] = await Promise.all([torn("/v2/user/attacks?limit=100&sort=DESC", 5 * MIN, force), torn("/user/?selections=events", 5 * MIN, force).catch(() => ({ events: {} }))]);
      const myId = me && me.id;
      const events = Object.values(ev.events || {}).filter((e) => /mugged you/i.test(e.event || ""));
      const list = (a.attacks || [])
        .filter((x) => x.defender && x.defender.id === myId && /mug/i.test(x.result || ""))
        .map((x) => {
          const evt = events.find((e) => Math.abs(e.timestamp - (x.ended || x.started)) < 300 && (!x.attacker || (e.event || "").includes(String(x.attacker.id)) || (e.event || "").includes(x.attacker.name)));
          const amount = evt ? +(((evt.event || "").match(/\$([\d,]+)/) || [])[1] || "0").replace(/,/g, "") : 0;
          const at = x.ended || x.started;
          const landed = (S.landings || []).find((l) => at >= l && at - l < 600);
          return { at, id: x.attacker && x.attacker.id, name: (x.attacker && x.attacker.name) || "Someone (stealthed)", amount, afterLanding: landed ? at - landed : null };
        });
      // Mugs found only in events (for example older than the attack list).
      for (const e of events) {
        if (list.some((m) => Math.abs(m.at - e.timestamp) < 300)) continue;
        const id = +(((e.event || "").match(/XID=(\d+)/) || [])[1] || 0);
        const name = ((e.event || "").match(/>([^<]+)<\/a>/) || [])[1] || "Someone";
        const amount = +(((e.event || "").match(/\$([\d,]+)/) || [])[1] || "0").replace(/,/g, "");
        const landed = (S.landings || []).find((l) => e.timestamp >= l && e.timestamp - l < 600);
        list.push({ at: e.timestamp, id, name, amount, afterLanding: landed ? e.timestamp - landed : null });
      }
      list.sort((x, y) => y.at - x.at);
      mugLog = { at: nowS(), list };
    } catch (e) {
      mugLog = { err: e.code === 16 ? "Your key can't read attacks. Use a Limited key." : e.message };
    }
    return mugLog;
  }
  function renderGuard() {
    const cash = walletNow();
    const m = mugLog;
    body().innerHTML = `
      <div class="form">
        <div class="card"><div class="big ${cash >= (S.cashLimit || 0) && cash ? "r" : ""}">${short(cash)}</div><div class="small muted">cash on hand now${me && me.money && me.money.walletAt ? ` · checked ${ago(me.money.walletAt)} ago` : ""}</div></div>
        <label class="tog"><input type="checkbox" data-s="cashGuard" ${S.cashGuard ? "checked" : ""}><span><b>Cash Guard</b><small class="muted">Warning before you fly with cash or a full bazaar, and a &ldquo;landed with $X&rdquo; banner.</small></span></label>
        <label class="tog"><input type="checkbox" data-s="landAlarm" ${S.landAlarm ? "checked" : ""}><span><b>Landing alarms on this phone</b><small class="muted">Torn PDA reminds you 3 minutes and 1 minute before every landing, set by itself.</small></span></label>
        <label class="tog">Warn me when cash on hand is over<input class="num wide" data-m="cashLimit" inputmode="decimal" value="${short(S.cashLimit).slice(1)}"></label>
        <p class="muted small">With phone alerts on (⚙ → Phone alerts), the helper also sends landing alarms and &ldquo;bazaar sold while you're flying&rdquo; alerts even when Torn PDA is closed.</p>
        <h3>Who mugged me</h3>
        ${
          !m
            ? `<div class="spin"></div>`
            : m.err
              ? `<p class="err small">${esc(m.err)}</p>`
              : m.list.length
                ? `<div class="list">${m.list
                    .slice(0, 25)
                    .map(
                      (x) => `<div class="row"><span class="nm">${x.id ? `<a href="https://www.torn.com/profiles.php?XID=${x.id}">${esc(x.name)}</a>` : esc(x.name)}<small>${new Date(x.at * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${x.afterLanding != null ? ` · <span class="r">${x.afterLanding < 90 ? x.afterLanding + " seconds" : dur(x.afterLanding)} after you landed</span>` : ""}</small></span><span class="rt"><b class="r">${x.amount ? "-" + short(x.amount) : "—"}</b></span></div>`
                    )
                    .join("")}</div><p class="muted small">Open a profile and tap 👁 in Torn Watch Geek to see when they're online.</p>`
                : `<p class="muted small">No mugs in your recent attacks. 🎉</p>`
        }
      </div>`;
    if (!m) loadMugs().then(() => view.name === "guard" && renderGuard());
    $$("[data-s]").forEach((el) => el.addEventListener("change", () => ((S[el.dataset.s] = el.checked), save(), guardTick())));
    $$("[data-m]").forEach((el) =>
      el.addEventListener("change", () => {
        S.cashLimit = parseMoney(el.value);
        save();
        syncSoon();
        toast(`Saved: ${short(S.cashLimit)}`);
        guardTick();
      })
    );
  }

  // ---------------------------------------------------------------- draggable button
  let fabDragged = false;
  function placeFab() {
    const fab = $(".fab");
    const p = S.fab;
    if (!p) {
      fab.style.right = "14px";
      fab.style.bottom = "208px"; // above Bazaar Plus 🛒 (84px) and Torn Watch Geek 👁 (146px)
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
    setInterval(tickCountdowns, 1000);
    guardTick();
    setInterval(guardTick, 5000);
    // Close to landing, check cash on hand and status more often.
    setInterval(() => {
      const loc = myLoc();
      if (loc && ["flying", "returning"].includes(loc.where) && loc.arrive && loc.arrive - nowS() < 300 && loc.arrive - nowS() > -600 && !document.hidden) loadMe(true).then(guardTick);
    }, 30 * 1000);
    setInterval(() => {
      try {
        if (document.querySelector('div[class*="stockTableWrapper"]')) shopTick();
      } catch {}
    }, 1500);
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
.fab { position: fixed; right: 14px; bottom: 208px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
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
.sorts.nav { margin: 10px 0 0; }
.guard { position: fixed; left: 8px; right: 8px; top: 8px; z-index: 2147483004; background: var(--bg); color: var(--text); border: 2px solid var(--r);
  border-radius: 14px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 14px; display: flex; flex-direction: column; gap: 8px; }
@media (min-width: 760px) { .guard { left: auto; width: 420px; } }
.guard small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.g-btns { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.g-btns .ib.sm { margin-left: auto; min-width: 30px; height: 30px; font-size: 14px; }
.g-btns .btn { margin: 0; }
.controls { margin-top: 10px; gap: 8px; }
.ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ctl > span:first-child { flex: 0 0 120px; color: var(--muted); font-size: 12px; }
.ctl select, .ctl input[type=time] { flex: 1; min-width: 110px; padding: 6px 8px; font-size: 14px; }
.ctl input.num { width: 80px; padding: 6px 8px; }
.ctl .sorts { flex: 1; margin: 0; }
.ctl .money { flex: 1; text-align: left; font-size: 15px; }
.ctl .money small, .tog span small { display: block; font-size: 11px; font-weight: 400; margin-top: 1px; }
.plan-sum { margin-top: 10px; border-color: rgba(127,220,111,.5); }
.next { margin-top: 10px; border-color: rgba(127,220,111,.6); display: grid; gap: 4px; }
.next-k { font-size: 11px; letter-spacing: .08em; color: var(--g); font-weight: 700; }
.next-h { font-size: 16px; }
.pinbar { color: var(--amber); }
details.why, details.full, details.opts { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; margin-top: 8px; font-size: 13px; }
details.why summary, details.full summary, details.opts summary { cursor: pointer; }
details.opts .ctl { margin-top: 8px; }
details.why .btn { margin-top: 6px; }
.free { padding: 4px 2px; }
.changed { margin-top: 10px; border-color: var(--amber); color: var(--amber); }
.leg { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; margin-top: 8px; display: grid; gap: 4px; }
.leg-h { font-size: 15px; }
.leg-h .n { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--bg3); font-size: 12px; font-weight: 700; margin-right: 2px; }
.cd { color: var(--acc); font-weight: 700; font-variant-numeric: tabular-nums; }
.buy { font-size: 13px; }
details.alt { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; margin-top: 6px; font-size: 13px; }
details.alt summary { cursor: pointer; }
.btns .btn { margin: 0 6px 6px 0; }
`;
  }
})();
