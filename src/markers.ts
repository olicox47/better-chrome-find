import { CURRENT_MATCH_COLOUR, MATCH_COLOUR, OWN_ATTRIBUTE } from "./types";

const WIDTH = 8;
const OUTLINE = "#00000059";

/**
 * Draws a VS Code-style overview ruler along the right edge of the viewport,
 * with a mark for each match at its relative position in the document.
 */
export class ScrollMarkers {
  private canvas?: HTMLCanvasElement;
  private positions: number[] = [];
  private current?: number;

  constructor() {
    window.addEventListener("resize", () => this.draw());
  }

  /** Positions are document-relative y coordinates in CSS pixels. */
  update(positions: number[], current?: number): void {
    this.positions = positions;
    this.current = current;
    this.draw();
  }

  clear(): void {
    this.positions = [];
    this.current = undefined;
    this.canvas?.remove();
  }

  private draw(): void {
    const documentHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;
    if (!this.positions.length || documentHeight <= viewportHeight) {
      this.canvas?.remove();
      return;
    }

    const canvas = (this.canvas ??= this.createCanvas());
    if (!canvas.isConnected) document.documentElement.append(canvas);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = WIDTH * ratio;
    canvas.height = viewportHeight * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.scale(ratio, ratio);
    const toRow = (position: number): number =>
      Math.min(
        viewportHeight - 2,
        Math.max(0, Math.round((position / documentHeight) * viewportHeight)),
      );

    // Merge marks that land on neighbouring rows so dense pages draw one
    // outlined run instead of thousands of overlapping rectangles.
    const rows = [...new Set(this.positions.map(toRow))].sort((a, b) => a - b);
    let start = rows[0];
    let end = start;
    for (const row of [...rows.slice(1), Infinity]) {
      if (row <= end + 2) {
        end = row;
        continue;
      }
      this.mark(context, start, end - start + 3, MATCH_COLOUR);
      start = end = row;
    }
    if (this.current !== undefined) {
      this.mark(context, toRow(this.current) - 1, 4, CURRENT_MATCH_COLOUR);
    }
  }

  private mark(
    context: CanvasRenderingContext2D,
    top: number,
    height: number,
    colour: string,
  ): void {
    context.fillStyle = OUTLINE;
    context.fillRect(0, top - 1, WIDTH, height + 2);
    context.fillStyle = colour;
    context.fillRect(1, top, WIDTH - 2, height);
  }

  private createCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.setAttribute(OWN_ATTRIBUTE, "markers");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = `all:initial;position:fixed;top:0;right:0;width:${WIDTH}px;height:100vh;pointer-events:none;z-index:2147483646;`;
    return canvas;
  }
}
