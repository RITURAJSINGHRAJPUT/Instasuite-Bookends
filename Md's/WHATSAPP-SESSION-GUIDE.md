# WhatsApp Session — Lifetime, Limits & Behavior

How the WhatsApp connection behaves once the feature is live: whether the session
stays active, what ends it, and how to keep it running. Based on the actual worker
code on the `build` branch — `worker/index.js`, `worker/README.md`, and migration
`supabase/migrations/0009_whatsapp_session.sql`.

---

## What this connection actually is

It is **`whatsapp-web.js`** — the same mechanism as **WhatsApp Web / Linked Devices**
on your phone. A small Node worker drives a headless Chrome that logs in as a *linked
device* by scanning a QR code **once**.

> ⚠ This is **not** the official WhatsApp Business API. It is an unofficial library that
> automates WhatsApp Web, and it **violates WhatsApp's Terms of Service**.

Architecture facts:

- **One global session for everyone.** One worker + one SIM serves *all* businesses.
  The session is a singleton row (`whatsapp_session`, `id = 'default'`). It is **not**
  per-business.
- **Runs on a machine you control** (your PC, a Raspberry Pi, a small VPS) — **not** on
  Render/Vercel, because it needs a real Chrome. The worker makes only outbound
  connections (Supabase + WhatsApp), so it needs no public URL and works behind NAT.
- **Session is saved to disk** via `LocalAuth` at `SESSION_PATH` (default
  `./.wwebjs_auth`, gitignored). This is what lets it survive restarts without a
  re-scan.

---

## Does the session ever end? Is there a limit?

**There is no fixed countdown or built-in expiry timer.** The session can stay active
for **months** — indefinitely in the happy path — *as long as all of these stay true*:

1. **The worker process keeps running** on an always-on machine.
2. **The paired phone goes online at least once every ~14 days.** This is the single
   hard limit: WhatsApp force-unlinks a linked device after **~14 days** of the primary
   phone being offline.
3. **The number doesn't get banned.** `whatsapp-web.js` is against WhatsApp's ToS; bans
   are **usually permanent**.
4. **The `.wwebjs_auth` session folder isn't deleted** and nobody logs the device out
   from the phone.
5. **WhatsApp doesn't change their web protocol** in a way that breaks the (unofficial)
   library.

So it is **not** an expiring session on a clock — but also **not** "set it once and it
runs forever untouched." It's *"stays alive as long as it's fed."*

---

## What ends or breaks the session

| Cause | Result | Recovery |
|---|---|---|
| Phone offline 14+ days | Auto-unlinked | Re-scan QR |
| Device logged out from the phone | Unlinked | Re-scan QR |
| **Number banned** (ToS violation) | Number dead, usually **permanent** | New dedicated SIM, start over |
| `.wwebjs_auth` deleted / machine reinstalled | Session lost | Re-scan QR |
| WhatsApp Web protocol change | Library breaks | Update/pin `whatsapp-web.js`, re-test |
| Worker crash or machine reboot | Worker down, **session files stay on disk** | Restart → reconnects **silently, no QR** |

---

## Known gap: no auto-reconnect

The worker does **not** auto-reconnect. On a `disconnected` event it only logs
`"restart to re-pair if needed"` — there is no reconnect logic in `worker/index.js`.

Practical implications:

- Run it under a process manager like **pm2** so it restarts on crash/reboot:
  ```sh
  pm2 start index.js --name instasuite-wa
  pm2 save && pm2 startup   # start on boot
  ```
- A `disconnected` event needs a restart to recover. If session files are intact, the
  restart reconnects with **no QR**; if the device was actually unlinked, the restart
  shows a **new QR** to scan.

---

## What the dashboard shows

The worker heartbeats its state every **15s** to the `whatsapp_session` row; the
dashboard's WhatsApp page reads it (via the gated `/api/whatsapp` service-role route).

- **States:** `initializing → qr → authenticated → connected`, plus `disconnected` /
  `auth_failure`.
- **Online detection:** the page marks the worker **offline** if that row hasn't updated
  in the last **60 seconds** — so a dead worker surfaces within about a minute.

---

## The reassuring part: failures are decoupled

If the worker is offline for any reason, **nothing breaks on the Instagram side.**
Detected orders queue as `pending` rows in `whatsapp_outbox` and flush automatically
when the worker returns. A WhatsApp outage can **never** affect an Instagram reply.

```
Instagram DM → web app (webhook) detects order/reservation
            → inserts a row into Supabase `whatsapp_outbox`
                                    ↑ (pull, outbound only)
   this worker polls the outbox ───┘ → sends via WhatsApp → marks the row 'sent'
```

Retries: a failed send stays `pending` and retries each poll until `MAX_ATTEMPTS`
(default 3), after which the row is marked `failed` with its `last_error`.

---

## Bottom line

- **No timed expiry** — in normal operation it can run for months without re-scanning.
- **It is not zero-maintenance.** To keep it "active throughout" you need:
  - an always-on machine running the worker (under pm2),
  - the paired phone opened/online at least every couple of days (well inside the
    14-day window),
  - acceptance that it can still drop at any time from a **ban** or a **WhatsApp update**.
- **Use a dedicated, warmed-up SIM** — never the restaurant's real number, never a
  staffer's personal one. The worker's own README calls this *"not a supportable
  production integration."*

---

## Recommended hardening (optional, not yet implemented)

- **Auto-reconnect loop** in the worker — retry on `disconnected` instead of requiring a
  manual restart.
- **pm2 boot config** so it survives machine reboots automatically.
- **Pin the `whatsapp-web.js` version** in `worker/package.json` (`npm ls whatsapp-web.js`)
  and re-test after any bump, since protocol changes can break it without notice.
