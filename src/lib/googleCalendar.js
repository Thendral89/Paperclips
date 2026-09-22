// Minimal Google Calendar client for the CRM's dedicated sync calendar.
//
// The service account should have access only to the dedicated CRM calendar.
// Credentials are supplied through Cloudflare Worker secrets.
//
// Required secrets:
//   GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON
//   GOOGLE_CALENDAR_ID

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

function base64Url(value) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function pemToArrayBuffer(pem) {
  const body = pem.replace(
    /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
    ""
  );

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function accessToken(env) {
  if (!env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON) {
    return null;
  }

  let credentials;

  try {
    credentials = JSON.parse(
      env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON
    );
  } catch {
    throw new Error(
      "Google Calendar service-account secret is not valid JSON"
    );
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(
      "Google Calendar service-account secret is incomplete"
    );
  }

  const now = Math.floor(Date.now() / 1000);

  const header = base64Url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
    })
  );

  const claims = base64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: GOOGLE_CALENDAR_SCOPE,
      aud: credentials.token_uri || GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );

  const signingInput = `${header}.${claims}`;

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(credentials.private_key),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    {
      name: "RSASSA-PKCS1-v1_5",
    },
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  const response = await fetch(
    credentials.token_uri || GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion:
          `${signingInput}.${base64Url(signature)}`,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Google Calendar token request failed (${response.status})`
    );
  }

  const token = await response.json();

  if (!token.access_token) {
    throw new Error(
      "Google Calendar did not return an access token"
    );
  }

  return token.access_token;
}

async function calendarRequest(env, path, init = {}) {
  if (!env.GOOGLE_CALENDAR_ID) {
    return null;
  }

  const token = await accessToken(env);

  if (!token) {
    return null;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    ...(init.body
      ? { "content-type": "application/json" }
      : {}),
    ...(init.headers || {}),
  };

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      env.GOOGLE_CALENDAR_ID
    )}${path}`,
    {
      ...init,
      headers,
    }
  );

  if (!response.ok) {
    const error = new Error(
      `Google Calendar request failed (${response.status})`
    );

    error.status = response.status;

    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function allDayRange(date) {
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(start);

  end.setUTCDate(end.getUTCDate() + 1);

  return {
    start: date,
    end: end.toISOString().slice(0, 10),
  };
}

/**
 * Create a new Calendar event or update an existing one.
 *
 * If the stored Google event ID no longer exists, Google returns 404.
 * In that case we create a fresh event instead.
 */
async function upsert(env, existingId, event) {
  if (existingId) {
    try {
      return await calendarRequest(
        env,
        `/events/${encodeURIComponent(existingId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(event),
        }
      );
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }

      // The CRM has a stale Google event ID.
      // Recreate the Calendar event.
    }
  }

  return calendarRequest(env, "/events", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

async function deleteCalendarEvent(env, googleEventId) {
  if (!googleEventId) {
    return;
  }

  try {
    await calendarRequest(
      env,
      `/events/${encodeURIComponent(googleEventId)}`,
      {
        method: "DELETE",
      }
    );
  } catch (error) {
    // A manually deleted Google event is already gone.
    // Treat a 404 as success.
    if (error?.status === 404) {
      return;
    }

    throw error;
  }
}

async function recordError(
  env,
  table,
  idColumn,
  id,
  error
) {
  await env.DB.prepare(
    `INSERT INTO ${table} (${idColumn}, last_error)
     VALUES (?, ?)
     ON CONFLICT(${idColumn})
     DO UPDATE SET
       last_error = excluded.last_error,
       synced_at = datetime('now')`
  )
    .bind(
      id,
      String(error).slice(0, 500)
    )
    .run();
}

/**
 * Synchronize a CRM event with Google Calendar.
 *
 * Behaviour:
 *   event date exists
 *     -> create/update Calendar event
 *
 *   event date removed
 *     -> delete Calendar event + remove sync record
 */
export async function syncCrmEvent(
  env,
  event,
  account
) {
  if (
    !env.GOOGLE_CALENDAR_ID ||
    !env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON
  ) {
    return;
  }

  try {
    const existing =
      await env.DB.prepare(
        `SELECT google_event_id
         FROM calendar_event_sync
         WHERE event_id = ?`
      )
        .bind(event.id)
        .first();

    // Event date was cleared.
    if (!event.event_date) {
      if (existing?.google_event_id) {
        await deleteCalendarEvent(
          env,
          existing.google_event_id
        );
      }

      await env.DB.prepare(
        `DELETE FROM calendar_event_sync
         WHERE event_id = ?`
      )
        .bind(event.id)
        .run();

      return;
    }

    const range = allDayRange(
      event.event_date
    );

    const remote = await upsert(
      env,
      existing?.google_event_id,
      {
        summary: `${event.type} — ${account.name}`,

        description: [
          `PCS CRM event #${event.id}`,
          event.venue
            ? `Venue: ${event.venue}`
            : null,
          `Status: ${event.status}`,
        ]
          .filter(Boolean)
          .join("\n"),

        start: {
          date: range.start,
        },

        end: {
          date: range.end,
        },

        reminders: {
          useDefault: false,
        },
      }
    );

    await env.DB.prepare(
      `INSERT INTO calendar_event_sync
       (event_id, google_event_id, synced_at, last_error)
       VALUES (?, ?, datetime('now'), NULL)
       ON CONFLICT(event_id)
       DO UPDATE SET
         google_event_id = excluded.google_event_id,
         synced_at = excluded.synced_at,
         last_error = NULL`
    )
      .bind(event.id, remote.id)
      .run();
  } catch (error) {
    await recordError(
      env,
      "calendar_event_sync",
      "event_id",
      event.id,
      error
    );
  }
}

/**
 * Synchronize a lead follow-up with Google Calendar.
 *
 * Behaviour:
 *   follow-up date exists
 *     -> create/update Calendar event
 *
 *   follow-up date removed
 *     -> delete Calendar event + remove sync record
 */
export async function syncLeadFollowUp(
  env,
  lead
) {
  if (
    !env.GOOGLE_CALENDAR_ID ||
    !env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON
  ) {
    return;
  }

  try {
    const existing =
      await env.DB.prepare(
        `SELECT google_event_id
         FROM calendar_followup_sync
         WHERE lead_id = ?`
      )
        .bind(lead.id)
        .first();

    // Follow-up date was cleared.
    if (!lead.next_follow_up_date) {
      if (existing?.google_event_id) {
        await deleteCalendarEvent(
          env,
          existing.google_event_id
        );
      }

      await env.DB.prepare(
        `DELETE FROM calendar_followup_sync
         WHERE lead_id = ?`
      )
        .bind(lead.id)
        .run();

      return;
    }

    const range = allDayRange(
      lead.next_follow_up_date
    );

    const remote = await upsert(
      env,
      existing?.google_event_id,
      {
        summary: `Follow up: ${lead.name}`,

        description: [
          `PCS CRM lead #${lead.id}`,
          lead.phone
            ? `Phone: ${lead.phone}`
            : null,
          lead.event_type
            ? `Event: ${lead.event_type}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),

        start: {
          date: range.start,
        },

        end: {
          date: range.end,
        },

        reminders: {
          useDefault: false,
        },
      }
    );

    await env.DB.prepare(
      `INSERT INTO calendar_followup_sync
       (lead_id, google_event_id, synced_at, last_error)
       VALUES (?, ?, datetime('now'), NULL)
       ON CONFLICT(lead_id)
       DO UPDATE SET
         google_event_id = excluded.google_event_id,
         synced_at = excluded.synced_at,
         last_error = NULL`
    )
      .bind(lead.id, remote.id)
      .run();
  } catch (error) {
    await recordError(
      env,
      "calendar_followup_sync",
      "lead_id",
      lead.id,
      error
    );
  }
}
