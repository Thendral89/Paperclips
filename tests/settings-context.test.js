import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/admin/settings-context.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const contextApi = sandbox.window.SettingsContext;

test("settings section remains selected across configuration refreshes", () => {
  const context = contextApi.create();
  contextApi.selectSection(context, "operations");
  assert.equal(context.section, "operations");
  contextApi.selectSection(context, "crm");
  assert.equal(context.section, "crm");
});

test("picklists are dependent on the selected business object", () => {
  const groups = [
    { object_key: "leads", group_key: "lead_stage" },
    { object_key: "events", group_key: "event_type" },
    { group_key: "general_flags" }
  ];
  assert.deepEqual(Array.from(contextApi.picklistsForObject(groups, "events"), group => group.group_key), ["event_type"]);
  assert.deepEqual(Array.from(contextApi.picklistsForObject(groups, "General"), group => group.group_key), ["general_flags"]);
  assert.deepEqual(Array.from(contextApi.picklistsForObject(groups, "")), []);
});

test("resource matching requires every service skill", () => {
  const resources = [
    { id: 1, active: 1, skill_ids: "2,5" },
    { id: 2, active: 1, skill_ids: "2" },
    { id: 3, active: 0, skill_ids: "2,5" }
  ];
  assert.deepEqual(Array.from(contextApi.compatibleResources(resources, [2, 5]), resource => resource.id), [1]);
  assert.deepEqual(Array.from(contextApi.compatibleResources(resources, []), resource => resource.id), [1, 2]);
});
