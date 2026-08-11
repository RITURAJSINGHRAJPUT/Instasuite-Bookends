import Nav from "./landing/Nav";
import Hero from "./landing/Hero";
import HowItWorks from "./landing/HowItWorks";
import Features from "./landing/Features";
import BuiltForRestaurants from "./landing/BuiltForRestaurants";
import RoadmapTeaser from "./landing/RoadmapTeaser";
import FinalCta from "./landing/FinalCta";
import Footer from "./landing/Footer";

// Public marketing page for signed-out visitors — see src/app/page.tsx for the
// signed-in branch. Everything here stays a Server Component for SEO/SSR; only
// the GSAP-driven reveal/entrance wrappers (landing/HeroReveal.tsx,
// landing/animation/Reveal.tsx) are client islands.
export default function Landing() {
  return (
    <div className="min-h-full bg-[var(--app-bg)]">
      <Nav />
      <Hero />
      <HowItWorks />
      <Features />
      <BuiltForRestaurants />
      <RoadmapTeaser />
      <FinalCta />
      <Footer />
    </div>
  );
}
