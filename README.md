# SBM Agencia — Worker

Cloudflare Worker que da soporte al panel de control de SBM AI Agency (`PANEL_DE_CONTROL_SBM_AGENCIA.html`).

## Qué hace

Expone endpoints HTTP para gestionar la tabla `agency_clients` en Supabase — los clientes de la agencia (no confundir con los tenants de cada negocio, como Cuerpo y Mente, que viven en las tablas `tenants`/`customers`/etc. del mismo proyecto Supabase).

- `GET /clients` — lista todos los clientes de la agencia
- `POST /clients` — crea un cliente nuevo
- `PATCH /clients/:id` — actualiza un cliente existente (edición parcial)
- `DELETE /clients/:id` — borra un cliente (uso real: solo para altas erróneas o el ejemplo ficticio)

## Despliegue

Conectado a Cloudflare Workers Builds. Cada push a `main` dispara un build y deploy automático a producción (no hay entorno de staging separado).

## Configuración

Variables de entorno necesarias (configuradas en Cloudflare, no en este repo): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Proyecto Supabase

`jbojoeifhrdjyqvfbapd` (el mismo proyecto que usa Cuerpo y Mente, tabla separada `agency_clients`).
