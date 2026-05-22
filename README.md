# Pizza Demo Auditor (MCP Server)

Servidor MCP local que se conecta a la Supabase de **Pizza Demo** (read-only) y deja auditar el negocio desde el chat de Claude Code: cuántos pedidos hubo, distribución, retrasos, y —lo más importante— **si el cliente sigue usando el sistema o lo abandonó** (silencios en horario pico).

- Documentación funcional: [docs/PRD.md](docs/PRD.md)
- Reglas de código: [docs/RULES.md](docs/RULES.md)
- Memoria de decisiones: [docs/ENGRAM.md](docs/ENGRAM.md)

Corre en **Mac, Linux y Windows**.

---

## Qué expone

**Tools:**
- `query_orders` — consulta y agrega pedidos en un rango (totales, distribución por estado/pago/entrega, ticket promedio, retrasos). Filtros + agrupación opcionales.
- `detect_activity_gaps` — detecta ventanas de horario pico (vie/sáb/dom) sin ningún pedido. La señal de abandono operativo.

**Resource:**
- `pizza-demo://schema` — auto-documentación del schema que el auditor puede leer.

---

## Prerequisitos

| Componente | Instalación |
|---|---|
| **Bun** ≥ 1.0 | Mac/Linux: `curl -fsSL https://bun.sh/install \| bash` · Windows: `powershell -c "irm bun.sh/install.ps1\|iex"` |
| Acceso a la Supabase de Pizza Demo | Necesitás poder correr SQL en el proyecto (Supabase Studio → SQL editor) |

---

## Setup

### 1. Instalar dependencias

```bash
bun install
```

### 2. Crear el rol read-only en Supabase

En el **SQL editor** del proyecto de Pizza Demo, correr UNA vez:

```sql
-- Rol dedicado, solo lectura. NUNCA usar la service_role key acá.
CREATE ROLE mcp_auditor LOGIN PASSWORD 'PONÉ_UN_PASSWORD_FUERTE_RANDOM';

GRANT USAGE ON SCHEMA public TO mcp_auditor;
GRANT SELECT ON orders, order_items, order_tokens, order_status_events,
                 customers, addresses, products, product_sizes, settings
  TO mcp_auditor;

-- Defensivo: el auditor NO necesita ver datos de staff.
REVOKE ALL ON profiles FROM mcp_auditor;
```

> **Por qué un rol aparte y no la service_role key:** defense-in-depth. Aunque el agente alucine un `DELETE`, la base lo rechaza porque el rol solo tiene `SELECT`. Ver [RULES §8](docs/RULES.md) (seguridad).

### 3. Configurar `.env.local`

```bash
cp .env.example .env.local
```

Editar `.env.local` y completar el connection string con el rol recién creado:

```
DATABASE_URL=postgres://mcp_auditor:TU_PASSWORD@TU_PROYECTO.supabase.co:5432/postgres?sslmode=require
```

> El host y el proyecto los sacás de Supabase → Project Settings → Database → Connection string.
> `.env.local` está en `.gitignore` — nunca se commitea.

---

## Verificar que funciona (MCP Inspector)

Antes de conectarlo a Claude Code, probalo con el inspector oficial:

```bash
bun run inspect
```

Esto abre una UI web donde podés:
1. Ver las 2 tools y el resource listados.
2. Invocar `query_orders` con `{ "preset": "semana" }` y ver el JSON de respuesta.
3. Invocar `detect_activity_gaps` con `{ "preset": "semana" }`.
4. Probar un input inválido (ej. `{ "preset": "futuro" }`) → debe devolver un error legible, NO crashear.

Si el server arranca pero las queries fallan, revisá el `DATABASE_URL`.

---

## Conectar a Claude Code

Agregar este bloque al archivo de config (según tu sistema operativo):

| Plataforma | Claude Code (CLI) | Claude Desktop |
|---|---|---|
| **Mac** | `~/.claude.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Linux** | `~/.claude.json` | `~/.config/Claude/claude_desktop_config.json` |
| **Windows** | `%USERPROFILE%\.claude.json` | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "pizza-demo-auditor": {
      "command": "bun",
      "args": [
        "--env-file=RUTA_ABSOLUTA_AL_REPO/.env.local",
        "run",
        "RUTA_ABSOLUTA_AL_REPO/src/index.ts"
      ]
    }
  }
}
```

> **Importante — el flag `--env-file` es obligatorio.** Claude Code lanza el server desde un directorio distinto al del repo, así que Bun NO encuentra el `.env.local` por sí solo. El `--env-file` con path absoluto se lo da explícito. Sin esto, el server arranca pero muere con "DATABASE_URL no está seteado".

Reemplazá `RUTA_ABSOLUTA_AL_REPO`:
- Mac/Linux: `/Users/tu-usuario/Desktop/mcpserver` (o donde lo tengas)
- Windows: `C:/Users/tu-usuario/Desktop/mcpserver` (forward slashes funcionan en JSON)

**Alternativa más simple (Claude Code CLI):** en vez de editar el JSON a mano, usá el comando:
```bash
claude mcp add pizza-demo-auditor -- bun --env-file=RUTA_ABSOLUTA_AL_REPO/.env.local run RUTA_ABSOLUTA_AL_REPO/src/index.ts
```

Reiniciá Claude Code. Las tools aparecen automáticamente.

---

## Usar

En el chat de Claude Code, preguntás en lenguaje natural:

- *"auditá la última semana de Pizza Demo"*
- *"¿hubo silencios en horario pico este mes?"*
- *"mostrame los pedidos de hoy agrupados por método de pago"*
- *"comparame esta semana con la anterior"*

El agente invoca las tools, lee el JSON, y te responde en español.

---

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run start` | Arranca el server (stdio). Útil para debug manual. |
| `bun run typecheck` | `tsc --noEmit` — chequeo de tipos. |
| `bun run inspect` | Abre el MCP Inspector contra el server. |

---

## Notas de seguridad

- Read-only por diseño Y por permisos de DB.
- `DATABASE_URL` nunca se commitea (`.gitignore`).
- Si el connection string se filtra: rotá el password del rol `mcp_auditor` en Supabase. Como solo tiene `SELECT`, el daño es limitado.
- El server corre local (stdio) — no expone ningún puerto.
