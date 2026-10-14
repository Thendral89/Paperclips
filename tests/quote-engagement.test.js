import test from "node:test";
import assert from "node:assert/strict";
import { logQuoteEngagement } from "../src/routes/publicRoutes.js";

function mockDb() {
  const writes=[];
  return { writes, prepare(sql) {
    const statement={sql,values:[]};
    statement.bind=(...values)=>{statement.values=values;return statement;};
    statement.first=async()=>sql.includes("FROM lead_quotes")?{id:21}:sql.includes("FROM quote_package_options")?{id:4,package_id:9}:null;
    statement.run=async()=>{writes.push({sql,values:statement.values});return {success:true};};
    return statement;
  }};
}

test("package engagement stores event type and package identity in the correct columns",async()=>{
  const DB=mockDb();
  const request=new Request("https://crm.test/api/quote/token/engagement",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event_type:"package_content_opened",package_option_id:4,session_key:"session-a"})});
  const response=await logQuoteEngagement(request,{DB},"token");
  assert.equal(response.status,200);
  assert.match(DB.writes[0].sql,/quote_id,event_type,quote_item_id,package_id,service_id,session_key/);
  assert.deepEqual(DB.writes[0].values,[21,"package_content_opened",null,9,null,"session-a"]);
});
