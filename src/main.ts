/**
 * App entry: build the controls, run the loop, keep the two in sync.
 */

import { Renderer } from "./render/canvas";
import { formatDuration, formatRate, loadColour } from "./render/theme";
import { Simulation, defaultConfig, type Config } from "./sim/engine";
import type { DisciplineName } from "./sim/queues";
import type { LimiterName } from "./sim/limiters";
import "./style.css";

const sim = new Simulation();
const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const renderer = new Renderer(canvas);

/**
 * A viewer who asked their system for less motion does not get a 60fps canvas
 * thrown at them unannounced. CSS cannot pause a simulation, so the page opens
 * paused for them, with the Play button as the invitation. Everyone else starts
 * running — the motion *is* the content.
 */
const prefersReducedMotion =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

let running = !prefersReducedMotion;
let lastFrame = performance.now();
let speed = 1;

// -- presets ----------------------------------------------------------------

/**
 * Named starting points, because the interesting configurations are not the
 * ones people find by dragging sliders at random. Each one demonstrates a
 * single idea in under ten seconds.
 */
const presets: Record<string, { label: string; note: string; config: Partial<Config> }> = {
  healthy: {
    label: "Healthy",
    note: "Load at 50%. The queue stays near empty and latency is just service time.",
    config: { ...defaultConfig, arrivalRate: 8, workers: 4, limiter: "none" },
  },
  knee: {
    label: "The knee",
    note: "Load at 90%. Nothing is 'overloaded', yet p99 is already several times p50 — this is the curve everyone plans capacity past.",
    config: { ...defaultConfig, arrivalRate: 14.4, workers: 4, limiter: "none" },
  },
  collapse: {
    label: "Collapse",
    note: "Load above 100% with an unbounded queue. Latency grows without limit, forever.",
    config: { ...defaultConfig, arrivalRate: 24, workers: 4, limiter: "none" },
  },
  backpressure: {
    label: "Backpressure",
    note: "Same overload, bounded queue. Some requests are dropped and the rest stay fast — the trade backpressure exists to make.",
    config: {
      ...defaultConfig, arrivalRate: 24, workers: 4,
      limiter: "bounded", limiterCapacity: 20,
    },
  },
  burst: {
    label: "Token bucket",
    note: "A burst allowance that refills. Quiet clients can spike; sustained load is still capped.",
    config: {
      ...defaultConfig, arrivalRate: 24, workers: 4,
      limiter: "token-bucket", limiterCapacity: 20, limiterRate: 12,
    },
  },
  noisy: {
    label: "Noisy neighbour",
    note: "Weighted fair queueing under overload. One tenant floods their own lane and nobody else's.",
    config: { ...defaultConfig, arrivalRate: 24, workers: 4, discipline: "wfq", tenants: 3 },
  },
  starvation: {
    label: "Starvation",
    note: "Strict priority under overload. Urgent work flows; the low-priority queue grows forever.",
    config: { ...defaultConfig, arrivalRate: 24, workers: 4, discipline: "priority" },
  },
};

// -- controls ---------------------------------------------------------------

interface SliderSpec {
  key: keyof Config;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

const sliders: SliderSpec[] = [
  { key: "arrivalRate", label: "Arrival rate", min: 1, max: 60, step: 1, format: (v) => `${v}/s` },
  { key: "workers", label: "Workers", min: 1, max: 16, step: 1, format: String },
  { key: "serviceTime", label: "Service time", min: 0.05, max: 2, step: 0.05, format: (v) => formatDuration(v) },
  { key: "serviceJitter", label: "Service jitter", min: 0, max: 1.5, step: 0.1, format: (v) => v.toFixed(1) },
  { key: "limiterCapacity", label: "Limiter capacity", min: 1, max: 100, step: 1, format: String },
  { key: "limiterRate", label: "Limiter rate", min: 1, max: 60, step: 1, format: (v) => `${v}/s` },
];

const disciplines: Array<[DisciplineName, string]> = [
  ["fifo", "FIFO"],
  ["lifo", "LIFO"],
  ["priority", "Priority"],
  ["wfq", "Fair queueing"],
];

const limiters: Array<[LimiterName, string]> = [
  ["none", "None"],
  ["bounded", "Bounded"],
  ["token-bucket", "Token bucket"],
  ["leaky-bucket", "Leaky bucket"],
];

function segmented<T extends string>(
  container: HTMLElement,
  label: string,
  options: Array<[T, string]>,
  current: T,
  onChange: (value: T) => void,
): void {
  const group = document.createElement("div");
  group.className = "control";
  group.innerHTML = `<span class="control__label">${label}</span>`;

  const row = document.createElement("div");
  row.className = "segmented";
  row.setAttribute("role", "radiogroup");
  row.setAttribute("aria-label", label);

  options.forEach(([value, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segmented__item";
    button.textContent = text;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(value === current));
    button.dataset.value = value;

    button.addEventListener("click", () => {
      row.querySelectorAll(".segmented__item").forEach((element) => {
        element.setAttribute("aria-checked", String(element === button));
      });
      onChange(value);
    });

    row.appendChild(button);
  });

  group.appendChild(row);
  container.appendChild(group);
}

function buildControls(): void {
  const panel = document.querySelector<HTMLElement>("#controls")!;

  const presetRow = document.createElement("div");
  presetRow.className = "presets";
  Object.entries(presets).forEach(([key, preset]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.textContent = preset.label;
    button.addEventListener("click", () => applyPreset(key));
    presetRow.appendChild(button);
  });
  panel.appendChild(presetRow);

  const note = document.createElement("p");
  note.className = "note";
  note.id = "note";
  note.textContent = presets.healthy.note;
  panel.appendChild(note);

  segmented(panel, "Discipline", disciplines, sim.config.discipline, (value) =>
    sim.update({ discipline: value }),
  );
  segmented(panel, "Admission control", limiters, sim.config.limiter, (value) =>
    sim.update({ limiter: value }),
  );

  sliders.forEach((spec) => {
    const control = document.createElement("div");
    control.className = "control";

    const id = `slider-${String(spec.key)}`;
    control.innerHTML = `
      <label class="control__label" for="${id}">
        ${spec.label}
        <output id="${id}-out">${spec.format(sim.config[spec.key] as number)}</output>
      </label>`;

    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(sim.config[spec.key]);

    input.addEventListener("input", () => {
      const value = Number(input.value);
      sim.update({ [spec.key]: value } as Partial<Config>);
      document.querySelector(`#${id}-out`)!.textContent = spec.format(value);
    });

    control.appendChild(input);
    panel.appendChild(control);
  });
}

function applyPreset(key: string): void {
  const preset = presets[key];
  if (!preset) return;

  sim.update(preset.config);
  sim.reset();

  document.querySelector("#note")!.textContent = preset.note;
  syncControls();
}

/** Push the simulation's state back into the controls after a preset. */
function syncControls(): void {
  sliders.forEach((spec) => {
    const input = document.querySelector<HTMLInputElement>(`#slider-${String(spec.key)}`);
    const output = document.querySelector(`#slider-${String(spec.key)}-out`);
    if (input) input.value = String(sim.config[spec.key]);
    if (output) output.textContent = spec.format(sim.config[spec.key] as number);
  });

  document.querySelectorAll<HTMLElement>(".segmented").forEach((group) => {
    group.querySelectorAll<HTMLElement>(".segmented__item").forEach((item) => {
      const value = item.dataset.value;
      const matches = value === sim.config.discipline || value === sim.config.limiter;
      item.setAttribute("aria-checked", String(matches));
    });
  });
}

// -- readouts ---------------------------------------------------------------

function updateReadouts(): void {
  const snapshot = sim.snapshot();
  const load = sim.offeredLoad();

  const set = (id: string, value: string, colour?: string) => {
    const element = document.querySelector<HTMLElement>(`#${id}`);
    if (!element) return;
    element.textContent = value;
    if (colour) element.style.color = colour;
  };

  set("stat-load", `${(load * 100).toFixed(0)}%`, loadColour(load));
  set("stat-throughput", formatRate(snapshot.throughput));
  set("stat-depth", String(snapshot.queueDepth));
  set("stat-p50", formatDuration(snapshot.p50));
  set("stat-p99", formatDuration(snapshot.p99));
  set(
    "stat-drop",
    `${(snapshot.dropRate * 100).toFixed(1)}%`,
    snapshot.dropRate > 0.01 ? "#F87171" : undefined,
  );
}

// -- loop -------------------------------------------------------------------

let reportedFailure = false;

function frame(now: number): void {
  // Scheduled first, and deliberately so. With this call at the end, a single
  // throw anywhere in step or draw meant the next frame was never requested —
  // the simulation froze permanently, silently, with no way back short of a
  // reload. One bad frame should cost one frame.
  requestAnimationFrame(frame);

  const elapsed = (now - lastFrame) / 1000;
  lastFrame = now;

  try {
    if (running) sim.step(elapsed * speed);
    renderer.draw(sim);
    updateReadouts();
  } catch (error) {
    // Reported once: a render bug that recurs every frame would otherwise
    // produce sixty identical console entries a second and bury its own cause.
    if (!reportedFailure) {
      reportedFailure = true;
      console.error("queueviz: a frame failed and was skipped", error);
    }
  }
}

function bindToolbar(): void {
  const playButton = document.querySelector<HTMLButtonElement>("#play")!;
  const setPlayState = () => {
    playButton.textContent = running ? "Pause" : "Play";
    playButton.setAttribute("aria-pressed", String(running));
  };


  playButton.addEventListener("click", () => {
    running = !running;
    setPlayState();
  });
  setPlayState();

  document.querySelector("#reset")!.addEventListener("click", () => sim.reset());

  document.querySelector<HTMLSelectElement>("#speed")!.addEventListener("change", (event) => {
    speed = Number((event.target as HTMLSelectElement).value);
  });

  // Space to pause is the shortcut anyone tries first on a simulation.
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      running = !running;
      setPlayState();
    }
    if (event.key === "r") sim.reset();
  });
}

buildControls();
bindToolbar();
applyPreset("healthy");

// After applyPreset, which owns the note element and would otherwise overwrite
// this the moment the page loads.
if (prefersReducedMotion) {
  const note = document.querySelector("#note");
  if (note) {
    note.textContent =
      "Paused, because your system asks for reduced motion. Press Play to watch it run.";
  }
}

requestAnimationFrame(frame);
