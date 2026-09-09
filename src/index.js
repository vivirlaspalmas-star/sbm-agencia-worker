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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

      return json({ error: "Ruta no encontrada" }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
