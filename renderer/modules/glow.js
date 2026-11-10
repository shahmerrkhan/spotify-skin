// Edge glow bands: a soft wide stroke under a thin bright one, drawn once as a
// static SVG. The band is twice the screen width and the wave repeats every
// quarter, so sliding it by half (pure compositor transform, no repaint) loops
// seamlessly. Colors come from --accent / --accent-2 via CSS.

const NS = 'http://www.w3.org/2000/svg';
const W = 3840;
const H = 48;
const PERIOD = 960;

function wavePath(phase, amp) {
  let d = '';
  for (let x = 0; x <= W; x += 24) {
    const y = H / 2 + Math.sin((x / PERIOD) * Math.PI * 2 + phase) * amp
      + Math.sin((x / (PERIOD / 2)) * Math.PI * 2 + phase * 1.7) * amp * 0.35;
    d += `${x ? 'L' : 'M'}${x} ${y.toFixed(2)}`;
  }
  return d;
}

export function drawGlow(svgs) {
  svgs.forEach((svg, i) => {
    const id = `glow-blur-${i}`;
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-2%');
    filter.setAttribute('y', '-150%');
    filter.setAttribute('width', '104%');
    filter.setAttribute('height', '400%');
    const blur = document.createElementNS(NS, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '6');
    filter.append(blur);
    const defs = document.createElementNS(NS, 'defs');
    defs.append(filter);

    const d = wavePath(i * 1.9, 7);
    const soft = document.createElementNS(NS, 'path');
    soft.setAttribute('class', 'glow__soft');
    soft.setAttribute('filter', `url(#${id})`);
    soft.setAttribute('d', d);
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'glow__line');
    line.setAttribute('d', d);
    svg.replaceChildren(defs, soft, line);
  });
}
