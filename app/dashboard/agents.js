// Placeholder for the Agents page. Task 7 replaces this with the hosted agent's live run view.
const runs = document.getElementById("runs");

async function load() {
  try {
    const r = await fetch("/api/agent");
    if (!r.ok) runs.textContent = "no agent yet";
  } catch {
    runs.textContent = "no agent yet";
  }
}

load();
