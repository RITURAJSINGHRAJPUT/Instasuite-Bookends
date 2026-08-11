import RequestAccessForm from "../request-access-form";
import Reveal from "./animation/Reveal";

export default function FinalCta() {
  return (
    <section id="request-access" className="mx-auto max-w-2xl px-6 py-20">
      <Reveal>
        <div className="text-center">
          <h2 className="text-2xl font-extrabold tracking-tight text-[var(--text-1)] md:text-3xl">
            Let&apos;s get your Instagram set up
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-[var(--text-3)]">
            We onboard every account by hand, so there&apos;s no instant signup — tell us about
            your restaurant and we&apos;ll reach out to set things up.
          </p>
        </div>

        <div className="mt-8">
          <RequestAccessForm />
        </div>
      </Reveal>
    </section>
  );
}
