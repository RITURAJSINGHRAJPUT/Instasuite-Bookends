# Instasuite — build specification

> A complete specification for rebuilding this system from zero. Written 2026-07-19 against
> commit `9b47cd4`. Every claim here was verified against the source; where something is
> reconstructed rather than read directly, it says so.

---

## 1. What this is

Instasuite answers a business's **Instagram Direct Messages with an AI assistant**, and gives
its team a dashboard to watch, take over, and configure that assistant.

A customer DMs a connected Instagram account. Meta delivers a webhook. The system works out
which business owns that account, loads that business's *script* (a system prompt), asks
Claude for a reply, and sends it back from that account. Staff see the whole thing live in an
inbox and can take over any conversation.

Built for a restaurant group running several outlets, but nothing in the schema is
restaurant-specific. The generic model is:

```
profile (a client/tenant)
  └── business            e.g. "Capiche"
        ├── script        the system prompt that governs replies
        └── instagram_account
              └── conversation
                    └── message
```

**"Tenant" means a `profiles` row.** A tenant owns businesses; businesses own Instagram
accounts and scripts; accounts own conversations. Every ownership question in the codebase is
a walk up that chain to `businesses.client_id`.

**There is no public signup.** Accounts are created only by a super-admin from the Users
screen. The single account-creation path in the entire codebase is `POST /api/admin/users`.

---

## 2. Architecture

### Components

| Component | Role |
|---|---|
| Next.js app (App Router) | Dashboard UI + every API route + the Meta webhook receiver |
| Supabase | Postgres, Auth, Row-Level Security, Realtime, transactional email |
| Anthropic Claude | Generates replies; also reformats uploaded documents into scripts |
| OpenRouter | Fallback model provider when Claude fails |
| Instagram Graph API | Receives webhooks, sends replies, OAuth, token refresh |
| Scheduler (cron) | Daily token refresh — Instagram tokens expire after 60 days |

### Flow A — an inbound DM becomes an AI reply

```
Instagram DM
  → POST /api/webhook
      ├─ verify X-Hub-Signature-256 HMAC over the RAW body
      ├─ respond {status:"received"} IMMEDIATELY   (Meta retries after ~5s)
      └─ after(() => withSlot(processMessage))     ← bounded background work
            ├─ resolveAccountByIgId(entry[0].id)   → tenant, token, systemPrompt
            ├─ find-or-create conversation (scoped to the account)
            ├─ INSERT inbound message              (23505 = Meta retry → stop)
            ├─ if conversation.mode === "human"     → stop, no AI
            ├─ checkMessageQuota(clientId)          → stop if over plan
            ├─ load last 20 messages
            ├─ getAIResponse(history, {systemPrompt})
            ├─ sendInstagramMessage(igsid, text, thisTenantsToken)
            ├─ INSERT assistant message
            └─ INSERT usage_events row (tokens + cost)
```

The ordering is deliberate and load-bearing — see §15.

### Flow B — connecting an Instagram account (OAuth)

```
GET /api/auth/instagram?business_id=…
  ├─ verify caller owns the business
  ├─ mint 32-byte state nonce
  ├─ set cookies ig_oauth_state + ig_oauth_business
  │     Path=/api/auth/instagram; HttpOnly; SameSite=Lax; Max-Age=600
  └─ 302 → www.instagram.com/oauth/authorize

GET /api/auth/instagram/callback?code=…&state=…
  ├─ compare state against cookie              (CSRF)
  ├─ RE-verify business ownership from the DB  (cookie is attacker-influenced)
  ├─ enforce plans.max_ig_accounts
  ├─ exchangeCodeForToken(code)                → short-lived (~1h)
  ├─ exchangeForLongLivedToken(short)          → 60-day token   ← MANDATORY
  ├─ fetchConnectedAccount(long)               → ig_account_id comes from HERE
  ├─ INSERT account (token encrypted, status pending unless staff)
  ├─ subscribeToWebhooks(token)                → non-fatal; warns on failure
  └─ 302 → /businesses?ig_connected=<username>
```

---

## 3. Tech stack

From `package.json` (name `instagram-dm-claude-code`, v0.1.0, private):

| Package | Version | Purpose |
|---|---|---|
| `next` | **16.2.1** (pinned) | App Router. Note: middleware is renamed **`proxy`** in 16. |
| `react` / `react-dom` | **19.2.4** (pinned) | |
| `@anthropic-ai/sdk` | ^0.111.0 | Claude |
| `openai` | ^6.33.0 | Used **only** as the OpenRouter client |
| `@supabase/supabase-js` | ^2.100.1 | Service-role client |
| `@supabase/ssr` | ^0.12.3 | Cookie-based server/browser clients |
| `lucide-react` | ^1.24.0 | Icons. **v1 removed all brand logos** — the Instagram glyph is inlined SVG. |
| `mammoth` | ^1.12.0 | `.docx` → text for script upload |
| `tailwindcss` + `@tailwindcss/postcss` | ^4 | CSS-first; **no `tailwind.config.js` exists** |
| `typescript` | ^5.9.3 | `strict: true` |

Scripts are only `dev`, `build`, `start`. **There is no linter and no test suite** — no
`eslint.config.*`, no eslint dependency, no test runner. The stray
`// eslint-disable-next-line` comments are vestigial.

Node version pinned to **20** via `.node-version`.

### Why a persistent Node process, not serverless

This matters more than it looks. `src/lib/queue.ts` is an **in-process** semaphore bounding
concurrent AI calls. It only works inside one long-lived process. On serverless, every
webhook is an isolated invocation, `active` resets to 0 each time, and the gate bounds
nothing — a burst of 50 DMs becomes 50 concurrent Claude calls.

Deploy on a platform that runs `next start` as a persistent process, at **one instance**.
Scaling horizontally requires replacing the in-process gate with a shared queue (Redis /
pg-boss) first.

---

## 4. Data model

Postgres via Supabase. Migrations live in `supabase/migrations/`, applied in filename order.

### ⚠️ Two tables have no `CREATE TABLE` in the repo

`instagram_conversations` and `instagram_messages` predate the migrations folder. **Anyone
rebuilding from `supabase/migrations/` alone gets a database missing the two most important
tables.** Their shape below is reconstructed from migration `0002` plus `src/lib/types.ts` —
column names and types are certain; exact defaults are inferred.

```sql
create table instagram_conversations (
  id uuid primary key default gen_random_uuid(),
  igsid text not null,                       -- Instagram-scoped sender id
  instagram_account_id uuid not null
    references instagram_accounts(id) on delete cascade,
  name text,
  username text,
  profile_pic text,
  follower_count int,
  is_user_follow_business boolean,
  is_business_follow_user boolean,
  mode text not null default 'agent' check (mode in ('agent','human')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instagram_account_id, igsid)       -- NOT unique(igsid) — see §15
);

create table instagram_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references instagram_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  instagram_msg_id text,                     -- Meta's `mid`
  created_at timestamptz not null default now()
);

create unique index instagram_messages_convo_msgid_key
  on instagram_messages (conversation_id, instagram_msg_id)
  where instagram_msg_id is not null;
```

### `0001_multi_tenant_foundation.sql`

- **`profiles`** — `id` (FK `auth.users` ON DELETE CASCADE), `email`, `role` (CHECK, widened
  in 0005), `created_at`.
- **`plans`** — `id`, `name` unique, `max_ig_accounts` (default 1), `max_messages_per_month`
  (**nullable = unlimited**), `price_cents`, `stripe_price_id`, `created_at`.
- **`subscriptions`** — `client_id` **unique** FK profiles, `plan_id`, `status`
  (`trialing|active|past_due|canceled`), Stripe columns, `current_period_end`.
- **`businesses`** — `client_id`, `name`, `default_script_id` (FK added after `scripts`
  because the relationship is circular), `status` (`pending|approved|rejected`).
- **`scripts`** — `business_id`, `name`, `content`, `created_at`, `updated_at`.
- **`instagram_accounts`** — `business_id`, **`ig_account_id` text UNIQUE** (this is
  webhook `entry[0].id`, the tenant routing key), `username`, `name`,
  `profile_picture_url`, `access_token` (encrypted), `token_expires_at`, `script_id`
  (nullable ⇒ inherit business default), `status` (`pending|approved|disabled`).
- **`usage_events`** — `client_id`, `business_id`, `instagram_account_id`, `kind`
  (default `'ai_reply'`), `model`, `input_tokens`, `output_tokens`,
  `cost_cents numeric(12,5)`.

### `0002_tenant_scope_conversations.sql`
Adds `instagram_account_id` to conversations (nullable → backfill → NOT NULL) and replaces
two globally-unique constraints with scoped ones. This migration fixes a real production
bug; see §15.

### `0003_rls_tenant_isolation.sql`
Enables RLS on all nine tables and replaces `using (true)` policies. Defines
`public.is_super_admin()`. Every policy walks the ownership chain to
`client_id = auth.uid() or public.is_super_admin()`.

### `0004_leads.sql`
`leads` — the landing page "request access" capture. **Not** restaurant leads. RLS on, select
policy for super-admins, and **deliberately no insert policy**: rows are written by the
service-role client only.

### `0005_staff_roles.sql`
Widens `profiles.role` to `client|super_admin|admin|manager|agent`, adds
`public.is_staff()`, and broadens every policy from super-admin-only to any staff.

### The two-layer access rule

RLS is the **safety net, not the lock**. The service-role client bypasses RLS entirely, and
most API routes use it — so every user-driven query *also* carries an explicit ownership
predicate in code, via `getContext()` (`src/lib/ownership.ts`). Reproduce both layers; either
alone is insufficient. RLS is what scopes **Realtime**, which runs under the user's JWT.

---

## 5. Auth & RBAC

### Roles and capabilities

Seven features × five roles, defined in `src/lib/permissions.ts` — a pure module imported by
both server and client.

| Role | overview | inbox | businesses | scripts | settings | admin | users |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `super_admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `manager` | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `agent` | — | ✓ | — | — | — | — | — |
| `client` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |

`isStaff()` = everyone except `client`. Staff operate the *operator's* data (`getContext()`
returns the full account set); a `client` is scoped to its own businesses. This mirrors
`public.is_staff()` in SQL — **keep the two in sync or RLS and the app will disagree.**

### Three enforcement layers — reproduce all three

1. **`src/proxy.ts`** (Next 16's renamed middleware) — session only, **role-unaware**. Any
   authenticated user passes. Unauthenticated: `/api/*` → 401 JSON, pages → `/login?from=…`.
2. **`AppGuard`** (client) — capability-based, **cosmetic only**.
3. **Per-route server gates** — `can(role, feature)`, returning **404 and never 403**, so an
   unauthorised role can't confirm the surface exists.

Hiding a nav link is never the lock.

### The most consequential default

`getSessionUser()` (`src/lib/supabase-server.ts:59`) resolves role as
`profile?.role ?? "client"`. **A user with an auth account but no `profiles` row silently
becomes a `client`** — which grants five capabilities, not zero. `getContext()` then scopes
them to an empty account set so they see nothing, but the pages render.

This is why `POST /api/admin/users` performs a **rollback** — it deletes the auth user if any
downstream write fails, because a half-created account is worse than a failed one.

---

## 6. Instagram integration

All in `src/lib/instagram.ts`. **API version `v24.0`.** Three hosts, and mixing them up is a
real failure mode:

| Host | Used for |
|---|---|
| `graph.instagram.com` | profile, `/me`, send, `subscribed_apps`, long-lived exchange, refresh |
| `api.instagram.com` | **code→token exchange only** (POST, form-encoded) |
| `www.instagram.com` | the OAuth authorize redirect |

### Meta app configuration

- Create a Meta app with the **Instagram** product (Instagram Business Login).
- **`client_id` is the Instagram app ID and `client_secret` is the Instagram app secret** —
  *not* the Facebook app's pair under App Settings → Basic. The same Instagram secret also
  signs webhooks, which is why `META_APP_SECRET` is reused for both.
- Scopes: `instagram_business_basic`, `instagram_business_manage_messages`.
- Webhook callback → `https://<domain>/api/webhook`, verify token = `INSTAGRAM_VERIFY_TOKEN`,
  subscribe the **`messages`** field.
- Valid OAuth Redirect URI → `https://<domain>/api/auth/instagram/callback`, matching
  `INSTAGRAM_REDIRECT_URI` **exactly**.

### Functions

| Function | Call |
|---|---|
| `fetchInstagramProfile(igsid, token)` | `GET graph.instagram.com/v24.0/{igsid}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user` — **never throws**, returns all-nulls on failure |
| `fetchConnectedAccount(token)` | `GET graph.instagram.com/v24.0/me?fields=user_id,username,name,account_type,profile_picture_url,followers_count,media_count` — **throws** so a bad token is visible |
| `instagramAuthUrl(state, redirectUri)` | `www.instagram.com/oauth/authorize?client_id=…&response_type=code&scope=…&state=…` |
| `exchangeCodeForToken(code, redirectUri)` | `POST api.instagram.com/oauth/access_token`, form-encoded. Error shape differs from Graph — check **both** `data.error_message` and `data.error.message` |
| `exchangeForLongLivedToken(short)` | `GET graph.instagram.com/access_token?grant_type=ig_exchange_token` — **unversioned URL** |
| `subscribeToWebhooks(token)` | `POST graph.instagram.com/v24.0/me/subscribed_apps?subscribed_fields=messages` — params in the **query string**, no body. Idempotent. |
| `refreshInstagramToken(token)` | `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` — **unversioned**. Meta requires the token be **>24h old and still valid**. |
| `sendInstagramMessage(igsid, text, token)` | `POST graph.instagram.com/v24.0/me/messages`, JSON body `{recipient:{id},message:{text}}` |

### Three non-obvious requirements

**The long-lived exchange is mandatory.** `refreshInstagramToken` uses `ig_refresh_token`,
which only renews tokens that are *already* long-lived. Store the short-lived token and the
account works for an hour, then dies with no way to renew it.

**`ig_account_id` must come from `/me`, never from a request body.** The token *is* the proof
of ownership. Accepting a caller-supplied id lets someone claim another business's account
and receive its webhooks.

**The module sets `dns.setDefaultResultOrder("ipv4first")` on import.** Meta's Graph API
resolves to both IPv4 and IPv6, and on some networks the IPv6 route hangs until timeout. This
also makes the module Node-runtime-only.

`fetchWithRetry` (8s timeout, 2 total attempts) **resolves for any HTTP status** — only
network failures throw. Every caller must check `!res.ok || data.error` itself.
`sendInstagramMessage` is the one function that doesn't, so **send failures are silent**.

### Webhook

- **GET** — Meta's handshake: echo `hub.challenge` when `hub.verify_token` matches, else 403.
- **POST** — read the **raw body text first** (the signature is over exact bytes;
  re-serialising breaks it), verify `X-Hub-Signature-256` as `sha256=<hmac>` with
  `crypto.timingSafeEqual` and a length guard.
- It **fails open with a loud warning when `META_APP_SECRET` is unset** — otherwise a missing
  env var would silently drop every real message. Set the secret in production; a forged
  event is a cross-tenant write.
- `export const maxDuration = 60`.

---

## 7. The AI reply pipeline

`src/lib/ai.ts` — `getAIResponse(messages, { systemPrompt, model? })`.

- **Primary:** Claude, `ANTHROPIC_MODEL || "claude-haiku-4-5"`, `max_tokens: 1024`.
- **Fallback:** OpenRouter, a chain of five free models, tried in order. The loop only
  continues on **429 or 404** and rethrows anything else.
- `REPLY_GUARD` is appended to every system prompt: *"Reply with only the message to send to
  the guest — no preamble, no quotes, no explanation of your reasoning."* Opus with thinking
  off otherwise narrates its reasoning into the reply.
- Leading non-user turns are shifted off the history — the API rejects a history that opens
  with an assistant turn, reachable when a human starts a thread from the dashboard.
- `stop_reason === "refusal"` returns a canned handoff line rather than an error.
- **No tool use, no structured output.** Replies are pure free text; the content is never
  inspected. Nothing is extracted from conversations.

The Anthropic client reads `ANTHROPIC_API_KEY` **itself** — it never appears as
`process.env.ANTHROPIC_API_KEY` in application code, which makes it easy to miss when
auditing env vars. Its absence shows up only as failed replies.

### Concurrency

`src/lib/queue.ts` — `withSlot(task)`, bounded by `MAX_CONCURRENT_REPLIES` (default 4).
`release()` hands the slot directly to the next waiter without decrementing `active`.
`withRetry` — 2 retries, backoff `1000 * 2**attempt`, transient = 429 or ≥500.

Written because a burst of 50 DMs previously fired 50 concurrent AI calls: rate limits,
timeouts, dropped replies. The system got *worse* under load instead of merely slower.

### Cost

Hardcoded Haiku 4.5 pricing in the webhook: `$1/1M input, $5/1M output`, i.e.
`(in/1e6)*100 + (out/1e6)*500` cents. Change the model, change this formula.

---

## 8. Scripts (system prompts)

A script is a Markdown document in `scripts.content` that becomes the system prompt.

**Resolution order:** `instagram_accounts.script_id ?? businesses.default_script_id`
(`src/lib/tenant.ts`). That single expression gives both "one script for all accounts" and
"a different script per account" from the same schema. Creating a business auto-creates a
"Default script" and points `default_script_id` at it — every business must have a fallback.

**Upload & reformat:** `POST /api/scripts/reformat` accepts `.txt/.md/.markdown/.docx`
(2 MB cap → 413), extracts text (`.docx` via `mammoth`), and has Claude reshape it into the
app's script format (`reformatToScript`, `max_tokens: 8192`). It **fills the editor for
review and never saves** — this text governs every reply, so persisting stays a human step.

> `src/lib/script.ts` exports `CAPICHE_SCRIPT` and is **dead code** — nothing imports it. It
> remains the best available *specimen* of the script format (persona, facts, rules, tone).
> The live prompt path is entirely DB-driven.

---

## 9. Inbox & Realtime

### ⚠️ Realtime requires dashboard setup not present in any migration

No migration adds `instagram_conversations` / `instagram_messages` to the
**`supabase_realtime` publication**. Do this in the Supabase dashboard or **the live inbox is
silently dead** — everything renders, nothing updates.

### The subscription

Exactly one, in `src/app/(app)/inbox/page.tsx`:

- The client must be **session-aware** (`createBrowserClient`), not a bare anon client.
  Realtime enforces RLS per event, and the policies key on `auth.uid()` — an unauthenticated
  socket matches zero rows.
- `supabase.realtime.setAuth(session.access_token)` before subscribing, and re-called on
  `onAuthStateChange`: the token expires after ~1h and the socket otherwise **goes quiet with
  no error**.
- Handlers read `selectedIdRef` / `fetchConversationsRef` **refs**, so switching conversation
  doesn't tear down and rebuild the socket — a rebuild drops events during the gap.
- INSERT on `instagram_messages` → append if that conversation is open (deduped by id), and
  always refetch the conversation list. Any change on `instagram_conversations` → refetch.

### Behaviour

Three panes: list (300px) / thread / context aside (280px, `xl:` only); mobile is single-pane
push. Each conversation has a **mode**: `agent` (AI replies) or `human` (AI stays silent).
The toggle only updates the UI on `res.ok` — it used to update unconditionally, so a failed
PATCH left the UI claiming the agent was off while it was still replying.

Sending a manual reply resolves the conversation's own account and sends **from that token,
never a global one**. Note: sending manually does **not** auto-flip the conversation to human
mode, and the UI says so explicitly.

---

## 10. Usage metering & plans

`src/lib/usage.ts`. Billing period is the **UTC calendar month** (`periodStart`) — no
proration, no anniversary dates.

- **What counts:** only `usage_events` rows with `kind='ai_reply'`, written by the webhook,
  and only when `ai.provider !== "none"`. Human replies, inbound messages, and total failures
  don't count. **OpenRouter fallback replies count as a message but record `cost_cents: 0`.**
- `getMonthlyUsage` pulls every row for the month and counts client-side — one row per
  message, O(n) per tenant per month.
- `checkMessageQuota` **fails closed** on a missing subscription or a status outside
  `active|trialing`. `max_messages_per_month = null` means unlimited and short-circuits.
- Enforced in the webhook **before** the AI call and **after** the inbound message is stored,
  so nothing is lost — the tenant just stops getting auto-replies.

> **Known defect:** `getMonthlyUsage` destructures only `{ data }` with no error check, so a
> failed query reads as **zero usage** — quota fails *open* while `checkMessageQuota` fails
> *closed*. The two halves disagree. Fix this in a rebuild.

> **Known defect:** `/api/usage` calls `getMonthlyUsage(ctx.user.id)`. For a **staff** user
> that's their own id, which has no `usage_events` rows, so staff see zeros.

---

## 11. Email

Supabase Auth sends all transactional mail. There is no email code in the app.

### Required configuration

1. **Custom SMTP.** The built-in mailer is capped (~2/hour) and on newer projects only
   delivers to project team members — invitees get nothing. Configure a real provider
   (Resend works well) under **Authentication → Emails → SMTP Settings**, and raise the
   hourly cap under **Rate Limits**.
2. **URL configuration.** Site URL must be the production domain, and Redirect URLs must
   include `https://<domain>/**` — **with the wildcard**. Supabase matches exactly; a bare
   domain does not match a URL with a path, and Supabase then silently rewrites
   `redirect_to` to the Site URL. The symptom is invite links pointing at `localhost:3000`.
3. **Templates.** `supabase/email-templates/` holds the versioned source; paste into the
   dashboard. The stock template is a heading, one line and a bare link — structurally
   identical to phishing, and it gets spam-filed.
4. **DNS.** SPF, DKIM and DMARC on the sending domain. A new sending domain still lands in
   spam for the first days regardless; that's reputation, not configuration.

### Onboarding flow

`POST /api/admin/users` creates the account, then tries `resetPasswordForEmail`. Only if that
fails does it mint a `generateLink({type:"recovery"})` for manual delivery.

**These two calls cannot both run.** Each mints a recovery token and the newer invalidates the
older — doing both hands the admin a dead link. Because a recovery link is what new teammates
receive, **the "Reset Password" template is the one that matters**, not "Invite user".

---

## 12. Frontend

### Pages

| Route | Notes |
|---|---|
| `/` | Server redirect only, no UI. Signed out → `/login`; else → `firstAllowedRoute(role)` |
| `/login` | Public. **Uncontrolled inputs read via refs** — password-manager autofill often doesn't fire React `onChange`, leaving controlled state empty and the submit a no-op |
| `/auth/reset` | Public. Handles **two incompatible callback shapes**: `?code=` (PKCE) and `#access_token=` (implicit). Built with `detectSessionInUrl:false` and hand-consumed, because a PKCE client throws on an implicit callback |
| `/privacy`, `/terms`, `/data-deletion` | Public legal pages Meta requires for App Review |
| `/dashboard` | Overview: token-expiry banner, pending-approvals banner, 4 stat cards, usage bar, volume chart, business table |
| `/inbox` | §9 |
| `/businesses` | Create businesses, connect accounts (OAuth **or** paste-token fallback), attach scripts |
| `/scripts` | List + editor, upload & reformat, make default |
| `/settings` | Usage, plan (read-only — no billing flow exists), theme |
| `/admin` | Approvals, platform AI cost, plans, leads |
| `/users` | Super-admin only. Create/suspend/delete users; delete requires typing the email |

### Shell

`(app)/layout.tsx` is a route group, so URLs are unchanged and `proxy.ts` can gate by literal
URL. **No global topbar by design** — the inbox needs full height. `min-h-0 min-w-0` on
`<main>` is required or the flex child refuses to shrink and the inbox blows out the viewport.

Nav is `NAV.filter(l => me?.capabilities?.includes(l.feature))`. `useMe` caches
`/api/me` at **module scope** so the sidebar and page guard share one request — it is never
invalidated, so a role change requires a full reload.

### Styling

Tailwind v4, CSS-first, **no config file**. `globals.css` rebinds the `dark:` variant:

```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

Stock v4 `dark:` keys off the OS, so it would follow `prefers-color-scheme` while everything
else followed the in-app toggle. This binds both to the attribute.

Theme is a semantic CSS-variable set (`--app-bg`, `--panel-bg`, `--text-1`…`--text-6`,
`--accent*`, `--ok/--warn/--danger`), persisted in `localStorage["theme"]` and applied by a
**blocking pre-paint script** injected as the first child of `<body>`, with
`suppressHydrationWarning` on `<html>`.

Fonts: Plus Jakarta Sans + Geist Mono via `next/font/google`.

---

## 13. Deployment

Requirements: a persistent Node process, **one instance**, always on (a sleeping instance
drops Instagram webhooks), plus a daily scheduler.

Render is what this runs on. `render.yaml` defines the web service and a cron service, and is
**deliberately tracked in git** because Render's Blueprint reads it from the repo. Do not set
`PORT` — the platform injects it. Health check `/login`.

**Region matters more than expected.** Every dynamic request round-trips to origin. A
US-region service serving users in India measured ~1.2s TTFB warm (up to 3.8s). Deploy near
the users.

### Environment variables

| Var | Required | Notes |
|---|:-:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Baked into the client bundle at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Also required for Realtime |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Bypasses RLS — server only, never exposed |
| `ANTHROPIC_API_KEY` | ✅ | Read by the SDK itself, not via `process.env` in app code |
| `TOKEN_ENCRYPTION_KEY` | ✅ | 32 bytes base64. **Cannot be regenerated** — it decrypts every stored Instagram token |
| `META_APP_SECRET` | ✅ | The **Instagram** app secret. Also the OAuth `client_secret` and the webhook HMAC key |
| `INSTAGRAM_APP_ID` | ✅ | OAuth `client_id` |
| `INSTAGRAM_REDIRECT_URI` | ✅ | Must match Meta's allow-list exactly |
| `INSTAGRAM_VERIFY_TOKEN` | ✅ | Webhook handshake |
| `CRON_SECRET` | ✅ | Bearer token for the refresh job; the route fails closed without it |
| `ANTHROPIC_MODEL` | — | Defaults `claude-haiku-4-5` |
| `OPENROUTER_API_KEY`, `AI_MODEL` | — | Fallback provider |
| `MAX_CONCURRENT_REPLIES` | — | Defaults `4` |

`NEXT_PUBLIC_APP_URL` appears in `render.yaml` but **no code reads it** — the app derives its
own URL from the incoming request (`request.nextUrl.origin`). Harmless to set, not required.

---

## 14. Operations

### Token refresh (mandatory)

Instagram long-lived tokens expire after **60 days**. `POST /api/cron/refresh-tokens` renews
every non-disabled account whose token expires within 10 days **or whose expiry is unknown**
(that's how pre-tracking accounts get backfilled). Schedule it **daily** — Meta requires a
token to be >24h old before it can be refreshed.

Auth is `Bearer $CRON_SECRET` **or** a super_admin session; unauthorised returns 404.

Its key safety property: the new token is **verified against Meta before being persisted**. A
failed refresh leaves the working token in place, because overwriting with a broken token
bricks the account with no way back.

### Failure modes

| Symptom | Cause |
|---|---|
| Account silently stops replying; `190` in logs | Token expired — cron isn't running |
| DMs never arrive | Webhook URL wrong, or the account was never `subscribeToWebhooks`'d |
| Inbox renders but never updates live | Tables not in the `supabase_realtime` publication |
| Invite links point at `localhost` | Supabase Site URL / Redirect URLs misconfigured |
| Replies stop for one tenant only | Quota reached, or subscription status ≠ active/trialing |
| Everything slow | Service deployed far from users; or a sleeping free instance |

---

## 15. Design decisions & rationale

The parts a rebuilder would otherwise get wrong.

**Ack the webhook before doing any work.** Meta retries if you don't respond in ~5s, and a
retry means duplicate processing. Respond `{status:"received"}` immediately, then work in
`after()`. On serverless, that background work is bounded by `maxDuration` — exceed it and
the reply is killed mid-generation *after* Meta already got its 200: a silent no-reply.

**Uniqueness must be scoped to the tenant.** `igsid` was originally globally unique. The
moment a customer DM'd a second business, the insert raised `23505`, which the webhook's
retry handler swallowed — producing a permanent silent no-reply. Same class of bug for
`instagram_msg_id`. Both are now scoped: `(instagram_account_id, igsid)` and
`(conversation_id, instagram_msg_id)`.

**Use the DB for dedupe, not application logic.** Meta retries are absorbed by catching
Postgres `23505` on insert. It's atomic and correct under concurrency; an application-level
"have I seen this?" check is not.

**Never fall back to another tenant.** `resolveAccountByIgId` returns `null` at four distinct
points (unknown account, account not approved, business not approved, no script), each with
its own warning. Ignoring the event is always correct; guessing is a cross-tenant leak.

**Status is never taken from a request body.** A client could otherwise self-approve and
bypass the super-admin gate. Mutations use hard field whitelists.

**404, never 403.** A 403 confirms the surface exists. Every capability failure returns 404.

**Guards fail closed** — unknown role gets zero capabilities; a missing `CRON_SECRET` means
no anonymous access. The one deliberate exception is the webhook signature check, which fails
*open* with a loud warning when `META_APP_SECRET` is unset, because failing closed there
would silently drop every real message.

**Tokens are encrypted at rest and never selected into a client response.** AES-256-GCM,
version-prefixed (`v1:iv:tag:ciphertext`) so the scheme can rotate without guessing at old
rows. The API layer additionally never puts `access_token` in a `.select()`.

**Reply from the conversation's own account token.** The token is the sender identity; a
global token would send from the wrong business.

**Deleting a user means deleting the `auth.users` row.** The FK is
`profiles.id → auth.users(id) ON DELETE CASCADE`, one-way. Deleting the profile row instead
leaves a live, login-capable auth account — and one whose missing profile now defaults to
role `client`.

**Never let the last super_admin be demoted or deleted.** Nothing in the app can create one;
recovery would need direct SQL.

**Don't render metrics you can't compute.** The reference design's "AI efficiency" score and
"data captured" panel were removed rather than mocked, because no ground-truth signal exists
in the schema. Week-over-week delta is `null` (and hidden) rather than a meaningless "+100%"
when there's no baseline.

---

## 16. Known gaps and defects

Carried forward honestly — these are the state of the code, not aspirations.

**Architectural gaps**
- **No reservation or order model.** Reservations complete off-platform (a link in the script
  text); the app never learns the outcome. Takeaway "orders" exist only as an unparsed line
  of text in `instagram_messages`.
- **No structured extraction.** The AI path is free-text only; nothing inspects replies.
- **`instagram_messages` has no `source` column** — an AI reply and a human staff reply are
  both `role='assistant'` and indistinguishable. This limits analytics.
- **Single instance only.** The concurrency gate is in-process.
- **No pagination** on the message list; `/api/conversations` does an N+1 for previews.

**Defects worth fixing**
- Quota **fails open** on a DB error (§10).
- `/api/usage` shows zeros for staff (§10).
- `sendInstagramMessage` never checks its response — send failures are silent.
- `/businesses` script toggle: the branch labelled "Detach" actually **attaches** the business
  default.
- Legal pages' `<title>` says "mera-kaam" while all body copy says "Instasuite".
- `agent` role degrades oddly: no `overview` ⇒ the sidebar plan widget silently vanishes
  (`/api/usage` 404s); no `scripts` ⇒ the inbox context panel permanently reads "No script
  resolved" (`/api/scripts` 404s).
- No theme context — Sidebar and Settings hold independent state and desync mid-navigation.
- Inbox send/delete and every `/admin` mutation **ignore the response**; only the mode toggle
  and `/users` check `res.ok`.
- `/admin` uses raw Tailwind palette classes instead of theme vars — it will look wrong in
  light mode.

**Dead code**
- `src/lib/script.ts` (`CAPICHE_SCRIPT`) — no importers.
- `src/app/request-access-form.tsx` — no importers; the landing page it belonged to is gone.
- `auth/callback` is excluded in the proxy matcher but no such route exists.
- `useCapability()` is exported and unused.

**Not built:** WhatsApp integration (dish availability in, order notifications out) is fully
designed in `WHATSAPP-INTEGRATION-PLAN.md` but not implemented.

**Documentation is gitignored.** `DEPLOY.md`, `AGENTS.md`, `APP_REVIEW.md`, `ONBOARDING.md`
and others are excluded from the repo, so a fresh clone gets none of the operational runbooks.

---

## 17. Rebuild checklist

1. **Supabase project.** Create it in a region near your users.
2. **Schema.** Run `0001`→`0005` in order, then create `instagram_conversations` and
   `instagram_messages` from §4 — *they are not in the migrations.*
3. **Realtime.** Add both those tables to the `supabase_realtime` publication in the
   dashboard, or the inbox will never update.
4. **Seed a plan and a super-admin.** Insert a `plans` row, create an auth user, then insert
   a matching `profiles` row with `role='super_admin'`. Without the profile row they silently
   become a `client`.
5. **Meta app.** Add the Instagram product, note the **Instagram** app id/secret, set scopes,
   the OAuth redirect URI, and the webhook callback + verify token + `messages` field.
6. **Env vars.** All ten required ones from §13. Generate `TOKEN_ENCRYPTION_KEY` once
   (32 bytes base64) and never lose it.
7. **Deploy.** Persistent Node process, one instance, always on, near your users.
8. **Custom domain + DNS**, then point Meta's webhook and OAuth redirect at it.
9. **Email.** Custom SMTP, Site URL + wildcard redirect allow-list, paste the templates,
   add SPF/DKIM/DMARC.
10. **Schedule the cron** — daily `POST /api/cron/refresh-tokens` with `Bearer $CRON_SECRET`.
11. **Verify end to end:** connect an Instagram account via OAuth → confirm it was
    webhook-subscribed → DM it from another account → an AI reply arrives and appears live in
    the inbox → a `usage_events` row was written.
