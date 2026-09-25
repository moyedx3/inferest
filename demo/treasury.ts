import { api, customerWithVault, chat, env, printState, sleep, step, usd, warp } from "./lib.ts";

const HALF_YEAR = Math.round(182.5 * 86_400);

step(1, "Finance lead deposits 100,000 USDC. The vault shares stay in their wallet.");
const c = await customerWithVault(env("DEMO_TREASURY_KEY") as `0x${string}`, 100_000_000_000n, "Treasury");
console.log(`   vault ${c.vault}, principal ${usd(await c.value())}`);

step(2, "Admin creates three developer keys at equal weight.");
const keys: { name: string; key: string }[] = [];
for (const name of ["dev-1", "dev-2", "dev-3"]) keys.push({ name, ...(await api("/api/keys", { vault: c.vault, name, weight: 1 })) });

step(3, "Six months pass. The keeper reports; limits open from the yield.");
await warp(HALF_YEAR);
await api("/api/admin/report", {});
await api("/api/admin/sync", {});
await printState(c.vault);

step(4, "Developers call real models on their own keys.");
for (const k of keys) {
  const r = await chat(k.key, [{ role: "user", content: "In one sentence, why do treasuries hold stablecoins?" }]);
  console.log(`   ${k.name}: ${r.choices[0].message.content.trim().slice(0, 90)}  (cost $${r.usage?.cost ?? "?"})`);
}
await sleep(5_000); // OpenRouter usage lands within a few seconds
await api("/api/admin/sync", {});
await printState(c.vault);

step(5, "Month end: settle. Usage to the float, 10% of the leftover to us, the rest back to the customer.");
console.log(`   ${JSON.stringify(await api("/api/admin/settle", { vault: c.vault }))}`);
console.log(`   principal now ${usd(await c.value())}, still in the customer's wallet`);

step(6, "Withdraw everything, straight from the wallet. No request, no wait.");
console.log(`   USDC balance ${usd(await c.withdrawAll())}`);
