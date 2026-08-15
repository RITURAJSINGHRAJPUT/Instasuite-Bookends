# Instasuite AI Agent — Test Cases & Sample Chat

_Last updated: 2026-08-13_

This covers the AI reply agent's behavior end-to-end: normal reservation/takeaway flows, and every exception case added by the recent cost-optimization and reliability work (trivial-message filtering, burst debounce, phone-reply sync, human handoff).

---

## Sample chat — normal reservation flow

A full, realistic conversation showing the exact message formats currently in production.

```
Guest:      👋
Instasuite: Hey there! 👋 Welcome to Aiko — are you looking to book a table or
            place a takeaway order?
            [canned reply — no AI call, this is the opening message]

Guest:      table for 2 tonight please
Instasuite: Sure — I'd love to set up your reservation! Which outlet, and
            what time tonight?

Guest:      Pal, Surat around 8pm
Instasuite: Got it — table for 2 at Pal, Surat, tonight at 8:00 PM. Could I
            get your name and a contact number?

Guest:      Rituraj, 7990201438
Instasuite: Perfect, Rituraj! Just confirming — table for 2 at Pal, Surat,
            tonight at 8:00 PM. Our team will review your reservation
            request and confirm it with you shortly. Let me know if you'd
            like to change anything before then!
            [internal handoff line captured to Orders — stripped from what
            the guest sees]

Guest:      🙏
Instasuite: (no reply — trivial acknowledgment after the request was
            already captured; nothing sent, no AI call)
```

Staff then confirms from `/orders`, which sends a separate, real confirmation:

```
Instasuite: ✅ Your reservation is confirmed!
            · Outlet: Pal, Surat
            · Date & time: Tonight, 8:00 PM
            · Party size: 2
            · Contact: 7990201438
            We'll have your table ready — see you then!
```

## Sample chat — normal takeaway flow

```
Guest:      hi, can I order 4 dragon rolls for pickup
Instasuite: Sure! 4× Dragon Roll — got it. Which outlet would you like to
            pick up from, and roughly what time?

Guest:      Pal, Surat, around 2pm
Instasuite: Perfect, Rituraj! Just to confirm — you're picking up today at
            2:00 PM from Pal, Surat.

            Your order:
            4× Dragon Roll  Rs 940 each

            Subtotal: Rs 3760
            GST (5%): Rs 188
            Total payable: Rs 3948

            Our team will confirm your order and revert to you shortly.
```

---

## Normal-flow test cases

| # | Scenario | Expected result |
|---|---|---|
| N1 | Guest states reservation intent directly in their opening message ("Hi, table for 4 tonight") | AI acknowledges immediately and starts collecting missing details — does **not** send the generic welcome (real AI call, since real intent is present) |
| N2 | Guest gives reservation details one at a time across several messages, spaced apart | AI never re-asks for a detail already given; asks only for what's missing each turn |
| N3 | Guest completes a reservation | AI sends the confirmation summary ending in "Our team will review your reservation request and confirm it with you shortly" — never claims it's already confirmed |
| N4 | Guest completes a takeaway order | AI sends an itemized bill (subtotal, 5% GST, total) ending in "Our team will confirm your order and revert to you shortly" — never claims it's ready by a specific time |
| N5 | Staff confirms the order/reservation from `/orders` | A separate "✅ confirmed" message is sent to the guest, with real details |
| N6 | Guest asks a menu/hours/policy question mid-flow | Answered directly from the script's facts, without derailing the reservation/order already in progress |
| N7 | Guest places a second, new order after an earlier one was finalized | Treated as a fresh request — AI does not resume, re-confirm, or re-emit the finished order, and does not restart with a generic greeting |

## Exception / edge-case test cases

| # | Conversation state | Guest sends | Expected behavior | AI call? |
|---|---|---|---|---|
| E1 | Brand new conversation | `👋` / `😊` (pure emoji) | Canned welcome sent instantly | No |
| E2 | Brand new | `hi` / `hello` / `hey` / `yo` | Canned welcome sent instantly | No |
| E3 | Brand new | `info?` | Canned welcome sent instantly | No |
| E4 | Brand new | `Hi, table for 4 tonight` | Real intent present — normal AI flow, not treated as a no-intent opener | Yes |
| E5 | Mid-conversation, order not yet finalized | `👍` (e.g. after AI asked "which outlet?") | No reply — a thumbs-up was never a valid answer to that question anyway | No |
| E6 | Right after an order was finalized | `thanks` / `thank you` / `🙏` | No reply | No |
| E7 | AI just asked "Shall I confirm — table for 4, 8pm?" | `yes` | Reaches the AI normally and confirms — **must never be swallowed** | Yes |
| E8 | Same as E7 | `ok` | Reaches the AI normally — deliberately excluded from the trivial list for exactly this reason | Yes |
| E9 | Mid-conversation | `no` / `actually make it 6 people` | Reaches the AI normally | Yes |
| E10 | Guest sends 3 short messages in a burst | `hi` → 3s later `table for 2` → 4s later `tonight 8pm` | Each message resets a 6s debounce timer; only after 6s of silence does ONE AI call fire, covering all three merged into one turn | Yes (×1, not ×3) |
| E11 | Mid-burst | `table for 2 tonight` → 2s later `🙏` (before the debounce timer fires) | The emoji is stored but doesn't reset the debounce; when the timer fires, both rows are in history and get merged into one turn before the AI sees them | Yes (×1) |
| E12 | Staff replies manually from the connected account's own phone (Instagram app, not the dashboard) | Anything | The reply syncs into the ongoing chat in `/inbox`, and the conversation flips to human mode — the AI stops auto-replying to that guest | No (for that message, and for anything after until a human hands it back) |
| E13 | Conversation already in human mode | Anything, trivial or not | No AI call, no automated reply | No |
| E14 | AI is unavailable (paused key, outage, or refusal) | Any message | Guest gets a safe holding message ("Our team will get back to you shortly"), conversation flips to human mode | Attempted, but no usable reply |
| E15 | AI detects a REVIEW matter (complaint, collab pitch, billing question, etc.) | Any message describing one of these | Captured to `/review`, conversation flips to human mode so a person takes over | Yes |
| E16 | Client's monthly message quota is exhausted | Any message | Message is still stored, but no AI reply is sent or attempted until the quota resets or the plan is upgraded | No |
| E17 | Guest asks about a finished order after the fact ("what did I order earlier?") | Any past-order reference | The context-reset filter is lifted for that one turn so the AI can see the full transcript and answer accurately | Yes |
| E18 | Brand new conversation | `🍕` (an emoji that could arguably mean "I want pizza") | Still treated as a no-intent opener — pure emoji, regardless of which one — canned welcome sent. Deliberate simplification rather than trying to interpret specific emoji meaning | No |

## How to run these manually

1. Use a test Instagram account to DM a connected business account.
2. For the AI-call cases, watch server logs and/or `usage_events` in the dashboard to confirm whether a Claude call actually fired.
3. For E7/E8/E9 specifically — these are the highest-risk cases (a false positive here silently drops a real booking answer) — verify explicitly on every change to the trivial-message lists in `src/lib/message-triage.ts`.
4. For E10/E11 (debounce) — time the messages with a stopwatch; sending them faster than ~6s apart is required to trigger batching.
5. For E12 (phone sync) — reply from the actual Instagram mobile app on the connected account, not the dashboard.
