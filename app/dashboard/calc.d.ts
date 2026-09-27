export type Price = { id: string; name: string; in: number; out: number };
export type Preset = { label: string; icon: string; deposit: number | null; modelId: string };
export const PRICES: Price[];
export const PRICES_DATE: string;
export const RATES: number[];
export const RAIL_FEE: number;
export const PRESETS: Preset[];
export function compute(i: { deposit: number; rate: number; modelId: string }): {
  model: Price; interest: number; credit: number; tokens: number; perCall: number; callsMonth: number; callsDay: number;
  others: { id: string; name: string; tokens: number }[];
};
export function tokensText(n: number): string;
export function callsText(n: number): string;
export function callsDayText(n: number): string;
