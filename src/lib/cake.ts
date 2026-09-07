// Is this takeaway a WHOLE CAKE order?
//
// Cakes are a different animal from the rest of the takeaway board: Part 25 of the Capiche
// script (Part 23 in Aiko's) makes them advance orders — Surat only, placed a day ahead,
// pickup from 2:00 PM — while everything else on that board is food to collect within the
// hour. They look identical in the list, so the Orders page badges them.
//
// Deliberately NOT in order-detect.ts: that module imports node:crypto for dedupeKey's
// sha1, and this has to be importable from the "use client" Orders page. Pure, no imports.
//
// Detection is heuristic because there is no structured marker — `orders.details` is the
// ` · `-joined summary the AI emitted. A marker in the TAKEAWAY hand-off line would be
// sturdier, but it could only ever tag FUTURE orders; reading the text badges the ledger
// we already have.

// The 11 cake flavours, from THE CAKES in the script's cake Part. Both brands ship the
// identical list. This mirrors menu data that lives in prose, so it will drift if the cake
// menu changes — update it here when the script's list changes.
//
// Two flavours are missing ON PURPOSE, because they are also plated desserts:
//   · "Tiramisu"      — a Capiche dessert at Rs 640 (only "Tiramisu cake" counts)
//   · "Ferrero Crunch" — an Aiko dessert at Rs 600
// Badging those on the bare name would flag ordinary dessert orders as cakes. When someone
// really does order one as a cake it carries a weight, which the size rule below catches.
const CAKE_FLAVOURS =
  /\b(?:ultimate chocolate|birthday cake|coconut rose|almond praline|berry mascarpone|german chocolate|jim jam biscoff|humming ?bird|carrot cake|tiramisu cake)\b/i;

// Whole cakes are sold ONLY as 500 g / 1 kg / 1.5 kg / 2 kg, and a plated dessert is never
// sold by weight — so a weight in the items is the single most reliable cake signal, and the
// one that still works when the AI writes a flavour we don't know about.
const CAKE_SIZE = /\b(?:500\s*g(?:ms?)?|1\s*kg|1\.5\s*kg|2\s*kg)\b/i;

// "cake" as its own word. \b already prevents a match inside "cheesecake" (no boundary
// between "cheese" and "cake"), so Jamun Cheesecake needs no special case — but
// "Pistachio Mousse Cake", a Capiche dessert, does.
const CAKE_WORD = /\bcakes?\b/i;
const MOUSSE_CAKE = /\bmousse\s+cakes?\b/i;

/**
 * True when an order's `details` describes a whole cake.
 *
 * Callers must gate on kind === "takeaway" themselves: a reservation that happens to
 * mention a birthday cake is a different situation and isn't what the badge is for.
 */
export function isCakeOrder(details: string | null | undefined): boolean {
  const d = (details ?? "").trim();
  if (!d) return false;
  if (CAKE_SIZE.test(d)) return true;
  if (CAKE_FLAVOURS.test(d)) return true;
  return CAKE_WORD.test(d) && !MOUSSE_CAKE.test(d);
}
