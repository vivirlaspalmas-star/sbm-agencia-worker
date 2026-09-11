// SBM AI Agency — Worker del panel de control
// Sirve la tabla agency_clients (Supabase) al panel PANEL_DE_CONTROL_SBM_AGENCIA.html

async function sb(env, path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase ${method} ${res.url} -> ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const META_API_VERSION = "v21.0";
const CACHE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos

async function metaFetch(env, path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${path}`);
  url.searchParams.set("access_token", env.META_SYSTEM_USER_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Meta API error (${res.status})`);
  }
  return data;
}

async function fetchAdsSummaryFromMeta(env, adAccountId) {
  const accountInfo = await metaFetch(env, adAccountId, {
    fields: "account_status,disable_reason"
  });
  const paymentIssue = accountInfo.account_status !== 1;

  let spendCents = 0;
  try {
    const insights = await metaFetch(env, `${adAccountId}/insights`, {
      fields: "spend",
      date_preset: "last_30d"
    });
    spendCents = Math.round(parseFloat(insights.data?.[0]?.spend || "0") * 100);
  } catch (err) {}

  const campaigns = await metaFetch(env, `${adAccountId}/campaigns`, {
    fields: "id,name,effective_status",
    limit: "200"
  });
  const rows = campaigns.data || [];
  const activeCampaigns = rows.filter(c => c.effective_status === "ACTIVE").length;
  const pausedCampaigns = rows.filter(c => c.effective_status === "PAUSED").length;

  return {
    spend_cents: spendCents,
    active_campaigns: activeCampaigns,
    paused_campaigns: pausedCampaigns,
    payment_issue: paymentIssue,
    raw_data: { account_status: accountInfo.account_status, disable_reason: accountInfo.disable_reason || null, campaign_count: rows.length }
  };
}

async function handleAdsOverview(request, env) {
  try {
    const clients = await sb(env, `agency_clients?meta_ad_account_id=not.is.null&select=id,name,meta_ad_account_id`);
    const results = [];

    for (const client of clients) {
      try {
        const cacheRows = await sb(env, `ads_cache?client_id=eq.${client.id}&select=*`);
        const cached = cacheRows[0];
        const isFresh = cached && (Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MAX_AGE_MS);

        let summary;
        if (isFresh) {
          summary = cached;
        } else {
          const fresh = await fetchAdsSummaryFromMeta(env, client.meta_ad_account_id);
          const upserted = await sb(env, "ads_cache", {
            method: "POST",
            prefer: "return=representation,resolution=merge-duplicates",
            body: { client_id: client.id, ...fresh, fetched_at: new Date().toISOString() }
          });
          summary = upserted[0] || fresh;
        }

        results.push({
          client_id: client.id,
          name: client.name,
          spend_cents: summary.spend_cents,
          active_campaigns: summary.active_campaigns,
          paused_campaigns: summary.paused_campaigns,
          payment_issue: summary.payment_issue,
          fetched_at: summary.fetched_at
        });
      } catch (err) {
        results.push({ client_id: client.id, name: client.name, error: String(err) });
      }
    }

    return json(results);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

async function handleAdsSummary(request, env, clientId) {
  try {
    const clientRows = await sb(env, `agency_clients?id=eq.${clientId}&select=meta_ad_account_id`);
    const client = clientRows[0];
    if (!client) return json({ error: "Cliente no encontrado" }, 404);
    if (!client.meta_ad_account_id) return json({ error: "Este cliente no tiene cuenta publicitaria configurada" }, 400);

    const cacheRows = await sb(env, `ads_cache?client_id=eq.${clientId}&select=*`);
    const cached = cacheRows[0];
    const isFresh = cached && (Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MAX_AGE_MS);

    if (isFresh) {
      return json({ ...cached, from_cache: true });
    }

    const fresh = await fetchAdsSummaryFromMeta(env, client.meta_ad_account_id);
    const upserted = await sb(env, "ads_cache", {
      method: "POST",
      prefer: "return=representation,resolution=merge-duplicates",
      body: { client_id: clientId, ...fresh, fetched_at: new Date().toISOString() }
    });
    return json({ ...(upserted[0] || fresh), from_cache: false });
  } catch (err) {
    const cacheRows = await sb(env, `ads_cache?client_id=eq.${clientId}&select=*`).catch(() => []);
    if (cacheRows[0]) return json({ ...cacheRows[0], from_cache: true, stale_error: String(err) });
    return json({ error: String(err) }, 500);
  }
}

async function handleAdsPauseAll(request, env, clientId) {
  try {
    const clientRows = await sb(env, `agency_clients?id=eq.${clientId}&select=meta_ad_account_id`);
    const client = clientRows[0];
    if (!client) return json({ error: "Cliente no encontrado" }, 404);
    if (!client.meta_ad_account_id) return json({ error: "Este cliente no tiene cuenta publicitaria configurada" }, 400);

    const campaigns = await metaFetch(env, `${client.meta_ad_account_id}/campaigns`, {
      fields: "id,name,effective_status",
      limit: "200"
    });
    const activeCampaigns = (campaigns.data || []).filter(c => c.effective_status === "ACTIVE");

    const results = [];
    for (const camp of activeCampaigns) {
      try {
        const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${camp.id}`);
        url.searchParams.set("access_token", env.META_SYSTEM_USER_TOKEN);
        url.searchParams.set("status", "PAUSED");
        const res = await fetch(url.toString(), { method: "POST" });
        const data = await res.json();
        results.push({ id: camp.id, name: camp.name, paused: !!data.success, error: data.error?.message || null });
      } catch (err) {
        results.push({ id: camp.id, name: camp.name, paused: false, error: String(err) });
      }
    }

    await sb(env, `ads_cache?client_id=eq.${clientId}`, { method: "DELETE" }).catch(() => {});

    return json({ paused_count: results.filter(r => r.paused).length, total: results.length, results });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

// ---------------------------------------------------------------------------
// Endpoints de voz (Sofía / Retell) — multi-tenant, uno solo para todos los negocios.
// El tenant se identifica por su "slug" en la URL: /voice/:slug/...
// ---------------------------------------------------------------------------

async function getTenantBySlug(env, slug) {
  const rows = await sb(env, `tenants?slug=eq.${encodeURIComponent(slug)}&select=*`);
  return rows[0] || null;
}

async function handleListServices(request, env, slug) {
  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return json({ error: "Negocio no encontrado" }, 404);
  if (tenant.subscription_status !== "active") return json({ error: "Servicio no disponible" }, 403);

  const services = await sb(
    env,
    `services?tenant_id=eq.${tenant.id}&active=eq.true&select=id,name,duration_minutes,price_cents&order=name.asc`
  );
  return json(
    services.map((s) => ({
      id: s.id,
      name: s.name,
      duration_minutes: s.duration_minutes,
      price_eur: s.price_cents / 100,
    }))
  );
}

async function handleCheckAvailability(request, env, slug) {
  const body = await request.json().catch(() => ({}));
  const { date, service_id: serviceId } = body;
  if (!date || !serviceId) {
    return json({ error: "Faltan parámetros: date, service_id" }, 400);
  }

  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return json({ error: "Negocio no encontrado" }, 404);
  if (tenant.subscription_status !== "active") return json({ error: "Servicio no disponible" }, 403);

  const serviceRows = await sb(env, `services?id=eq.${serviceId}&tenant_id=eq.${tenant.id}&select=duration_minutes`);
  const service = serviceRows[0];
  if (!service) return json({ error: "Servicio no encontrado" }, 404);
  const durationMin = service.duration_minutes;

  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=domingo .. 6=sábado
  const rules = await sb(
    env,
    `availability_rules?tenant_id=eq.${tenant.id}&weekday=eq.${weekday}&select=staff_id,start_time,end_time`
  );
  if (rules.length === 0) return json({ date, service_id: serviceId, slots: [] });

  const staffIds = [...new Set(rules.map((r) => r.staff_id))];
  const staffRows = await sb(
    env,
    `staff?tenant_id=eq.${tenant.id}&active=eq.true&id=in.(${staffIds.join(",")})&select=id,name`
  );
  const activeStaffById = new Map(staffRows.map((s) => [s.id, s]));

  const existingAppts = await sb(
    env,
    `appointments?tenant_id=eq.${tenant.id}&starts_at=gte.${date}T00:00:00&starts_at=lte.${date}T23:59:59&status=neq.cancelled&select=staff_id,starts_at,ends_at`
  );

  const slots = [];
  for (const rule of rules) {
    const staffInfo = activeStaffById.get(rule.staff_id);
    if (!staffInfo) continue;

    let cursor = new Date(`${date}T${rule.start_time}Z`);
    const end = new Date(`${date}T${rule.end_time}Z`);

    while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
      const slotEnd = new Date(cursor.getTime() + durationMin * 60000);
      const overlaps = existingAppts.some(
        (a) =>
          a.staff_id === rule.staff_id &&
          new Date(a.starts_at) < slotEnd &&
          new Date(a.ends_at) > cursor
      );
      if (!overlaps) {
        slots.push({
          staff_id: rule.staff_id,
          staff_name: staffInfo.name,
          starts_at: cursor.toISOString(),
          ends_at: slotEnd.toISOString(),
        });
      }
      cursor = new Date(cursor.getTime() + durationMin * 60000);
    }
  }
  slots.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  return json({ date, service_id: serviceId, slots });
}

async function handleCreateAppointment(request, env, slug) {
  const body = await request.json();
  const { customer_name, customer_phone, service_id, staff_id, starts_at } = body;
  if (!customer_name || !customer_phone || !service_id || !staff_id || !starts_at) {
    return json(
      { error: "Faltan campos obligatorios: customer_name, customer_phone, service_id, staff_id, starts_at" },
      400
    );
  }

  const tenant = await getTenantBySlug(env, slug);
  if (!tenant) return json({ error: "Negocio no encontrado" }, 404);
  if (tenant.subscription_status !== "active") return json({ error: "Servicio no disponible" }, 403);

  const serviceRows = await sb(env, `services?id=eq.${service_id}&tenant_id=eq.${tenant.id}&select=duration_minutes`);
  const service = serviceRows[0];
  if (!service) return json({ error: "Servicio no encontrado" }, 404);

  const startsAtDate = new Date(starts_at);
  const endsAtDate = new Date(startsAtDate.getTime() + service.duration_minutes * 60000);

  const existingCustomers = await sb(
    env,
    `customers?tenant_id=eq.${tenant.id}&phone=eq.${encodeURIComponent(customer_phone)}&select=id`
  );
  let customerId = existingCustomers[0]?.id;
  if (!customerId) {
    const [newCustomer] = await sb(env, "customers", {
      method: "POST",
      prefer: "return=representation",
      body: { tenant_id: tenant.id, name: customer_name, phone: customer_phone },
    });
    customerId = newCustomer.id;
  }

  const [appointment] = await sb(env, "appointments", {
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenant.id,
      customer_id: customerId,
      service_id,
      staff_id,
      starts_at: startsAtDate.toISOString(),
      ends_at: endsAtDate.toISOString(),
      status: "confirmed",
      source: "voice",
    },
  });

  return json(appointment);
}

// ---------------------------------------------------------------------------
// Autenticación del dashboard de cliente — enlace mágico por email.
// El tenant de cada petición se resuelve SIEMPRE a partir de la sesión válida,
// nunca de un id en la URL, para que un cliente nunca pueda ver datos de otro.
// ---------------------------------------------------------------------------

const DASHBOARD_URL = "https://cuerpo-y-mente-dashboard.pages.dev"; // TODO: mover a un dominio propio del panel cuando se consolide
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutos para canjear el enlace
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días de sesión

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendMagicLinkEmail(env, email, token) {
  const link = `${DASHBOARD_URL}/?token=${token}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "SBM AI Agency <panel@sbmaiagency.com>",
      to: [email],
      subject: "Tu enlace de acceso al panel",
      html: `<p>Haz clic para entrar a tu panel de control:</p><p><a href="${link}">${link}</a></p><p>Este enlace caduca en 15 minutos y solo se puede usar una vez. Si no lo has pedido tú, ignora este correo.</p>`,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend ${res.status}: ${errText}`);
  }
}

async function handleRequestLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  if (!email) return json({ error: "Falta el email" }, 400);

  // Respuesta siempre genérica, exista o no el email, para no filtrar qué correos están dados de alta
  const generic = { sent: true, message: "Si ese email está registrado, te hemos enviado un enlace." };

  const rows = await sb(env, `dashboard_users?email=eq.${encodeURIComponent(email)}&select=tenant_id`);
  if (!rows.length) return json(generic);

  const tenantId = rows[0].tenant_id;
  const token = randomToken();
  const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString();

  await sb(env, "dashboard_login_tokens", {
    method: "POST",
    body: { email, tenant_id: tenantId, token, expires_at: expiresAt },
  });

  try {
    await sendMagicLinkEmail(env, email, token);
  } catch (err) {
    return json({ error: "No se pudo enviar el email. Inténtalo de nuevo en un momento." }, 502);
  }

  return json(generic);
}

async function handleVerifyLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = body.token || "";
  if (!token) return json({ error: "Falta el token" }, 400);

  const rows = await sb(env, `dashboard_login_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
  const loginToken = rows[0];
  if (!loginToken) return json({ error: "Enlace no válido" }, 401);
  if (loginToken.used_at) return json({ error: "Este enlace ya se ha usado" }, 401);
  if (new Date(loginToken.expires_at) < new Date()) return json({ error: "Este enlace ha caducado" }, 401);

  await sb(env, `dashboard_login_tokens?id=eq.${loginToken.id}`, {
    method: "PATCH",
    body: { used_at: new Date().toISOString() },
  });

  const sessionToken = randomToken();
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sb(env, "dashboard_sessions", {
    method: "POST",
    body: {
      token: sessionToken,
      tenant_id: loginToken.tenant_id,
      email: loginToken.email,
      expires_at: sessionExpiresAt,
    },
  });

  const tenantRows = await sb(env, `tenants?id=eq.${loginToken.tenant_id}&select=name`);
  return json({
    session_token: sessionToken,
    tenant_id: loginToken.tenant_id,
    tenant_name: tenantRows[0]?.name || "tu negocio",
  });
}

// Devuelve { tenantId, email } si la sesión es válida, o null si no lo es.
async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return null;
  const sessionToken = match[1];

  const rows = await sb(env, `dashboard_sessions?token=eq.${encodeURIComponent(sessionToken)}&select=tenant_id,email,expires_at`);
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  return { tenantId: session.tenant_id, email: session.email };
}

// ---------------------------------------------------------------------------
// Datos del dashboard de cliente — migrados desde el Worker por-cliente,
// ahora siempre autenticados y con el tenant resuelto por sesión.
// ---------------------------------------------------------------------------

async function handleDashboardLeads(request, env, tenantId) {
  const normalize = (s) => (s || "").replace(/\D/g, "").slice(-9);
  const conversations = await sb(env, `conversations?tenant_id=eq.${tenantId}&select=id,channel,external_user_id,created_at&order=created_at.desc&limit=50`);
  const customers = await sb(env, `customers?tenant_id=eq.${tenantId}&select=phone`);
  const knownPhones = new Set(customers.map((c) => normalize(c.phone)).filter(Boolean));
  const leadConvos = conversations.filter((c) => c.channel === "whatsapp" && !knownPhones.has(normalize(c.external_user_id)));
  const leads = [];
  for (const convo of leadConvos.slice(0, 15)) {
    const lastMsg = await sb(env, `messages?conversation_id=eq.${convo.id}&role=eq.user&order=created_at.desc&limit=1&select=content,created_at`);
    const preview = lastMsg[0]?.content?.slice(0, 80) || "(sin mensaje registrado)";
    const when = lastMsg[0]?.created_at || convo.created_at;
    const days = Math.max(0, Math.floor((Date.now() - new Date(when).getTime()) / 86400000));
    leads.push({ name: "Cliente por WhatsApp", phone: convo.external_user_id, msg: preview, days, urgent: days >= 3 });
  }
  return json(leads);
}

async function handleDashboardAppointments(request, env, tenantId) {
  const rows = await sb(
    env,
    `appointments?tenant_id=eq.${tenantId}&status=eq.confirmed&select=id,starts_at,ends_at,status,source,customers(name,phone),services(name,duration_minutes,price_cents)&order=starts_at.asc`
  );
  return json(rows);
}

async function handleDashboardCustomers(request, env, tenantId) {
  const rows = await sb(
    env,
    `customers?tenant_id=eq.${tenantId}&archived=eq.false&select=id,name,phone,appointments(starts_at,services(name,price_cents,duration_minutes))`
  );
  return json(rows);
}

async function handleDashboardServices(request, env, tenantId) {
  const rows = await sb(env, `services?tenant_id=eq.${tenantId}&select=id,name,duration_minutes,price_cents,active&order=name.asc`);
  return json(rows);
}

async function handleDashboardAvailability(request, env, tenantId) {
  const rows = await sb(env, `availability_rules?tenant_id=eq.${tenantId}&select=id,weekday,start_time,end_time,staff_id&order=weekday.asc,start_time.asc`);
  return json(rows);
}

async function handleDashboardAppointmentCreate(request, env, tenantId) {
  const body = await request.json();
  let staffId = body.staff_id;
  if (!staffId) {
    const staffRows = await sb(env, `staff?tenant_id=eq.${tenantId}&select=id&limit=1`);
    staffId = staffRows[0]?.id;
  }
  const result = await handleCreateAppointmentForTenant(env, tenantId, { ...body, staff_id: staffId }, "manual");
  return json(result);
}

async function handleDashboardAppointmentCancel(request, env, tenantId) {
  const body = await request.json();
  if (!body.appointment_id) return json({ error: "Falta appointment_id" }, 400);
  const existing = await sb(env, `appointments?id=eq.${body.appointment_id}&tenant_id=eq.${tenantId}&select=id`);
  if (!existing.length) return json({ error: "Cita no encontrada para este negocio" }, 404);
  const result = await sb(env, `appointments?id=eq.${body.appointment_id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "cancelled" },
  });
  return json({ cancelled: true, appointment: result[0] || null });
}

async function handleDashboardServiceCreate(request, env, tenantId) {
  const body = await request.json();
  const row = await sb(env, "services", {
    method: "POST",
    prefer: "return=representation",
    body: {
      tenant_id: tenantId,
      name: body.name || "Nuevo servicio",
      duration_minutes: body.duration_minutes || 30,
      price_cents: body.price_cents || 0,
      active: true,
    },
  });
  return json(row[0]);
}

async function handleDashboardServiceUpdate(request, env, tenantId) {
  const body = await request.json();
  if (!body.id) return json({ error: "Falta id" }, 400);
  const patch = {};
  for (const f of ["name", "duration_minutes", "price_cents", "active"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  const result = await sb(env, `services?id=eq.${body.id}&tenant_id=eq.${tenantId}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: patch,
  });
  return json(result[0] || null);
}

async function handleDashboardAvailabilitySave(request, env, tenantId) {
  const body = await request.json();
  const staffRows = await sb(env, `staff?tenant_id=eq.${tenantId}&select=id&limit=1`);
  const staffId = staffRows[0]?.id;
  if (!staffId) return json({ error: "No hay ningún miembro del personal dado de alta para este negocio" }, 400);
  await sb(env, `availability_rules?tenant_id=eq.${tenantId}`, { method: "DELETE" });
  const newRows = (body.rules || []).map((r) => ({
    tenant_id: tenantId,
    staff_id: staffId,
    weekday: r.weekday,
    start_time: r.start_time,
    end_time: r.end_time,
  }));
  const inserted = newRows.length
    ? await sb(env, "availability_rules", { method: "POST", prefer: "return=representation", body: newRows })
    : [];
  return json({ saved: true, rules: inserted });
}

async function handleDashboardCustomerArchive(request, env, tenantId) {
  const body = await request.json();
  if (!body.customer_id) return json({ error: "Falta customer_id" }, 400);
  const existing = await sb(env, `customers?id=eq.${body.customer_id}&tenant_id=eq.${tenantId}&select=id`);
  if (!existing.length) return json({ error: "Clienta no encontrada para este negocio" }, 404);
  const result = await sb(env, `customers?id=eq.${body.customer_id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { archived: true },
  });
  return json({ archived: true, customer: result[0] || null });
}

// Variante de create_appointment reutilizable tanto desde el dashboard como, en el futuro,
// desde cualquier otro sitio que ya tenga el tenantId resuelto (en vez de un slug en la URL).
async function handleCreateAppointmentForTenant(env, tenantId, input, source) {
  const { customer_name, customer_phone, service_id, staff_id, starts_at } = input;
  const serviceRows = await sb(env, `services?id=eq.${service_id}&tenant_id=eq.${tenantId}&select=duration_minutes`);
  const service = serviceRows[0];
  if (!service) return { error: "Servicio no encontrado" };
  const startsAtDate = new Date(starts_at);
  const endsAtDate = new Date(startsAtDate.getTime() + service.duration_minutes * 60000);

  let customer = customer_phone
    ? (await sb(env, `customers?tenant_id=eq.${tenantId}&phone=eq.${encodeURIComponent(customer_phone)}`))[0]
    : null;
  if (!customer) {
    customer = (
      await sb(env, "customers", {
        method: "POST",
        prefer: "return=representation",
        body: { tenant_id: tenantId, name: customer_name, phone: customer_phone || null },
      })
    )[0];
  }

  const appointment = (
    await sb(env, "appointments", {
      method: "POST",
      prefer: "return=representation",
      body: {
        tenant_id: tenantId,
        customer_id: customer.id,
        service_id,
        staff_id,
        starts_at: startsAtDate.toISOString(),
        ends_at: endsAtDate.toISOString(),
        status: "confirmed",
        source: source || null,
      },
    })
  )[0];
  return { confirmed: true, appointment };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // GET /clients — lista todos los clientes de la agencia
      if (request.method === "GET" && url.pathname === "/clients") {
        const rows = await sb(env, "agency_clients?select=*&order=created_at.asc");
        return json(rows);
      }

      // POST /clients — crea un cliente nuevo
      if (request.method === "POST" && url.pathname === "/clients") {
        const body = await request.json();
        if (!body.id || !body.name || !body.plan) {
          return json({ error: "Faltan campos obligatorios: id, name, plan" }, 400);
        }
        const [row] = await sb(env, "agency_clients", {
          method: "POST",
          prefer: "return=representation",
          body: {
            id: body.id,
            name: body.name,
            short: body.short || body.name.slice(0, 2).toUpperCase(),
            plan: body.plan,
            status: body.status || "active",
            since: body.since || null,
            contact: body.contact || null,
            phone: body.phone || null,
            setup_fee: body.setup_fee ?? 0,
            monthly_fee: body.monthly_fee ?? 0,
            rating: body.rating || null,
            modules: body.modules || {},
            notes: body.notes || null,
          },
        });
        return json(row);
      }

      // PATCH /clients/:id — actualiza un cliente existente (edición parcial)
      const patchMatch = url.pathname.match(/^\/clients\/([^/]+)$/);
      if (request.method === "PATCH" && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        const body = await request.json();
        body.updated_at = new Date().toISOString();
        const [row] = await sb(env, `agency_clients?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          prefer: "return=representation",
          body,
        });
        if (!row) return json({ error: "Cliente no encontrado" }, 404);
        return json(row);
      }

      // DELETE /clients/:id — borra un cliente (uso real: solo para el ejemplo ficticio o errores de alta)
      const deleteMatch = url.pathname.match(/^\/clients\/([^/]+)$/);
      if (request.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        await sb(env, `agency_clients?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
        return json({ deleted: true, id });
      }

      if (request.method === "GET" && url.pathname === "/clients/ads-overview") {
        return handleAdsOverview(request, env);
      }

      const adsSummaryMatch = url.pathname.match(/^\/clients\/([^/]+)\/ads-summary$/);
      if (request.method === "GET" && adsSummaryMatch) {
        return handleAdsSummary(request, env, decodeURIComponent(adsSummaryMatch[1]));
      }

      const adsPauseMatch = url.pathname.match(/^\/clients\/([^/]+)\/ads-pause-all$/);
      if (request.method === "POST" && adsPauseMatch) {
        return handleAdsPauseAll(request, env, decodeURIComponent(adsPauseMatch[1]));
      }

      // --- Endpoints de voz (Sofía / Retell), multi-tenant ---
      const listServicesMatch = url.pathname.match(/^\/voice\/([^/]+)\/list-services$/);
      if (request.method === "GET" && listServicesMatch) {
        return handleListServices(request, env, decodeURIComponent(listServicesMatch[1]));
      }

      const checkAvailMatch = url.pathname.match(/^\/voice\/([^/]+)\/check-availability$/);
      if (request.method === "POST" && checkAvailMatch) {
        return handleCheckAvailability(request, env, decodeURIComponent(checkAvailMatch[1]));
      }

      const createApptMatch = url.pathname.match(/^\/voice\/([^/]+)\/create-appointment$/);
      if (request.method === "POST" && createApptMatch) {
        return handleCreateAppointment(request, env, decodeURIComponent(createApptMatch[1]));
      }

      // --- Login del dashboard de cliente (enlace mágico) ---
      if (request.method === "POST" && url.pathname === "/dashboard/request-login") {
        return handleRequestLogin(request, env);
      }
      if (request.method === "POST" && url.pathname === "/dashboard/verify") {
        return handleVerifyLogin(request, env);
      }

      // --- Rutas del dashboard de cliente, todas requieren sesión válida ---
      const DASHBOARD_ROUTES = {
        "GET /dashboard/leads": handleDashboardLeads,
        "GET /dashboard/appointments": handleDashboardAppointments,
        "GET /dashboard/customers": handleDashboardCustomers,
        "GET /dashboard/services": handleDashboardServices,
        "GET /dashboard/availability": handleDashboardAvailability,
        "POST /dashboard/appointments/create": handleDashboardAppointmentCreate,
        "POST /dashboard/appointments/cancel": handleDashboardAppointmentCancel,
        "POST /dashboard/services/create": handleDashboardServiceCreate,
        "POST /dashboard/services/update": handleDashboardServiceUpdate,
        "POST /dashboard/availability/save": handleDashboardAvailabilitySave,
        "POST /dashboard/customers/archive": handleDashboardCustomerArchive,
      };
      const routeKey = `${request.method} ${url.pathname}`;
      if (DASHBOARD_ROUTES[routeKey]) {
        const session = await requireSession(request, env);
        if (!session) return json({ error: "Sesión no válida o caducada. Vuelve a iniciar sesión." }, 401);
        return DASHBOARD_ROUTES[routeKey](request, env, session.tenantId);
      }

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
