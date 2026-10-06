// src/routes/configRoutes.js
// Admin-only configuration API. Internal entity/route keys remain stable;
// labels/picklists/resources are configurable data.

import { json, badRequest, notFound } from "../lib/util.js";

const PHASES = ["Pre-Production", "Production", "Post-Production"];
const RESOURCE_TYPES = ["Person", "Vendor"];

function parseRuleValue(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function picklistObject(groupKey) {
  const key = String(groupKey || "").toLowerCase();
  if (key.startsWith("resource_")) return "resources";
  if (key.startsWith("event_") || key.startsWith("post_production_")) return "events";
  if (key.startsWith("lead_")) return "leads";
  if (key.startsWith("account_") || key.startsWith("client_")) return "accounts";
  if (key.startsWith("package_") || key.startsWith("service_")) return "packages";
  if (key.startsWith("equipment_")) return "equipment";
  if (key.startsWith("expense_")) return "expenses";
  if (key.startsWith("financial_") || key.startsWith("payment_")) return "financials";
  return "general";
}

export async function getConfig(request, env) {
  const [{ results: labels }, { results: groups }, { results: resources }, { results: skills }, { results: resourceTypes }] =
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
          GROUP_CONCAT(DISTINCT rs.skill_id) AS skill_ids,
          GROUP_CONCAT(DISTINCT rp.phase) AS phases
        FROM resources r
        LEFT JOIN resource_skills rs ON rs.resource_id=r.id
        LEFT JOIN skills s ON s.id=rs.skill_id AND s.active=1
        LEFT JOIN resource_phase_assignments rp ON rp.resource_id=r.id
        GROUP BY r.id
        ORDER BY r.name
      `).all(),
      env.DB.prepare(`SELECT * FROM skills WHERE active=1 ORDER BY label`).all(),
	  env.DB.prepare(`SELECT value_key,value_label FROM picklist_values v JOIN picklist_groups g ON g.id=v.group_id WHERE g.group_key=? AND g.active=1 AND v.active=1 ORDER BY v.sort_order,v.value_label`).bind("resource_type").all(),
    ]);

  return json({
    labels: Object.fromEntries(labels.map(x => [x.label_key, x.label_value])),
    picklist_groups: groups,
	resource_types: resourceTypes,
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
    LEFT JOIN picklist_values v ON v.group_id=g.id AND v.active=1
    WHERE g.active=1
    ORDER BY g.sort_order,g.label,v.sort_order,v.value_label
  `).all();
  const groups = {};
  for (const row of results) {
    const g = groups[row.group_key] ||= {
      group_key: row.group_key, object_key: picklistObject(row.group_key),
      label: row.group_label, description: row.description, values: []
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

export async function listSkills(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT id,skill_key,label,active,created_at,updated_at FROM skills WHERE active=1 ORDER BY label`
  ).all();
  return json(results);
}

export async function upsertSkill(request, env) {
  const body = await request.json().catch(() => null);
  const label = String(body?.label || '').trim();
  if (!label) return badRequest('label is required');
  const key = String(body?.skill_key || label)
    .trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if (!key) return badRequest('invalid skill key');

  if (body.id) {
    await env.DB.prepare(`
      UPDATE skills SET skill_key=?,label=?,active=1,updated_at=datetime('now') WHERE id=?
    `).bind(key,label,body.id).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO skills(skill_key,label,active,created_at,updated_at)
      VALUES(?,?,1,datetime('now'),datetime('now'))
      ON CONFLICT(skill_key) DO UPDATE SET label=excluded.label,active=1,updated_at=datetime('now')
    `).bind(key,label).run();
  }
  return json({ ok:true });
}

export async function deleteSkill(request, env, id) {
  await env.DB.prepare(`UPDATE skills SET active=0,updated_at=datetime('now') WHERE id=?`).bind(id).run();
  return json({ ok:true });
}

export async function listResources(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT r.id,r.name,r.resource_type,r.phone,r.email,r.notes,r.active,
      COALESCE(GROUP_CONCAT(DISTINCT s.label),'') AS skills,
      COALESCE(GROUP_CONCAT(DISTINCT rs.skill_id),'') AS skill_ids,
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
  const requestedType = String(body.resource_type || "Person");
  const typeRow = await env.DB.prepare(`SELECT value_label FROM picklist_values v JOIN picklist_groups g ON g.id=v.group_id WHERE g.group_key=? AND g.active=1 AND v.active=1 AND (v.value_label=? OR v.value_key=?)`).bind("resource_type",requestedType,requestedType.toLowerCase()).first();
  const resourceType = typeRow?.value_label || "Person";

  let id = body.id;
  if (id) {
    const old = await env.DB.prepare(`SELECT id FROM resources WHERE id=?`).bind(id).first();
    if (!old) return notFound("resource not found");
    await env.DB.prepare(`
      UPDATE resources SET name=?,resource_type=?,phone=?,email=?,notes=?,active=?,updated_at=datetime('now')
      WHERE id=?
    `).bind(body.name,resourceType,body.phone||null,body.email||null,body.notes||null,body.active===false?0:1,id).run();
  } else {
    const result = await env.DB.prepare(`
      INSERT INTO resources(name,resource_type,phone,email,notes,active) VALUES(?,?,?,?,?,1)
    `).bind(body.name,resourceType,body.phone||null,body.email||null,body.notes||null).run();
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
    SELECT era.*,r.name AS resource_name,r.resource_type,s.label AS skill_label
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

  const resource=await env.DB.prepare("SELECT id,name,resource_type,active FROM resources WHERE id=?").bind(Number(body.resource_id)).first();
  if(!resource) return notFound("resource not found");
  if(!resource.active) return badRequest("resource is inactive");

  const skillId=body.skill_id ? Number(body.skill_id) : null;
  if(skillId){
    const match=await env.DB.prepare(
      "SELECT 1 FROM resource_skills rs JOIN skills s ON s.id=rs.skill_id WHERE rs.resource_id=? AND rs.skill_id=? AND s.active=1"
    ).bind(resource.id,skillId).first();
    if(!match) return badRequest("selected skill is not assigned to this resource");
  }

  const event=await env.DB.prepare("SELECT event_date,start_time,end_time FROM events WHERE id=?").bind(eventId).first();
  if(!event) return notFound("event not found");

  const phaseAssignment=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM resource_phase_assignments WHERE resource_id=?"
  ).bind(resource.id).first();
  if(Number(phaseAssignment?.n||0)>0){
    const phaseOk=await env.DB.prepare(
      "SELECT 1 FROM resource_phase_assignments WHERE resource_id=? AND phase=?"
    ).bind(resource.id,body.phase).first();
    if(!phaseOk) return badRequest("resource is not configured for this workflow phase");
  }

  const existingId=body.id?Number(body.id):null;
  const existingAllocation=existingId?await env.DB.prepare(
    "SELECT original_estimate,start_at,end_at,allocation_date,start_time,end_time FROM event_resource_allocations WHERE id=? AND event_id=?"
  ).bind(existingId,eventId).first():null;

  const allocationDate=body.allocation_date || existingAllocation?.allocation_date || event.event_date || null;
  const startAt=body.start_at || (allocationDate && body.start_time ? `${allocationDate}T${body.start_time}` : existingAllocation?.start_at || (event.event_date && event.start_time ? `${event.event_date}T${event.start_time}` : null));
  const endAt=body.end_at || (allocationDate && body.end_time ? `${allocationDate}T${body.end_time}` : existingAllocation?.end_at || (event.event_date && event.end_time ? `${event.event_date}T${event.end_time}` : null));
  if(startAt && endAt && startAt>=endAt) return badRequest("end date/time must be after start date/time");

  const startDate=startAt ? String(startAt).slice(0,10) : allocationDate;
  const endDate=endAt ? String(endAt).slice(0,10) : startDate;
  const startTime=startAt ? String(startAt).slice(11,16) : null;
  const endTime=endAt ? String(endAt).slice(11,16) : null;

  const conflictRule=await env.DB.prepare(
    "SELECT value_json FROM crm_business_rules WHERE rule_key='resource.block_conflict' AND active=1 ORDER BY id DESC LIMIT 1"
  ).first();
  const conflictEnabled=conflictRule ? parseRuleValue(conflictRule.value_json).enabled!==false : true;
  if(conflictEnabled && startAt && endAt){
    const conflict=await env.DB.prepare(`
      SELECT era.id,r.name
      FROM event_resource_allocations era
      JOIN resources r ON r.id=era.resource_id
      WHERE era.resource_id=? AND era.event_id<>?
        AND COALESCE(era.status,'Planned')<>'Cancelled'
        AND COALESCE(era.start_at, CASE WHEN era.allocation_date IS NOT NULL AND era.start_time IS NOT NULL THEN era.allocation_date || 'T' || era.start_time END) < ?
        AND COALESCE(era.end_at, CASE WHEN era.allocation_date IS NOT NULL AND era.end_time IS NOT NULL THEN era.allocation_date || 'T' || era.end_time END) > ?
      LIMIT 1
    `).bind(resource.id,eventId,endAt,startAt).first();
    if(conflict) return badRequest(`resource conflict: ${conflict.name} is already allocated during that time`);
  }

  const resourceType=String(resource.resource_type||"Internal").toLowerCase();
  const isExternal=resourceType.includes("external") || resourceType.includes("vendor") || resourceType.includes("equipment");
  const original=Number(body.original_estimate ?? existingAllocation?.original_estimate ?? body.cost ?? 0);
  const revised=isExternal && body.revised_estimate!=="" && body.revised_estimate!=null ? Number(body.revised_estimate) : null;
  const actual=Number(body.actual_paid||0);
  if(!Number.isFinite(original)||original<0|| (revised!=null && (!Number.isFinite(revised)||revised<0)) || !Number.isFinite(actual)||actual<0) return badRequest("resource costs must be valid non-negative numbers");

  if(existingId){
    const existing=await env.DB.prepare("SELECT * FROM event_resource_allocations WHERE id=? AND event_id=?").bind(existingId,eventId).first();
    if(!existing) return notFound("allocation not found");
    await env.DB.prepare(`
      UPDATE event_resource_allocations
      SET resource_id=?,phase=?,role_label=?,skill_id=?,cost=?,status=?,notes=?,
          allocation_date=?,start_time=?,end_time=?,start_at=?,end_at=?,original_estimate=?,revised_estimate=?,actual_paid=?,payment_date=?,cost_notes=?
      WHERE id=? AND event_id=?
    `).bind(resource.id,body.phase,null,skillId,revised??original,body.status||"Planned",body.notes||null,
      startDate,startTime,endTime,startAt,endAt,original,revised,actual,body.payment_date||null,body.cost_notes||null,existingId,eventId).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO event_resource_allocations(
        event_id,resource_id,phase,role_label,skill_id,cost,status,notes,
        allocation_date,start_time,end_time,start_at,end_at,original_estimate,revised_estimate,actual_paid,payment_date,cost_notes
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(eventId,resource.id,body.phase,null,skillId,revised??original,body.status||"Planned",body.notes||null,
      startDate,startTime,endTime,startAt,endAt,original,revised,actual,body.payment_date||null,body.cost_notes||null).run();
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
