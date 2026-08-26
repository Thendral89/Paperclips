// Token-scoped routes — everything here is reachable with no login, gated
// purely by requireEventLink() in index.js having already resolved a valid,
// unexpired token to exactly one event_staff_links row. Every query below
// filters on that one event_id; nothing here can reach another event.

import { json, badRequest } from "../lib/util.js";

export async function getScopedEvent(request, env, link) {
  const event = await env.DB.prepare(
    `SELECT e.id, e.type, e.event_date, e.venue, e.status, a.name AS account_name
     FROM events e JOIN accounts a ON a.id = e.account_id WHERE e.id = ?`
  ).bind(link.event_id).first();

  const [expenses, requests, tasks] = await Promise.all([
    env.DB.prepare(`SELECT * FROM expenses WHERE event_id = ? ORDER BY submitted_at DESC`).bind(link.event_id).all(),
    env.DB.prepare(`SELECT * FROM support_requests WHERE event_id = ? ORDER BY created_at DESC`).bind(link.event_id).all(),
    // Whole event's task list, same visibility model as expenses/support
    // above (anyone holding a valid link for this event can see it all) —
    // but `mine` marks which ones THIS link is allowed to update.
    env.DB.prepare(`SELECT et.*, esl.staff_name FROM event_tasks et LEFT JOIN event_staff_links esl ON esl.id = et.link_id WHERE et.event_id = ? ORDER BY et.created_at DESC`)
      .bind(link.event_id).all(),
  ]);

  return json({
    event,
    staff_name: link.staff_name,
    scope: link.scope,
    expires_at: link.expires_at,
    expenses: expenses.results,
    support_requests: requests.results,
    tasks: tasks.results.map((t) => ({ ...t, mine: t.link_id === link.id || t.link_id === null })),
  });
}

export async function submitExpense(request, env, link) {
  if (!link.scope.includes("expenses")) return badRequest("this link isn't scoped for expenses");
  const body = await request.json().catch(() => null);
  if (!body || !body.category || !body.amount) return badRequest("category and amount are required");
  await env.DB.prepare(
    `INSERT INTO expenses (event_id, link_id, category, amount, note) VALUES (?, ?, ?, ?, ?)`
  ).bind(link.event_id, link.id, body.category, Number(body.amount), body.note || null).run();
  return json({ ok: true }, { status: 201 });
}

export async function submitSupportRequest(request, env, link) {
  if (!link.scope.includes("support")) return badRequest("this link isn't scoped for support requests");
  const body = await request.json().catch(() => null);
  if (!body || !body.request) return badRequest("request text is required");
  await env.DB.prepare(
    `INSERT INTO support_requests (event_id, link_id, request) VALUES (?, ?, ?)`
  ).bind(link.event_id, link.id, body.request).run();
  return json({ ok: true }, { status: 201 });
}

export async function updateTaskStatus(request, env, link, taskId) {
  if (!link.scope.includes("tasks")) return badRequest("this link isn't scoped for tasks");
  const body = await request.json().catch(() => null);
  if (!body || !body.status) return badRequest("status is required");
  const task = await env.DB.prepare(`SELECT * FROM event_tasks WHERE id = ?`).bind(taskId).first();
  // Both checks matter: the event boundary (this token can only touch its
  // own event's tasks) and the assignment boundary (can't complete a task
  // that's specifically assigned to a different staff member).
  if (!task || task.event_id !== link.event_id) return badRequest("task not found on this event");
  if (task.link_id !== null && task.link_id !== link.id) return badRequest("this task is assigned to someone else");
  await env.DB.prepare(`UPDATE event_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(body.status, taskId).run();
  return json({ ok: true });
}
