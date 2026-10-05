// Seeded randomness and the Amount vocabulary (number | distribution | curve).

export function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const Z90 = 1.2815515655446004;
const lognormal = (a) => {
  const mu = Math.log(a.median);
  return [mu, (Math.log(a.p90) - mu) / Z90];
};

export function sample(a, r) {
  if (typeof a === 'number') return a;
  switch (a.dist) {
    case 'fixed': return a.value;
    case 'uniform': return a.min + (a.max - a.min) * r();
    case 'normal': return Math.max(0, a.mean + a.sd * gauss(r));
    case 'lognormal': { const [mu, s] = lognormal(a); return Math.exp(mu + s * gauss(r)); }
    case 'poisson': {
      if (a.mean > 30) return Math.max(0, Math.round(a.mean + Math.sqrt(a.mean) * gauss(r)));
      const L = Math.exp(-a.mean);
      let k = 0, p = 1;
      do { k++; p *= r(); } while (p > L);
      return k - 1;
    }
  }
  throw new Error(`not a distribution: ${JSON.stringify(a)}`);
}

export function moments(a) {
  if (typeof a === 'number') return [a, 0];
  switch (a.dist) {
    case 'fixed': return [a.value, 0];
    case 'uniform': return [(a.min + a.max) / 2, (a.max - a.min) / Math.sqrt(12)];
    case 'normal': return [a.mean, a.sd];
    case 'lognormal': {
      const [mu, s] = lognormal(a), m = Math.exp(mu + (s * s) / 2);
      return [m, m * Math.sqrt(Math.exp(s * s) - 1)];
    }
    case 'poisson': return [a.mean, Math.sqrt(a.mean)];
  }
  throw new Error(`not a distribution: ${JSON.stringify(a)}`);
}

// Sum of n draws. Exact for one draw, normal approximation otherwise.
export function sampleSum(a, n, r) {
  if (n <= 0) return 0;
  if (n === 1) return sample(a, r);
  const [m, sd] = moments(a);
  return Math.max(0, n * m + Math.sqrt(n) * sd * gauss(r));
}

// n-th value of a curve, n starting at 1.
export function curve(c, n) {
  if (typeof c === 'number') return c;
  switch (c.curve) {
    case 'linear': return c.base + c.step * (n - 1);
    case 'geometric': return c.base * c.ratio ** (n - 1);
    case 'power': return c.base * n ** c.exp;
    case 'table': return c.values[Math.min(n, c.values.length) - 1];
  }
  throw new Error(`not a curve: ${JSON.stringify(c)}`);
}
