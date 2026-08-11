/**
 * Canvas rendering of the running simulation.
 *
 * The layout is a pipeline read left to right — arrivals, the admission gate,
 * the queue, the workers — because that is the order a request experiences and
 * the order someone debugging one thinks in.
 */

import type { Simulation } from "../sim/engine";
import { WeightedFairQueue } from "../sim/queues";
import { formatDuration, formatRate, loadColour, tenantColour, theme } from "./theme";

const LANE_HEIGHT = 26;
const ITEM_SIZE = 11;
const ITEM_GAP = 3;

/**
 * Below this canvas width the three panels stop fitting side by side and stack
 * instead. Chosen from the content, not from a device: the gate needs ~92px,
 * the workers ~150px, and the queue is useless under ~180px — plus gaps, that
 * is where the row layout stops being readable.
 */
const STACK_BELOW = 560;

/** Nothing legible fits below this; the renderer draws a placeholder instead. */
const MIN_USABLE = 200;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private observer: ResizeObserver | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("2D canvas is not available in this browser");
    this.ctx = context;
    this.resize();

    // Observing the element rather than the window. Measuring once in the
    // constructor can capture a size the layout has not settled on yet, and a
    // window listener never corrects it — the canvas then renders a desktop
    // composition into a narrow box until the visitor happens to resize. The
    // observer fires on the real box, including the first time it is laid out.
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas);
    }
  }

  /** Stop observing. Not used by the app, which lives for the page's lifetime. */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * Size the backing store to the device pixel ratio.
   *
   * Without this the canvas is upscaled by the browser and every line and label
   * is soft — the single most common reason canvas UIs look cheap next to the
   * DOM around them.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(sim: Simulation): void {
    const { ctx } = this;
    if (this.width <= 0 || this.height <= 0) return;

    ctx.fillStyle = theme.colour.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const padding = this.width < STACK_BELOW ? theme.space(1.5) : theme.space(3);
    const inner = this.width - padding * 2;

    if (inner < MIN_USABLE) {
      this.drawTooNarrow(padding);
      return;
    }

    if (this.width < STACK_BELOW) {
      this.drawStacked(sim, padding, inner);
    } else {
      this.drawColumns(sim, padding, inner);
    }
  }

  /** The desktop composition: arrivals, queue and workers read left to right. */
  private drawColumns(sim: Simulation, padding: number, inner: number): void {
    const gap = theme.space(3);
    const gateWidth = 92;
    const workerWidth = 150;
    const queueX = padding + gateWidth + gap;
    const queueWidth = inner - gateWidth - workerWidth - gap * 2;
    const height = this.height - padding * 2;

    this.drawGate(sim, padding, padding, gateWidth, height);
    this.drawQueue(sim, queueX, padding, queueWidth, height);
    this.drawWorkers(sim, this.width - workerWidth - padding, padding, workerWidth, height);
  }

  /**
   * The narrow composition: the same pipeline turned vertical.
   *
   * Stacking rather than shrinking, because the three panels do not degrade
   * equally — the queue is the content and the other two are context, so they
   * become strips and the queue keeps the room.
   */
  private drawStacked(sim: Simulation, padding: number, inner: number): void {
    const gap = theme.space(1.5);
    const gateHeight = 72;
    const workerHeight = Math.min(190, Math.max(120, (this.height - padding * 2) * 0.38));
    const queueHeight = this.height - padding * 2 - gateHeight - workerHeight - gap * 2;

    let y = padding;
    this.drawGateStrip(sim, padding, y, inner, gateHeight);
    y += gateHeight + gap;

    if (queueHeight > 90) {
      this.drawQueue(sim, padding, y, inner, queueHeight);
      y += queueHeight + gap;
    }

    this.drawWorkers(sim, padding, y, inner, workerHeight);
  }

  private drawTooNarrow(padding: number): void {
    const { ctx } = this;
    this.panel(padding, padding, this.width - padding * 2, this.height - padding * 2);
    ctx.fillStyle = theme.colour.textMuted;
    ctx.font = `500 12px ${theme.font.sans}`;
    ctx.textAlign = "center";
    ctx.fillText("Widen the window to watch the queue", this.width / 2, this.height / 2);
    ctx.textAlign = "left";
  }

  // -- admission gate -------------------------------------------------------

  private drawGate(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    this.panel(x, y, w, h);
    this.label(x + theme.space(1.5), y + theme.space(2.5), "ARRIVALS");

    const snapshot = sim.snapshot();

    ctx.fillStyle = theme.colour.text;
    ctx.font = `600 20px ${theme.font.mono}`;
    ctx.textAlign = "left";
    ctx.fillText(formatRate(sim.arrivals.perSecond(sim.time)), x + theme.space(1.5), y + theme.space(6));

    this.label(x + theme.space(1.5), y + theme.space(10), "GATE");
    ctx.fillStyle = theme.colour.textMuted;
    ctx.font = `500 11px ${theme.font.mono}`;
    ctx.fillText(sim.limiter.name, x + theme.space(1.5), y + theme.space(12));

    // A vertical meter for the limiter's remaining allowance. It empties as a
    // burst is spent and visibly refills, which is what makes a token bucket
    // understandable in a way its formula is not.
    if (sim.limiter.name !== "none") {
      const meterX = x + theme.space(1.5);
      const meterY = y + theme.space(14);
      const meterW = w - theme.space(3);
      const meterH = 8;
      const level = Math.max(0, Math.min(1, sim.limiter.level()));

      ctx.fillStyle = theme.colour.line;
      this.roundRect(meterX, meterY, meterW, meterH, theme.radius.sm);
      ctx.fill();

      ctx.fillStyle = level > 0.25 ? theme.colour.accent : theme.colour.warn;
      this.roundRect(meterX, meterY, Math.max(2, meterW * level), meterH, theme.radius.sm);
      ctx.fill();
    }

    if (snapshot.dropped > 0) {
      this.label(x + theme.space(1.5), y + theme.space(19), "DROPPED");
      ctx.fillStyle = theme.colour.danger;
      ctx.font = `600 16px ${theme.font.mono}`;
      ctx.fillText(
        `${(snapshot.dropRate * 100).toFixed(1)}%`,
        x + theme.space(1.5),
        y + theme.space(22),
      );
    }
  }

  /** The gate as a horizontal strip, for the stacked layout. */
  private drawGateStrip(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    this.panel(x, y, w, h);

    const snapshot = sim.snapshot();
    const pad = theme.space(1.5);

    this.label(x + pad, y + 18, "ARRIVALS");
    ctx.fillStyle = theme.colour.text;
    ctx.font = `600 20px ${theme.font.mono}`;
    ctx.textAlign = "left";
    ctx.fillText(formatRate(sim.arrivals.perSecond(sim.time)), x + pad, y + 46);

    const midX = x + w * 0.45;
    this.label(midX, y + 18, "GATE");
    ctx.fillStyle = theme.colour.textMuted;
    ctx.font = `500 12px ${theme.font.mono}`;
    ctx.fillText(sim.limiter.name, midX, y + 38);

    if (sim.limiter.name !== "none") {
      const meterW = Math.max(20, w * 0.28);
      const level = Math.max(0, Math.min(1, sim.limiter.level()));

      ctx.fillStyle = theme.colour.line;
      this.roundRect(midX, y + 48, meterW, 7, theme.radius.sm);
      ctx.fill();

      ctx.fillStyle = level > 0.25 ? theme.colour.accent : theme.colour.warn;
      this.roundRect(midX, y + 48, Math.max(2, meterW * level), 7, theme.radius.sm);
      ctx.fill();
    }

    if (snapshot.dropped > 0) {
      ctx.textAlign = "right";
      this.labelRight(x + w - pad, y + 18, "DROPPED");
      ctx.fillStyle = theme.colour.danger;
      ctx.font = `600 18px ${theme.font.mono}`;
      ctx.fillText(`${(snapshot.dropRate * 100).toFixed(1)}%`, x + w - pad, y + 46);
      ctx.textAlign = "left";
    }
  }

  // -- queue ----------------------------------------------------------------

  private drawQueue(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    this.panel(x, y, w, h);

    this.label(x + theme.space(1.5), y + theme.space(2.5), `QUEUE · ${sim.queue.name.toUpperCase()}`);

    ctx.fillStyle = theme.colour.text;
    ctx.font = `600 20px ${theme.font.mono}`;
    ctx.fillText(String(sim.queue.size), x + theme.space(1.5), y + theme.space(6));

    ctx.fillStyle = theme.colour.textFaint;
    ctx.font = `500 11px ${theme.font.sans}`;
    ctx.fillText("waiting", x + theme.space(1.5) + 46, y + theme.space(6));

    const contentY = y + theme.space(8);
    const contentH = h - theme.space(8) - theme.space(11);

    if (sim.queue instanceof WeightedFairQueue) {
      this.drawTenantLanes(sim, x + theme.space(1.5), contentY, w - theme.space(3), contentH);
    } else {
      this.drawFlatQueue(sim, x + theme.space(1.5), contentY, w - theme.space(3), contentH);
    }

    this.drawDepthSparkline(
      sim,
      x + theme.space(1.5),
      y + h - theme.space(9),
      w - theme.space(3),
      theme.space(7),
    );
  }

  private drawFlatQueue(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const items = sim.queue.peekAll();
    const perRow = Math.max(1, Math.floor(w / (ITEM_SIZE + ITEM_GAP)));
    const rows = Math.max(1, Math.floor(h / (ITEM_SIZE + ITEM_GAP)));
    const capacity = perRow * rows;

    for (let i = 0; i < Math.min(items.length, capacity); i++) {
      const item = items[i];
      const column = i % perRow;
      const row = Math.floor(i / perRow);
      const age = sim.time - item.arrivedAt;

      // Waiting items warm from accent to danger as they age, so a starving
      // request is visible without reading a single number.
      ctx.fillStyle = age > 2 ? theme.colour.danger : age > 0.8 ? theme.colour.warn : theme.colour.accent;
      ctx.globalAlpha = 0.55 + Math.min(0.45, age * 0.3);

      this.roundRect(
        x + column * (ITEM_SIZE + ITEM_GAP),
        y + row * (ITEM_SIZE + ITEM_GAP),
        ITEM_SIZE,
        ITEM_SIZE,
        theme.radius.sm,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (items.length > capacity) {
      ctx.fillStyle = theme.colour.textFaint;
      ctx.font = `500 11px ${theme.font.mono}`;
      ctx.fillText(`+${items.length - capacity} more`, x, y + h + 12);
    }
  }

  private drawTenantLanes(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const queue = sim.queue as WeightedFairQueue;
    const depths = queue.depths();
    const laneH = Math.min(LANE_HEIGHT, h / Math.max(1, depths.length));
    const widest = Math.max(1, ...depths);

    const labelWidth = 34;
    // The count sits in a reserved gutter rather than on top of the bar. At
    // full width the fill would otherwise run underneath it, and the number on
    // the busiest lane — the one worth reading — becomes the hardest to read.
    const countWidth = 34;
    const trackX = x + labelWidth;
    const trackW = Math.max(10, w - labelWidth - countWidth);

    depths.forEach((depth, tenant) => {
      const laneY = y + tenant * (laneH + 6);

      ctx.fillStyle = theme.colour.line;
      this.roundRect(trackX, laneY, trackW, laneH - 6, theme.radius.sm);
      ctx.fill();

      ctx.fillStyle = tenantColour(tenant);
      this.roundRect(
        trackX,
        laneY,
        Math.max(2, trackW * (depth / widest)),
        laneH - 6,
        theme.radius.sm,
      );
      ctx.fill();

      ctx.font = `500 10px ${theme.font.mono}`;
      ctx.fillStyle = theme.colour.textMuted;
      ctx.textAlign = "left";
      ctx.fillText(`T${tenant}`, x, laneY + laneH - 12);

      ctx.fillStyle = theme.colour.textFaint;
      ctx.textAlign = "right";
      ctx.fillText(String(depth), x + w, laneY + laneH - 12);
      ctx.textAlign = "left";
    });
  }

  private drawDepthSparkline(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const values = sim.depthHistory.all();
    if (values.length < 2) return;

    const peak = Math.max(1, sim.depthHistory.peak());

    ctx.strokeStyle = theme.colour.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.stroke();

    ctx.beginPath();
    values.forEach((value, i) => {
      const px = x + (i / (values.length - 1)) * w;
      const py = y + h - (value / peak) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });

    ctx.strokeStyle = theme.colour.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // A filled area under the line, faded out — it reads as volume rather than
    // as a second line competing with the stroke.
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, y, 0, y + h);
    gradient.addColorStop(0, "rgba(34, 211, 238, 0.22)");
    gradient.addColorStop(1, "rgba(34, 211, 238, 0)");
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.fillStyle = theme.colour.textFaint;
    ctx.font = `500 10px ${theme.font.mono}`;
    ctx.fillText(`peak ${peak}`, x, y - 4);
  }

  // -- workers --------------------------------------------------------------

  private drawWorkers(sim: Simulation, x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    this.panel(x, y, w, h);

    this.label(x + theme.space(1.5), y + theme.space(2.5), "WORKERS");

    const load = sim.offeredLoad();
    ctx.fillStyle = loadColour(load);
    ctx.font = `600 20px ${theme.font.mono}`;
    ctx.fillText(`${(load * 100).toFixed(0)}%`, x + theme.space(1.5), y + theme.space(6));

    ctx.fillStyle = theme.colour.textFaint;
    ctx.font = `500 11px ${theme.font.sans}`;
    ctx.fillText("offered load", x + theme.space(1.5) + 52, y + theme.space(6));

    const barY = y + theme.space(8);
    const barH = 18;
    const barW = w - theme.space(3);
    const latencyY = y + h - theme.space(11);

    // A short panel cannot hold a stack of full-width worker bars *and* the
    // latency read-out; drawn anyway, the two overlap and the second wins.
    // Below the threshold the workers become a compact row of slots instead.
    const roomForBars = latencyY - barY - theme.space(1);
    const compact = roomForBars < sim.workers.length * (barH + 5);

    if (compact) {
      this.drawWorkerRow(sim, x + theme.space(1.5), barY, barW);
    } else {
      sim.workers.forEach((worker, index) => {
        const wy = barY + index * (barH + 5);
        if (wy + barH > latencyY - theme.space(1)) return;

        ctx.fillStyle = theme.colour.line;
        this.roundRect(x + theme.space(1.5), wy, barW, barH, theme.radius.sm);
        ctx.fill();

        if (worker.request) {
          const started = worker.request.startedAt ?? sim.time;
          const total = Math.max(0.001, worker.freeAt - started);
          const progress = Math.max(0, Math.min(1, (sim.time - started) / total));

          ctx.fillStyle = tenantColour(worker.request.tenant);
          this.roundRect(
            x + theme.space(1.5),
            wy,
            Math.max(3, barW * progress),
            barH,
            theme.radius.sm,
          );
          ctx.fill();

          ctx.fillStyle = theme.colour.bg;
          ctx.font = `600 10px ${theme.font.mono}`;
          ctx.fillText(`#${worker.request.id}`, x + theme.space(2), wy + 12);
        } else {
          ctx.fillStyle = theme.colour.textFaint;
          ctx.font = `500 10px ${theme.font.mono}`;
          ctx.fillText("idle", x + theme.space(2), wy + 12);
        }
      });
    }

    this.drawLatencyBars(sim, x + theme.space(1.5), latencyY, w - theme.space(3));
  }

  /**
   * Workers as a row of slots, for panels too short for individual bars.
   *
   * Each slot keeps the two things that matter — busy or idle, and which tenant
   * it is serving — and drops the progress fill and the request id, which need
   * width this layout does not have.
   */
  private drawWorkerRow(sim: Simulation, x: number, y: number, w: number): void {
    const { ctx } = this;
    const count = sim.workers.length;
    if (count === 0) return;

    const gap = 4;
    const slotW = Math.max(6, (w - gap * (count - 1)) / count);
    const slotH = 22;

    sim.workers.forEach((worker, index) => {
      const sx = x + index * (slotW + gap);

      ctx.fillStyle = theme.colour.line;
      this.roundRect(sx, y, slotW, slotH, theme.radius.sm);
      ctx.fill();

      if (worker.request) {
        const started = worker.request.startedAt ?? sim.time;
        const total = Math.max(0.001, worker.freeAt - started);
        const progress = Math.max(0, Math.min(1, (sim.time - started) / total));

        ctx.fillStyle = tenantColour(worker.request.tenant);
        this.roundRect(sx, y + slotH - Math.max(3, slotH * progress), slotW,
          Math.max(3, slotH * progress), theme.radius.sm);
        ctx.fill();
      }
    });

    // The count goes above the slots: below them it lands on the latency rows.
    const busy = sim.workers.filter((worker) => worker.request !== null).length;
    ctx.fillStyle = theme.colour.textFaint;
    ctx.font = `500 10px ${theme.font.mono}`;
    ctx.textAlign = "right";
    ctx.fillText(`${busy}/${count} busy`, x + w, y - 6);
    ctx.textAlign = "left";
  }

  private drawLatencyBars(sim: Simulation, x: number, y: number, w: number): void {
    const { ctx } = this;
    const snapshot = sim.snapshot();
    const rows: Array<[string, number, string]> = [
      ["p50", snapshot.p50, theme.colour.good],
      ["p95", snapshot.p95, theme.colour.warn],
      ["p99", snapshot.p99, theme.colour.danger],
    ];

    const scale = Math.max(0.001, snapshot.max);

    rows.forEach(([label, value, colour], index) => {
      const ry = y + index * 22;

      ctx.fillStyle = theme.colour.textMuted;
      ctx.font = `500 10px ${theme.font.mono}`;
      ctx.textAlign = "left";
      ctx.fillText(label, x, ry + 9);

      const barX = x + 26;
      const barW = w - 26 - 52;

      ctx.fillStyle = theme.colour.line;
      this.roundRect(barX, ry, barW, 8, theme.radius.sm);
      ctx.fill();

      ctx.fillStyle = colour;
      this.roundRect(barX, ry, Math.max(2, barW * (value / scale)), 8, theme.radius.sm);
      ctx.fill();

      ctx.fillStyle = theme.colour.textMuted;
      ctx.textAlign = "right";
      ctx.fillText(formatDuration(value), x + w, ry + 9);
      ctx.textAlign = "left";
    });
  }

  // -- primitives -----------------------------------------------------------

  private panel(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const { ctx } = this;
    ctx.fillStyle = theme.colour.panel;
    this.roundRect(x, y, w, h, theme.radius.lg);
    ctx.fill();
    ctx.strokeStyle = theme.colour.line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** A tracked-out label, right-aligned to ``x``. */
  private labelRight(x: number, y: number, text: string): void {
    const { ctx } = this;
    ctx.font = `600 10px ${theme.font.mono}`;
    const tracking = 0.9;
    let width = 0;
    for (const char of text) width += ctx.measureText(char).width + tracking;
    this.label(x - width, y, text);
  }

  private label(x: number, y: number, text: string): void {
    const { ctx } = this;
    ctx.fillStyle = theme.colour.textFaint;
    ctx.font = `600 10px ${theme.font.mono}`;
    ctx.textAlign = "left";
    // Letter-spacing is not a canvas property in every browser, so it is faked
    // by drawing character by character — small caps labels lose their whole
    // effect when set tight.
    let cursor = x;
    for (const char of text) {
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width + 0.9;
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    // Clamped at zero. A negative width reaches here whenever a layout is
    // squeezed past its minimum, and `arcTo` throws IndexSizeError on a
    // negative radius — which, from inside the render loop, killed the whole
    // simulation rather than dropping one shape.
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    if (w <= 0 || h <= 0) {
      ctx.beginPath();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
