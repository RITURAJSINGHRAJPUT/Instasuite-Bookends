# Email templates

Supabase stores auth email templates in its dashboard, not in this repo. These files are
the source of truth — edit here, then paste into
**Authentication → Emails → Templates** and save.

| File | Paste into | Live today? |
|---|---|---|
| `reset-password.html` | **Reset Password** | **Yes** — this is the one users actually receive |
| `invite-user.html` | **Invite user** | No — see below |

**Why "Reset Password" covers invites too.** `/api/admin/users` creates the account itself
and then mints a recovery link (`generateLink({ type: "recovery" })`), so a brand-new
teammate receives the *Reset Password* template, not the Invite one. That's why its copy
covers both "you forgot your password" and "you're setting one for the first time".
`invite-user.html` only becomes live if that route is switched to `inviteUserByEmail()`.

## Variables

Supabase renders Go templates. Available:

| Variable | Meaning |
|---|---|
| `{{ .ConfirmationURL }}` | The action link, including `redirect_to` |
| `{{ .Email }}` | Recipient's address |
| `{{ .SiteURL }}` | Project's configured Site URL |
| `{{ .Token }}` / `{{ .TokenHash }}` | 6-digit OTP / hash, if using code-based flows |

`{{ .ConfirmationURL }}` only lands on the right domain when **Authentication → URL
Configuration** is correct — Site URL `https://instasuite.in` and a redirect entry of
`https://instasuite.in/**`. Without the wildcard, Supabase silently rewrites the redirect to
the Site URL and the link goes to the wrong place.

The app itself does not hardcode this: `/api/admin/users` builds `redirectTo` from
`request.nextUrl.origin`, so the link follows whichever domain the dashboard was opened on.
The Site URL and the allowlist are what actually decide where a recipient lands.

## Why these templates look the way they do

The stock Supabase template is a heading, one sentence and a bare link — structurally
identical to a phishing mail, and it got filed as spam by Gmail. These are written for the
filter as much as the reader:

- **Table layout, inline CSS.** Mail clients strip `<style>` blocks.
- **No remote images, no web fonts.** Both are spam signals, and Gmail blocks images from
  unknown senders by default — an image-only header renders as an empty box.
- **The destination URL appears as visible text**, not only behind a button. A hidden
  destination is one of the strongest phishing signals, and it also rescues clients that
  strip buttons.
- **Enough prose** to fix the text-to-link ratio, and it says *why* the recipient got it.
- **Calm copy.** No caps, no exclamation marks, no "click here now".

## DNS (deliverability)

Sending domain is **`instasuite.in`** (moved from `click2pdf.in`). Mail is sent by Resend via
Supabase's custom SMTP, so BOTH have to agree on the domain:

1. **Resend** → Domains → add `instasuite.in` and add the DKIM/SPF records it gives you.
   Wait for it to show *Verified* — Resend refuses to send from an unverified domain, and
   that rejection surfaces in the app as the "couldn't email" fallback path.
2. **Supabase** → Authentication → SMTP Settings → set the sender address to something on
   `instasuite.in` (e.g. `no-reply@instasuite.in`). This is the setting that actually
   changes who the mail is *from*; the templates in this folder only affect the body.
3. **Supabase** → Authentication → URL Configuration → Site URL and redirect allowlist, as
   above.

Records needed on `instasuite.in`, mirroring what was verified on the old domain:

- **DKIM** — the `resend._domainkey` TXT record Resend generates, so `d=instasuite.in` aligns.
- **SPF** — on Resend's Return-Path subdomain (`send.instasuite.in`) →
  `v=spf1 include:amazonses.com ~all`.
- **DMARC** — `_dmarc.instasuite.in` → start at `p=none` while you confirm SPF and DKIM pass,
  then tighten to `p=quarantine`. Going straight to quarantine on an unproven domain sends
  your own invites to spam if anything is misaligned.

⚠️ Reputation does NOT transfer between domains. `instasuite.in` starts cold even though
`click2pdf.in` was warm, so expect the first sends to be filtered more aggressively.

## Testing

1. Send a reset to a Gmail address that has **never** marked this sender. An address where
   you already clicked "Report not spam" will inbox regardless and proves nothing.
2. In Gmail: **⋮ → Show original** → expect `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
3. Reputation on a new sending domain takes days of real sends to settle. Treat any single
   result as directional.
