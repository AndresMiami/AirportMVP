/** Tiny SVG line chart for two series over the same horizon. */
export function Sparkline({
  base,
  scenario,
  height = 80,
}: {
  base: readonly number[];
  scenario: readonly number[];
  height?: number;
}) {
  const W = 320;
  const all = [...base, ...scenario];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const n = Math.max(base.length, scenario.length);
  const pt = (series: readonly number[]) =>
    series
      .map((v, i) => `${(i / Math.max(1, n - 1)) * W},${height - ((v - min) / span) * (height - 8) - 4}`)
      .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full max-w-sm h-auto" role="img" aria-label="Base versus scenario trajectory">
      <polyline points={pt(base)} fill="none" stroke="#2f5d8a" strokeWidth="2" />
      <polyline points={pt(scenario)} fill="none" stroke="#3d7a5e" strokeWidth="2" strokeDasharray="5 3" />
    </svg>
  );
}
