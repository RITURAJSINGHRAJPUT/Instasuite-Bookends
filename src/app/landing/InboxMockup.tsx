// Illustrative mockup, not a real screenshot — no real customer data exists to
// show. Reuses the actual inbox's visual language (avatar gradient, message
// bubble shapes, status chip) so it reads as "this is really the product,"
// just with a generic guest name instead of doctoring a fake screenshot.
function Avatar({ initial }: { initial: string }) {
  return (
    <div
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white"
      style={{ background: "var(--brand-gradient)" }}
    >
      {initial}
    </div>
  );
}

function Bubble({ from, children }: { from: "guest" | "agent"; children: string }) {
  const isGuest = from === "guest";
  return (
    <div className={`flex ${isGuest ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-[12.5px] leading-relaxed ${
          isGuest
            ? "rounded-tl-sm border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-2)]"
            : "rounded-tr-sm text-white"
        }`}
        style={!isGuest ? { background: "var(--accent)" } : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export default function InboxMockup() {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] shadow-xl">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--danger)]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--warn)]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--ok)]/60" />
        <span className="ml-2 text-[11px] font-bold text-[var(--text-4)]">Inbox</span>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-start gap-2.5">
          <Avatar initial="G" />
          <div className="flex-1 space-y-1.5">
            <Bubble from="guest">Do you have a table for 4 tonight around 8?</Bubble>
          </div>
        </div>

        <div className="space-y-1.5 pl-11">
          <Bubble from="agent">
            We do! 8:00 PM for 4 at our Piplod outlet works — want me to book it?
          </Bubble>
          <Bubble from="guest">Yes please</Bubble>
        </div>

        <div className="flex items-center gap-2 pl-11">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ok-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--ok)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
            Reservation captured
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3">
        <div className="flex flex-1 items-center gap-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-5)] [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-5)] [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-5)]" />
        </div>
        <span className="text-[10px] text-[var(--text-5)]">Synced to your dashboard</span>
      </div>
    </div>
  );
}
