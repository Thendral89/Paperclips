import test from "node:test";
import assert from "node:assert/strict";
import { upsertPicklistGroup } from "../src/routes/configRoutes.js";
import { readFile } from "node:fs/promises";

function mockDb(){
  const calls=[];
  return {calls,prepare(sql){const stmt={sql,values:[]};stmt.bind=(...values)=>{stmt.values=values;return stmt;};stmt.first=async()=>({id:8});stmt.run=async()=>{calls.push({sql,values:stmt.values});return {success:true};};return stmt;}};
}

test("picklist groups save their selected object and a stable internal key",async()=>{
  const DB=mockDb();
  const request=new Request("https://crm.test/api/admin/picklist-groups",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({object_key:"inventory",label:"Equipment Types",description:"Kinds of owned equipment",sort_order:15})});
  const response=await upsertPicklistGroup(request,{DB});
  assert.equal(response.status,200);
  assert.match(DB.calls[0].sql,/INSERT INTO picklist_groups\(group_key,object_key,label,description,sort_order,active\)/);
  assert.deepEqual(DB.calls[0].values,["inventory_equipment_types","inventory","Equipment Types","Kinds of owned equipment",15]);
});

test("existing picklist groups can be reassigned to another object",async()=>{
  const DB=mockDb();
  const request=new Request("https://crm.test/api/admin/picklist-groups",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:8,object_key:"expenses",label:"Expense Categories",description:"Updated list",sort_order:4,group_key:"expense_category"})});
  const response=await upsertPicklistGroup(request,{DB});
  assert.equal(response.status,200);
  assert.match(DB.calls[0].sql,/UPDATE picklist_groups SET object_key=\?,label=\?,description=\?,sort_order=\? WHERE id=\?/);
  assert.deepEqual(DB.calls[0].values,["expenses","Expense Categories","Updated list",4,8]);
});

test("object manager applies every configured navigation label and icon",async()=>{
  const html=await readFile(new URL("../public/admin/index.html",import.meta.url),"utf8");
  assert.match(html,/for\(const el of document\.querySelectorAll\("\.navlink\[data-view\]"\)\)/);
  assert.match(html,/nav_icon\.\$\{view\}/);
  assert.match(html,/data-view="quotes"><svg/);
  assert.match(html,/data-view="equipment"><svg/);
  assert.match(html,/data-view="expenses"><svg/);
  assert.match(html,/Object Manager/);
});
