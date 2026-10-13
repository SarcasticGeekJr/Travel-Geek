# Travel Geek ✈️

A Torn userscript for travel trading. It shows the best things to buy abroad **for your own setup**, tells you **when to leave so you land at the restock**, and can send **phone alerts even when Torn PDA is closed**.

Built for **Torn PDA**, works in Tampermonkey too. It only reads data and notifies you. It never flies, buys or clicks anything for you.

## Install

**Torn PDA:** Settings → Userscripts → **+** → Remote load/update → paste the link below → Configure. Injection time: **END**. When it asks about the API key, tap **Add** (a Limited key is best).

```
https://raw.githubusercontent.com/SarcasticGeekJr/Travel-Geek/main/travel-geek.user.js
```

**Tampermonkey:** open the link above and install.

## 🧭 Trip planner (opens first)

Tells you which trips to make, in order, for the most profit in the time you have, with the money you can actually use.

- **Round trips only** (Torn → country → Torn), timed to **land at a restock**. It never plans for you to wait abroad.
- **Start:** now, or a time you pick. If you're abroad, flying or in hospital, it starts when you're back.
- **Play for:** 4 hours by default, or 1–8 hours, or until a time you choose.
- **Money I can use:** your wallet, vault, stocks and faction balance (points optional), read from the Torn API. Untick any of them, set a "don't spend more than", or type your own number. Plans only buy what you can afford, and each trip says where to get the cash first ("get $7.3m: Vault $6.1m, Faction $1.2m"). It never moves money for you.
- **Between trips:** "Don't sell" (pay for every trip from today's money) or "Sell" (profits pay for the next trip).
- **Business tickets I have:** 0 by default. Enter how many you have and it uses one only on a trip where the extra profit beats the ticket's price.
- **Expected vs best case:** "best case" assumes every restock arrives as predicted; "expected" counts how often predictions have really been right. Plans are ranked by expected profit.
- **Live:** countdowns tick every second and the plan is recalculated every minute. If the best plan changes, it says why.
- **⏰ Remind me for each trip** (Torn PDA) and **🔔 Follow this plan** (a phone alert before each departure).
- **"With $X you'd make +$Y more"** when more money would help.

## What it does

- **✈️ button** on every Torn page. The green number on it = good runs you could start right now.
- **Your setup, worked out for you:** how many items you can carry, from your perks (airstrip, suitcase, job, faction, books), re-read every time you open Torn, and your ticket (the best your perks allow, so a new airstrip counts straight away). The foreign shop's exact number is used until your perks change. The planner shows it as "I carry". Fix it in ⚙ → Your setup only if it's wrong.
- **Best runs:** every item abroad with profit per trip (for what *you* can carry, after the 5% fee) and profit per hour of flying. A **sells fast / slowly** badge, so cheap guns and armour that are hard to sell don't fool you. For other items (like the newer contraband), a market with 200+ bazaars selling it counts as fast and one with under 80 as slow.
- **When to leave:** for empty items, "Leave at 17:42 → land 18:46 for the restock ~18:48", with how sure it is (high / medium / low) and the restock window.
- **Cash to take:** the exact amount, so you don't carry extra money abroad.
- **⏰ Remind me** (Torn PDA): a phone reminder at your leave time.
- **⭐ Watch** items to always see them and always get alerts; **hide** items you never want.
- **In the foreign shop:** a **Fill** button next to Buy types the right amount into the box (your plan's amount, limited by room, stock and cash). You still press Buy yourself. Items in your plan get a green outline. The shop also tells Travel Geek your exact capacity.
- **How accurate?** Every restock the helper sees is checked against what it predicted. Each item shows its hit rate ("7 of 9 within 10 min") and which method works best for it (recent restocks, all restocks, last 3, or same time of day).

## 🛡 Cash Guard (against muggers)

Muggers watch big bazaar sellers. When you fly, bazaar sales pile up as cash on hand (you can't bank in the air), they work out your landing time and attack the moment you land. Cash Guard helps you not be that target:

- **Before you fly:** on the travel page, a red warning if you have cash on hand or items in your bazaar, with buttons to your Vault, Bank and Bazaar.
- **Landing alarms, automatic:** Torn PDA reminds you 1–3 minutes before every landing. With phone alerts on, the helper also alerts you 3 minutes and 1 minute before landing even when Torn PDA is closed, with how much cash you're carrying.
- **"💰 $X on hand while you're flying":** an alert when bazaar sales push your cash on hand over your limit (default $1m), and again each time it doubles.
- **"🛬 You landed with $X on hand":** a banner (and an alert) right after landing, with a button to your vault. On the vault page, **Fill all cash** types the amount into the deposit box. You still press Deposit.
- **Who mugged me:** from your attacks and events (Limited key): who, when, how much, and whether it was right after you landed.
- Turn parts on or off in ⚙ → 🛡 Cash Guard. It never deposits, closes your bazaar or clicks anything for you.

## Phone alerts (ntfy)

A small helper runs in the cloud every minute, day and night. It watches stock, learns restock patterns, checks where you are and sends alerts to the free **ntfy** app:

- 🛫 **Leave now**: you'd land right at a predicted restock
- ⏰ **Get ready**: a few minutes before that
- ✅ **Just restocked**, and there'll still be stock when you land
- ⚠️ **Sold out** while you're flying there, with a backup pick
- 🔔 **Restocked here** while you're abroad
- 💸 **Cheap**: an item is 15%+ under its usual price

**Crowd warning (optional, off by default):** if you turn on "Share where and when I land", other Travel Geek players can see the country and landing time of your trips (never your name). If you turn on "Warn me", trips and alerts tell you when other sharing players land at the same shop within 10 minutes of you, and whether there may not be enough stock for everyone.

It won't alert you while you're in hospital or jail. You can set quiet hours, a minimum profit (default $1m per trip), only fast sellers, only ⭐ items, and a maximum per hour.

**Turn it on:** ✈️ → ⚙ → Phone alerts → tick "Send alerts to my phone" → install ntfy → subscribe to the channel name shown → "Send a test alert".

### Your API key

When phone alerts are on, your key is stored on the helper and used about once a minute to read your status and travel (where you are and when you land). It isn't shared or used for anything else. Turning alerts off deletes it from the helper.

| Data | Stored | Shared | Purpose | Key access |
|---|---|---|---|---|
| Status, travel | Helper (only while alerts are on) | No | Time alerts to where you are | Limited (Public works with less detail) |
| Perks | This device only | No | Work out what you can carry | Limited |
| Money (wallet, vault, networth, faction balance) | This device only | No | Plan within the money you can use | Limited |
| Cash on hand (while alerts are on) | Helper | No | Cash Guard alerts while flying and landing | Limited |
| Your bazaar, attacks and events | This device only | No | Cash Guard warning and mug log | Limited |
| Shop stock you see abroad | Helper (stock only) | Feeds everyone's predictions | Exact restock times | Your key is used once to check you're in that country |
| Country and landing time of your trips (only if you turn on sharing) | Helper | Yes, without your name | Crowd warning for others | — |

## Good to know

- Stock data comes from players visiting shops (YATA and Prometheus), so it can be a few minutes old.
- Torn changed restocks in December 2025. Predictions are estimates and get better the longer the helper runs.
- Sell price = the lower of market value and the cheapest bazaar (TornW3B).

## For the owner: the helper

The helper lives in `helper/` (a Cloudflare Worker, free plan). Pushing changes to `helper/` on `main` tests and deploys it with GitHub Actions, using the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

- Tests: `cd helper && npm ci && npm test`
- Endpoints: `GET /api/state` (stock and predictions), `POST /api/user` (turn alerts on or change settings), `DELETE /api/user`, `POST /api/test`, `POST /api/plan` (follow a plan), `POST /api/report` (exact stock from a player in the shop).
- Planner tests: `node --test test/*.test.js` (the planner block inside the script is pure and tested on its own).
