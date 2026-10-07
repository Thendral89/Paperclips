import { json, badRequest, notFound } from "../lib/util.js";
import { rebuildEventOperations, initializeEventWork } from "./adminRoutes.js";

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
  const q=await env.DB.prepare(`SELECT q.*,l.name AS lead_name,l.phone,l.email,l.event_type,l.event_date,l.venue,l.source,l.id AS lead_id,a.id AS existing_account_id
    FROM lead_quotes q JOIN leads l ON l.id=q.lead_id LEFT JOIN accounts a ON a.lead_id=l.id WHERE q.id=?`).bind(quoteId).first();
  if(!q) return notFound("quote not found");
  if(!["Accepted","Won"].includes(q.status)) return badRequest("Quote must be Accepted/Won before conversion");

  let accountId=q.existing_account_id;
  if(!accountId){
    const ar=await env.DB.prepare("INSERT INTO accounts(lead_id,name,phone,email,notes) VALUES(?,?,?,?,?)").bind(q.lead_id,q.lead_name,q.phone||null,q.email||null,"Created from accepted quote").run();
    accountId=ar.meta.last_row_id;
  }

  const selected=await env.DB.prepare("SELECT * FROM quote_package_options WHERE quote_id=? AND selected=1 ORDER BY id LIMIT 1").bind(quoteId).first();
  const addon=(await env.DB.prepare("SELECT * FROM quote_items WHERE quote_id=? AND is_addon=1 AND selected=1 ORDER BY id").bind(quoteId).all()).results;
  const customized=selected?(await env.DB.prepare("SELECT * FROM quote_items WHERE quote_package_option_id=? AND is_addon=0 AND selected=1 ORDER BY id").bind(selected.id).all()).results:[];
  const legacy=selected?[]:(await env.DB.prepare("SELECT * FROM quote_items WHERE quote_id=? AND selected=1 ORDER BY id").bind(quoteId).all()).results;
  const items=selected
    ? [{id:selected.id,service_id:null,package_id:selected.package_id,label:selected.label,price:Number(selected.price||0),quantity:1,is_addon:0,selected:1,details_json:selected.details_json},...customized,...addon]
    : legacy;
  const total=Math.max(0,items.reduce((s,x)=>s+Number(x.price||0)*Number(x.quantity||1),0)-Number(q.concession_amount||0));
  const quoteSnapshot={quote_id:q.id,status:"Accepted",accepted_at:new Date().toISOString(),concession_amount:Number(q.concession_amount||0),concession_note:q.concession_note||null,valid_until:q.valid_until||null,selected_package_option_id:selected?.id||null,items:items.map(x=>({id:x.id,service_id:x.service_id||null,package_id:x.package_id||null,label:x.label,price:Number(x.price||0),quantity:Number(x.quantity||1),is_addon:Number(x.is_addon||0),selected:Number(x.selected||0),details_json:x.details_json||null}))};

  const existing=await env.DB.prepare("SELECT id,event_number FROM events WHERE quote_id=? ORDER BY id DESC LIMIT 1").bind(quoteId).first();
  if(existing) return json({ok:true,event_id:existing.id,event_number:existing.event_number,account_id:accountId,already_exists:true});

  const eventNumber=await nextNumber(env,"event");
  const er=await env.DB.prepare(`INSERT INTO events(account_id,booking_id,quote_id,event_number,type,event_date,start_date,end_date,venue,status,quote_total,finalized_quote_total,quote_snapshot_json,commercial_finalized_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).bind(accountId,null,quoteId,eventNumber||null,q.event_type||"Wedding",q.event_date||null,q.event_date||null,q.event_date||null,q.venue||null,"Planning",total,total,JSON.stringify(quoteSnapshot)).run();
  const eventId=er.meta.last_row_id;

  const serviceRows=items.filter(x=>x.service_id).map(x=>[eventId,x.service_id||null,x.package_id||null,Number(x.price||0),x.is_addon?1:0]);
  if(serviceRows.length){
    const width=5,chunk=18;
    for(let i=0;i<serviceRows.length;i+=chunk){
      const rows=serviceRows.slice(i,i+chunk);
      const placeholders=rows.map(()=>"(?,?,?,?,?)").join(",");
      await env.DB.prepare("INSERT INTO event_services(event_id,service_id,package_id,price_at_booking,is_crosssell) VALUES "+placeholders).bind(...rows.flat()).run();
    }
  }

  await env.DB.prepare("UPDATE lead_quotes SET status='Accepted',updated_at=datetime('now') WHERE id=?").bind(quoteId).run();
  await env.DB.prepare("UPDATE leads SET stage='Won',updated_at=datetime('now') WHERE id=?").bind(q.lead_id).run();
  await env.DB.prepare("INSERT INTO lead_status_history(lead_id,to_stage,changed_by) VALUES(?,?,?)").bind(q.lead_id,"Won","quote-conversion").run();

  await rebuildEventOperations(env,eventId);
  await initializeEventWork(env,eventId);

  return json({ok:true,event_id:eventId,event_number:eventNumber,account_id:accountId,booking_id:null,task_count:0,architecture:"Lead -> Quote -> Client -> Event"});
}
