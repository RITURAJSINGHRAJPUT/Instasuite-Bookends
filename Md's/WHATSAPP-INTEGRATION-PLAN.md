# WhatsApp integration — implementation plan

> **Status: planned, not implemented.** Written 2026-07-18. Nothing in this document
> has been built. It is a design reference for whenever this work is picked up.

Two features:
1. **Availability IN** — staff report 86'd dishes in their existing WhatsApp group; the AI
   must stop offering those items.
2. **Notifications OUT** — when a takeaway order is captured or a TableCheck booking link is
   shared, notify staff on WhatsApp.

---

## Two constraints that shape everything

**WhatsApp groups cannot be automated officially.** The WhatsApp Business Cloud API is 1:1
only — it can neither post to nor read from a group. Reading or posting to a real group
requires Baileys (a reverse-engineered WhatsApp Web client), which violates WhatsApp's ToS
and carries real per-number ban risk. Any vendor advertising a "WhatsApp group API" is
wrapping the same unofficial approach.

**"Successful reservation" does not exist in this codebase.** Verified by exploration:
- Reservations complete off-platform on TableCheck. `src/lib/script.ts` states outright:
  *"The AI agent never confirms, holds, or modifies reservations manually."* The app never
  learns whether a guest booked. `TABLECHECK-API-REQUEST.md` is drafted but unsent — no API
  access exists.
- The only machine-detectable signals today are:
  - the `TAKEAWAY [Outlet]–[City] / [Items] / Name:… | Contact:… | Pickup:…` line the AI
    already emits (currently just an unparsed `instagram_messages` row), and
  - a `tablecheck.com` URL appearing in a reply.
- There are no orders/availability tables, and no structured extraction anywhere — the AI
  path is pure free text. The menu exists only as markdown inside `scripts.content`.

**Decisions taken:** both transports (official staff DMs *and* unofficial group post);
triggers = takeaway + booking link; availability sourced by reading the existing group.

---

## Three things that will silently break — handle first

1. **`src/proxy.ts:72`** gates everything not explicitly excluded. Add `api/whatsapp` to the
   matcher, or the worker's calls get 401'd before the route's own guard runs. The file
   already documents this exact footgun for `api/cron`.
2. **Baileys must NOT enter the root `package.json`.** It pulls libsignal/protobufjs into the
   Next build and puts crash/OOM risk inside the process that serves Meta's webhooks. It
   lives only in `worker/package.json`.
3. **`src/lib/script.ts` is dead code** — nothing imports `CAPICHE_SCRIPT`. The live prompt is
   `scripts.content`, resolved in `tenant.ts`. Availability must be injected there; editing
   `script.ts` would do nothing.

Secondary: `MAX_CONCURRENT_REPLIES=4` (`src/lib/queue.ts:11`) is a shared gate — group-message
processing must not consume it uncontrolled.

---

## Schema — `supabase/migrations/0006_whatsapp.sql`

- **`whatsapp_settings`** (pk `business_id`) — per-business toggles: `cloud_enabled`,
  `cloud_phone_number_id`, `cloud_access_token` (via `encryptSecret`), template names,
  `staff_numbers text[]`; `group_enabled`, `group_jid`; `availability_enabled`,
  `availability_group_jid`; `strip_handoff_line` (default false — see Triggers).
- **`menu_availability`** — `unique(business_id, item_key)`, plus `state`, `note`, `source`,
  `confidence`, and **`expires_at`** (auto-clears at next 05:00 IST — nobody in a kitchen
  remembers to say "biryani is back", and a stale 86 is worse than the original problem).
  Deliberately *not* a normalised menu catalogue.
- **`notification_events`** — `unique(business_id, kind, dedupe_key)`. **This is the anti-spam
  mechanism**: insert first, treat `23505` as "already sent, skip" (same pattern as
  `webhook/route.ts:120`). Atomic, so concurrent webhook handlers can't race.
- **`whatsapp_outbox`** + a `claim_whatsapp_outbox()` RPC using `for update skip locked` — a
  Render Background Worker has no inbound port, so the app queues and the worker polls.
  Durable across restarts by construction.
- **`whatsapp_sessions`** / **`whatsapp_session_keys`** — Baileys auth state persisted to
  Postgres, because Render's filesystem is wiped on every deploy.
- **`whatsapp_group_messages`** — audit trail + `unique(session_id, wa_message_id)` idempotency.

**RLS:** readable tables follow the `businesses` chain from migration 0005. Session, outbox,
and group tables get RLS **on with no policy** (service-role only, same reasoning as `leads`
in 0004). Never add a select policy on `whatsapp_sessions` — RLS is row-level, not
column-level, and `creds` sits on that row.

`whatsapp_session_keys` grows unbounded (pre-keys churn constantly) — prune
`category='pre-key' AND updated_at < now() - interval '30 days'` monthly.

---

## Availability → AI (the low-risk half)

New `src/lib/availability.ts`:
- `getUnavailableItems(businessId)` — returns `[]` on any error; availability must **never**
  break a reply.
- `renderAvailabilityBlock()` — returns `""` when empty, so there is zero behaviour change
  when the feature is off.

In `src/lib/tenant.ts:74-93`, `Promise.all` the existing script fetch with the availability
fetch and append the block to `systemPrompt`. Appending means it overrides the menu above it
("this list overrides the menu"). Scope by `data.business_id`, already in hand — no extra
join, and `Promise.all` keeps the added latency at zero.

---

## Parsing group messages — regex gate, Claude parser

**Stage 1 — cheap regex prefilter** decides whether to spend a model call. A staff group is
mostly noise ("ok", 👍, photos, shift chat). Match on: `86`, `khatam/khtm`, `over`,
`sold out`, `finished`, `nahi/nai`, `band`, `back`, `aa gaya`, `restock`. Log every message
either way so the regex can be tuned from real misses rather than guesses.

**Stage 2 — `claude-haiku-4-5` with `tool_choice`** forcing a `record_availability` tool, for
guaranteed-shape JSON. Regex alone cannot handle `"biryani ka stock khatam ho gaya bhai"`,
multi-item lines, or reversals — and critically it cannot **map free text to canonical menu
names**. The tool schema instructs: *omit the update entirely if nothing on the menu matches*,
which is what keeps garbage out of the system prompt. Menu names are extracted once per script
from `scripts.content` markdown tables and cached by script id.

Apply `confidence >= 0.7`; store rejects too, so the threshold can be audited. Reuse the
exported `anthropic` client from `src/lib/ai.ts:25` — **not** `getAIResponse`, which is
free-text only and whose OpenRouter fallback is useless for structured extraction.

---

## Triggers + dispatch

New `src/lib/triggers.ts` — pure, synchronous, no I/O, cannot throw: `TAKEAWAY_RE`,
`TABLECHECK_RE`, `detectTriggers()`, `stripHandoffLine()`.

**Dedupe keys** (where the anti-spam semantics actually live):
- `booking_link`: `conversationId:serviceDay:outletSlug` — re-sharing one outlet's link
  collapses to a single notification; a guest switching outlet is a genuine new signal.
- `takeaway_order`: `conversationId:serviceDay:sha1(items|name|contact|pickup)` — a verbatim
  re-emission collapses, but an **edited** order re-notifies, because the kitchen needs the
  amendment.

`serviceDay` (IST date) in both keys stops the permanent unique constraint from muting a
repeat customer next week.

**In `webhook/route.ts:146-164`:** detect **before** the send (stripping changes what the
guest sees), then send / persist / meter exactly as today, then dispatch notifications inside
`try/catch` with `withTimeout(…, 8s)` so a notification failure can never affect the reply.
Add `withTimeout` beside the existing `withRetry` in `src/lib/queue.ts`.

`strip_handoff_line` defaults **off**: today the TAKEAWAY line is sent to the customer. Hiding
it once staff get it on WhatsApp is a visible behaviour change, so it stays a deliberate toggle.

---

## Transports — `src/lib/notify.ts` (pluggable, both coexist)

**`notify/cloud-api.ts`** — `POST graph.facebook.com/v23.0/{phone_id}/messages`:
- **Must always be a template.** Staff never DM the bot, so the 24h free-form window is never
  open. Do not build a "try text, fall back to template" path — it will only fail in production.
- Template body params **cannot contain newlines, tabs, or >4 consecutive spaces** — a
  multi-line order dump is rejected. Sanitise with `replace(/\s+/g, " ").trim().slice(0, 900)`.
- Two **UTILITY** templates (`takeaway_order`, `booking_link_shared`) need Meta approval.
  **Submit these on day 1 — approval takes hours to days and is the long pole.**
- One HTTP request per staff number; no multi-recipient. Report `partial` if some succeed.
- Graph returns HTTP 200 with an `error` body in some failure modes — check `data.error`
  explicitly, as `src/lib/instagram.ts:100` already does. Wrap in existing `withRetry`.
- Until the WABA is business-verified you're capped at 5 verified test recipients.

**`notify/group.ts`** — inserts into `whatsapp_outbox`. `ok` means *queued*, not *delivered*;
the worker flips status to `sent`. Surface queue depth in the UI so a dead session is visible
rather than silent.

**`dispatchNotifications`** — insert `notification_events` first (dedupe), then run enabled
transports under `Promise.allSettled` so one failing never blocks the other, then record
per-transport results with status `sent | partial | failed`.

---

## Deployment — "will it work with the existing system?"

- **Official path: yes, no new infrastructure.** Outbound HTTPS + a webhook — architecturally
  identical to the existing Instagram integration. Runs on the current Render service as-is.
- **Unofficial path: needs a SECOND Render service** — a Background Worker at `worker/`
  (~$7/mo). Never in the Next process: a Baileys crash or OOM must not take down the process
  answering Meta's webhooks.

`render.yaml` additions: `type: worker`, `rootDir: worker`, `numInstances: 1`
(**load-bearing** — two sockets on one WhatsApp number cause a mutual-logout cascade), and:

```yaml
    buildFilter:
      paths:
        - worker/**
```

**This is the single most valuable deployment decision here:** normal app deploys then don't
redeploy the worker at all, so the WhatsApp session survives day-to-day pushes. Combined with
Supabase-persisted auth state (for the times the worker *does* redeploy), the "re-scan the QR
after every push" failure mode disappears entirely.

Worker needs its own `package.json` **and** `package-lock.json` (Render runs `npm ci` from
`rootDir`). `TOKEN_ENCRYPTION_KEY` must be **byte-identical** across web and worker — it now
gates the WhatsApp session too.

### `worker/src/auth-state.ts` — the part people get wrong

Implements Baileys' `AuthenticationState` against Supabase instead of `useMultiFileAuthState`
(which writes to a disk Render wipes). Four non-obvious requirements:

1. **`BufferJSON.replacer` / `BufferJSON.reviver` are mandatory.** Creds contain
   `Buffer`/`Uint8Array` key material; a plain `JSON.stringify` round-trip silently produces
   `{"0":12,"1":54,…}`, pairing *appears* to succeed, and every decrypt then fails with a
   meaningless error. This is *the* classic custom-store bug.
2. **`app-state-sync-key` must be revived through `proto.Message.AppStateSyncKeyData.fromObject`.**
3. **The in-memory key cache is a requirement, not an optimisation** — a fresh pairing writes
   hundreds of pre-keys and a round trip per key will time out the handshake. Also wrap with
   `makeCacheableSignalKeyStore`.
4. On `DisconnectReason.loggedOut`, delete rows from **both** tables — stale creds cause an
   infinite reconnect-fail loop.

Copy `src/lib/crypto.ts` verbatim into `worker/` rather than importing across `rootDir`.
**Pin Baileys to an exact version** — WhatsApp changes the protocol and unpinned upgrades are
a leading cause of outages. Quarterly bump on the calendar.

Socket config: `markOnlineOnConnect: false` (the default steals push notifications from the
staffer's actual phone — they *will* notice), `syncFullHistory: false`.

### QR pairing

Worker renders the QR to a PNG data URL (so the Next app needs no QR dependency) and stores it
on `whatsapp_sessions`. `/api/whatsapp/session` — gated by `getContext()` + `can(role,"settings")`
— returns only safe columns, **never `creds`**. On connect, `groupFetchAllParticipating()`
populates a group dropdown so nobody has to hunt for a raw `120363…@g.us`.

### Inbound — `/api/whatsapp/ingest`

Mirrors the Instagram webhook's discipline: Bearer guard that **fails closed** when the secret
is unset; resolve `business_id` from `availability_group_jid`, ignore unknown groups and never
fall back to another tenant; `23505` → early return. **Run the regex prefilter synchronously,
before `withSlot`** — otherwise a chatty staff group starves the 4 slots serving customer DM
replies. That is the sharpest interaction hazard between the two features.

---

## Risks

Baileys violates WhatsApp's ToS. Bans are per-number, usually permanent, and appeals for
automation-flagged numbers rarely succeed. Mitigations, ranked by how much they matter:

1. **Use a dedicated SIM** added to the group — not the restaurant's public number, not a
   staffer's personal one. Turns a catastrophic risk into a ₹200 one. This single decision
   matters more than everything else combined.
2. **Warm the number** for a week or two before linking a client. A brand-new number that
   instantly links WhatsApp Web and starts posting is the textbook ban signal.
3. **Strongly consider running Baileys read-only** (`availability_enabled: true`,
   `group_enabled: false`) and sending notifications over the official Cloud API. Same value,
   far less exposure — the pluggable transport design makes this a per-business toggle.
4. `markOnlineOnConnect: false`, `syncFullHistory: false`, rate-limit + jitter, never message
   non-contacts.
5. Document to the client that this is not a supportable production integration and can stop
   working with no notice.

**Session fragility:** WhatsApp force-unlinks if the paired phone is offline ~14 days, so that
phone must stay powered and connected. `logged_out` is a *human-latency* outage — someone must
physically scan a QR — so alert on it. Never run the worker locally against the production
`WA_SESSION_ID`; use a separate session id for dev. (This will happen at least once.)

**False positives are expensive:** a mis-parsed "86 the truffle" stops the AI selling a ₹940
pizza. The confidence gate, the "omit if no menu match" instruction, auto-expiry, and a manual
override UI are all defences. Ship the override UI in Phase 0 so there is always a correction path.

---

## Sequencing

| Phase | Scope | Effort | Risk |
|---|---|---|---|
| **0** | Migration + `availability.ts` + `tenant.ts` injection + manual 86-toggle UI. **Delivers the real value of feature 1 on its own.** In parallel: start WABA setup, submit both templates. | ½ day | None |
| **1** | `triggers.ts` + `notify.ts` + Cloud API transport + webhook hook + dedupe. Official only. | 1 day | None |
| **2** | Baileys worker **read-only** — auth state, QR UI, ingest, prefilter, Haiku extractor. Run a week before depending on it. | 2-3 days | ToS |
| **3** | Group transport + outbox poller + `group_enabled`. Both transports now switchable per business. | ½ day | ToS |
| **4** | `logged_out` alerting, pre-key pruning (extend the daily cron), health panel in `/admin`, `strip_handoff_line` rollout. | — | — |

---

## Verification

1. **Phase 0:** mark an item 86'd, DM the IG account asking for it → agent declines and
   suggests an alternative; clear it → agent offers it again.
2. **Dedupe:** send a booking link three times in one thread → exactly **one**
   `notification_events` row. Edit a takeaway order → a second row.
3. **Reply isolation:** deliberately break the notify transport → the Instagram reply still sends.
4. **Auth store:** force a worker redeploy → it reconnects **without** a QR scan. This is the
   test that proves the Supabase auth state works.
5. **Cloud API:** confirm a template send reaches a staff number, and that a newline in a param
   is sanitised rather than rejected.

---

## Key files

| Path | Change |
|---|---|
| `supabase/migrations/0006_whatsapp.sql` | new — all schema, RLS, claim function |
| `src/lib/tenant.ts` | availability injection (lines 74-93) |
| `src/app/api/webhook/route.ts` | trigger detection + dispatch (lines 146-164) |
| `src/proxy.ts` | matcher exclusion for `api/whatsapp` — silent 401s without it |
| `src/lib/availability.ts`, `src/lib/triggers.ts`, `src/lib/notify.ts` | new |
| `worker/` | new Background Worker (Baileys, auth state, outbox poller) |
| `render.yaml` | worker service: `rootDir` + `buildFilter` + `numInstances: 1` |
