import { json, badRequest, notFound } from "../lib/util.js";

const OBJECTS = ["leads","quotes","clients","bookings","events","tasks","resources","expenses","payments"];

function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

async function audit(env, staff, action, objectKey, recordId, before, after, source="web") {
  await env.DB.prepare(`INSERT INTO crm_audit_log(actor_type,actor_id,actor_email,action,object_key,record_id,before_json,after_json,source)
    VALUES('user',?,?,?,?,?,?,?)`)
    .bind(staff?.id || null, staff?.email || null, action, objectKey || null, recordId || null,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), source).run();
}

export async function getProductConfig(request, env) {
  const [company, branding, rules, templates, fields, numbering, documents, ai] = await Promise.all([
    env.DB.prepare("SELECT * FROM crm_company_profile WHERE id=1").first(),
    env.DB.prepare("SELECT * FROM crm_branding WHERE id=1").first(),
    env.DB.prepare("SELECT * FROM crm_business_rules WHERE active=1 ORDER BY category,label").all(),
    env.DB.prepare("SELECT * FROM crm_task_templates WHERE active=1 ORDER BY event_type_key,phase,sort_order,id").all(),
    env.DB.prepare("SELECT * FROM crm_custom_fields WHERE active=1 ORDER BY object_key,sort_order,id").all(),
    env.DB.prepare("SELECT * FROM crm_numbering_sequences ORDER BY object_key").all(),
    env.DB.prepare("SELECT * FROM crm_document_templates WHERE active=1 ORDER BY document_type,name").all(),
    env.DB.prepare("SELECT * FROM crm_ai_permissions WHERE id=1").first()
  ]);
  const rulesOut = rules.results.map(r => ({...r, value: parseJson(r.value_json,{})}));
  const fieldsOut = fields.results.map(f => ({...f, options: parseJson(f.options_json,[])}));
  return json({
    company, branding, rules: rulesOut, task_templates: templates.results,
    custom_fields: fieldsOut, numbering: numbering.results, document_templates: documents.results,
    ai: ai ? {...ai, allowed_read: parseJson(ai.allowed_read_json,[]), allowed_write: parseJson(ai.allowed_write_json,[]), confirmation_required: parseJson(ai.confirmation_required_json,[])} : null,
    objects: OBJECTS
  });
}

export async function updateCompany(request, env, staff) {
  const body = await request.json().catch(()=>null);
  if (!body?.company_name) return badRequest("company_name is required");
  const before = await env.DB.prepare("SELECT * FROM crm_company_profile WHERE id=1").first();
  await env.DB.prepare(`UPDATE crm_company_profile SET company_name=?,legal_name=?,phone=?,email=?,website=?,address=?,tax_id=?,currency=?,timezone=?,business_type=?,updated_at=datetime('now') WHERE id=1`)
    .bind(body.company_name,body.legal_name||null,body.phone||null,body.email||null,body.website||null,body.address||null,body.tax_id||null,body.currency||"INR",body.timezone||"Asia/Kolkata",body.business_type||"Wedding Photography & Production").run();
  const after = await env.DB.prepare("SELECT * FROM crm_company_profile WHERE id=1").first();
  await audit(env,staff,"update","company",1,before,after);
  return json(after);
}

export async function updateBranding(request, env, staff) {
  const body = await request.json().catch(()=>null);
  const before = await env.DB.prepare("SELECT * FROM crm_branding WHERE id=1").first();
  await env.DB.prepare(`UPDATE crm_branding SET logo_primary_url=?,logo_light_url=?,logo_dark_url=?,favicon_url=?,primary_color=?,secondary_color=?,accent_color=?,background_color=?,surface_color=?,theme_mode=?,font_family=?,ui_density=?,updated_at=datetime('now') WHERE id=1`)
    .bind(body.logo_primary_url||null,body.logo_light_url||null,body.logo_dark_url||null,body.favicon_url||null,body.primary_color||"#111111",body.secondary_color||"#666666",body.accent_color||"#B08D57",body.background_color||"#F7F5F1",body.surface_color||"#FFFFFF",["light","dark","system"].includes(body.theme_mode)?body.theme_mode:"system",body.font_family||"Inter",["compact","comfortable","spacious"].includes(body.ui_density)?body.ui_density:"comfortable").run();
  const after = await env.DB.prepare("SELECT * FROM crm_branding WHERE id=1").first();
  await audit(env,staff,"update","branding",1,before,after);
  return json(after);
}

export async function upsertBusinessRule(request, env, staff) {
  const body=await request.json().catch(()=>null);
  if (!body?.rule_key || !body?.label) return badRequest("rule_key and label are required");
  const before=body.id ? await env.DB.prepare("SELECT * FROM crm_business_rules WHERE id=?").bind(body.id).first() : null;
  const value=typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? {});
  if(body.id) await env.DB.prepare("UPDATE crm_business_rules SET rule_key=?,label=?,description=?,category=?,value_json=?,active=?,updated_at=datetime('now'),updated_by=? WHERE id=?").bind(body.rule_key,body.label,body.description||null,body.category||"General",value,body.active===false?0:1,staff?.email||null,body.id).run();
  else await env.DB.prepare("INSERT INTO crm_business_rules(rule_key,label,description,category,value_json,active,updated_by) VALUES(?,?,?,?,?,1,?)").bind(body.rule_key,body.label,body.description||null,body.category||"General",value,staff?.email||null).run();
  const after=await env.DB.prepare("SELECT * FROM crm_business_rules WHERE rule_key=?").bind(body.rule_key).first();
  await audit(env,staff,body.id?"update":"create","business_rule",after.id,before,after);
  return json({...after,value:parseJson(after.value_json,{})});
}

export async function upsertTaskTemplate(request, env, staff) {
  const body=await request.json().catch(()=>null);
  if(!body?.template_key || !body?.default_title || !["Pre-Production","Production","Post-Production"].includes(body.phase)) return badRequest("template_key, default_title and valid phase are required");
  const before=body.id?await env.DB.prepare("SELECT * FROM crm_task_templates WHERE id=?").bind(body.id).first():null;
  if(body.id) await env.DB.prepare(`UPDATE crm_task_templates SET template_key=?,name=?,event_type_key=?,phase=?,task_type=?,default_title=?,default_description=?,sort_order=?,required=?,auto_create=?,active=?,updated_at=datetime('now') WHERE id=?`).bind(body.template_key,body.name||"Default",body.event_type_key||null,body.phase,body.task_type||"Task",body.default_title,body.default_description||null,Number(body.sort_order||0),body.required?1:0,body.auto_create===false?0:1,body.active===false?0:1,body.id).run();
  else await env.DB.prepare(`INSERT INTO crm_task_templates(template_key,name,event_type_key,phase,task_type,default_title,default_description,sort_order,required,auto_create) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(body.template_key,body.name||"Default",body.event_type_key||null,body.phase,body.task_type||"Task",body.default_title,body.default_description||null,Number(body.sort_order||0),body.required?1:0,body.auto_create===false?0:1).run();
  const after=await env.DB.prepare("SELECT * FROM crm_task_templates WHERE template_key=?").bind(body.template_key).first();
  await audit(env,staff,body.id?"update":"create","task_template",after.id,before,after);
  return json(after);
}

export async function upsertCustomField(request, env, staff) {
  const body=await request.json().catch(()=>null);
  if(!OBJECTS.includes(body?.object_key)||!body?.field_key||!body?.field_label||!["text","long_text","number","date","boolean","select","multi_select","url"].includes(body?.field_type)) return badRequest("valid object_key, field_key, field_label and field_type are required");
  const options=JSON.stringify(Array.isArray(body.options)?body.options:[]);
  if(body.id) await env.DB.prepare("UPDATE crm_custom_fields SET object_key=?,field_key=?,field_label=?,field_type=?,options_json=?,required=?,active=?,sort_order=? WHERE id=?").bind(body.object_key,body.field_key,body.field_label,body.field_type,options,body.required?1:0,body.active===false?0:1,Number(body.sort_order||0),body.id).run();
  else await env.DB.prepare("INSERT INTO crm_custom_fields(object_key,field_key,field_label,field_type,options_json,required,sort_order) VALUES(?,?,?,?,?,?,?)").bind(body.object_key,body.field_key,body.field_label,body.field_type,options,body.required?1:0,Number(body.sort_order||0)).run();
  const after=await env.DB.prepare("SELECT * FROM crm_custom_fields WHERE object_key=? AND field_key=?").bind(body.object_key,body.field_key).first();
  await audit(env,staff,body.id?"update":"create","custom_field",after.id,null,after);
  return json({...after,options:parseJson(after.options_json,[])});
}

export async function updateNumbering(request, env, staff) {
  const body=await request.json().catch(()=>null);
  if(!OBJECTS.includes(body?.object_key)||!body?.prefix) return badRequest("object_key and prefix are required");
  await env.DB.prepare("UPDATE crm_numbering_sequences SET prefix=?,include_year=?,next_number=?,padding=?,updated_at=datetime('now') WHERE object_key=?").bind(body.prefix,body.include_year===false?0:1,Math.max(1,Number(body.next_number||1)),Math.max(1,Number(body.padding||4)),body.object_key).run();
  const after=await env.DB.prepare("SELECT * FROM crm_numbering_sequences WHERE object_key=?").bind(body.object_key).first();
  await audit(env,staff,"update","numbering",after.id,null,after);
  return json(after);
}

export async function updateAiPermissions(request, env, staff) {
  const body=await request.json().catch(()=>null);
  await env.DB.prepare("UPDATE crm_ai_permissions SET enabled=?,mcp_enabled=?,allowed_read_json=?,allowed_write_json=?,confirmation_required_json=?,updated_at=datetime('now') WHERE id=1")
    .bind(body?.enabled?1:0,body?.mcp_enabled?1:0,JSON.stringify(body?.allowed_read||[]),JSON.stringify(body?.allowed_write||[]),JSON.stringify(body?.confirmation_required||[])).run();
  const after=await env.DB.prepare("SELECT * FROM crm_ai_permissions WHERE id=1").first();
  await audit(env,staff,"update","ai_permissions",1,null,after,"web");
  return json({...after,allowed_read:parseJson(after.allowed_read_json,[]),allowed_write:parseJson(after.allowed_write_json,[]),confirmation_required:parseJson(after.confirmation_required_json,[])});
}

export async function getAuditLog(request, env) {
  const limit=Math.min(200,Math.max(1,Number(new URL(request.url).searchParams.get("limit")||50)));
  const {results}=await env.DB.prepare("SELECT * FROM crm_audit_log ORDER BY id DESC LIMIT ?").bind(limit).all();
  return json(results);
}
