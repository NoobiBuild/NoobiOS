import { loadAiSettings, aiCall, tryParseJsonFromText } from "./providers.js";
import { opsSchemaInstruction, refineTaskPrompt, rebalanceTodayPrompt } from "./prompts.js";

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "Not an object" };
  if (!Array.isArray(payload.ops)) return { ok: false, error: "Missing ops[]" };
  const allowed = new Set(["add","update","complete","undo_complete","delete"]);
  for (const op of payload.ops) {
    if (!op || typeof op !== "object") return { ok: false, error: "Bad op object" };
    if (!allowed.has(op.op)) return { ok: false, error: `Unsupported op: ${op.op}` };
    if (!op.id || typeof op.id !== "string") return { ok: false, error: "Op missing id" };
    if ((op.op === "add" || op.op === "update") && (!op.fields || typeof op.fields !== "object")) {
      return { ok: false, error: "add/update must include fields{}" };
    }
  }
  return { ok: true };
}

async function runOps(system, user, context) {
  const settings = loadAiSettings();
  if (!settings.enabled) throw new Error("AI disabled");

  const txt = await aiCall(settings, system, user, context);
  const payload = tryParseJsonFromText(txt);
  if (!payload) throw new Error("AI did not return valid JSON");
  const v = validatePayload(payload);
  if (!v.ok) throw new Error(`AI payload invalid: ${v.error}`);
  return payload;
}

export async function runRefineTask({ task, context }) {
  const system = opsSchemaInstruction();
  const user = refineTaskPrompt(task);
  return await runOps(system, user, context);
}

export async function runRebalanceToday({ todayISO, tasks, context }) {
  const system = opsSchemaInstruction();
  const user = `${rebalanceTodayPrompt(todayISO)}\n\nTasks snapshot:\n${JSON.stringify(tasks.slice(0, 120), null, 2)}`;
  return await runOps(system, user, context);
}