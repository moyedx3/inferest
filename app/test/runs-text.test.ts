import { test } from "node:test";
import assert from "node:assert/strict";
import { runsText } from "../dashboard/runs-text.js";

// noon UTC keeps the local date the same from UTC-11 to UTC+11
const noon = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12) / 1000;
const DAY = 86_400;
const weekly = Array.from({ length: 8 }, (_, i) => ({ clockAt: noon(2026, 10, 4) + i * 7 * DAY }));
const MIDDLE = "Each run reads the book, samples every yield source, fetches a price through a paid tool and decides once.";

test("the demo fork says the vault clock and the month ends", () => {
  assert.equal(runsText(weekly, { intervalMs: 600000, demoDays: 7 }),
    "8 runs from Oct 4 to Nov 22, one every 7 days of vault time. " + MIDDLE +
    " On this demo fork the clock moves 7 days before each run and every fourth run is a month end.");
});

test("a real chain says how often the runner wakes", () => {
  const t = runsText(weekly, { intervalMs: 600000, demoDays: 0 });
  assert.ok(t.endsWith("The runner wakes every 10 minutes."), t);
  assert.ok(!t.includes("vault time"), t);
  assert.equal(t, "8 runs from Oct 4 to Nov 22. " + MIDDLE + " The runner wakes every 10 minutes.");
});

test("the interval reads in minutes, hours or days", () => {
  const one = [{ clockAt: noon(2026, 10, 4) }];
  const tail = (ms: number) => runsText(one, { intervalMs: ms, demoDays: 0 }).split(MIDDLE + " ")[1];
  assert.equal(tail(60_000), "The runner wakes every 1 minute.");
  assert.equal(tail(3_600_000), "The runner wakes every 1 hour.");
  assert.equal(tail(7_200_000), "The runner wakes every 2 hours.");
  assert.equal(tail(86_400_000), "The runner wakes every 1 day.");
  assert.equal(tail(3 * 86_400_000), "The runner wakes every 3 days.");
});

test("one day of vault time is singular", () => {
  assert.ok(runsText(weekly, { intervalMs: 600000, demoDays: 1 }).startsWith("8 runs from Oct 4 to Nov 22, one every 1 day of vault time. "));
});

test("one run, runs on one date, and no runs", () => {
  assert.ok(runsText([{ clockAt: noon(2026, 10, 4) }], null).startsWith("1 run on Oct 4. "));
  const sameDay = [0, 60, 120].map((s) => ({ clockAt: noon(2026, 10, 4) + s }));
  assert.ok(runsText(sameDay, null).startsWith("3 runs on Oct 4. "));
  assert.equal(runsText([], { intervalMs: 600000, demoDays: 7 }), "");
});

test("a null schedule gives only the count and what a run does", () => {
  assert.equal(runsText(weekly, null), "8 runs from Oct 4 to Nov 22. " + MIDDLE);
  assert.equal(runsText(weekly, undefined), "8 runs from Oct 4 to Nov 22. " + MIDDLE);
});

test("the order of the runs does not matter", () => {
  const s = { intervalMs: 600000, demoDays: 7 };
  assert.equal(runsText([...weekly].reverse(), s), runsText(weekly, s));
});

test("no em dashes", () => {
  assert.ok(!runsText(weekly, { intervalMs: 600000, demoDays: 7 }).includes("—"));
});
