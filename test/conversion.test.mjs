// Regression coverage for package conversion, quote revisions, retries and failure recovery.
import { makeDB } from "./d1shim.mjs";
import { convertLead } from "../src/routes/adminRoutes.js";

let failures = 0;
function check(condition, message) {
  console.log((condition ? "PASS " : "FAIL ") + message);
  if (!condition) failures++;
}
const db = makeDB();
const raw = db.raw;
const env = { DB: db };
const query = (sql, ...args) => raw.prepare(sql).all(...args);
const request = () => new Request("https://example.test/api", { method: "POST", body: "{}" });

raw.exec(`INSERT INTO services(id,name,base_price) VALUES(901,'Candid photography',1),(902,'Cinematic video',1);
INSERT INTO packages(id,name,base_price) VALUES(901,'Gold',1);
INSERT INTO package_items(package_id,service_id,quantity) VALUES(901,901,1),(901,902,1);
INSERT INTO leads(id,name,phone,phone_normalized,source,event_type,event_date,stage)
 VALUES(1,'Meera','9999900000','9999900000','Instagram','Wedding','2027-02-14','Quoted');
INSERT INTO lead_quotes(id,lead_id,token,status,version) VALUES(1,1,'abc','Finalized',1);
INSERT INTO quote_package_options(quote_id,package_id,label,price,selected) VALUES(1,901,'Gold',195000,1);`);

let response = await convertLead(request(), env, 1);
let body = await response.json();
check(response.ok && body.event_id, "Lead conversion creates an Event");
check(body.booking_id === null, "existing response contract is preserved");
check(query("SELECT COUNT(*) AS n FROM accounts WHERE lead_id=1")[0].n === 1, "one Client account is created");
check(query("SELECT COUNT(*) AS n FROM events")[0].n === 1, "exactly one Event is created");
check(query("SELECT booking_id FROM events")[0].booking_id === null, "Event remains unlinked to a Booking");
const serviceRows = query("SELECT service_id,package_id FROM event_services");
check(serviceRows.length === 1 && serviceRows[0].service_id === null && serviceRows[0].package_id === 901,
  "selected package satisfies the event_services exclusivity constraint");
const work = query("SELECT service_id FROM event_work_items ORDER BY service_id").map(row => row.service_id);
check(JSON.stringify(work) === "[901,902]", "package services generate work items");
check(query("SELECT status FROM lead_quotes WHERE id=1")[0].status === "Accepted", "quote is Accepted after success");
check(query("SELECT COUNT(*) AS n FROM lead_status_history WHERE lead_id=1 AND to_stage='Won'")[0].n === 1,
  "conversion records Won history once");

response = await convertLead(request(), env, 1);
check(response.ok, "repeated conversion succeeds");
check(query("SELECT COUNT(*) AS n FROM events")[0].n === 1, "retry does not create a duplicate Event");
check(query("SELECT COUNT(*) AS n FROM event_work_items")[0].n === 2, "retry does not duplicate work");
check(query("SELECT COUNT(*) AS n FROM lead_status_history WHERE lead_id=1 AND to_stage='Won'")[0].n === 1,
  "retry does not duplicate Won history");

raw.exec(`INSERT INTO lead_quotes(id,lead_id,token,status,version,revision_of_quote_id)
 VALUES(2,1,'def','Finalized',2,1);
INSERT INTO quote_package_options(quote_id,package_id,label,price,selected) VALUES(2,901,'Gold',210000,1);`);
response = await convertLead(request(), env, 1);
body = await response.json();
check(response.ok && body.updated_existing_event === true, "quote revision updates the existing Event");
check(query("SELECT COUNT(*) AS n FROM events")[0].n === 1, "revision does not create a second Event");
check(query("SELECT quote_total FROM events")[0].quote_total === 210000, "revised quote total is saved");

raw.exec(`INSERT INTO leads(id,name,phone,phone_normalized,source,event_type,event_date,stage)
 VALUES(2,'Karthik','8888800000','8888800000','Referral','Wedding','2027-03-01','Quoted');
INSERT INTO lead_quotes(id,lead_id,token,status,version) VALUES(3,2,'ghi','Finalized',1);
INSERT INTO quote_package_options(quote_id,package_id,label,price,selected) VALUES(3,901,'Gold',100000,1);
CREATE TRIGGER injected_work_failure BEFORE INSERT ON event_work_items
 BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
let failed = false;
try { await convertLead(request(), env, 2); } catch { failed = true; }
check(failed, "work-generation failure is surfaced");
check(query("SELECT stage FROM leads WHERE id=2")[0].stage !== "Won", "failed conversion leaves Lead retryable");
check(query("SELECT status FROM lead_quotes WHERE id=3")[0].status === "Finalized", "failed conversion restores Finalized quote");
raw.exec("DROP TRIGGER injected_work_failure");
response = await convertLead(request(), env, 2);
check(response.ok && query("SELECT stage FROM leads WHERE id=2")[0].stage === "Won", "retry succeeds after failure is removed");
check(query("SELECT COUNT(*) AS n FROM events WHERE account_id=(SELECT id FROM accounts WHERE lead_id=2)")[0].n === 1,
  "retry reuses the partial Event");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
