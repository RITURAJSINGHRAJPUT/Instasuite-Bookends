import { Store, Building2, ShoppingBag, CalendarCheck } from "lucide-react";
import Reveal from "./animation/Reveal";

const CASES = [
  { icon: Store, title: "Single outlet", body: "One restaurant, one Instagram account, up and running fast." },
  {
    icon: Building2,
    title: "Multi-outlet groups",
    body: "Run several outlets under one brand, each with its own hours and availability, sharing one script.",
  },
  {
    icon: ShoppingBag,
    title: "Takeaway-only kitchens",
    body: "No dine-in to manage — just fast, accurate takeaway order capture from DMs.",
  },
  {
    icon: CalendarCheck,
    title: "Dine-in with reservations",
    body: "Table bookings confirmed straight from the conversation, no phone tag.",
  },
];

export default function BuiltForRestaurants() {
  return (
    <section id="restaurants" className="mx-auto max-w-6xl px-6 py-20">
      <Reveal>
        <h2 className="text-2xl font-extrabold tracking-tight text-[var(--text-1)] md:text-3xl">
          Built for restaurants and hospitality
        </h2>
        <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-[var(--text-3)]">
          However your restaurant operates, Instasuite fits the way you actually take orders and
          bookings.
        </p>
      </Reveal>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {CASES.map((c, i) => (
          <Reveal key={c.title} delay={i * 0.06}>
            <div className="flex items-start gap-3.5 rounded-2xl border border-[var(--border)] bg-[var(--panel-bg)] p-5">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                <c.icon size={16} strokeWidth={2.2} />
              </div>
              <div>
                <h3 className="text-[14px] font-bold text-[var(--text-1)]">{c.title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-3)]">{c.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
