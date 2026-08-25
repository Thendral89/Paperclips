// Runs hourly (see wrangler.jsonc triggers.crons). Blueprint §4, trigger 2:
// flags any lead sitting untouched for 48h+ so it shows on the dashboard's
// overdue list without anyone having to remember to check.
//
// Email/WhatsApp push notification is intentionally NOT wired here yet — it
// needs a Resend API key (or similar) you haven't provided. The flag still
// works today via the dashboard's overdue_followups list; see README for
// what to add once you're ready to activate outbound notifications.

export async function handleScheduled(env) {
  const { results: stale } = await env.DB.prepare(
    `SELECT id FROM leads
     WHERE stage NOT IN ('Booked','Lost')
       AND updated_at < datetime('now','-48 hours')
       AND (next_follow_up_date IS NULL OR next_follow_up_date < date('now'))`
  ).all();

  for (const lead of stale) {
    // Pull the follow-up date forward to today so it surfaces on the
    // dashboard's "Today's follow-ups" list until someone actions it.
    await env.DB.prepare(
      `UPDATE leads SET next_follow_up_date = date('now') WHERE id = ?`
    ).bind(lead.id).run();
  }

  return { flagged: stale.length };
}
