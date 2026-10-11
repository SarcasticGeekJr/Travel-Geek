# Travel Geek ✈️

A Torn userscript for travel trading. It shows the best things to buy abroad **for your own setup**, tells you **when to leave so you land at the restock**, and can send **phone alerts even when Torn PDA is closed**.

Built for **Torn PDA**, works in Tampermonkey too. It only reads data and notifies you. It never flies, buys or clicks anything for you.

## Install

**Torn PDA:** Settings → Userscripts → **+** → Remote load/update → paste the link below → Configure. Injection time: **END**. When it asks about the API key, tap **Add** (a Limited key is best).

```
https://raw.githubusercontent.com/SarcasticGeekJr/Travel-Geek/main/travel-geek.user.js
```

**Tampermonkey:** open the link above and install.

## What it does

- **✈️ button** on every Torn page. The green number on it = good runs you could start right now.
- **Your setup, worked out for you:** how many items you can carry, from your perks (airstrip, suitcase, job, faction, books), and your ticket type (from your last trip). Fix it in ⚙ → Your setup only if it's wrong.
- **Best runs:** every item abroad with profit per trip (for what *you* can carry, after the 5% fee) and profit per hour of flying. A **sells fast / slowly** badge, so cheap guns and armour that are hard to sell don't fool you.
- **When to leave:** for empty items, "Leave at 17:42 → land 18:46 for the restock ~18:48", with how sure it is (high / medium / low) and the restock window.
- **Cash to take:** the exact amount, so you don't carry extra money abroad.
- **⏰ Remind me** (Torn PDA): a phone reminder at your leave time.
- **⭐ Watch** items to always see them and always get alerts; **hide** items you never want.

## Phone alerts (ntfy)

A small helper runs in the cloud every minute, day and night. It watches stock, learns restock patterns, checks where you are and sends alerts to the free **ntfy** app:

- 🛫 **Leave now**: you'd land right at a predicted restock
- ⏰ **Get ready**: a few minutes before that
- ✅ **Just restocked**, and there'll still be stock when you land
- ⚠️ **Sold out** while you're flying there, with a backup pick
- 🔔 **Restocked here** while you're abroad
- 💸 **Cheap**: an item is 15%+ under its usual price

It won't alert you while you're in hospital or jail. You can set quiet hours, a minimum profit (default $1m per trip), only fast sellers, only ⭐ items, and a maximum per hour.

**Turn it on:** ✈️ → ⚙ → Phone alerts → tick "Send alerts to my phone" → install ntfy → subscribe to the channel name shown → "Send a test alert".

### Your API key

When phone alerts are on, your key is stored on the helper and used about once a minute to read your status and travel (where you are and when you land). It isn't shared or used for anything else. Turning alerts off deletes it from the helper.

| Data | Stored | Shared | Purpose | Key access |
|---|---|---|---|---|
| Status, travel | Helper (only while alerts are on) | No | Time alerts to where you are | Limited (Public works with less detail) |
| Perks | This device only | No | Work out what you can carry | Limited |

## Good to know

- Stock data comes from players visiting shops (YATA and Prometheus), so it can be a few minutes old.
- Torn changed restocks in December 2025. Predictions are estimates and get better the longer the helper runs.
- Sell price = the lower of market value and the cheapest bazaar (TornW3B).

## For the owner: the helper

The helper lives in `helper/` (a Cloudflare Worker, free plan). Pushing changes to `helper/` on `main` tests and deploys it with GitHub Actions, using the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

- Tests: `cd helper && npm ci && npm test`
- Endpoints: `GET /api/state` (stock and predictions), `POST /api/user` (turn alerts on or change settings), `DELETE /api/user`, `POST /api/test`.
