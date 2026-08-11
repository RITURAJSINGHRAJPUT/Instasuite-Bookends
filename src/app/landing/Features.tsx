import { FileText, ShoppingBag, CalendarCheck, LayoutGrid } from "lucide-react";
import Reveal from "./animation/Reveal";

const FEATURES = [
  {
    icon: FileText,
    title: "AI replies in your restaurant's voice",
    body: "Every business gets its own script — menu, tone, outlet details — so replies sound like your restaurant, not a generic bot.",
  },
  {
    icon: ShoppingBag,
    title: "Takeaway orders captured automatically",
    body: "Items, pickup time, and contact details pulled straight from the conversation — no manual re-typing.",
  },
  {
    icon: CalendarCheck,
    title: "Reservations captured automatically",
    body: "Outlet, date, time, party size, and contact — captured and ready for your team to confirm.",
  },
  {
    icon: LayoutGrid,
    title: "One dashboard, every business",
    body: "Orders, reviews, businesses, scripts, and your team — multi-business and multi-Instagram-account support in one place.",
  },
];

export default function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-20">
      <Reveal>
        <h2 className="text-2xl font-extrabold tracking-tight text-[var(--text-1)] md:text-3xl">
          Everything the DM needs to become an order
        </h2>
      </Reveal>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 0.06}>
            <div className="h-full rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <f.icon size={18} strokeWidth={2.2} />
              </div>
              <h3 className="mt-4 text-[15px] font-bold text-[var(--text-1)]">{f.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-3)]">{f.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
