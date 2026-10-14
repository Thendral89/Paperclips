import test from "node:test";
import assert from "node:assert/strict";
import { updateLabel } from "../src/routes/configRoutes.js";
import { updateAiPermissions } from "../src/routes/productConfigRoutes.js";

function mockDb() {
  const calls=[];
  let label={label_key:"nav.events",label_value:"Events"};
  return {calls,prepare(sql) {
    const statement={sql,values:[]};
    statement.bind=(...values)=>{statement.values=values;return statement;};
    statement.first=async()=>sql.includes("app_labels")?{...label}:sql.includes("crm_ai_permissions")?{id:1,enabled:0}:null;
    statement.run=async()=>{calls.push({sql,values:statement.values});if(sql.includes("INSERT INTO app_labels"))label={label_key:statement.values[0],label_value:statement.values[1]};return {success:true};};
    return statement;
  }};
}

test("label updates record previous and current values in the audit log",async()=>{
  const DB=mockDb();
  const request=new Request("https://crm.test/api/admin/labels",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({label_key:"nav.events",label_value:"Projects"})});
  await updateLabel(request,{DB},{id:2,email:"staff@example.test"});
  const audit=DB.calls.at(-1);
  assert.match(audit.sql,/before_json,after_json,source/);
  assert.equal(audit.values.length,4);
  assert.deepEqual(JSON.parse(audit.values[2]),{label_key:"nav.events",label_value:"Events"});
  assert.deepEqual(JSON.parse(audit.values[3]),{label_key:"nav.events",label_value:"Projects"});
});

test("AI permission audit records the previous configuration",async()=>{
  const DB=mockDb();
  const request=new Request("https://crm.test/api/admin/product-config/ai",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:true})});
  await updateAiPermissions(request,{DB},{id:2,email:"staff@example.test"});
  const audit=DB.calls.at(-1);
  assert.match(audit.sql,/before_json,after_json,source/);
  assert.ok(audit.values[5]);
});
