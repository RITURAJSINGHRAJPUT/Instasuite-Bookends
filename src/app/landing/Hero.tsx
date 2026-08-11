import HeroReveal from "./HeroReveal";
import InboxMockup from "./InboxMockup";

export default function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 md:pb-28 md:pt-24">
      <HeroReveal>
        <div className="grid items-center gap-12 md:grid-cols-2 md:gap-8">
          <div>
            <span
              data-hero-item
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[var(--accent)]"
            >
              AI Instagram DM agent for restaurants
            </span>

            <h1
              data-hero-item
              className="mt-5 text-4xl font-extrabold leading-tight tracking-tight text-[var(--text-1)] md:text-5xl"
            >
              Every Instagram DM, answered like your best host.
            </h1>

            <p data-hero-item className="mt-5 max-w-md text-[15px] leading-relaxed text-[var(--text-3)]">
              Instasuite&apos;s AI agent replies to your restaurant&apos;s Instagram DMs in your
              own voice — capturing table reservations and takeaway orders straight out of the
              conversation, ready for your team to confirm.
            </p>

            <div data-hero-item className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#request-access"
                className="rounded-xl bg-[var(--accent)] px-5 py-3 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Request access
              </a>
              <a
                href="#how-it-works"
                className="rounded-xl border border-[var(--border-strong)] px-5 py-3 text-sm font-bold text-[var(--text-2)] transition-colors hover:bg-[var(--surface-1)]"
              >
                See how it works
              </a>
            </div>
          </div>

          <div data-hero-item>
            <InboxMockup />
          </div>
        </div>
      </HeroReveal>
    </section>
  );
}
