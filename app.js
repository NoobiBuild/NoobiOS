import { runRefineTask, runRebalanceToday } from "./ai/engine.js";
import {
  loadAiSettings,
  saveAiSettings,
  clearAiSettings,
  getAiReadyState
} from "./ai/providers.js";
import { buildAiContext } from "./ai/context.js";

const STORAGE_KEY = "ast_task_overrides_v1";
const OVERLAYS_VERSION = 1;

/* ---------- Utilities ---------- */
function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISODate(s) {
  if (!s || typeof s !== "string") return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function isoFromDate(dateObj) {
  if (!dateObj) return "";
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(12, 0, 0, 0);
  return date;
}
function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(12, 0, 0, 0);
  return e;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12, 0, 0, 0);
}
function safeText(s) {
  return (s ?? "").toString();
}
function uniq(arr) {
  return Array.from(new Set(arr));
}
function normalizeType(t) {
  const v = (t || "").toLowerCase().trim();
  if (!v) return "";
  if (v === "event" || v === "meeting" || v === "task") return v;
  return v;
}
function priorityNum(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 999;
  return n;
}
function dlFile(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2200);
}

/* ---------- Overlays ---------- */
function defaultOverlays() {
  return {
    version: OVERLAYS_VERSION,
    updated_at: new Date().toISOString(),
    deletions: [],
    task_overrides: {},
    new_tasks: [],
    recurrence_overrides: {},
    learning: {
      completion_log: [],
      move_log: [],
      stats: { moves: 0, completes: 0 }
    }
  };
}
function loadOverlays() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultOverlays();
    const obj = JSON.parse(raw);
    return {
      ...defaultOverlays(),
      ...obj,
      deletions: Array.isArray(obj.deletions) ? obj.deletions : [],
      new_tasks: Array.isArray(obj.new_tasks) ? obj.new_tasks : [],
      task_overrides:
        obj.task_overrides && typeof obj.task_overrides === "object"
          ? obj.task_overrides
          : {},
      recurrence_overrides:
        obj.recurrence_overrides && typeof obj.recurrence_overrides === "object"
          ? obj.recurrence_overrides
          : {},
      learning:
        obj.learning && typeof obj.learning === "object"
          ? { ...defaultOverlays().learning, ...obj.learning }
          : defaultOverlays().learning
    };
  } catch {
    return defaultOverlays();
  }
}
function saveOverlays(overlays) {
  overlays.updated_at = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
  updateStorageInfo(overlays);
}

/* ---------- Merge ---------- */
function mergeData(base, overlays) {
  const baseTasks = Array.isArray(base.tasks) ? base.tasks : [];
  const baseEvents = Array.isArray(base.events) ? base.events : [];
  const recRules = Array.isArray(base.recurrence_rules) ? base.recurrence_rules : [];

  const deletions = new Set(overlays.deletions || []);
  const overrides = overlays.task_overrides || {};
  const newTasks = overlays.new_tasks || [];

  let tasks = baseTasks.filter((t) => t && t.id && !deletions.has(t.id));
  let events = baseEvents.filter((e) => e && e.id && !deletions.has(e.id));

  tasks = tasks.map((t) => (overrides[t.id] ? { ...t, ...overrides[t.id] } : t));
  events = events.map((e) => (overrides[e.id] ? { ...e, ...overrides[e.id] } : e));

  const appended = [];
  for (const nt of newTasks) {
    if (!nt || !nt.id) continue;
    if (deletions.has(nt.id)) continue;
    appended.push(nt);
  }
  tasks = tasks.concat(appended);

  return { ...base, tasks, events, recurrence_rules: recRules, __overlays: overlays };
}

/* ---------- State ---------- */
const state = {
  base: null,
  overlays: loadOverlays(),
  merged: null,
  view: "today",
  zen: false,
  actionId: null,
  pendingAiPayload: null, // {summary, ops[]}
  filters: {
    pillar: "any",
    owner_id: "any",
    month: "any",
    status: "any",
    q: ""
  },
  sort: "due"
};

/* ---------- Base truth fetch ---------- */
async function loadBase() {
  const res = await fetch("./tasks.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load tasks.json (${res.status})`);
  return await res.json();
}

/* ---------- Derived lists ---------- */
function ownersList(base) {
  const arr = base.owners || base.people || [];
  return Array.isArray(arr) ? arr : [];
}
function pillarsList(base) {
  const p = base.pillars;
  if (Array.isArray(p) && p.length) return p;
  const ts = Array.isArray(base.tasks) ? base.tasks : [];
  const codes = uniq(ts.map((t) => t?.pillar).filter(Boolean)).sort();
  return codes.map((code) => ({ code, name: code }));
}
function ownerName(ownerId) {
  const base = state.merged || state.base || {};
  const owners = ownersList(base);
  const found = owners.find((o) => o.owner_id === ownerId || o.id === ownerId);
  return found ? found.name || ownerId : ownerId || "—";
}
function pillarLabel(pillarCode) {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const found = pillars.find(
    (p) => p.code === pillarCode || p.id === pillarCode || p.pillar === pillarCode
  );
  return found ? found.name || found.label || pillarCode : pillarCode || "—";
}
function getStatus(t) {
  const patch = state.overlays.task_overrides?.[t.id] || {};
  const status = patch.status || t.status || "";
  return status === "completed" ? "completed" : "open";
}
function isDone(t) {
  return getStatus(t) === "completed";
}
function isOverdue(t, today) {
  if (isDone(t)) return false;
  const due = parseISODate(t.due_date);
  if (!due) return false;
  return due < today;
}
function matchesFilters(item) {
  const f = state.filters;

  const q = (f.q || "").trim().toLowerCase();
  if (q) {
    const hay = `${item.title || ""} ${item.notes || ""} ${item.id || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }

  if (f.pillar !== "any" && (item.pillar || "") !== f.pillar) return false;
  if (f.owner_id !== "any" && (item.owner_id || "") !== f.owner_id) return false;

  if (f.month !== "any") {
    const d = (item.due_date || item.start_date || "");
    if (!d.startsWith(f.month)) return false;
  }

  if (f.status !== "any") {
    if (f.status === "completed" && item.__status !== "completed") return false;
    if (f.status === "open" && item.__status !== "open") return false;
  }

  return true;
}

function sortItems(items) {
  const today = parseISODate(todayLocalISO());
  const getKey = (it) => {
    if (state.sort === "priority") return priorityNum(it.priority);
    const d =
      parseISODate(state.sort === "start" ? it.start_date : it.due_date) ||
      parseISODate(state.sort === "start" ? it.due_date : it.start_date);
    return d ? d.getTime() : 9e15;
  };

  return items.slice().sort((a, b) => {
    // Overdue floats up inside open lists
    const ao = a.__status === "open" && isOverdue(a, today) ? 0 : 1;
    const bo = b.__status === "open" && isOverdue(b, today) ? 0 : 1;
    if (a.__status === "open" && b.__status === "open" && ao !== bo) return ao - bo;

    const ka = getKey(a);
    const kb = getKey(b);
    if (ka !== kb) return ka - kb;

    return safeText(a.title).localeCompare(safeText(b.title));
  });
}

/* ---------- View building ---------- */
function decorateTasks(tasks) {
  return tasks.map((t) => ({
    ...t,
    __status: isDone(t) ? "completed" : "open",
    type: normalizeType(t.type) || "task"
  }));
}

function buildTaskList(view) {
  const merged = state.merged || {};
  const tasks = Array.isArray(merged.tasks) ? merged.tasks : [];
  const today = parseISODate(todayLocalISO());
  const wStart = startOfWeek(today);
  const wEnd = endOfWeek(today);
  const mStart = startOfMonth(today);
  const mEnd = endOfMonth(today);

  let list = decorateTasks(tasks);

  if (view === "completed") list = list.filter((t) => t.__status === "completed");
  else list = list.filter((t) => t.__status === "open");

  if (view === "week") {
    list = list.filter((t) => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && d >= wStart && d <= wEnd;
    });
  } else if (view === "month") {
    list = list.filter((t) => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && d >= mStart && d <= mEnd;
    });
  } else if (view === "upcoming") {
    list = list.filter((t) => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      if (!d) return true;
      return d >= today;
    });
  } else if (view === "today") {
    // Today view is sectioned later
  }

  list = list.filter(matchesFilters);
  list = sortItems(list);
  return list;
}

function buildEvents() {
  const merged = state.merged || {};
  const baseEvents = Array.isArray(merged.events) ? merged.events : [];
  const tasks = Array.isArray(merged.tasks) ? merged.tasks : [];

  const taskEvents = tasks
    .filter((t) => {
      const type = normalizeType(t.type);
      return type === "event" || type === "meeting";
    })
    .map((t) => ({ ...t, __from_tasks: true }));

  const combined = baseEvents.concat(taskEvents).map((e) => ({
    ...e,
    __status: isDone(e) ? "completed" : "open",
    type: normalizeType(e.type) || (e.__from_tasks ? "event" : "event")
  }));

  return sortItems(combined.filter((e) => e.__status === "open").filter(matchesFilters));
}

/* ---------- UI helpers ---------- */
function viewTitleText(view) {
  const today = parseISODate(todayLocalISO());
  if (view === "today") return `Today (${isoFromDate(today)})`;
  if (view === "week") return `Week (${isoFromDate(startOfWeek(today))} → ${isoFromDate(endOfWeek(today))})`;
  if (view === "month") return `Month (${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")})`;
  if (view === "upcoming") return "Upcoming";
  if (view === "completed") return "Completed";
  if (view === "events") return "Events / Milestones";
  if (view === "pillars") return "Pillars Dashboard";
  return "Tasks";
}
function updateMetaLine() {
  const base = state.base || {};
  const meta = base.meta || {};
  const tz = meta.timezone ? `• ${meta.timezone}` : "";
  const ver = meta.version ? `v${meta.version}` : "";
  const line = [ver, meta.last_updated ? `updated ${meta.last_updated}` : "", tz].filter(Boolean).join(" ");
  document.getElementById("metaLine").textContent = line || "Flow Tasks";
}
function updateStorageInfo(overlays) {
  const el = document.getElementById("storageInfo");
  try {
    const bytes = new Blob([JSON.stringify(overlays)]).size;
    el.textContent = `Overlays: ${overlays.deletions.length} del • ${Object.keys(overlays.task_overrides || {}).length} patch • ${overlays.new_tasks.length} new • ~${Math.round(bytes / 1024)} KB`;
  } catch {
    el.textContent = "Local overlays stored.";
  }
}
function openSheet(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

/* ---------- Long press ---------- */
function attachLongPress(el, onLongPress) {
  let timer = null;
  let moved = false;
  const start = () => {
    moved = false;
    timer = setTimeout(() => {
      if (!moved) onLongPress();
    }, 420);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener(
    "touchmove",
    () => {
      moved = true;
      cancel();
    },
    { passive: true }
  );

  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("mousemove", () => {
    moved = true;
    cancel();
  });
}

/* ---------- Overlay mutations ---------- */
function ensurePatch(id) {
  if (!state.overlays.task_overrides[id]) state.overlays.task_overrides[id] = {};
  return state.overlays.task_overrides[id];
}

function logComplete(id, completed) {
  const now = new Date().toISOString();
  state.overlays.learning.stats.completes += 1;
  state.overlays.learning.completion_log.push({ id, completed, at: now });
  state.overlays.learning.completion_log = state.overlays.learning.completion_log.slice(-400);
}

function logMove(id, from, to, reason) {
  const now = new Date().toISOString();
  state.overlays.learning.stats.moves += 1;
  state.overlays.learning.move_log.push({ id, from, to, reason, at: now });
  state.overlays.learning.move_log = state.overlays.learning.move_log.slice(-400);
}

function toggleComplete(id) {
  const merged = state.merged || {};
  const all = (merged.tasks || []).concat(merged.events || []);
  const item = all.find((x) => x.id === id);
  if (!item) return;

  const patch = ensurePatch(id);
  const nowDone = !(getStatus(item) === "completed");
  patch.status = nowDone ? "completed" : "open";
  patch.completed_at = nowDone ? new Date().toISOString() : null;

  logComplete(id, nowDone);

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast(nowDone ? "Completed" : "Undone");
  render();
}

function deleteItem(id) {
  if (!id) return;
  if (!state.overlays.deletions.includes(id)) state.overlays.deletions.push(id);
  delete state.overlays.task_overrides[id];
  state.overlays.new_tasks = state.overlays.new_tasks.filter((t) => t.id !== id);

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Deleted (overlay)");
  render();
}

function moveToToday(id, reason = "manual") {
  const patch = ensurePatch(id);
  const today = todayLocalISO();
  const before = { start_date: patch.start_date ?? null, due_date: patch.due_date ?? null };
  patch.start_date = today;
  patch.due_date = today;
  logMove(id, before, { start_date: today, due_date: today }, reason);

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Moved to Today");
  render();
}

function deferOneDay(id) {
  const merged = state.merged || {};
  const item = (merged.tasks || []).find((t) => t.id === id);
  if (!item) return;

  const patch = ensurePatch(id);
  const current = parseISODate(patch.due_date || item.due_date || patch.start_date || item.start_date);
  const d = current ? new Date(current) : parseISODate(todayLocalISO());
  d.setDate(d.getDate() + 1);

  const before = { start_date: patch.start_date ?? item.start_date ?? null, due_date: patch.due_date ?? item.due_date ?? null };
  const nextISO = isoFromDate(d);
  patch.due_date = nextISO;
  if (!patch.start_date) patch.start_date = nextISO;
  logMove(id, before, { start_date: patch.start_date, due_date: patch.due_date }, "defer_1d");

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Deferred");
  render();
}

/* ---------- Rendering ---------- */
function renderSummary() {
  const list = buildTaskList("upcoming").filter((t) => t.__status === "open");
  const today = parseISODate(todayLocalISO());
  const wStart = startOfWeek(today);
  const wEnd = endOfWeek(today);

  const todayItems = list.filter((t) => {
    const d = parseISODate(t.due_date) || parseISODate(t.start_date);
    return d && isoFromDate(d) === isoFromDate(today);
  });
  const weekItems = list.filter((t) => {
    const d = parseISODate(t.due_date) || parseISODate(t.start_date);
    return d && d >= wStart && d <= wEnd;
  });
  const overdue = list.filter((t) => isOverdue(t, today));

  document.getElementById("sumToday").textContent = String(todayItems.length);
  document.getElementById("sumWeek").textContent = String(weekItems.length);
  document.getElementById("sumOverdue").textContent = String(overdue.length);
}

function renderRecurring() {
  const base = state.merged || {};
  const rules = Array.isArray(base.recurrence_rules) ? base.recurrence_rules : [];
  const panel = document.getElementById("recurringPanel");
  if (!rules.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const overrides = state.overlays.recurrence_overrides || {};
  panel.innerHTML = `
    <div class="recHead" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <strong>Recurring</strong>
      <span class="muted small">${rules.length} rule(s)</span>
    </div>
    ${rules
      .map((r) => {
        const enabled = overrides[r.id]?.enabled ?? true;
        const meta = [r.frequency, r.day_of_week].filter(Boolean).join(" ");
        return `
        <div class="rule">
          <div>
            <strong>${safeText(r.title || r.id)}</strong>
            <div class="muted small">${safeText(r.pillar || "")} ${meta ? "• " + meta : ""}</div>
            ${r.notes ? `<div class="muted small">${safeText(r.notes)}</div>` : ""}
          </div>
          <button class="toggle ${enabled ? "on" : ""}" data-rec="${r.id}" aria-label="Toggle recurrence">
            <span class="dot"></span>
          </button>
        </div>
      `;
      })
      .join("")}
  `;
  panel.querySelectorAll(".toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.rec;
      const cur = state.overlays.recurrence_overrides?.[id]?.enabled ?? true;
      if (!state.overlays.recurrence_overrides) state.overlays.recurrence_overrides = {};
      state.overlays.recurrence_overrides[id] = { enabled: !cur };
      saveOverlays(state.overlays);
      renderRecurring();
      toast(!cur ? "Recurring enabled" : "Recurring disabled");
    });
  });
}

function renderPillarsDash() {
  const dash = document.getElementById("pillarsDash");
  const byPillar = document.getElementById("dashByPillar");
  const byOwner = document.getElementById("dashByOwner");

  const open = buildTaskList("upcoming").filter((t) => t.__status === "open");
  const today = parseISODate(todayLocalISO());

  function counts(groupKeyFn) {
    const map = new Map();
    for (const t of open) {
      const k = groupKeyFn(t) || "—";
      if (!map.has(k)) map.set(k, { total: 0, overdue: 0, p1: 0 });
      const c = map.get(k);
      c.total += 1;
      if (isOverdue(t, today)) c.overdue += 1;
      if (String(t.priority) === "1") c.p1 += 1;
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }

  const pillarCounts = counts((t) => t.pillar);
  const ownerCounts = counts((t) => t.owner_id);

  byPillar.innerHTML =
    pillarCounts
      .map(
        ([k, c]) => `
    <div class="dashRow" data-pillar="${k}">
      <div>
        <div><strong>${pillarLabel(k)}</strong></div>
        <small>${k}</small>
      </div>
      <div class="kpis">
        <span class="kpi">${c.total} open</span>
        <span class="kpi ${c.overdue ? "danger" : ""}">${c.overdue} overdue</span>
        <span class="kpi">${c.p1} P1</span>
      </div>
    </div>
  `
      )
      .join("") || `<div class="muted small">No open tasks.</div>`;

  byOwner.innerHTML =
    ownerCounts
      .map(
        ([k, c]) => `
    <div class="dashRow" data-owner="${k}">
      <div>
        <div><strong>${ownerName(k)}</strong></div>
        <small>${k}</small>
      </div>
      <div class="kpis">
        <span class="kpi">${c.total} open</span>
        <span class="kpi ${c.overdue ? "danger" : ""}">${c.overdue} overdue</span>
        <span class="kpi">${c.p1} P1</span>
      </div>
    </div>
  `
      )
      .join("") || `<div class="muted small">No open tasks.</div>`;

  dash.hidden = state.view !== "pillars";

  dash.querySelectorAll("[data-pillar]").forEach((row) => {
    row.addEventListener("click", () => {
      state.filters.pillar = row.dataset.pillar;
      document.getElementById("filterPillar").value = state.filters.pillar;
      setView("upcoming");
      toast(`Filtered: ${row.dataset.pillar}`);
    });
  });
  dash.querySelectorAll("[data-owner]").forEach((row) => {
    row.addEventListener("click", () => {
      state.filters.owner_id = row.dataset.owner;
      document.getElementById("filterOwner").value = state.filters.owner_id;
      setView("upcoming");
      toast(`Filtered: ${row.dataset.owner}`);
    });
  });
}

function renderCard(t) {
  const today = parseISODate(todayLocalISO());
  const due = parseISODate(t.due_date);
  const start = parseISODate(t.start_date);
  const overdue = isOverdue(t, today);

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = t.id || "";

  const box = document.createElement("button");
  box.className = "checkbox" + (t.__status === "completed" ? " is-done" : "");
  box.setAttribute(
    "aria-label",
    t.__status === "completed" ? "Mark as not completed" : "Mark as completed"
  );
  box.innerHTML = `<span aria-hidden="true">${t.__status === "completed" ? "✓" : ""}</span>`;
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleComplete(t.id);
  });

  const main = document.createElement("div");
  main.className = "card__main";

  const title = document.createElement("h3");
  title.className = "card__title" + (t.__status === "completed" ? " done" : "");
  title.textContent = safeText(t.title || "(untitled)");

  const meta = document.createElement("div");
  meta.className = "card__meta";

  const pill = document.createElement("span");
  pill.className = "badge accent";
  pill.textContent = pillarLabel(t.pillar);

  const own = document.createElement("span");
  own.className = "badge";
  own.textContent = ownerName(t.owner_id);

  const d = document.createElement("span");
  d.className = "badge" + (overdue ? " danger" : "");
  d.textContent = due ? `due ${isoFromDate(due)}` : start ? `start ${isoFromDate(start)}` : "no date";

  const pr = document.createElement("span");
  pr.className = "badge ok";
  pr.textContent = `P${t.priority ?? 2}`;

  meta.append(pill, own, d, pr);
  main.append(title, meta);

  if (t.notes) {
    const notes = document.createElement("div");
    notes.className = "notes";
    notes.textContent = safeText(t.notes);
    main.appendChild(notes);
  }

  card.addEventListener("click", () => openEdit(t.id));
  attachLongPress(card, () => openActions(t.id, t.title));

  card.append(box, main);
  return card;
}

function renderTodaySections(listEl) {
  const today = parseISODate(todayLocalISO());
  const all = buildTaskList("today").filter((t) => t.__status === "open");
  const filtered = all.filter(matchesFilters);

  const overdue = filtered.filter((t) => isOverdue(t, today));
  const dueToday = filtered
    .filter((t) => !isOverdue(t, today))
    .filter((t) => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && isoFromDate(d) === isoFromDate(today);
    });

  const next = filtered.filter((t) => !overdue.includes(t) && !dueToday.includes(t));

  const makeSection = (label, arr) => {
    if (!arr.length) return;
    const h = document.createElement("div");
    h.className = "groupTitle";
    h.textContent = label;
    listEl.appendChild(h);
    if (state.zen) listEl.appendChild(renderCard(arr[0]));
    else arr.forEach((it) => listEl.appendChild(renderCard(it)));
  };

  makeSection("Overdue", sortItems(overdue));
  makeSection("Today", sortItems(dueToday));
  makeSection("Next", sortItems(next));

  if (!overdue.length && !dueToday.length && !next.length) {
    listEl.innerHTML = `<div class="muted" style="padding:18px 6px">Nothing here. Quick Add to capture something.</div>`;
  }
}

function render() {
  document.body.classList.toggle("zen", state.zen);

  document.getElementById("viewTitle").textContent = viewTitleText(state.view);
  renderSummary();
  renderRecurring();
  renderPillarsDash();
  renderAiHint();

  const listEl = document.getElementById("list");
  listEl.innerHTML = "";

  if (state.view === "pillars") return;

  if (state.view === "today") {
    renderTodaySections(listEl);
    return;
  }

  let items = [];
  if (state.view === "events") items = buildEvents();
  else items = buildTaskList(state.view);

  if (!items.length) {
    listEl.innerHTML = `<div class="muted" style="padding:18px 6px">Nothing here. Quick Add to capture something.</div>`;
    return;
  }

  const groups = new Map();
  for (const it of items) {
    const d = parseISODate(it.due_date) || parseISODate(it.start_date);
    const key = d ? isoFromDate(d) : "No date";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const entries = Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === "No date") return 1;
    if (b[0] === "No date") return -1;
    return a[0].localeCompare(b[0]);
  });

  for (const [k, arr] of entries) {
    const h = document.createElement("div");
    h.className = "groupTitle";
    h.textContent = k;
    listEl.appendChild(h);
    arr.forEach((it) => listEl.appendChild(renderCard(it)));
  }
}

/* ---------- Views ---------- */
function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  render();
}

/* ---------- Quick Add / Edit ---------- */
function initFilterOptions() {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  document.getElementById("filterPillar").innerHTML =
    `<option value="any">All Pillars</option>` +
    pillars
      .map((p) => {
        const code = p.code || p.id || p.pillar;
        const label = safeText(p.name || p.label || code);
        return `<option value="${code}">${label}</option>`;
      })
      .join("");

  document.getElementById("filterOwner").innerHTML =
    `<option value="any">All Owners</option>` +
    owners
      .map((o) => {
        const id = o.owner_id || o.id;
        const label = safeText(o.name || id);
        return `<option value="${id}">${label}</option>`;
      })
      .join("");

  const tasks = Array.isArray(base.tasks) ? base.tasks : [];
  const months = uniq(tasks.map((t) => (t?.due_date || "").slice(0, 7)).filter(Boolean))
    .sort()
    .reverse();
  document.getElementById("filterMonth").innerHTML =
    `<option value="any">All Months</option>` +
    months.map((m) => `<option value="${m}">${m}</option>`).join("");
}

function openQuickAdd() {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  document.getElementById("qaTitle").value = "";
  document.getElementById("qaNotes").value = "";
  document.getElementById("qaStart").value = "";
  document.getElementById("qaDue").value = "";
  document.getElementById("qaType").value = "task";
  document.getElementById("qaPriority").value = "2";

  document.getElementById("qaPillar").innerHTML =
    `<option value="">—</option>` +
    pillars
      .map((p) => `<option value="${p.code || p.id || p.pillar}">${safeText(p.name || p.label || p.code)}</option>`)
      .join("");
  document.getElementById("qaOwner").innerHTML =
    `<option value="">—</option>` +
    owners
      .map((o) => `<option value="${o.owner_id || o.id}">${safeText(o.name || o.owner_id || o.id)}</option>`)
      .join("");

  const aiSettings = loadAiSettings();
  document.getElementById("qaAiRefine").checked = !!(aiSettings.enabled && aiSettings.autoRefine);

  openSheet("quickAddSheet");
  setTimeout(() => document.getElementById("qaTitle").focus(), 60);
}

function saveQuickAdd() {
  const title = safeText(document.getElementById("qaTitle").value).trim();
  if (!title) return toast("Title required");

  const newId = `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const task = {
    id: newId,
    title,
    notes: safeText(document.getElementById("qaNotes").value || ""),
    start_date: document.getElementById("qaStart").value || null,
    due_date: document.getElementById("qaDue").value || null,
    type: document.getElementById("qaType").value || "task",
    priority: Number(document.getElementById("qaPriority").value || 2),
    pillar: document.getElementById("qaPillar").value || null,
    owner_id: document.getElementById("qaOwner").value || null
  };

  state.overlays.new_tasks.push(task);
  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);

  closeSheet("quickAddSheet");
  toast("Added");
  render();

  if (document.getElementById("qaAiRefine").checked) {
    aiRefineTaskById(newId, { origin: "quick_add" });
  }
}

function openEdit(id) {
  const merged = state.merged || {};
  const all = (merged.tasks || []).concat(merged.events || []);
  const item = all.find((x) => x.id === id);
  if (!item) return;

  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  document.getElementById("editId").value = id;
  document.getElementById("editTitle").value = item.title || "";
  document.getElementById("editNotes").value = item.notes || "";
  document.getElementById("editStart").value = item.start_date || "";
  document.getElementById("editDue").value = item.due_date || "";
  document.getElementById("editType").value = normalizeType(item.type) || "";
  document.getElementById("editPriority").value = (item.priority ?? "").toString();

  document.getElementById("editPillar").innerHTML =
    `<option value="">—</option>` +
    pillars
      .map((p) => {
        const code = p.code || p.id || p.pillar;
        const label = safeText(p.name || p.label || code);
        return `<option value="${code}" ${code === item.pillar ? "selected" : ""}>${label}</option>`;
      })
      .join("");

  document.getElementById("editOwner").innerHTML =
    `<option value="">—</option>` +
    owners
      .map((o) => {
        const oid = o.owner_id || o.id;
        const label = safeText(o.name || oid);
        return `<option value="${oid}" ${oid === item.owner_id ? "selected" : ""}>${label}</option>`;
      })
      .join("");

  openSheet("editSheet");
}

function saveEdit() {
  const id = document.getElementById("editId").value;
  if (!id) return;

  const patch = {
    title: safeText(document.getElementById("editTitle").value).trim(),
    notes: safeText(document.getElementById("editNotes").value || ""),
    start_date: document.getElementById("editStart").value || null,
    due_date: document.getElementById("editDue").value || null,
    type: document.getElementById("editType").value || null,
    priority: document.getElementById("editPriority").value
      ? Number(document.getElementById("editPriority").value)
      : null,
    pillar: document.getElementById("editPillar").value || null,
    owner_id: document.getElementById("editOwner").value || null
  };

  const idx = state.overlays.new_tasks.findIndex((t) => t.id === id);
  if (idx !== -1) state.overlays.new_tasks[idx] = { ...state.overlays.new_tasks[idx], ...patch };
  else Object.assign(ensurePatch(id), patch);

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  closeSheet("editSheet");
  toast("Saved");
  render();
}

/* ---------- Actions sheet ---------- */
function openActions(id, title) {
  state.actionId = id;
  document.getElementById("actionTitle").textContent = safeText(title || id);
  openSheet("actionSheet");
}

/* ---------- Export / Import ---------- */
function exportOverlays() {
  dlFile("overrides.json", JSON.stringify(state.overlays, null, 2));
}
function importOverlays() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    try {
      const obj = JSON.parse(txt);
      state.overlays = { ...defaultOverlays(), ...obj };
      saveOverlays(state.overlays);
      state.merged = mergeData(state.base, state.overlays);
      toast("Imported overlays");
      render();
    } catch {
      toast("Invalid JSON");
    }
  };
  input.click();
}
function backupMerged() {
  dlFile("merged.json", JSON.stringify(state.merged, null, 2));
}
function resetOverlays() {
  if (!confirm("Reset local overlays? This deletes completions, edits, and new tasks.")) return;
  state.overlays = defaultOverlays();
  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Reset");
  render();
}

/* ===========================
   AI: auto-apply safe ops (Mode B)
   =========================== */

function renderAiHint() {
  const row = document.getElementById("aiHintRow");
  const text = document.getElementById("aiHintText");
  const ready = getAiReadyState();

  if (!ready.enabled) {
    row.hidden = true;
    return;
  }

  if (state.pendingAiPayload) {
    row.hidden = false;
    text.textContent = state.pendingAiPayload.summary || "AI has suggestions ready.";
    return;
  }

  row.hidden = true;
}

function showAiReview(payload) {
  state.pendingAiPayload = payload;
  document.getElementById("aiReviewSummary").textContent = payload.summary || "AI suggestions";
  const list = document.getElementById("aiOpsList");
  list.innerHTML =
    (payload.ops || [])
      .map(
        (o) => `
    <div class="ai-op">
      <div class="ai-op__top">
        <span class="ai-op__kind">${safeText(o.op)}</span>
        <span class="muted small">${safeText(o.id)}</span>
      </div>
      <div class="muted small" style="margin-top:6px">${safeText(o.reason || "")}</div>
      ${
        o.fields
          ? `<pre class="muted small" style="margin:8px 0 0;white-space:pre-wrap">${safeText(
              JSON.stringify(o.fields, null, 2)
            )}</pre>`
          : ""
      }
    </div>
  `
      )
      .join("") || `<div class="muted small">No operations returned.</div>`;

  openSheet("aiReviewSheet");
  renderAiHint();
}

function discardAi() {
  state.pendingAiPayload = null;
  closeSheet("aiReviewSheet");
  renderAiHint();
  toast("Discarded");
}

function applyOpsArray(ops) {
  if (!Array.isArray(ops) || !ops.length) return 0;

  for (const o of ops) {
    if (o.op === "add") {
      const id =
        o.id && o.id.startsWith("temp_")
          ? o.id
          : `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      const fields = o.fields || {};
      state.overlays.new_tasks.push({
        id,
        title: safeText(fields.title || "Untitled"),
        type: normalizeType(fields.type) || "task",
        pillar: fields.pillar ?? null,
        owner_id: fields.owner_id ?? null,
        start_date: fields.start_date ?? null,
        due_date: fields.due_date ?? null,
        priority: fields.priority ?? 2,
        notes: safeText(fields.notes || ""),
        subtasks: Array.isArray(fields.subtasks) ? fields.subtasks : undefined,
        estimated_minutes: fields.estimated_minutes ?? undefined,
        energy: fields.energy ?? undefined
      });
    }

    if (o.op === "update") {
      Object.assign(ensurePatch(o.id), o.fields || {});
    }

    if (o.op === "complete") {
      const patch = ensurePatch(o.id);
      patch.status = "completed";
      patch.completed_at = new Date().toISOString();
      logComplete(o.id, true);
    }

    if (o.op === "undo_complete") {
      const patch = ensurePatch(o.id);
      patch.status = "open";
      patch.completed_at = null;
      logComplete(o.id, false);
    }

    if (o.op === "delete") {
      if (!state.overlays.deletions.includes(o.id)) state.overlays.deletions.push(o.id);
      delete state.overlays.task_overrides[o.id];
      state.overlays.new_tasks = state.overlays.new_tasks.filter((t) => t.id !== o.id);
    }
  }

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  return ops.length;
}

function applyAiOps(payload) {
  const ops = payload?.ops || [];
  if (!ops.length) return toast("No ops to apply");

  applyOpsArray(ops);

  state.pendingAiPayload = null;
  closeSheet("aiReviewSheet");
  renderAiHint();
  toast("Applied AI suggestions");
  render();
}

/**
 * MODE B: auto-apply safe edits.
 * Safe = update-only AND fields limited to a small allowlist, and no date changes/subtasks.
 */
function splitAiOpsForAutoApply(payload) {
  const ops = Array.isArray(payload?.ops) ? payload.ops : [];
  const safeFieldsAllow = new Set([
    "title",
    "notes",
    "pillar",
    "owner_id",
    "priority",
    "type",
    "estimated_minutes",
    "energy"
  ]);

  const autoOps = [];
  const reviewOps = [];

  for (const op of ops) {
    if (!op || typeof op !== "object") continue;

    if (op.op !== "update") {
      reviewOps.push(op);
      continue;
    }

    // Only allow updates to existing items (not temp adds)
    if (typeof op.id !== "string" || op.id.startsWith("temp_")) {
      // temp items can still be refined, but we treat as review so user sees what changed
      reviewOps.push(op);
      continue;
    }

    const fields = op.fields || {};
    const keys = Object.keys(fields);

    // Anything touching dates or subtasks must be reviewed
    if (keys.includes("start_date") || keys.includes("due_date") || keys.includes("subtasks")) {
      reviewOps.push(op);
      continue;
    }

    // Must be only allowlisted fields
    const allSafe = keys.every((k) => safeFieldsAllow.has(k));
    if (!allSafe) {
      reviewOps.push(op);
      continue;
    }

    // “Safe enough” — auto apply
    autoOps.push(op);
  }

  return { autoOps, reviewOps };
}

async function aiRefineTaskById(id, { origin = "manual" } = {}) {
  const settings = loadAiSettings();
  if (!settings.enabled) return toast("Enable AI in More");

  const merged = state.merged || {};
  const t = (merged.tasks || []).find((x) => x.id === id) || state.overlays.new_tasks.find((x) => x.id === id);
  if (!t) return;

  toast("AI refining…");

  try {
    const ctx = await buildAiContext(state.merged, state.overlays, { origin });
    const payload = await runRefineTask({ task: t, context: ctx });

    if (!payload || !Array.isArray(payload.ops)) {
      toast("AI returned nothing usable");
      return;
    }

    // Mode B split
    const { autoOps, reviewOps } = splitAiOpsForAutoApply(payload);

    let didAuto = 0;
    if (autoOps.length) {
      didAuto = applyOpsArray(autoOps);
    }

    if (reviewOps.length) {
      // Show only review ops; summary updated to reflect auto-applied changes
      const summaryBits = [];
      if (didAuto) summaryBits.push(`${didAuto} safe tweak${didAuto === 1 ? "" : "s"} applied`);
      summaryBits.push(`${reviewOps.length} change${reviewOps.length === 1 ? "" : "s"} to review`);
      showAiReview({
        summary: payload.summary ? `${payload.summary} · ${summaryBits.join(" · ")}` : summaryBits.join(" · "),
        ops: reviewOps
      });
      return;
    }

    // Nothing to review: AI UI should disappear
    state.pendingAiPayload = null;
    closeSheet("aiReviewSheet");
    renderAiHint();
    toast(didAuto ? "Refined" : "No changes needed");
    render();
  } catch (e) {
    console.error(e);
    toast(`AI error: ${e.message || "failed"}`);
  }
}

async function aiRebalanceToday() {
  const settings = loadAiSettings();
  if (!settings.enabled) return toast("Enable AI in More");

  toast("AI rebalancing…");

  try {
    const ctx = await buildAiContext(state.merged, state.overlays, { origin: "rebalance_today" });

    const today = todayLocalISO();
    const open = decorateTasks(state.merged?.tasks || []).filter((t) => t.__status === "open");
    const payload = await runRebalanceToday({ todayISO: today, tasks: open, context: ctx });

    if (!payload || !Array.isArray(payload.ops)) {
      toast("No rebalance suggestions");
      return;
    }

    // Rebalance is date-moving by nature, so always review
    showAiReview(payload);
  } catch (e) {
    console.error(e);
    toast(`AI error: ${e.message || "failed"}`);
  }
}

/* ---------- AI settings UI ---------- */
function loadAiSettingsIntoUI() {
  const s = loadAiSettings();
  document.getElementById("aiEnabled").checked = !!s.enabled;
  document.getElementById("aiAutoRefine").checked = !!s.autoRefine;
  document.getElementById("aiProvider").value = s.provider || "openai";
  document.getElementById("aiModel").value = s.model || "";
  document.getElementById("aiEndpoint").value = s.endpoint || "";
  document.getElementById("aiHeaders").value = s.headersJson || "";
  document.getElementById("aiRememberKey").checked = !!s.rememberKey;
  document.getElementById("aiKey").value = s.rememberKey ? s.apiKey || "" : "";
}

/* ---------- Wiring ---------- */
function wireUI() {
  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view))
  );

  document.getElementById("filterPillar").addEventListener("change", (e) => {
    state.filters.pillar = e.target.value;
    render();
  });
  document.getElementById("filterOwner").addEventListener("change", (e) => {
    state.filters.owner_id = e.target.value;
    render();
  });
  document.getElementById("filterMonth").addEventListener("change", (e) => {
    state.filters.month = e.target.value;
    render();
  });
  document.getElementById("filterStatus").addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    render();
  });
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.filters.q = e.target.value;
    render();
  });
  document.getElementById("sortBy").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });

  const filterbar = document.getElementById("filterbar");
  document.getElementById("btnToggleFilters").addEventListener("click", () => {
    filterbar.hidden = !filterbar.hidden;
  });

  document.getElementById("btnZen").addEventListener("click", () => {
    state.zen = !state.zen;
    toast(state.zen ? "Zen mode" : "Standard mode");
    render();
  });

  document.getElementById("btnMore").addEventListener("click", () => {
    loadAiSettingsIntoUI();
    openSheet("moreSheet");
  });

  document.getElementById("btnRebalance").addEventListener("click", aiRebalanceToday);

  // Close sheets
  document.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => closeSheet(el.dataset.close))
  );

  // FAB / Quick add
  document.getElementById("fab").addEventListener("click", openQuickAdd);
  document.getElementById("btnQuickAdd").addEventListener("click", openQuickAdd);
  document.getElementById("btnQaSave").addEventListener("click", saveQuickAdd);

  // Edit save / delete
  document.getElementById("btnEditSave").addEventListener("click", saveEdit);
  document.getElementById("btnDelete").addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    if (!id) return;
    if (!confirm("Delete this item? (Stored as deletion overlay.)")) return;
    closeSheet("editSheet");
    deleteItem(id);
  });

  document.getElementById("btnEditMoveToday").addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    if (!id) return;
    moveToToday(id, "edit_move_today");
    closeSheet("editSheet");
  });

  document.getElementById("btnEditAiRefine").addEventListener("click", async () => {
    const id = document.getElementById("editId").value;
    if (!id) return;
    closeSheet("editSheet");
    await aiRefineTaskById(id, { origin: "edit_refine" });
  });

  // Action sheet buttons
  document.getElementById("btnActionComplete").addEventListener("click", () => {
    if (!state.actionId) return;
    toggleComplete(state.actionId);
    closeSheet("actionSheet");
  });
  document.getElementById("btnActionEdit").addEventListener("click", () => {
    if (!state.actionId) return;
    closeSheet("actionSheet");
    openEdit(state.actionId);
  });
  document.getElementById("btnActionToday").addEventListener("click", () => {
    if (!state.actionId) return;
    moveToToday(state.actionId, "longpress_today");
    closeSheet("actionSheet");
  });
  document.getElementById("btnActionDefer").addEventListener("click", () => {
    if (!state.actionId) return;
    deferOneDay(state.actionId);
    closeSheet("actionSheet");
  });
  document.getElementById("btnActionAiRefine").addEventListener("click", async () => {
    if (!state.actionId) return;
    closeSheet("actionSheet");
    await aiRefineTaskById(state.actionId, { origin: "longpress_refine" });
  });

  // Inbox capture
  const inboxInput = document.getElementById("inboxInput");
  document.getElementById("btnInboxAdd").addEventListener("click", () => {
    const v = inboxInput.value.trim();
    if (!v) return;

    const newId = `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    state.overlays.new_tasks.push({
      id: newId,
      title: v,
      type: "task",
      priority: 2,
      notes: "",
      start_date: null,
      due_date: null,
      pillar: null,
      owner_id: null
    });

    inboxInput.value = "";
    saveOverlays(state.overlays);
    state.merged = mergeData(state.base, state.overlays);
    toast("Inbox captured");
    render();

    const ai = loadAiSettings();
    if (ai.enabled && ai.autoRefine) aiRefineTaskById(newId, { origin: "inbox_capture" });
  });
  inboxInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btnInboxAdd").click();
  });

  // Export / import
  document.getElementById("btnExportOverlays").addEventListener("click", exportOverlays);
  document.getElementById("btnImportOverlays").addEventListener("click", importOverlays);
  document.getElementById("btnBackupMerged").addEventListener("click", backupMerged);
  document.getElementById("btnResetOverlays").addEventListener("click", resetOverlays);

  // AI hint
  document.getElementById("btnAiHintOpen").addEventListener("click", () => openSheet("aiReviewSheet"));

  // AI review
  document.getElementById("btnAiDiscard").addEventListener("click", discardAi);
  document.getElementById("btnAiApply").addEventListener("click", () => {
    if (!state.pendingAiPayload) return discardAi();
    if (!confirm("Apply these AI suggestions to overlays?")) return;
    applyAiOps(state.pendingAiPayload);
  });

  // AI settings save/clear
  document.getElementById("btnAiSaveSettings").addEventListener("click", () => {
    const enabled = document.getElementById("aiEnabled").checked;
    const autoRefine = document.getElementById("aiAutoRefine").checked;
    const provider = document.getElementById("aiProvider").value;
    const model = document.getElementById("aiModel").value.trim();
    const endpoint = document.getElementById("aiEndpoint").value.trim();
    const headersJson = document.getElementById("aiHeaders").value.trim();
    const rememberKey = document.getElementById("aiRememberKey").checked;
    const apiKey = document.getElementById("aiKey").value;

    saveAiSettings({
      enabled,
      autoRefine,
      provider,
      model,
      endpoint,
      headersJson,
      rememberKey,
      apiKey: rememberKey ? apiKey : ""
    });
    toast("AI settings saved");
    closeSheet("moreSheet");
    renderAiHint();
  });

  document.getElementById("btnAiClearSettings").addEventListener("click", () => {
    clearAiSettings();
    loadAiSettingsIntoUI();
    toast("AI settings cleared");
    renderAiHint();
  });

  // Escape closes
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["editSheet", "quickAddSheet", "moreSheet", "actionSheet", "aiReviewSheet"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.hidden) el.hidden = true;
    });
  });
}

/* ---------- Boot ---------- */
async function boot() {
  wireUI();
  updateStorageInfo(state.overlays);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  try {
    state.base = await loadBase();
    updateMetaLine();
    state.merged = mergeData(state.base, state.overlays);
    initFilterOptions();
    render();
  } catch (e) {
    console.error(e);
    toast("Could not load tasks.json");
    document.getElementById("list").innerHTML = `<div class="muted" style="padding:18px 6px">
        <strong>Could not load tasks.json</strong><br>
        Host via http:// (not file://). tasks.json must be in the same folder.
      </div>`;
  }
}
boot();