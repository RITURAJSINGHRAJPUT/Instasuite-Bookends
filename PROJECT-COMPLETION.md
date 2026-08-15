# Instasuite — Project Completion Summary

_Last updated: 2026-08-13_

## Overview

Instasuite is an AI-powered Instagram DM management tool built for restaurants. It auto-replies to incoming Instagram DMs in a restaurant's own voice, captures takeaway orders and table reservations straight out of the conversation, and gives staff a dashboard to review, confirm, and manage everything.

## Core Features

- **AI auto-reply agent** — replies to Instagram DMs using a per-business script (each restaurant brand has its own script defining tone, menu, hours, and outlets).
- **Takeaway order capture** — items, special instructions, pickup time, and contact number extracted automatically from the conversation and billed with GST breakdown.
- **Table reservation capture** — outlet, date, time, party size, and contact captured automatically.
- **No auto-acceptance** — orders and reservations are never presented to the guest as already confirmed; the AI always tells the guest the team will review and confirm shortly. Staff confirm from the dashboard.
- **Staff dashboard** — Overview, Inbox, Orders, Review (handoff items like complaints/collabs), Unavailable, Businesses, AI Scripts, Settings, Admin, Users.
- **Live conversation sync** — messages sent manually from the connected account's own Instagram app (phone) now sync into the ongoing chat in the dashboard in real time, and hand the conversation off to a human so the AI doesn't also reply.
- **Order/reservation notification sound** — a short chime plays in the dashboard whenever a new pending order or reservation arrives.
- **Multi-business / multi-account support** — one operator can run several restaurant brands, each with its own Instagram account(s), script, and outlets.
- **Instagram account connection** — via Instagram Business Login (OAuth) or a manually pasted long-lived access token as a fallback; access tokens are encrypted at rest and refreshed automatically before they expire.
- **Public marketing landing page** — a real public homepage (`/`) with a hero, "how it works" walkthrough, feature highlights, a restaurant-focused use-cases section, a "coming soon" roadmap teaser, and a request-access contact form — polished with restrained GSAP scroll animations, fully respecting `prefers-reduced-motion`.

## Roles & Access

| Role | Overview | Inbox | Orders | Review | Unavailable | Businesses | AI Scripts | Settings | Admin | Users |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Super admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Manager | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Agent | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Client (legacy) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

- **Manager cannot access Businesses** — can't connect/disconnect Instagram accounts or edit business settings; restricted to day-to-day operations.
- **Super admin is bootstrap-only** — there's meant to be exactly one at a time. It cannot be assigned to anyone through the Users page or the underlying API, either at creation or via a role change — enforced both in the UI (the option is hidden) and server-side (the API rejects it outright). It can only be set up directly, matching how the very first super admin account is provisioned.
- Every role restriction is enforced at the API level, not just hidden in the UI — a denied role gets a clean "not found" response even with a hand-crafted request.

## Public Landing Page

- Lives at `/` — signed-out visitors see the marketing page; signed-in users are still redirected straight to their dashboard, unchanged.
- Content is honest to what the product actually does today: no fabricated customer logos, no invented usage stats, no "free trial / no credit card" claims. Instasuite onboards every account manually — the landing page reflects that with a "Request access" flow instead of self-serve signup.
- The request-access form is a real, working lead-capture form that reaches the team for manual follow-up.
- No pricing section yet — pricing is still discussed manually rather than published.

## Instagram Integration

- Connects via a Meta Developer app using Instagram Business Login.
- Webhook verified with a signature check so only genuine Meta traffic is processed.
- Handles: inbound guest messages, the AI's own outbound replies, manually-sent dashboard replies, and now also messages sent manually from the phone app — all correctly deduplicated so nothing appears twice.
- Currently live on a custom domain with the webhook and OAuth callback fully verified end-to-end.

## Recent Work Completed

1. Removed two previously-connected Instagram accounts and prepared the app for two new ones on a fresh Meta app, using the same restaurant scripts as before.
2. Added an audible notification when a new takeaway order or reservation arrives, without needing to keep the Orders page open.
3. Fully configured and verified the new Instagram app: webhook callback, verify token, and OAuth redirect, all live on the custom domain.
4. Built the public marketing landing page from scratch, matching the existing product's visual design system, with tasteful scroll/entrance animation.
5. Restricted the Manager role from the Businesses page.
6. Locked Super Admin so it can never be granted through the app itself — only one is meant to exist at a time.
7. Fixed the AI's order-confirmation wording so it never implies an order is already accepted or ready — it now always says the team will confirm and revert shortly, matching how reservations were already handled.
8. Fixed a gap where replies sent manually from the connected Instagram account's phone app never appeared in the dashboard's chat history — they now sync in and correctly hand the conversation to a human so the AI stops auto-replying to that guest.

## Tech Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **Styling**: Tailwind CSS v4, Plus Jakarta Sans typeface
- **Icons**: lucide-react
- **Animation**: GSAP + `@gsap/react` (landing page only)
- **AI**: Anthropic Claude (primary), OpenRouter (fallback)
- **Backend/auth**: Supabase (Postgres + Auth) — see the project's own setup docs for schema details
- **Messaging**: Meta Instagram Graph API (Business Login + Messaging webhook)
- **Hosting**: Render (web service + a daily cron for token refresh), custom domain

## Environment Variables Required (names only — see `.env.local` for actual values)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OPENROUTER_API_KEY`, `AI_MODEL`, `INSTAGRAM_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_VERIFY_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`, `MAX_CONCURRENT_REPLIES`.

## Known Gaps / Possible Next Steps

- **Historical phone-sent messages aren't backfilled** — the chat-sync fix only applies going forward from when it was deployed; older phone-sent replies in existing conversations were never stored and can't be recovered automatically without a separate one-time backfill using Instagram's conversation-history API.
- **No pricing section** on the landing page yet.
- **No self-serve signup** — every account is still onboarded by hand; this is intentional for now, not a bug.
- **"Coming soon" roadmap items** (WhatsApp/Messenger, richer analytics) are teased on the landing page but not yet built.
