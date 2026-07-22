# Instasuite WhatsApp worker

Sends a WhatsApp confirmation to the reservation team whenever the Instagram AI agent
captures a **new takeaway order** or shares a **TableCheck reservation link**.

It is a small standalone Node process using [whatsapp-web.js]. It does **not** run on
Render — whatsapp-web.js drives a headless Chrome (Puppeteer), which Render's Node
runtime can't launch without Docker. Run it on any always-on machine you control (your
PC, a Raspberry Pi, a small VPS), where Chrome runs natively with **no Docker**.

## How it works

```
Instagram DM → web app (webhook) detects order/reservation
            → inserts a row into Supabase `whatsapp_outbox`
                                    ↑ (pull, outbound only)
   this worker polls the outbox ───┘ → sends via WhatsApp → marks the row 'sent'
```

The worker only makes **outbound** connections (Supabase + WhatsApp), so it needs no
public URL and works behind NAT. If it's offline, rows just queue and flush when it
comes back — a WhatsApp outage can never affect an Instagram reply.

## Prerequisites

1. Apply the DB migration `supabase/migrations/0006_whatsapp_outbox.sql` to your
   Supabase project (SQL editor or your migration tool). The worker reads the
   `whatsapp_outbox` table it creates.
2. A **dedicated** phone number/SIM for sending (see Risks). Add it to the
   reservation-team WhatsApp group.
3. Node.js 18+ on the machine that will run this.

## Setup

```sh
cd worker
npm install
cp .env.example .env      # then edit .env
node index.js             # or: npm start
```

On first run it prints a QR code in the terminal — scan it once with the **sending**
WhatsApp account (Linked Devices → Link a Device). The session is saved under
`SESSION_PATH` and survives restarts, so you won't rescan unless you log out.

### Finding the group id

Leave `WA_GROUP_ID` blank the first time. Once the client is ready it prints every
group the account is in, with ids like `1203xxxxxxxxx@g.us`. Copy your
reservation-team group's id into `.env` → `WA_GROUP_ID` and restart.

`WA_STAFF_NUMBERS` (optional) is a comma-separated list of numbers in E.164 **without**
the `+` (e.g. `919876543210,919812345678`). Confirmations go to the group **and** each
number.

### Keep it running

Use a process manager so it restarts on crash/reboot:

```sh
npm i -g pm2
pm2 start index.js --name instasuite-wa
pm2 save && pm2 startup   # start on boot
```

## Configuration (`.env`)

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Same project as the web app |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — bypasses RLS to read/update the outbox. **Secret.** |
| `WA_GROUP_ID` | Reservation-team group id (`…@g.us`) |
| `WA_STAFF_NUMBERS` | Optional staff numbers, comma-separated, E.164 without `+` |
| `POLL_MS` | Poll interval (default 5000) |
| `MAX_ATTEMPTS` | Retries before a row is marked `failed` (default 3) |
| `SESSION_PATH` | Where the WhatsApp session is stored (default `./.wwebjs_auth`) |

## ⚠ Risks — read before relying on this

- **whatsapp-web.js is unofficial and violates WhatsApp's Terms of Service.** Numbers
  can be **banned**, usually permanently. Use a **dedicated SIM** added to the group —
  not the restaurant's public number, not a staffer's personal one. This one choice
  matters more than everything else. **Warm the number** (normal use for a week or two)
  before depending on it.
- **Session fragility:** the paired phone must stay powered and online — WhatsApp
  force-unlinks a device after ~14 days offline. A logout means someone re-scans the QR.
- **This is not a supportable production integration** and can stop working with no
  notice if WhatsApp changes their web protocol. Pin the `whatsapp-web.js` version
  (run `npm ls whatsapp-web.js` after install and set it exactly in `package.json`), and
  re-test after any bump.

## Troubleshooting

- **Chrome fails to launch on Linux:** install its libraries, e.g. on Debian/Ubuntu
  `sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 libxshmfence1`.
- **Row stuck `failed`:** check its `last_error` in the `whatsapp_outbox` table. Common
  causes: wrong `WA_GROUP_ID`, or a staff number not registered on WhatsApp.
- **Nothing sends:** confirm `WA_GROUP_ID` and/or `WA_STAFF_NUMBERS` are set and the
  sending account is a member of the group.

[whatsapp-web.js]: https://wwebjs.dev/
