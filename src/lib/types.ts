import type { Media } from "./attachments";

export interface Conversation {
  id: string;
  igsid: string;
  // The tenant key, added to the table by migration 0002 but never reflected
  // here. /api/conversations selects "*", so it was always in the payload.
  instagram_account_id: string;
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
  mode: "agent" | "human";
  /** Why mode last flipped to "human": "outage" (Claude failed) or "review" (flagged for a person). Null once dismissed or back in agent mode. */
  human_handoff_reason: string | null;
  updated_at: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  instagram_msg_id: string | null;
  /**
   * Story replies, story mentions and shared posts/reels (see src/lib/attachments.ts).
   * Null on a plain text message. The URLs are Meta's short-lived CDN links, so the
   * Inbox must tolerate them expiring.
   */
  attachments: Media[] | null;
  created_at: string;
}

/** The conversation's most recent captured order, if any — drives the Inbox Ongoing/Completed split. */
export interface ConversationOrder {
  kind: "reservation" | "takeaway";
  /** Reservation/pickup time as a UTC ISO string, or null if the AI didn't emit a parseable time. */
  scheduled_at: string | null;
  status: string;
}

export interface ConversationWithLastMessage extends Conversation {
  last_message: string | null;
  order?: ConversationOrder | null;
}
