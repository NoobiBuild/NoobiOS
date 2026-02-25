// Builds a compact context bundle for the AI.
// Future hook: load local reference docs (workplans/budgets/playbooks) via fetch if present.

function normalizeType(t) {
  const v = (t || "").toLowerCase().trim();
  if (!v) return "task";
  if (v === "event" || v === "meeting" || v === "task") return v;
  return "task";
}
function isCompleted(overlays, item) {
  const patch = overlays?.task_overrides?.[item.id] || {};
  const status = patch.status || item.status || "";
  return status === "completed";
}

async function tryLoadReference() {
  // Optional file: ./ai/reference.json
  // User can later drop in AS&T GPT playbook/workplans/budgets as structured JSON.
  try {
    const res = await fetch("./ai/reference.json", { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return json;
  } catch {
    return null;
  }
}

export async function buildAiContext(merged, overlays, { origin = "unknown" } = {}) {
  const tasks = Array.isArray(merged?.tasks) ? merged.tasks : [];
  const events = Array.isArray(merged?.events) ? merged.events : [];
  const learning = overlays?.learning || {};

  const pick = (x) => ({
    id: x.id,
    title: x.title || "",
    pillar: x.pillar || "",
    owner_id: x.owner_id || "",
    start_date: x.start_date || null,
    due_date: x.due_date || null,
    priority: x.priority ?? null,
    type: normalizeType(x.type),
    status: isCompleted(overlays, x) ? "completed" : "open",
    notes: (x.notes || "").slice(0, 220)
  });

  const open = tasks.filter(t => !isCompleted(overlays, t)).slice(0, 220).map(pick);
  const doneRecent = tasks.filter(t => isCompleted(overlays, t)).slice(0, 60).map(pick);
  const evOpen = events.filter(e => !isCompleted(overlays, e)).slice(0, 60).map(pick);

  const reference = await tryLoadReference();

  return {
    origin,
    open_tasks: open,
    recent_completed: doneRecent,
    open_events: evOpen,
    learning: {
      stats: learning.stats || {},
      completion_log_tail: (learning.completion_log || []).slice(-60),
      move_log_tail: (learning.move_log || []).slice(-60)
    },
    reference // optional: playbooks/workplans/budgets
  };
}