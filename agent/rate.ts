const YEAR_SECONDS = 365 * 86_400;
/** Annualized rate from the last two share-price samples of a yield source; null with fewer than two or no time between them. */
export function rateFrom(samples: { sharePrice: bigint; at: number }[]): number | null {
  if (samples.length < 2) return null;
  const [a, b] = samples.slice(-2);
  if (b.at <= a.at || a.sharePrice === 0n) return null;
  const growth = Number(b.sharePrice) / Number(a.sharePrice) - 1;
  return growth * (YEAR_SECONDS / (b.at - a.at));
}
