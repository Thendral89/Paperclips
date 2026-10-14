import test from "node:test";
import assert from "node:assert/strict";
import { upsertSkill } from "../src/routes/configRoutes.js";

function mockDb(currentSkill = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = { sql, values: [] };
      statement.bind = (...values) => { statement.values = values; return statement; };
      statement.first = async () => currentSkill;
      statement.run = async () => { calls.push({ sql, values: statement.values }); return { success: true }; };
      return statement;
    }
  };
}

const request = body => new Request("https://crm.test/api/admin/skills", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

test("skill edits persist phase, offsets, and cost", async () => {
  const DB = mockDb({ workflow_phase: "Production", start_offset_days: 0, due_offset_days: 2, default_cost: 10 });
  const response = await upsertSkill(request({ id: 7, label: "Album layout", workflow_phase: "Post-Production", start_offset_days: 5, due_offset_days: 20, default_cost: 1250 }), { DB });
  assert.equal(response.status, 200);
  assert.match(DB.calls[0].sql, /workflow_phase=\?,start_offset_days=\?,due_offset_days=\?,default_cost=\?/);
  assert.deepEqual(DB.calls[0].values, ["album-layout", "Album layout", "Post-Production", 5, 20, 1250, 7]);
});

test("legacy skill edits preserve timeline fields when omitted", async () => {
  const DB = mockDb({ workflow_phase: "Production", start_offset_days: 1, due_offset_days: 3, default_cost: 750 });
  await upsertSkill(request({ id: 9, label: "Candid photo" }), { DB });
  assert.deepEqual(DB.calls[0].values, ["candid-photo", "Candid photo", "Production", 1, 3, 750, 9]);
});

test("invalid skill phase or negative timeline is rejected", async () => {
  const DB = mockDb();
  const response = await upsertSkill(request({ label: "Bad skill", workflow_phase: "Sales", start_offset_days: -1 }), { DB });
  assert.equal(response.status, 400);
  assert.equal(DB.calls.length, 0);
});
