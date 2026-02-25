export function opsSchemaInstruction() {
  return `
Return ONLY valid JSON with this exact shape:
{
  "summary": "one short sentence",
  "ops": [
    {
      "op": "add" | "update" | "complete" | "undo_complete" | "delete",
      "id": "existing-id-or-temp-id",
      "fields": { ... },      // add/update only
      "reason": "short reason"
    }
  ]
}

Rules:
- Prefer small, high-quality changes.
- For "add": fields must include at least { "title": "...", "type": "task|meeting|event" }.
- For "update": include ONLY changed fields.
- Dates must be YYYY-MM-DD or null.
- priority if provided must be 1-4.
- You may include fields like: pillar, owner_id, notes, start_date, due_date, priority, estimated_minutes, energy, subtasks[].
- subtasks: array of short strings.
`;
}

export function refineTaskPrompt(task) {
  return `
Refine this task so it is clearer and more actionable. If it looks like multiple tasks, you may propose multiple adds.
Task:
${JSON.stringify(task, null, 2)}

Goals:
- Clean title (short + specific)
- Infer missing fields if safe (pillar/owner/priority/dates)
- Suggest subtasks if helpful
- Keep user intent (do not invent unrelated work)

Return ops JSON only.
`;
}

export function rebalanceTodayPrompt(todayISO) {
  return `
Suggest a better "Today" plan. You may:
- Move some tasks to today (update start_date/due_date to ${todayISO})
- Defer low-priority items (push by 1-3 days)
- Leave critical items for today
Be conservative and propose small changes.

Return ops JSON only.
`;
}