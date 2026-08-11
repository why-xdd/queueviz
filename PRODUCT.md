# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Backend and SRE-leaning software engineers who already sort of know queueing
theory but have never had the phenomena *click*. The primary usage scene is
solo and exploratory: someone opens the page after reading a blog post about
tail latency, or after being surprised by a p99 problem at work, and drives the
knobs themselves. Talks, mentoring, and hiring evaluations are downstream
audiences, not the target.

## Product Purpose

Turn queueing behaviour — arrivals, service, disciplines, backpressure, rate
limiting, fair queueing — into something a person can *watch* rather than
derive on paper. The bet is that ten seconds of watching a queue build at 95%
load, and then not build once backpressure is switched on, produces an
intuition that a correct algebra proof does not.

Success is a reader forwarding a link, bookmarking it, or citing a specific
preset ("go look at the collapse one") instead of writing three paragraphs.

## Positioning

- A real, seeded, 60 fps simulation with the knobs exposed — not a static
  diagram, an animated GIF, or a formula.
- Seven curated presets, each demonstrating exactly one idea in under ten
  seconds. The presets are the argument.
- Hand-rolled canvas rendering at zero runtime dependencies. The medium is part
  of the point: the artifact is small and self-contained, the way the ideas it
  teaches are.
- Opinionated author's voice throughout, in the README and in the UI. Not a
  neutral textbook.

## Operating Context

- Opened in a desktop browser, usually via a link (HN / blog / social /
  colleague DM). Rarely landed on cold.
- Session shape: pick a preset, watch for ten to thirty seconds, twiddle a
  knob, watch again. Pause with `Space`, reset with `R`. Every run is seeded,
  so a screenshot is reproducible.
- The simulation runs at 60 fps against `requestAnimationFrame`; a hidden tab
  pauses rather than fast-forwards.
- The canvas scales to `devicePixelRatio` because a blurry visualisation next
  to a crisp DOM undermines the whole "this looks designed" claim.

## Capabilities and Constraints

**Simulation model.** Arrivals are a Poisson process; service times are
log-normal-ish. Disciplines: FIFO, LIFO, priority (binary heap, FIFO within a
band), weighted fair queueing (deficit round robin across per-tenant queues).
Admission control: bounded queue, token bucket (continuous refill), leaky
bucket (constant output). Metrics surfaced: offered load, throughput, queue
depth, p50 / p99 latency, dropped count.

**Stack floor (binding for every future change).**

- Zero runtime npm dependencies.
- No framework — plain TypeScript against the DOM and canvas.
- No chart library, no UI library, no animation library, no icon package, no
  webfont loader. Anything visual is drawn or styled by hand.
- Bundle stays in the same order of magnitude as today (~7.6 kB gz JS,
  ~1.5 kB gz CSS, ~1.2 kB gz HTML). A design pass may not dissolve any of
  these to make its own work easier.

**Determinism (binding).** Everything stochastic draws from a seeded RNG so
runs reproduce. `Math.random()` is disallowed. Anything new that introduces
randomness — decorative motion, particles, staggered animations — must either
draw from the seeded RNG or be provably outside the simulated world.

**Invariants pinned by the test suite (40 tests).** Requests are conserved
(`arrived === dropped + completed + in flight`); backpressure lowers p99
without costing throughput; fair queueing serves a quiet tenant early;
the priority heap holds its invariant and stays FIFO within a band;
`requestAnimationFrame` deltas are clamped so a hidden tab cannot fast-forward
the world; every arrival in a frame is admitted; the token bucket refills
continuously and never banks more than capacity.

**Accessibility today.** Every control is reachable by tab, focus rings are
visible, segmented groups carry `aria-checked`, keyboard shortcuts are
documented in the UI (`Space`, `R`). Canvas content is labelled by
`aria-label` on the `<canvas>` element. No formal WCAG conformance target has
been committed to.

## Brand Commitments

- Name: **queueviz**, lowercase everywhere — in the title bar, the header, the
  README, the URL, any future OG image.
- Voice: opinionated, tight, second-person direct, present-tense.
  Phenomena-first ("The queue stays near empty, latency *is* service time.").
  Prose over marketing copy. No exclamation marks, no "🚀", no product-launch
  register. Explanations name the thing and then say why it matters, in that
  order.
- License: MIT.
- Attribution: `why-xdd` (GitHub: <https://github.com/why-xdd>) stays visible
  somewhere reasonable — today the README footer.
- Repository: <https://github.com/why-xdd/queueviz>.

## Evidence on Hand

- README.md — the canonical pitch and voice reference; treat as source of
  truth for tone.
- docs/screenshot.png — queueviz at 50% offered load (hero image in README).
- docs/screenshot-wfq.png — weighted fair queueing under overload, per-tenant
  lanes (the "comparison worth internalising" figure).
- src/ — the working simulation and renderer (~1200 lines TS total, roughly
  half simulation).
- 40-test suite pinning the invariants listed above.
- Build output with size reporting in the README (`dist/index.{html,css,js}`
  with gzipped sizes).
- CI: GitHub Actions workflow badged in the README.
- **Not on hand, do not invent:** user counts, star counts, testimonials,
  named customer references, third-party benchmarks against other simulators,
  academic citations, comparisons to specific books or courses.

## Product Principles

1. **Show, don't derive.** Every claim in the product resolves to something a
   viewer can see happen on screen within seconds.
2. **One idea per preset.** If a preset takes two sentences to explain what it
   is demonstrating, it is doing two things and should be split.
3. **Reproducibility is a feature, not a nice-to-have.** Seeded runs make
   screenshots re-runnable and failing tests re-playable; anything that breaks
   this is a defect.
4. **The medium is part of the argument.** No runtime dependencies, no
   framework, no chart library. A visualisation that teaches "small,
   principled systems behave well under load" cannot itself be a
   dependency-heavy bundle.
5. **Author's voice, not a house voice.** The README's opinionated register is
   deliberate. Future copy — footer lines, empty states, tooltips, an eventual
   about page — matches it rather than smoothing it into product-marketing
   neutral.

## Accessibility & Inclusion

Documented today: full keyboard reachability, visible focus rings,
`aria-checked` on segmented groups, `aria-label` on the canvas, keyboard
shortcuts described in the UI. No formal WCAG level, colour-contrast target,
or reduced-motion behaviour has been committed to — future work that touches
motion, colour, or interactive controls should decide these explicitly rather
than assuming inheritance.
