// Per-poll palette and the celebration burst.

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Second-hue offsets that pair well with the first: analogous, split
// complementary, triadic and so on. One is picked per poll.
const PAIRINGS = [40, -45, 150, 200, 95, -110, 60];

export function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function paletteFor(seed, override) {
  const n = hash(seed);
  const h = override && Number.isInteger(override.hue) ? override.hue : n % 360;
  const h2 = override && Number.isInteger(override.hue2) ? override.hue2 : (h + PAIRINGS[(n >>> 9) % PAIRINGS.length] + 360) % 360;
  return { h, h2 };
}

export function applyTheme(seed, override) {
  const { h, h2 } = paletteFor(seed, override);
  const root = document.documentElement.style;
  root.setProperty("--h", String(h));
  root.setProperty("--h2", String(h2));
  const meta = document.querySelector('meta[name="theme-color"]') || document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
  meta.content = `hsl(${h} 70% 48%)`;
}

export function confetti() {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.id = "confetti";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = (canvas.width = innerWidth * dpr);
  const H = (canvas.height = innerHeight * dpr);
  const css = getComputedStyle(document.documentElement);
  const h = Number(css.getPropertyValue("--h")) || 230;
  const h2 = Number(css.getPropertyValue("--h2")) || 300;
  const colors = [`hsl(${h} 85% 60%)`, `hsl(${h2} 85% 62%)`, `hsl(${(h + h2) / 2} 90% 70%)`, `hsl(${h} 90% 80%)`, "#fff"];
  const pieces = Array.from({ length: 160 }, (_, i) => {
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -60 : -120) + (Math.random() - 0.5) * 50;
    const speed = (14 + Math.random() * 16) * dpr;
    return {
      x: fromLeft ? 0 : W,
      y: H * 0.75,
      vx: Math.cos((angle * Math.PI) / 180) * speed,
      vy: Math.sin((angle * Math.PI) / 180) * speed,
      w: (6 + Math.random() * 6) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      c: colors[i % colors.length],
      round: Math.random() < 0.3,
    };
  });
  const start = performance.now();
  const frame = (t) => {
    const elapsed = t - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - 1800) / 900);
    for (const p of pieces) {
      p.vy += 0.45 * dpr;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 2);
      ctx.restore();
    }
    if (elapsed < 2700) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
