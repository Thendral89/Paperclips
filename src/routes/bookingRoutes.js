import { json, badRequest, notFound } from "../lib/util.js";

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
  const q=await env.DB.prepare(`SELECT q.*,l.name AS lead_name,l.phone,l.email,l.event_type,l.event_date,l.source,l.id AS lead_id,
    a.id AS existing_account_id
    FROM lead_quotes q JOIN leads l ON l.id=q.lead_id
    LEFT JOIN accounts a ON a.lead_id=l.id
    WHERE q.id=?`).bind(quoteId).first();
  if(!q) return notFound("quote not found");
  if(!["Accepted","Won"].includes(q.status)) return badRequest("Quote must be Accepted/Won before conversion");
  const [conversionRule,taskRule]=await Promise.all([
    env.DB.prepare("SELECT value_json FROM crm_business_rules WHERE rule_key='booking.create_from_won_quote' AND active=1 ORDER BY id DESC LIMIT 1").first(),
    env.DB.prepare("SELECT value_json FROM crm_business_rules WHERE rule_key='event.auto_create_quote_tasks' AND active=1 ORDER BY id DESC LIMIT 1").first()
  ]);
  const conversionEnabled=conversionRule ? parseRuleValue(conversionRule.value_json).enabled!==false : true;
  if(!conversionEnabled) return badRequest("Booking creation from quotes is disabled by business rule");
  const autoCreateTasks=taskRule ? parseRuleValue(taskRule.value_json).enabled!==false : true;

  let accountId=q.existing_account_id;
  if(!accountId){
    const ar=await env.DB.prepare("INSERT INTO accounts(lead_id,name,phone,email,notes) VALUES(?,?,?,?,?)")
      .bind(q.lead_id,q.lead_name,q.phone||null,q.email||null,"Created from accepted quote").run();
    accountId=ar.meta.last_row_id;
  }

  const existingBooking=await env.DB.prepare("SELECT id FROM bookings WHERE quote_id=?").bind(quoteId).first();
  if(existingBooking) return json({ok:true,booking_id:existingBooking.id,already_exists:true});

  const items=(await env.DB.prepare("SELECT * FROM quote_items WHERE quote_id=? AND selected=1 ORDER BY id").bind(quoteId).all()).results;
  const total=items.reduce((s,x)=>s+Number(x.price||0),0)-Number(q.concession_amount||0);
  const bookingNumber=await nextNumber(env,"booking");
  const br=await env.DB.prepare(`INSERT INTO bookings(account_id,quote_id,booking_number,status,booked_value,discount,notes,confirmed_at)
    VALUES(?,?,?,?,?,?,?,datetime('now'))`).bind(accountId,quoteId,bookingNumber||null,"Booked",Math.max(0,total),Number(q.concession_amount||0),q.concession_note||null).run();
  const bookingId=br.meta.last_row_id;

  const advanceRule=await env.DB.prepare("SELECT value_json FROM crm_business_rules WHERE rule_key='booking.default_advance' AND active=1 ORDER BY id DESC LIMIT 1").first();
  const advancePercent=Math.min(100,Math.max(0,Number(parseRuleValue(advanceRule?.value_json).percent ?? 30)));
  const advanceAmount=Math.round(Math.max(0,total)*advancePercent/100);
  if(Math.max(0,total)>0){
    await env.DB.batch([
      env.DB.prepare("INSERT INTO booking_payment_schedule(booking_id,label,due_date,amount,status) VALUES(?,?,?,?,?)").bind(bookingId,"Advance",new Date().toISOString().slice(0,10),advanceAmount,"Due"),
      env.DB.prepare("INSERT INTO booking_payment_schedule(booking_id,label,due_date,amount,status) VALUES(?,?,?,?,?)").bind(bookingId,"Balance",q.event_date||null,Math.max(0,total)-advanceAmount,"Due")
    ]);
  }

  const eventNumber=await nextNumber(env,"event");
  const er=await env.DB.prepare(`INSERT INTO events(account_id,booking_id,event_number,type,event_date,status,quote_total)
    VALUES(?,?,?,?,?,?,?)`).bind(accountId,bookingId,eventNumber||null,q.event_type||"Wedding",q.event_date||null,"Planning",Math.max(0,total)).run();
  const eventId=er.meta.last_row_id;

  for(const item of items){
    if(item.service_id){
      await env.DB.prepare("INSERT INTO event_services(event_id,service_id,price_at_booking,is_crosssell) VALUES(?,?,?,?)")
        .bind(eventId,item.service_id,Number(item.price||0),item.is_addon?1:0).run();
    }
  }

  const templates=autoCreateTasks
    ? (await env.DB.prepare(`SELECT * FROM crm_task_templates
      WHERE active=1 AND auto_create=1 AND (event_type_key IS NULL OR event_type_key=?)
      ORDER BY phase,sort_order,id`).bind(q.event_type||"Wedding").all()).results
    : [];

  let taskCount=0;
  for(const t of templates){
    const matching=t.task_type==="Resource"
      ? items.filter(i=>resourceItemMatches(t.default_title,i.label))
      : [];
    const count=t.task_type==="Resource"
      ? matching.reduce((n,i)=>n+parseQty(i.label),0)
      : 1;
    for(let n=1;n<=count;n++){
      const sourceItem=t.task_type==="Resource" ? matching[Math.min(n-1,matching.length-1)] : null;
      const title=t.task_type==="Resource" && count>1 ? `${t.default_title} #${n}` : t.default_title;
      const tr=await env.DB.prepare(`INSERT INTO event_tasks(event_id,task,status,phase,required,template_id,source_quote_item_id)
        VALUES(?,?,?,?,?,?,?)`).bind(eventId,title,"Pending",t.phase,t.required?1:0,t.id,sourceItem?.id||null).run();
      taskCount++;
      if(t.task_type==="Resource"){
        await env.DB.prepare(`INSERT INTO event_resource_requirements(event_id,task_id,role_label,quantity,phase,allocation_date)
          VALUES(?,?,?,?,?,?)`).bind(eventId,tr.meta.last_row_id,t.default_title,1,t.phase,q.event_date||null).run();
      }
    }
  }

  await env.DB.prepare("UPDATE lead_quotes SET status='Accepted',updated_at=datetime('now') WHERE id=?").bind(quoteId).run();
  await env.DB.prepare("UPDATE leads SET stage='Booked',updated_at=datetime('now') WHERE id=?").bind(q.lead_id).run();
  await env.DB.prepare("INSERT INTO lead_status_history(lead_id,to_stage,changed_by) VALUES(?,?,?)").bind(q.lead_id,"Booked","quote-conversion").run();

  return json({ok:true,booking_id:bookingId,event_id:eventId,booking_number:bookingNumber,event_number:eventNumber,account_id:accountId,task_count:taskCount});
}
