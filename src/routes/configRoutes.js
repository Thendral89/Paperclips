// src/routes/configRoutes.js
// Admin-only configuration API. Internal entity/route keys remain stable;
// labels/picklists/resources are configurable data.

import { json, badRequest, notFound } from "../lib/util.js";

const PHASES = ["Pre-Production", "Production", "Post-Production"];

export async function getConfig(request, env) {
  const [{ results: labels }, { results: groups }, { results: resources }, { results: skills }] =
    await Promise.all([
      env.DB.prepare(`SELECT label_key, label_value FROM app_labels ORDER BY label_key`).all(),
      env.DB.prepare(`
        SELECT g.id,g.group_key,g.label,g.description,g.sort_order,g.active,
               COUNT(v.id) AS value_count
        FROM picklist_groups g
        LEFT JOIN picklist_values v ON v.group_id=g.id AND v.active=1
        GROUP BY g.id
        ORDER BY g.sort_order,g.label
      `).all(),
      env.DB.prepare(`
        SELECT r.*,
          GROUP_CONCAT(DISTINCT s.label) AS skills,
          GROUP_CONCAT(DISTINCT rp.phase) AS phases
        FROM resources r
        LEFT JOIN resource_skills rs ON rs.resource_id=r.id
        LEFT JOIN skills s ON s.id=rs.skill_id AND s.active=1
        LEFT JOIN resource_phase_assignments rp ON rp.resource_id=r.id
        GROUP BY r.id
        ORDER BY r.name
      `).all(),
      env.DB.prepare(`SELECT * FROM skills WHERE active=1 ORDER BY label`).all(),
    ]);

  return json({
    labels: Object.fromEntries(labels.map(x => [x.label_key, x.label_value])),
    picklist_groups: groups,
    resources,
    skills,
    phases: PHASES
  });
}

export async function listLabels(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT label_key,label_value,updated_at,updated_by FROM app_labels ORDER BY label_key`
  ).all();
  return json(results);
}

export async function updateLabel(request, env, staff) {
  const body = await request.json().catch(() => null);
  if (!body?.label_key) return badRequest("label_key is required");
  const value = String(body.label_value ?? "").trim();
  if (!value) return badRequest("label_value is required");
  await env.DB.prepare(`
    INSERT INTO app_labels(label_key,label_value,updated_at,updated_by)
    VALUES(?,?,datetime('now'),?)
    ON CONFLICT(label_key) DO UPDATE SET
      label_value=excluded.label_value,
      updated_at=datetime('now'),
      updated_by=excluded.updated_by
  `).bind(body.label_key, value, staff?.email || null).run();
  return json({ ok: true });
}

export async function listPicklists(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT g.group_key,g.label AS group_label,g.description,g.sort_order AS group_sort,
           v.id,v.value_key,v.value_label,v.sort_order,v.active
    FROM picklist_groups g
    LEFT JOIN picklist_values v ON v.group_id=g.id
    WHERE g.active=1
    ORDER BY g.sort_order,g.label,v.sort_order,v.value_label
  `).all();
  const groups = {};
  for (const row of results) {
    const g = groups[row.group_key] ||= {
      group_key: row.group_key, label: row.group_label,
      description: row.description, values: []
    };
    if (row.id) g.values.push(row);
  }
  return json(Object.values(groups));
}

export async function upsertPicklistValue(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.group_key || !body?.value_label) return badRequest("group_key and value_label are required");
  const group = await env.DB.prepare(`SELECT id FROM picklist_groups WHERE group_key=? AND active=1`)
    .bind(body.group_key).first();
  if (!group) return notFound("picklist group not found");

  const key = String(body.value_key || body.value_label)
    .trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  if (!key) return badRequest("invalid value key");

  if (body.id) {
    await env.DB.prepare(`
      UPDATE picklist_values
      SET value_key=?,value_label=?,sort_order=?,active=?
      WHERE id=? AND group_id=?
    `).bind(key,String(body.value_label).trim(),Number(body.sort_order||0),body.active===false?0:1,body.id,group.id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO picklist_values(group_id,value_key,value_label,sort_order,active)
      VALUES(?,?,?,?,1)
      ON CONFLICT(group_id,value_key) DO UPDATE SET
        value_label=excluded.value_label,
        active=1
    `).bind(group.id,key,String(body.value_label).trim(),Number(body.sort_order||0)).run();
  }
  return json({ ok: true });
}

export async function deletePicklistValue(request, env, id) {
  await env.DB.prepare(`UPDATE picklist_values SET active=0 WHERE id=?`).bind(id).run();
  return json({ ok: true });
}

export async function listResources(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT r.id,r.name,r.phone,r.email,r.notes,r.active,
      COALESCE(GROUP_CONCAT(DISTINCT s.label),'') AS skills,
      COALESCE(GROUP_CONCAT(DISTINCT rp.phase),'') AS phases
    FROM resources r
    LEFT JOIN resource_skills rs ON rs.resource_id=r.id
    LEFT JOIN skills s ON s.id=rs.skill_id AND s.active=1
    LEFT JOIN resource_phase_assignments rp ON rp.resource_id=r.id
    GROUP BY r.id
    ORDER BY r.name
  `).all();
  return json(results);
}

export async function saveResource(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.name) return badRequest("name is required");

  let id = body.id;
  if (id) {
    const old = await env.DB.prepare(`SELECT id FROM resources WHERE id=?`).bind(id).first();
    if (!old) return notFound("resource not found");
    await env.DB.prepare(`
      UPDATE resources SET name=?,phone=?,email=?,notes=?,active=?,updated_at=datetime('now')
      WHERE id=?
    `).bind(body.name,body.phone||null,body.email||null,body.notes||null,body.active===false?0:1,id).run();
  } else {
    const result = await env.DB.prepare(`
      INSERT INTO resources(name,phone,email,notes,active) VALUES(?,?,?,?,1)
    `).bind(body.name,body.phone||null,body.email||null,body.notes||null).run();
    id = result.meta.last_row_id;
  }

  await env.DB.prepare(`DELETE FROM resource_skills WHERE resource_id=?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM resource_phase_assignments WHERE resource_id=?`).bind(id).run();

  for (const skillId of (Array.isArray(body.skill_ids) ? body.skill_ids : [])) {
    await env.DB.prepare(`INSERT OR IGNORE INTO resource_skills(resource_id,skill_id) VALUES(?,?)`).bind(id,skillId).run();
  }
  for (const phase of (Array.isArray(body.phases) ? body.phases : [])) {
    if (!PHASES.includes(phase)) continue;
    await env.DB.prepare(`INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase) VALUES(?,?)`).bind(id,phase).run();
  }
  return json({ ok:true,id });
}

export async function deleteResource(request, env, id) {
  const used = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM event_resource_allocations WHERE resource_id=?`
  ).bind(id).first();
  if (Number(used?.n || 0) > 0) return badRequest("Resource is allocated to an event. Deactivate it instead.");
  await env.DB.prepare(`UPDATE resources SET active=0,updated_at=datetime('now') WHERE id=?`).bind(id).run();
  return json({ ok:true });
}

export async function listEventResources(request, env, eventId) {
  const { results } = await env.DB.prepare(`
    SELECT era.*,r.name AS resource_name,s.label AS skill_label
    FROM event_resource_allocations era
    JOIN resources r ON r.id=era.resource_id
    LEFT JOIN skills s ON s.id=era.skill_id
    WHERE era.event_id=?
    ORDER BY CASE era.phase
      WHEN 'Pre-Production' THEN 1
      WHEN 'Production' THEN 2
      WHEN 'Post-Production' THEN 3 ELSE 4 END,
      r.name
  `).bind(eventId).all();
  return json(results);
}

export async function saveEventResource(request, env, eventId) {
  const body = await request.json().catch(() => null);
  if (!body?.resource_id || !PHASES.includes(body.phase)) return badRequest("resource_id and valid phase are required");
  const resource = await env.DB.prepare(`SELECT id FROM resources WHERE id=? AND active=1`).bind(body.resource_id).first();
  if (!resource) return notFound("resource not found");
  const phaseAssignment = await env.DB.prepare(`
    SELECT 1 FROM resource_phase_assignments WHERE resource_id=? AND phase=?
  `).bind(body.resource_id,body.phase).first();
  if (!phaseAssignment) return badRequest("Resource is not assigned to this workflow phase");
  const skillId = body.skill_id ? Number(body.skill_id) : null;
  if (skillId) {
    const skillAssignment = await env.DB.prepare(`
      SELECT 1 FROM resource_skills WHERE resource_id=? AND skill_id=?
    `).bind(body.resource_id,skillId).first();
    if (!skillAssignment) return badRequest("Selected skill is not assigned to this resource");
  }
  const cost = Number(body.cost || 0);
  if (!Number.isFinite(cost) || cost < 0) return badRequest("cost must be a non-negative number");

  // SQLite UNIQUE constraints treat NULLs as distinct, so handle the
  // no-skill allocation explicitly instead of relying on ON CONFLICT.
  let existing;
  if (skillId == null) {
    existing = await env.DB.prepare(`
      SELECT id FROM event_resource_allocations
      WHERE event_id=? AND resource_id=? AND phase=? AND skill_id IS NULL
    `).bind(eventId,body.resource_id,body.phase).first();
  } else {
    existing = await env.DB.prepare(`
      SELECT id FROM event_resource_allocations
      WHERE event_id=? AND resource_id=? AND phase=? AND skill_id=?
    `).bind(eventId,body.resource_id,body.phase,skillId).first();
  }

  if (existing) {
    await env.DB.prepare(`
      UPDATE event_resource_allocations
      SET role_label=?,skill_id=?,cost=?,status=?,notes=?
      WHERE id=?
    `).bind(body.role_label||null,skillId,cost,body.status||"Planned",body.notes||null,existing.id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO event_resource_allocations(event_id,resource_id,phase,role_label,skill_id,cost,status,notes)
      VALUES(?,?,?,?,?,?,?,?)
    `).bind(eventId,body.resource_id,body.phase,body.role_label||null,skillId,cost,body.status||"Planned",body.notes||null).run();
  }
  return json({ok:true});
}

export async function deleteEventResource(request, env, allocationId) {
  await env.DB.prepare(`DELETE FROM event_resource_allocations WHERE id=?`).bind(allocationId).run();
  return json({ok:true});
}

export async function hydrateEventExpenseMeta(env, expenseId) {
  await env.DB.prepare(`
    INSERT INTO event_expense_meta(expense_id,event_code,client_name,event_date,event_type)
    SELECT e2.id,
           'EV-' || printf('%06d',e2.id) || '-' || replace(COALESCE(a.name,''),' ','-') || '-' || COALESCE(e2.event_date,'TBD'),
           a.name,e2.event_date,e2.type
    FROM expenses x
    JOIN events e2 ON e2.id=x.event_id
    JOIN accounts a ON a.id=e2.account_id
    WHERE x.id=?
    ON CONFLICT(expense_id) DO UPDATE SET
      event_code=excluded.event_code,client_name=excluded.client_name,
      event_date=excluded.event_date,event_type=excluded.event_type
  `).bind(expenseId).run();
}

export async function listEventExpenses(request, env, eventId) {
  const { results } = await env.DB.prepare(`
    SELECT x.*,m.event_code,m.client_name,m.event_date,m.event_type
    FROM expenses x
    LEFT JOIN event_expense_meta m ON m.expense_id=x.id
    WHERE x.event_id=?
    ORDER BY x.submitted_at DESC
  `).bind(eventId).all();
  return json(results);
}


export async function listServicesConfig(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id,name,base_price,category FROM services ORDER BY category,name`
  ).all();
  return json(results);
}

export async function saveService(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.name) return badRequest("name is required");
  const name = String(body.name).trim();
  const price = Number(body.base_price ?? 0);
  if (!Number.isFinite(price) || price < 0) return badRequest("base_price must be a non-negative number");
  if (body.id) {
    const existing = await env.DB.prepare(`SELECT id FROM services WHERE id=?`).bind(body.id).first();
    if (!existing) return notFound("service not found");
    await env.DB.prepare(`UPDATE services SET name=?,base_price=?,category=? WHERE id=?`)
      .bind(name, price, body.category || null, body.id).run();
    return json({ ok:true, id:Number(body.id) });
  }
  const result = await env.DB.prepare(`INSERT INTO services(name,base_price,category) VALUES(?,?,?)`)
    .bind(name, price, body.category || null).run();
  return json({ ok:true, id:result.meta.last_row_id }, {status:201});
}

export async function deleteService(request, env, id) {
  const used = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM event_services WHERE service_id=?) +
      (SELECT COUNT(*) FROM package_items WHERE service_id=?) AS n
  `).bind(id,id).first();
  if (Number(used?.n || 0) > 0) {
    return badRequest("Service is already used by an event or package. Deactivate/keep it instead of deleting it.");
  }
  await env.DB.prepare(`DELETE FROM services WHERE id=?`).bind(id).run();
  return json({ok:true});
}
