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

            const adsSummaryMatch = url.pathname.match(/^\/clients\/([^/]+)\/ads-summary$/);
              if (request.method === "GET" && adsSummaryMatch) {
                        return handleAdsSummary(request, env, decodeURIComponent(adsSummaryMatch[1]));
              }

            const adsPauseMatch = url.pathname.match(/^\/clients\/([^/]+)\/ads-pause-all$/);
              if (request.method === "POST" && adsPauseMatch) {
                        return handleAdsPauseAll(request, env, decodeURIComponent(adsPauseMatch[1]));
              }

            return json({ error: "Ruta no encontrada" }, 404);
      } catch (err) {
              return json({ error: String(err) }, 500);
      }
    },
};
