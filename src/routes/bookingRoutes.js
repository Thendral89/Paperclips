import { json, badRequest, notFound } from "../lib/util.js";
import { rebuildEventOperations } from "./adminRoutes.js";

function parseQty(label) {
  const s=String(label||"");
  const m=s.match(/^\s*(\d+)\s*[x×]/i);
  if(m) return Math.max(1,Number(m[1]));
  const words=s.toLowerCase();
  if(/\b(two|2)\b/.test(words)) return 2;
  if(/\b(three|3)\b/.test(words)) return 3;
  return 1;
}
function parseRuleValue(value) {
  try { return value == null ? {} : JSON.parse(value); } catch { return {}; }
}
function resourceItemMatches(templateTitle,label) {
  const t=String(templateTitle||"").toLowerCase();
  const s=String(label||"").toLowerCase();
  const groups={
    "photography":["photography","photographer","photographers","photo"],
    "videography":["videography","videographer","videographers","video"],
    "cinematography":["cinematography","cinematographer","cinematographers","cinematic"],
    "drone":["drone","aerial"]
  };
  for(const [key,words] of Object.entries(groups)) {
    if(t.includes(key)) return words.some(w=>s.includes(w));
  }
  return s.includes(t.split(/\s+/)[0]);
}

async function nextNumber(env,key) {
  for(let attempt=0;attempt<5;attempt++){
    const row=await env.DB.prepare("SELECT prefix,include_year,next_number,padding FROM crm_numbering_sequences WHERE object_key=?").bind(key).first();
    if(!row) return null;
    const number=Number(row.next_number||1);
    const year=Number(row.include_year) ? new Date().getFullYear()+"-" : "";
    const value=String(number).padStart(Number(row.padding||4),"0");
    const updated=await env.DB.prepare(`UPDATE crm_numbering_sequences
      SET next_number=next_number+1,updated_at=datetime('now')
      WHERE object_key=? AND next_number=?`).bind(key,number).run();
    if(Number(updated.meta?.changes||0)===1) return String(row.prefix||"")+year+value;
  }
  throw new Error(`Unable to allocate a unique ${key} number after concurrent updates`);
}

export async function listBookings(request, env) {
  const {results}=await env.DB.prepare(`SELECT b.*,a.name AS client_name,a.phone AS client_phone,q.status AS quote_status,
    (SELECT COUNT(*) FROM events e WHERE e.booking_id=b.id) AS event_count,
    (SELECT COALESCE(SUM(p.amount),0) FROM booking_payments p WHERE p.booking_id=b.id) AS paid_amount
    FROM bookings b JOIN accounts a ON a.id=b.account_id
    LEFT JOIN lead_quotes q ON q.id=b.quote_id
    ORDER BY b.created_at DESC LIMIT 200`).all();
  return json(results);
}

export async function getBooking(request, env, id) {
  const b=await env.DB.prepare(`SELECT b.*,a.name AS client_name,a.phone AS client_phone,a.email AS client_email
    FROM bookings b JOIN accounts a ON a.id=b.account_id WHERE b.id=?`).bind(id).first();
  if(!b) return notFound("booking not found");
  const [events,payments,schedule]=await Promise.all([
    env.DB.prepare("SELECT * FROM events WHERE booking_id=? ORDER BY event_date,id").bind(id).all(),
    env.DB.prepare("SELECT * FROM booking_payments WHERE booking_id=? ORDER BY payment_date,id").bind(id).all(),
    env.DB.prepare("SELECT * FROM booking_payment_schedule WHERE booking_id=? ORDER BY due_date,id").bind(id).all()
  ]);
  return json({...b,events:events.results,payments:payments.results,payment_schedule:schedule.results});
}


export async function addBookingPayment(request, env, bookingId, staff) {
  const body=await request.json().catch(()=>null);
  const amount=Number(body?.amount);
  if(!Number.isFinite(amount)||amount<=0) return badRequest("amount must be greater than zero");
  const booking=await env.DB.prepare("SELECT id,booked_value FROM bookings WHERE id=?").bind(bookingId).first();
  if(!booking) return notFound("booking not found");
  const paidRow=await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS paid_amount FROM booking_payments WHERE booking_id=?").bind(bookingId).first();
  const outstanding=Math.max(0,Number(booking.booked_value||0)-Number(paidRow?.paid_amount||0));
  if(amount>outstanding) return badRequest(`payment exceeds outstanding balance of ${outstanding}`);
  const paymentDate=body.payment_date || new Date().toISOString().slice(0,10);
  const result=await env.DB.prepare(`INSERT INTO booking_payments(booking_id,amount,payment_date,method,reference,notes)
    VALUES(?,?,?,?,?,?)`).bind(bookingId,Math.round(amount),paymentDate,body.method||null,body.reference||null,body.notes||null).run();
  await env.DB.prepare("UPDATE bookings SET updated_at=datetime('now') WHERE id=?").bind(bookingId).run();
  const schedule=(await env.DB.prepare("SELECT * FROM booking_payment_schedule WHERE booking_id=? ORDER BY due_date,id").bind(bookingId).all()).results;
  let remainingPaid=Number(paidRow?.paid_amount||0)+Math.round(amount);
  for(const item of schedule){
    const itemAmount=Number(item.amount||0);
    const status=remainingPaid>=itemAmount && itemAmount>0 ? "Paid" : remainingPaid>0 ? "Partially Paid" : "Due";
    remainingPaid=Math.max(0,remainingPaid-itemAmount);
    if(status!==item.status) await env.DB.prepare("UPDATE booking_payment_schedule SET status=?,updated_at=datetime('now') WHERE id=?").bind(status,item.id).run();
  }
  return json({ok:true,id:result.meta.last_row_id,booking_id:bookingId});
}

export async function convertAcceptedQuote(request, env, quoteId) {
  const q=await env.DB.prepare(`SELECT q.*,l.name AS lead_name,l.phone,l.email,l.event_type,l.event_date,l.venue,l.source,l.id AS lead_id,
    a.id AS existing_account_id
    FROM lead_quotes q JOIN leads l ON l.id=q.lead_id
    LEFT JOIN accounts a ON a.lead_id=l.id
    WHERE q.id=?`).bind(quoteId).first();
  if(!q) return notFound("quote not found");
  if(!["Accepted","Won"].includes(q.status)) return badRequest("Quote must be Accepted/Won before conversion");

  const architectureRule=await env.DB.prepare(
    "SELECT value_json FROM crm_business_rules WHERE rule_key='architecture.accepted_quote.create_event' AND active=1 ORDER BY id DESC LIMIT 1"
  ).first();
  const conversionEnabled=architectureRule ? parseRuleValue(architectureRule.value_json).enabled!==false : true;
  if(!conversionEnabled) return badRequest("Accepted quote to Event conversion is disabled by business rule");

  const taskRule=await env.DB.prepare(
    "SELECT value_json FROM crm_business_rules WHERE rule_key='event.auto_create_quote_tasks' AND active=1 ORDER BY id DESC LIMIT 1"
  ).first();
  const autoCreateTasks=taskRule ? parseRuleValue(taskRule.value_json).enabled!==false : true;

  let accountId=q.existing_account_id;
  if(!accountId){
    const ar=await env.DB.prepare(
      "INSERT INTO accounts(lead_id,name,phone,email,notes) VALUES(?,?,?,?,?)"
    ).bind(
      q.lead_id,
      q.lead_name,
      q.phone||null,
      q.email||null,
      "Created from accepted quote"
    ).run();
    accountId=ar.meta.last_row_id;
  }

  let booking=await env.DB.prepare(
    "SELECT id,booking_number,booked_value FROM bookings WHERE quote_id=? ORDER BY id DESC LIMIT 1"
  ).bind(quoteId).first();
  if(!booking){
    const bookingNumber=await nextNumber(env,"booking");
    const br=await env.DB.prepare(`INSERT INTO bookings(account_id,quote_id,booking_number,status,booked_value,finalized_quote_total,confirmed_at)
      VALUES(?,?,?,?,?,?,datetime('now'))`).bind(accountId,quoteId,bookingNumber||null,"Booked",0,0).run();
    booking={id:br.meta.last_row_id,booking_number:bookingNumber||null,booked_value:0};
  }

  const existingEvent=await env.DB.prepare(
    "SELECT id,event_number,booking_id FROM events WHERE quote_id=? ORDER BY id DESC LIMIT 1"
  ).bind(quoteId).first();
  if(existingEvent) return json({
    ok:true,booking_id:booking.id,booking_number:booking.booking_number,
    event_id:existingEvent.id,event_number:existingEvent.event_number,
    account_id:accountId,already_exists:true
  });

  const selectedOption=await env.DB.prepare(
    "SELECT * FROM quote_package_options WHERE quote_id=? AND selected=1 ORDER BY id LIMIT 1"
  ).bind(quoteId).first();
  const addonItems=(await env.DB.prepare(
    "SELECT * FROM quote_items WHERE quote_id=? AND is_addon=1 AND selected=1 ORDER BY id"
  ).bind(quoteId).all()).results;
  const customizedItems=selectedOption ? (await env.DB.prepare(
    "SELECT * FROM quote_items WHERE quote_package_option_id=? AND is_addon=0 AND selected=1 ORDER BY id"
  ).bind(selectedOption.id).all()).results : [];
  const legacyItems=selectedOption ? [] : (await env.DB.prepare(
    "SELECT * FROM quote_items WHERE quote_id=? AND selected=1 ORDER BY id"
  ).bind(quoteId).all()).results;
  const items=selectedOption
    ? [{id:selectedOption.id,service_id:null,package_id:selectedOption.package_id,label:selectedOption.label,price:Number(selectedOption.price||0),quantity:1,is_addon:0,selected:1,details_json:selectedOption.details_json},...customizedItems,...addonItems]
    : legacyItems;
  const total=Math.max(0,items.reduce((sum,x)=>sum+Number(x.price||0)*Number(x.quantity||1),0)-Number(q.concession_amount||0));
  const bookingSnapshot={quote_id:q.id,status:"Accepted",concession_amount:Number(q.concession_amount||0),concession_note:q.concession_note||null,valid_until:q.valid_until||null,selected_package_option_id:selectedOption?.id||null,items:items.map(x=>({id:x.id,service_id:x.service_id||null,package_id:x.package_id||null,label:x.label,price:Number(x.price||0),quantity:Number(x.quantity||1),is_addon:Number(x.is_addon||0),selected:Number(x.selected||0),details_json:x.details_json||null}))};
  const quoteSnapshot={
    quote_id:q.id,
    status:"Accepted",
    accepted_at:new Date().toISOString(),
    concession_amount:Number(q.concession_amount||0),
    concession_note:q.concession_note||null,
    valid_until:q.valid_until||null,
    selected_package_option_id:selectedOption?.id||null,
    items:items.map(x=>({
      id:x.id,service_id:x.service_id||null,package_id:x.package_id||null,label:x.label,
      price:Number(x.price||0),quantity:Number(x.quantity||1),is_addon:Number(x.is_addon||0),selected:Number(x.selected||0),
      details_json:x.details_json||null
    }))
  };

  const eventNumber=await nextNumber(env,"event");
  const er=await env.DB.prepare(`INSERT INTO events(
      account_id,booking_id,quote_id,event_number,type,event_date,start_date,end_date,venue,status,quote_total,finalized_quote_total,
      quote_snapshot_json,commercial_finalized_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).bind(
      accountId,
      booking.id,
      quoteId,
      eventNumber||null,
      q.event_type||"Wedding",
      q.event_date||null,
      q.event_date||null,
      q.event_date||null,
      q.venue||null,
      "Planning",
      total,
      total,
      JSON.stringify(quoteSnapshot)
    ).run();
  const eventId=er.meta.last_row_id;

  // Keep conversion comfortably below D1 Free's per-invocation query ceiling.
  // Bulk INSERTs are chunked by bound-parameter count rather than issuing one
  // D1 statement per service/task/checklist row.
  const bulkInsert=async(table,columns,rows,maxParams=90)=>{
    if(!rows.length) return;
    const width=columns.length;
    const chunkSize=Math.max(1,Math.floor(maxParams/width));
    for(let i=0;i<rows.length;i+=chunkSize){
      const chunk=rows.slice(i,i+chunkSize);
      const placeholders=chunk.map(()=>`(${columns.map(()=>"?").join(",")})`).join(",");
      const binds=chunk.flat();
      await env.DB.prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES ${placeholders}`
      ).bind(...binds).run();
    }
  };

  const eventServiceRows=items.map(item=>[
    eventId,
    item.service_id||null,
    item.package_id||null,
    Number(item.price||0),
    item.is_addon?1:0
  ]);
  await bulkInsert(
    "event_services",
    ["event_id","service_id","package_id","price_at_booking","is_crosssell"],
    eventServiceRows
  );

  const templates=autoCreateTasks
    ? (await env.DB.prepare(`SELECT * FROM crm_task_templates
        WHERE active=1 AND auto_create=1 AND (event_type_key IS NULL OR event_type_key=?)
        ORDER BY phase,sort_order,id`).bind(q.event_type||"Wedding").all()).results
    : [];

  const taskRows=[];
  for(const t of templates){
    const matching=t.task_type==="Resource"
      ? items.filter(i=>resourceItemMatches(t.default_title,i.label))
      : [];
    const count=t.task_type==="Resource"
      ? matching.reduce((n,i)=>n+parseQty(i.label),0)
      : 1;

    for(let n=1;n<=count;n++){
      const sourceItem=t.task_type==="Resource"
        ? matching[Math.min(n-1,matching.length-1)]
        : null;
      const title=t.task_type==="Resource" && count>1
        ? `${t.default_title} #${n}`
        : t.default_title;
      taskRows.push([
        eventId,
        title,
        "Pending",
        t.phase,
        t.required?1:0,
        t.id,
        sourceItem?.id||null
      ]);
    }
  }

  await bulkInsert(
    "event_tasks",
    ["event_id","task","status","phase","required","template_id","source_quote_item_id"],
    taskRows
  );

  // Resource requirements are derived from the created task rows, so we don't
  // need one INSERT per task and don't need to depend on last_row_id ordering.
  await env.DB.prepare(`INSERT INTO event_resource_requirements(
      event_id,task_id,role_label,quantity,phase,allocation_date
    )
    SELECT et.event_id,et.id,t.default_title,1,et.phase,?
    FROM event_tasks et
    JOIN crm_task_templates t ON t.id=et.template_id
    WHERE et.event_id=? AND t.task_type='Resource'`).bind(
      q.event_date||null,eventId
    ).run();

  const checklistTemplates=(await env.DB.prepare(
    "SELECT * FROM checklist_templates WHERE active=1 ORDER BY phase,sort_order,id"
  ).all()).results;
  const checklistRows=checklistTemplates.map(item=>[
    eventId,
    item.item,
    0,
    item.phase||"Pre-Production",
    item.id
  ]);
  await bulkInsert(
    "event_checklist",
    ["event_id","item","done","phase","template_id"],
    checklistRows
  );
  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET booked_value=?,finalized_quote_total=?,quote_snapshot_json=?,confirmed_at=COALESCE(confirmed_at,datetime('now')),updated_at=datetime('now') WHERE id=?`)
      .bind(total,total,JSON.stringify(bookingSnapshot),booking.id),
    env.DB.prepare(`UPDATE lead_quotes SET status='Accepted',updated_at=datetime('now') WHERE id=?`).bind(quoteId)
  ]);
  await rebuildEventOperations(env,eventId);
  await env.DB.prepare(
    "UPDATE leads SET stage='Won',updated_at=datetime('now') WHERE id=?"
  ).bind(q.lead_id).run();
  await env.DB.prepare(
    "INSERT INTO lead_status_history(lead_id,to_stage,changed_by) VALUES(?,?,?)"
  ).bind(q.lead_id,"Won","quote-conversion").run();

  return json({
    ok:true,
    booking_id:booking.id,
    booking_number:booking.booking_number,
    event_id:eventId,
    event_number:eventNumber,
    account_id:accountId,
    task_count:taskRows.length,
    checklist_count:checklistTemplates.length
  });
}
