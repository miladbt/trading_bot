// Probe: is window N+1's priceToBeat ≈ window N's finalPrice (Chainlink TWAP
// continuity)? If yes, we can reconstruct a coarse underlying path from Gamma
// settlement metadata alone (one request per window, no Binance needed).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function meta(slug) {
  const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  const arr = await res.json();
  if (!arr.length) return null;
  const em = arr[0].eventMetadata;
  const m = arr[0].markets[0];
  let outcome = null;
  try {
    const prices = JSON.parse(m.outcomePrices);
    outcome = Number(prices[0]) > 0.5 ? "UP" : "DOWN";
  } catch {
    outcome = m.outcomePrices;
  }
  return {
    priceToBeat: em?.priceToBeat,
    finalPrice: em?.finalPrice,
    outcome,
    tickSize: m.orderPriceMinTickSize,
    minSize: m.orderMinSize,
  };
}

const T0 = 1790690400; // a settled window from earlier probes
for (const t of [T0, T0 + 300, T0 + 600, T0 + 900]) {
  const m = await meta(`btc-updown-5m-${t}`);
  console.log(t, new Date(t * 1000).toISOString(), JSON.stringify(m));
  await sleep(300);
}

// Continuity check: compare finalPrice(N) vs priceToBeat(N+1).
const a = await meta(`btc-updown-5m-${T0}`);
const b = await meta(`btc-updown-5m-${T0 + 300}`);
if (a?.finalPrice && b?.priceToBeat) {
  const diff = Math.abs(a.finalPrice - b.priceToBeat);
  const rel = (diff / a.finalPrice) * 100;
  console.log(
    `continuity: final(N)=${a.finalPrice} vs toBeat(N+1)=${b.priceToBeat} diff=${diff.toFixed(4)} (${rel.toFixed(4)}%)`,
  );
}
