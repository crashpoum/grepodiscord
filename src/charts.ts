/** History charts rendered server-side to PNG (chart.js via chartjs-node-canvas, composed with node-canvas). */
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { createCanvas, loadImage } from 'canvas';
import type { ChartConfiguration } from 'chart.js';

export interface HistoryPoint { date: string; points: number; towns: number; att: number; def: number; members?: number }

const W = 900;
const H = 320;
const BG = '#2b2d31'; // Discord dark
const FG = '#dbdee1';
const GRID = 'rgba(255,255,255,0.08)';

const renderer = new ChartJSNodeCanvas({ width: W, height: H, backgroundColour: BG });

function baseOptions(title: string) {
  return {
    responsive: false,
    animation: false as const,
    plugins: { title: { display: true, text: title, color: FG, font: { size: 16 } }, legend: { labels: { color: FG } } },
    scales: {
      x: { ticks: { color: FG, maxTicksLimit: 10 }, grid: { color: GRID } },
      y: { ticks: { color: FG }, grid: { color: GRID }, position: 'left' as const },
      y2: { ticks: { color: FG, precision: 0 }, grid: { drawOnChartArea: false }, position: 'right' as const },
    },
  };
}

/** Sort ascending by date and de-duplicate. Input from GrepoData is newest-first. */
export function normalizeHistory(h: HistoryPoint[]): HistoryPoint[] {
  const m = new Map<string, HistoryPoint>();
  for (const p of h) m.set(p.date, p);
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function renderHistoryChart(name: string, history: HistoryPoint[], opts: { secondary?: 'towns' | 'members'; labels?: { points: string; towns: string; abp: string; dbp: string; members?: string } } = {}): Promise<Buffer> {
  const h = normalizeHistory(history);
  const labels = h.map((p) => p.date.slice(5)); // MM-DD
  const L = { points: 'Points', towns: 'Towns', abp: 'Attack BP', dbp: 'Defence BP', members: 'Members', ...opts.labels };
  const secondary = opts.secondary ?? 'towns';

  const top: ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: L.points, data: h.map((p) => p.points), borderColor: '#5865f2', backgroundColor: 'rgba(88,101,242,0.2)', fill: true, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        secondary === 'members'
          ? { label: L.members!, data: h.map((p) => p.members ?? 0), borderColor: '#fee75c', pointRadius: 0, stepped: true, yAxisID: 'y2' }
          : { label: L.towns, data: h.map((p) => p.towns), borderColor: '#fee75c', pointRadius: 0, stepped: true, yAxisID: 'y2' },
      ],
    },
    options: baseOptions(`${name}: ${L.points} / ${secondary === 'members' ? L.members : L.towns}`) as never,
  };
  const bottom: ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: L.abp, data: h.map((p) => p.att), borderColor: '#ed4245', pointRadius: 0, tension: 0.2, yAxisID: 'y' },
        { label: L.dbp, data: h.map((p) => p.def), borderColor: '#57f287', pointRadius: 0, tension: 0.2, yAxisID: 'y' },
      ],
    },
    options: { ...baseOptions(`${name}: BP`), scales: { ...baseOptions('').scales, y2: { display: false } } } as never,
  };
  const [a, b] = await Promise.all([renderer.renderToBuffer(top), renderer.renderToBuffer(bottom)]);
  const canvas = createCanvas(W, H * 2);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await loadImage(a), 0, 0);
  ctx.drawImage(await loadImage(b), 0, H);
  return canvas.toBuffer('image/png');
}
