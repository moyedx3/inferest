/**
 * Fills the top bar's network chip. With fewer than two sites in the server's config it is the chain name; with
 * CHAIN_SITES naming this instance and others, it becomes a picker that opens the same page on the chosen instance.
 */
export function renderNetwork(el, cfg) {
  const label = `${cfg.chainName ?? `chain ${cfg.chainId}`}${cfg.demoFaucet ? " · demo chain" : ""}`;
  const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
  if (sites.length < 2) {
    el.textContent = label;
    return;
  }
  const here = String(cfg.publicUrl ?? "").replace(/\/+$/, "");
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Chain");
  let found = false;
  for (const site of sites) {
    const option = document.createElement("option");
    const isHere = site.url === here;
    option.value = site.url;
    option.textContent = isHere ? label : site.name;
    option.selected = isHere;
    found = found || isHere;
    select.append(option);
  }
  if (!found) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = label;
    option.selected = true;
    select.prepend(option);
  }
  select.addEventListener("change", () => {
    if (select.value) location.assign(select.value + location.pathname + location.search);
  });
  el.replaceChildren(select);
}
