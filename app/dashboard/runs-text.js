// The line under the Agents page's Runs headline. A browser ES module that node tests import.

const day = (clockAt) => new Date(clockAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function every(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.round(ms / 86_400_000), "day");
}

/**
 * One line under the Runs headline saying how many runs there were, when, and how they came about. "" without runs.
 * `total` is the agent's lifetime run count; the endpoint carries only the latest fifty runs.
 */
export function runsText(runs, schedule, total = runs?.length ?? 0) {
  if (!runs || runs.length === 0) return "";
  const at = runs.map((r) => r.clockAt).sort((a, b) => a - b);
  const first = day(at[0]);
  const last = day(at[at.length - 1]);
  const demoDays = Number(schedule?.demoDays ?? 0);
  const heading = total > runs.length ? `The latest ${runs.length} of ${plural(total, "run")},` : plural(runs.length, "run");
  let count = first === last ? `${heading} on ${first}` : `${heading} from ${first} to ${last}`;
  if (demoDays > 0) count += `, one every ${plural(demoDays, "day")} of vault time`;
  const sentences = [count + ".", "Each run reads the book, samples every yield source, fetches a price through a paid tool and decides once."];
  if (demoDays > 0) sentences.push(`On this demo fork the clock moves ${plural(demoDays, "day")} before each run and every fourth run is a month end.`);
  else if (schedule?.intervalMs > 0) sentences.push(`The runner wakes every ${every(schedule.intervalMs)}.`);
  return sentences.join(" ");
}
