// Canned replies staff can send from the Review page.
//
// Shared by the API route that sends it and the page that previews it before
// sending. Kept in one module deliberately: if the page rendered its own copy,
// the two could drift and staff would approve one wording while the guest
// received another.

/**
 * The standing answer to collaboration / paid-promo / barter proposals.
 *
 * Brand-neutral on purpose ("us", "we") so the same text serves every connected
 * account. Must stay under Instagram's 1000-character message limit — past that
 * sendInstagramMessage splits it and the guest receives two bubbles.
 */
export const COLLAB_DECLINE = `Hi! Thank you so much for reaching out and for considering us for a collaboration. We truly appreciate your interest and the thought behind it. 🤍

At the moment, we're not taking up any collaborations, partnerships, or promotional exchanges. We hope you understand, and we'd be happy to welcome you as a guest anytime.

Thank you once again for reaching out and wishing you all the best! ✨`;

/**
 * Button label. Names the collab case explicitly rather than saying "Send reply":
 * the button appears on every review category, so this text is the only thing
 * telling staff what will actually go out to a complaint or billing item.
 */
export const COLLAB_DECLINE_LABEL = "Send collab decline";
