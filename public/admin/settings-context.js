(() => {
  const SettingsContext = {
    create() { return { section: "company", crmObject: "", openPanels: [] }; },
    selectSection(context, section) { context.section = section; return context.section; },
    selectObject(context, objectKey) { context.crmObject = objectKey || ""; return context.crmObject; },
    picklistsForObject(groups, objectKey) {
      if (!objectKey) return [];
      return groups.filter(group => (group.object_key || "General") === objectKey);
    },
    compatibleResources(resources, requiredSkillIds) {
      const required = requiredSkillIds.map(Number).filter(Number.isFinite);
      return resources.filter(resource => resource.active && required.every(skillId =>
        String(resource.skill_ids || "").split(",").map(Number).includes(skillId)
      ));
    }
  };
  if (typeof window !== "undefined") window.SettingsContext = SettingsContext;
})();
