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

return json({ error: "Ruta no encontrada" }, 404);
} catch (err) {
return json({ error: String(err) }, 500);
}
},
};
