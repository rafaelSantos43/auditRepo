# PRD — Pizza Demo Auditor (MCP Server)

> Servidor MCP local cross-platform (Mac / Linux / Windows) que da a Rafael una vista de control auditable sobre la Supabase de Pizza Demo. Le permite responder, desde su chat de Claude Code, **una sola pregunta crítica del negocio**: ¿el cliente sigue usando el sistema, o volvió a tomar pedidos por chat?

**Versión:** 1.0
**Estado:** Listo para construir
**Última actualización:** 2026-05-21
**Owner:** backend@codecraftdev.com
**Sistema auditado:** Pizza Demo (SaaS single-tenant para Pizzas Family — repo separado, no en este árbol)

---

## 1. Resumen ejecutivo

Rafael vende Pizza Demo a Pizzas Family por **$99.000 COP/mes** con trial de 14 días y cobro 100% manual. Después del mes 1, necesita evidencia objetiva para responder:

- ¿El cajero abrió el panel hoy?
- ¿Entraron pedidos en horario pico, o silencio total?
- ¿Cuánto tarda el cajero en validar comprobantes de Nequi?
- ¿Vale la pena recomendar la renovación del mes 2?

La data existe en Supabase pero atomizada en tablas. Sin una herramienta cómoda, Rafael abre Supabase Studio y escribe SQL cada vez — fricción que mata el hábito.

**La solución:** servidor MCP local cross-platform que corre en la máquina de Rafael (sea Mac, Linux o Windows). Abre Claude Code, pregunta en lenguaje natural; el agente invoca **tools composables** que ejecutan SQL parametrizadas y devuelven **datos estructurados (JSON)**. El agente decide cómo presentárselos.

**No es:** un dashboard web, una página `/admin/metricas` dentro de Pizza Demo, ni un reporte automatizado por cron. Es exploración conversacional asistida por LLM.

---

## 2. Dolor real y por qué importa

| Dolor | Frecuencia esperada | Costo si no se resuelve |
|---|---|---|
| No sé si el cliente sigue activo con el sistema | Semanal (todo el trial + cada mes) | Renovaciones a ciegas, no puedo asesorar al dueño |
| Abrir Supabase Studio cada vez que tengo una pregunta | Diaria potencial | Fricción que me hace dejar de mirar |
| Las preguntas no son fijas (cambian semana a semana) | Permanente | Un dashboard estático no las cubre todas |
| Necesito profundizar y componer (comparar X vs Y, ¿por qué cayó Z?) | Cada vez que algo se ve raro | SQL crudo es lento de iterar |

**Hipótesis fundamental:** el problema NO es falta de datos. Es falta de una superficie cómoda y rápida para interrogarlos. MCP cubre exactamente ese gap porque el LLM hace de intérprete entre intención del usuario y SQL.

---

## 3. Objetivos (medibles, honestos)

**Objetivo único de v1:**

Rafael, sin abrir Supabase Studio, puede responder en menos de 30 segundos:
1. ¿Hubo actividad en Pizza Demo en X periodo, con qué shape?
2. ¿Hubo ventanas de silencio sospechosas en horario pico?

Si después de instalar el MCP, Rafael **sigue abriendo Supabase Studio** para estas 2 preguntas, el producto falló.

### 3.1 No-objetivos explícitos

- NO es un dashboard visual (sin UI, sin gráficos).
- NO es un sistema de alertas push (no manda WhatsApp ni email).
- NO es multi-tenant (un solo cliente: Pizza Demo / Pizzas Family).
- NO es multi-sede en v1 (ver §10).
- NO escribe datos. Read-only por diseño Y por permisos de DB.
- NO reemplaza una futura `/admin/metricas` dentro de Pizza Demo — son complementarios.
- NO incluye análisis de costos, márgenes, ni proyecciones. Solo actividad operativa observable.

---

## 4. Usuario y caso de uso

| Rol | Quién | Cuándo lo usa | Cómo lo usa |
|---|---|---|---|
| **Rafael (único usuario)** | Desarrollador / vendedor del SaaS | Semanal durante trial, mensual post-renovación, ad-hoc cuando algo se ve raro | Claude Code en su laptop (Mac/Linux/Windows), pregunta en español, el agente invoca tools del MCP. |

**No hay rol "cliente final del MCP"** — el dueño de la pizzería NO lo usa.

**Flujo típico (con tools composables):**
```
Rafael:  "auditá la última semana"
Claude:  [invoca query_orders(preset="semana", groupBy="status")]
         [invoca detect_activity_gaps(preset="semana")]
         "Esta semana hubo 47 pedidos (40 delivered, 5 cancelled, 2 awaiting_payment).
          Pero el viernes 8pm–10:30pm hay un hueco de 2.5h en horario pico
          sin ningún INSERT. Es señal de que el cajero no operó el sistema."

Rafael:  "comparalo con la semana anterior"
Claude:  [invoca query_orders(preset="semana") con rango shifted]
         "Semana actual: 47. Anterior: 62. Caída del 24%."
```

El LLM **compone** las llamadas. Las tools devuelven JSON, no markdown.

---

## 5. Diseño MCP

### 5.1 Primitives usadas

| Primitive | ¿Usado? | Para qué |
|---|---|---|
| **Tools** | Sí, 2 | Operaciones que el LLM invoca con parámetros (queries con resultado calculado). |
| **Resources** | Sí, 1 | `pizza-demo://schema` — auto-documentación del schema del sistema auditado. |
| **Prompts** | No en v1 | Reservado para v1.1 si Rafael repite preguntas idénticas y vale tenerlas pre-canned. |

### 5.2 Tools

#### Tool 1: `query_orders`

**Descripción para el agente** (esto va al campo `description` que el LLM lee para decidir cuándo invocarla):
> Consulta y agrega pedidos de Pizza Demo en un rango de tiempo. Úsala para responder cualquier pregunta cuantitativa sobre actividad: cuántos pedidos hubo, distribución por estado/método de pago/tipo de entrega, ticket promedio, total facturado, pedidos retrasados. Aplica filtros opcionales y agrupa por una dimensión.

**Input schema (JSON Schema vía Zod):**
```ts
{
  // Rango: exactly one of (preset) OR (from + to)
  preset?: "hoy" | "ayer" | "semana" | "mes",
  from?: string,  // ISO 8601 datetime
  to?: string,    // ISO 8601 datetime

  // Filtros opcionales (todos se combinan con AND)
  filters?: {
    status?: ("new" | "awaiting_payment" | "payment_approved" | "preparing"
            | "ready" | "on_the_way" | "delivered" | "cancelled"
            | "payment_rejected")[],
    payment_method?: ("cash" | "bancolombia" | "nequi" | "llave")[],
    delivery_type?: ("delivery" | "pickup")[],
    delayed?: boolean
  },

  // Agrupación: el output devuelve breakdown por esta dimensión
  groupBy?: "status" | "payment_method" | "delivery_type" | "weekday" | "hour_of_day" | "none",

  // Por default agrega; si true devuelve raw orders (limitado a 100 filas)
  detail?: boolean
}
```

**Output schema (estructurado, NO markdown):**
```ts
{
  range: { from: string, to: string, timezone: "America/Bogota", label: string },
  applied_filters: object,
  summary: {
    total_orders: number,
    revenue_real_cop: number,    // suma de total_cents de orders con status=delivered
    revenue_gross_cop: number,   // suma de total_cents de orders excepto cancelled/payment_rejected
    avg_ticket_cop: number,      // revenue_real / count(delivered)
    delayed_orders: number,      // count con delayed=true
    delayed_pct: number          // (delayed_orders / total_orders) * 100
  },
  groups?: [                     // presente si groupBy != "none"
    { key: string, count: number, revenue_gross_cop: number }
  ],
  detail?: [                     // presente solo si detail=true, máx 100 filas
    { id, created_at, status, payment_method, delivery_type, total_cents, delayed }
  ],
  total_available?: number       // presente solo si detail truncó (filas reales > 100)
}
```

**Definiciones explícitas** (resuelven la ambigüedad del audit punto E):
- `revenue_real`: solo orders en estado terminal positivo (`status='delivered'`). Es el dinero que efectivamente entró.
- `revenue_gross`: todas las orders excepto `cancelled` y `payment_rejected`. Incluye in-flight (preparing, on_the_way). Útil para proyectar revenue del periodo.
- `avg_ticket`: `revenue_real / count(status='delivered')`. Si hay 0 delivered, devuelve `0`.

#### Tool 2: `detect_activity_gaps`

**Descripción para el agente:**
> Detecta ventanas de tiempo en horario pico donde no entró ningún pedido en Pizza Demo. Úsala para responder "¿el sistema se está usando en los momentos que importan?" o "¿hubo abandono operativo el viernes/sábado/domingo?". Devuelve los huecos como rangos de tiempo discretos. Es la señal más fuerte de que el cliente abandonó el sistema (más fuerte que contar pedidos: ausencia en pico = renuncia).

**Input schema:**
```ts
{
  preset?: "semana" | "mes",   // default "semana"
  from?: string,                // ISO 8601
  to?: string,                  // ISO 8601
  window_hours?: number         // mínimo 1, máximo 6, default 2
}
```

**Output schema:**
```ts
{
  range: { from: string, to: string, timezone: "America/Bogota", label: string },
  window_hours: number,
  peak_hours_definition: {
    viernes: "18:00-23:00",
    sabado: "12:00-23:00",
    domingo: "12:00-21:00"
  },
  gaps: [
    {
      start: string,            // ISO datetime
      end: string,
      duration_hours: number,
      weekday: "viernes" | "sabado" | "domingo"
    }
  ],
  total_peak_hours: number,
  total_silent_hours: number,
  silence_pct: number
}
```

**Por qué solo 2 tools y no 5:** `query_orders` con `filters` + `groupBy` cubre todas las preguntas cuantitativas sobre la tabla `orders` componiendo parámetros — el LLM no necesita 5 tools chicas. `detect_activity_gaps` justifica ser separada porque su lógica es estructuralmente distinta (iteración día-por-día buscando huecos en horario pico), no se compone de `query_orders`. Nota de implementación: en vez de SQL con `generate_series`, trae los timestamps con un SELECT simple y calcula los huecos en TypeScript — más legible y suficiente para el volumen de una pizzería.

### 5.3 Resources

#### Resource: `pizza-demo://schema`

Auto-documentación del schema de Pizza Demo relevante para el auditor. Resource (no tool) porque es estático para una versión dada del MCP — el LLM lo lee como referencia, no lo "ejecuta".

**Contenido (JSON):**
```json
{
  "fuente": "Snapshot manual del schema de Pizza Demo al 2026-05-21. Actualizar cuando el sistema auditado cambie sus columnas.",
  "tablas_legibles": {
    "orders": {
      "columnas_relevantes": ["id", "status", "payment_method", "delivery_type",
                               "total_cents", "delayed", "eta_at", "created_at",
                               "delivered_at"],
      "status_values": ["new", "awaiting_payment", "payment_approved",
                        "payment_rejected", "preparing", "ready", "on_the_way",
                        "delivered", "cancelled"]
    },
    "order_tokens": { "columnas_relevantes": ["customer_id", "expires_at", "used_at", "created_at"] },
    "customers": { "columnas_relevantes": ["id", "phone"] }
  },
  "tablas_no_legibles": ["profiles"],
  "notas": [
    "Moneda: COP, almacenada en *_cents pero NO usa centavos. 1000_cents = $1.000 COP.",
    "Timestamps en UTC en la DB. Convertir a America/Bogota para outputs al usuario.",
    "delivery_type agregado en feature pickup 2026-05-08 — puede estar NULL en rows viejas."
  ]
}
```

### 5.4 Contrato de errores (resuelve audit punto D)

Las tools NO throwean. Devuelven `{ isError: true, content: [...] }` con el error legible cuando algo falla. El agente puede ver el error y decidir cómo reaccionar (reintentar, pedir aclaración al usuario, dar up).

| Tipo de error | Cómo se devuelve | Ejemplo |
|---|---|---|
| Rango inválido (`desde > hasta`, fecha futura) | `isError: true`, content describe el problema | "El rango es inválido: `desde` es posterior a `hasta`." |
| SQL falla en runtime (timeout, columna inexistente) | `isError: true`, content incluye el mensaje crudo de Postgres | "Error de DB: relation 'orders' does not exist" |
| Conexión a Supabase caída | `isError: true`, content explícito | "No se pudo conectar a la DB. Verificá DATABASE_URL en .env.local." |
| `preset` + `desde`/`hasta` ambos vacíos | Validación Zod, `isError: true` | "Especificá `preset` o el par `desde`+`hasta`." |
| Excepción no manejada | El server stdio loggea a stderr y devuelve `isError: true` con stack truncado | — |

### 5.5 Budget de tokens en outputs (resuelve audit punto I)

Las tools devuelven **agregaciones por default**. El parámetro `detalle: true` activa raw rows con **límite duro de 100 filas**. Si el usuario pide más detalle, devolvemos las primeras 100 + un campo `total_disponible: N` para que el LLM sepa que truncó.

**Cota superior de tamaño de output:** ~30KB. Suficiente headroom para un mes de pedidos agregados, sin reventar el context.

### 5.6 Estrategia de naming y descriptions

- **Naming:** verbo + objeto en inglés (`query_orders`, `detect_activity_gaps`). Snake_case. El dominio en español va en `.describe()` y mensajes de error (ver política de idioma en RULES §8). Suficientemente descriptivos para que un agente sin haber leído este PRD pueda inferir cuándo usarlos.
- **Descriptions:** describen **cuándo** usar la tool (con ejemplos de preguntas que la disparan), no solo qué hace. Ver textos de descripción en §5.2. Esto es prompt engineering del MCP — afecta directamente la tasa de uso correcto por el agente.

---

## 6. Stack y dependencias

| Capa | Tecnología | Por qué |
|---|---|---|
| Lenguaje | TypeScript estricto | Consistencia con Pizza Demo. SDK MCP es first-class en TS. |
| Runtime | **Bun** | Corre TS directo sin build step. Mismo manager que Pizza Demo. |
| MCP SDK | `@modelcontextprotocol/sdk` (oficial) | Único SDK maduro. Soporta stdio out-of-the-box. |
| DB driver | `postgres` (porsager/postgres) | Template literals parametrizados (anti-injection by construction). |
| Validación de inputs | `zod` | Las tools MCP definen input schemas; Zod es estándar de facto. JSON Schema se exporta vía `zod-to-json-schema` si hace falta. |
| Logging | `console.error` (stderr) | stdout reservado para protocolo MCP. Cero deps de logger. |

**Total: 3 deps de prod (más `zod-to-json-schema` si la API MCP lo requiere).**

---

## 7. Arquitectura

### 7.1 Diagrama

```
┌──────────────────┐   stdio    ┌────────────────────────────┐
│ Claude Code      │ ──────────▶│ Pizza Demo Auditor (Bun)   │
│ Local host       │   MCP RPC  │  src/index.ts              │
│ (Mac/Linux/Win)  │ ◀──────────│   ├── tool: query_orders   │
└──────────────────┘            │   ├── tool: detect_activ…  │
                                │   └── resource: schema     │
                                └────────────┬───────────────┘
                                             │ TLS / postgres
                                             ▼
                                  ┌────────────────────────┐
                                  │ Supabase (Pizza Demo)  │
                                  │ rol mcp_auditor        │
                                  │ GRANT SELECT only      │
                                  └────────────────────────┘
```

### 7.2 Estructura del repo

```
mcpserver/
├── README.md                         # Setup + uso + verificación
├── docs/
│   └── PRD.md                        # Este documento (PRD del MCP server)
├── src/
│   ├── index.ts                      # Entry: server MCP + registro tools/resources
│   ├── db.ts                         # Cliente postgres + helper query
│   ├── tools/
│   │   ├── query-orders.ts      # Tool 1: schema + SQL + serializer
│   │   └── detect-activity-gaps.ts     # Tool 2: schema + SQL + serializer
│   ├── resources/
│   │   └── schema.ts                 # Resource estático
│   ├── lib/
│   │   ├── ranges.ts                 # Parse de preset/desde/hasta en America/Bogota
│   │   └── errors.ts                 # Helper toErrorResult(err) → { isError: true, content }
│   └── constants.ts                  # T_ORDERS = 'orders', BUSINESS_HOURS, etc.
├── .env.example
├── .env.local                        # gitignored
├── .gitignore
├── package.json
└── tsconfig.json
```

**Nota:** este repo NO contiene los docs del sistema auditado (PRD/EMGRAM de Pizza Demo viven en su propio repo). Toda la información de schema relevante que el MCP necesita ya está extraída e incorporada acá — en §5.3 (resource `pizza-demo://schema`) y §7.4 (modelo de datos).

### 7.3 Decisión arquitectónica: específico a Pizza Demo, no agnóstico

El MCP **NO** está diseñado para ser reusable contra otros SaaS. Las SQL referencian tablas y columnas concretas de Pizza Demo (`orders.status`, `payment_method`, `delivery_type`).

**Por qué no agnóstico hoy:**
1. Solo hay 1 cliente — abstraer sin un 2do caso real es adivinanza.
2. Cuando aparezca cliente #2, sus métricas relevantes pueden ser distintas (no se traduce 1:1).
3. Cada hora invertida en abstracción es una hora no invertida en mejor profundidad para Pizza Demo.

**Higiene desde día 1 (gratis) para que un futuro refactor a config externa cueste ~2h:**
- SQL parametrizadas con `postgres` template literals (no concat de strings).
- SQL en archivos separados por tool, no inline en handlers de MCP.
- Nombres de tabla y umbrales en `src/constants.ts`, no magic strings.

### 7.4 Modelo de datos (read-only sobre Pizza Demo)

El MCP NO crea ni modifica tablas. Lee de las existentes en la Supabase de Pizza Demo (schema relevante listado abajo + ampliado en §5.3 resource):

| Tabla | Para qué la lee el MCP en v1 |
|---|---|
| `orders` | Métricas: total, status, payment_method, delivery_type, delayed, eta_at, created_at, delivered_at, total_cents |
| `order_tokens` | (Reservado v1.1) Tasa de conversión link → pedido |
| `order_status_events` | (Reservado v1.1) Tiempos en cada estado |
| `order_items` / `products` / `product_sizes` | No usadas en v1 |
| `customers` / `addresses` | No leídas (no se devuelven datos personales) |
| `settings` | No usada en v1 (futuro: validar config esperada) |
| `profiles` | **NUNCA** — REVOKE explícito |

### 7.5 Lifecycle y concurrencia (resuelve audit punto J)

- **Lifecycle:** Claude Code lanza el server como **subprocess stdio al iniciar la conversación** y lo mata al cerrar. No es daemon, no persiste entre conversaciones. Comportamiento idéntico en Mac, Linux y Windows porque stdio es estándar POSIX/Win32.
- **Concurrencia:** stdio MCP es single-process, single-connection. **Las tools NO se ejecutan en paralelo dentro de una conversación** — el agente las invoca secuencialmente. No hay race conditions que considerar en el server.
- **Pool de DB:** una sola conexión por instancia del server, con `idle_timeout: 30s`. Si la conversación pausa y reanuda, la conexión se rebuilds transparente.
- **Portabilidad:** todas las dependencias (Bun, `@modelcontextprotocol/sdk`, `postgres`, `zod`) tienen builds nativos para Mac (x64/arm64), Linux (x64/arm64) y Windows (x64). Path handling usa `path.join()` (no separators hardcoded) cuando aplica.

---

## 8. Seguridad

| Área | Cómo se cubre |
|---|---|
| Credenciales | `DATABASE_URL` en `.env.local`, nunca commiteado. `.env.example` solo placeholder. |
| Privilegios DB | Rol Postgres dedicado `mcp_auditor` con **GRANT SELECT** sobre 8 tablas, REVOKE explícito sobre `profiles`. Sin INSERT/UPDATE/DELETE/TRUNCATE. |
| Bypass RLS | El rol custom bypasea RLS por diseño (no es `anon` ni `authenticated`) pero solo tiene SELECT. RLS de Pizza Demo intacta para el resto del sistema. |
| Conexión | TLS obligatorio (`sslmode=require`). |
| Inyección SQL | Todas las queries usan template literals parametrizados de `postgres`. Cero concat de strings. |
| Secrets en logs | Logs por stderr, nunca imprimen `DATABASE_URL`. |
| Acceso al server | Local-only stdio. No hay puerto expuesto. Solo el proceso de Claude Code corriendo como el usuario actual del SO puede invocarlo (IPC same-host, idéntico en Mac/Linux/Windows). |

---

## 9. Soporte cross-platform

El MCP funciona idéntico en los 3 SOs principales. Las únicas diferencias están en **dónde Claude Code/Desktop busca su archivo de configuración** y en el path absoluto del repo (cada usuario decide dónde clonarlo).

### 9.1 Ubicación del config de Claude (por plataforma)

| Plataforma | Claude Code (CLI) | Claude Desktop (app) |
|---|---|---|
| **Mac** | `~/.claude.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Linux** | `~/.claude.json` | `~/.config/Claude/claude_desktop_config.json` |
| **Windows** | `%USERPROFILE%\.claude.json` | `%APPDATA%\Claude\claude_desktop_config.json` |

### 9.2 Bloque de config a agregar (mismo JSON en todas las plataformas)

```json
{
  "mcpServers": {
    "pizza-demo-auditor": {
      "command": "bun",
      "args": [
        "--env-file=<RUTA_ABSOLUTA_AL_REPO>/.env.local",
        "run",
        "<RUTA_ABSOLUTA_AL_REPO>/src/index.ts"
      ]
    }
  }
}
```

> El flag `--env-file` con path absoluto es **obligatorio**: Claude Code lanza el server desde otro cwd, así que Bun no encuentra el `.env.local` por sí solo. Verificado empíricamente 2026-05-22.

Donde `<RUTA_ABSOLUTA_AL_REPO>` se reemplaza según la plataforma:
- Mac/Linux: `/home/usuario/mcpserver` o `/Users/usuario/Desktop/mcpserver`
- Windows: `C:\\Users\\usuario\\mcpserver` (escapando backslashes en JSON) o usar forward slashes `C:/Users/usuario/mcpserver` (también válido)

### 9.3 Prerequisitos en cada SO

| Componente | Comando de install (los 3 SOs) |
|---|---|
| Bun ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash` (Mac/Linux) — En Windows: `powershell -c "irm bun.sh/install.ps1\|iex"` |
| Git | Instalador nativo de cada plataforma |
| Conexión a Internet para llegar a Supabase | — |

El README enumera los pasos exactos por SO en el sub-apartado "Setup".

### 9.4 Path handling en código

- Constantes de path usan `path.join()` de Node/Bun, nunca strings hardcoded con `/` o `\`.
- `process.env.HOME` para Mac/Linux, `process.env.USERPROFILE` para Windows — pero el server no necesita home del usuario en runtime, solo en el setup del config de Claude.
- Line endings: el repo respeta LF (`.gitattributes` con `* text=auto eol=lf` si hace falta cuando se commitee).

---

## 10. Estrategia de logging (resuelve audit punto L)

- **Destino:** stderr exclusivamente.
- **Niveles:** info / warn / error. No debug en prod por default.
- **Qué se loguea:**
  - `info` — start/stop del server, lista de tools/resources registrados al inicio.
  - `info` — cada invocación de tool con `{ tool, paramsHash, durationMs }`. NO se loguean los params en plain (puede haber rangos sensibles).
  - `warn` — rango raro (más de 90 días, posible carga pesada), validación falló.
  - `error` — SQL error, error de conexión, excepción no manejada.
- **Lo que NO se loguea:** filas de resultado (privacidad + ruido).
- **Toggle:** env var `LOG_LEVEL=debug` activa output verboso si Rafael debuggea.

---

## 11. Multi-sede (futuro, no en v1)

Pizzas Family tiene 3 sedes (Campiña, Bello Horizonte, Santander) pero Pizza Demo es **single-branch** en v1 (decisión congelada del lado de Pizza Demo hasta "sí" verbal del cliente — ver historial en repo de Pizza Demo).

**Path más probable** (~80%): una sola Supabase + columna `branch_id` en `orders`.

**Adaptación del MCP cuando eso pase:**
- Agregar parámetro opcional `sede?: string` a cada tool.
- En las SQL: si `sede` viene → `WHERE branch_id = (SELECT id FROM sucursales WHERE name = $sede)`. Si no viene → agrega across sedes.
- Cambio total: ~30 minutos gracias a la higiene de §7.3.

**Por qué NO agregarlo hoy:** noise sin caso real + adivinar el nombre del campo es apostar. El auditor no debe ir más adelante que el sistema auditado.

---

## 12. Plan de entrega

**Tiempo total estimado: ~4-5 horas.**

| # | Paso | Tiempo |
|---|---|---|
| 0 | PRD.md (este documento) | ✅ |
| 1 | `bun init`, deps, tsconfig estricto, .gitignore, .env.example | ~10 min |
| 2 | `src/constants.ts` + `src/db.ts` (cliente + helper) | ~15 min |
| 3 | `src/lib/ranges.ts` (parse en America/Bogota) | ~25 min |
| 4 | `src/lib/errors.ts` (helper `toErrorResult`) | ~10 min |
| 5 | Tool 1: `query_orders` — schema Zod + SQL + serializer | ~60 min |
| 6 | Tool 2: `detect_activity_gaps` — schema + SQL + serializer | ~60 min |
| 7 | Resource: `pizza-demo://schema` | ~10 min |
| 8 | `src/index.ts` — server MCP + registro tools/resources/error handler | ~40 min |
| 9 | README.md (setup + uso + verificación) | ~20 min |
| 10 | Verificación: `tsc --noEmit` + MCP Inspector + conexión a Claude Code | ~30 min |

---

## 13. Verificación end-to-end

1. **Build:** `bunx tsc --noEmit` exit 0.
2. **Local run:** `bun run src/index.ts` arranca, loggea por stderr el registro de tools y resources, stdout queda libre.
3. **MCP Inspector:** `npx @modelcontextprotocol/inspector bun run src/index.ts`. UI lista las 2 tools y 1 resource. Invocar `query_orders({ preset: "semana" })` devuelve JSON válido (aunque sea con counts en 0 si la DB está vacía).
4. **Conexión Claude Code:** bloque agregado a `~/.claude.json`, reinicio, las tools aparecen disponibles. Pregunta *"auditá la última semana"* dispara las invocaciones esperadas.
5. **Test de error:** invocar `query_orders({ preset: "futuro" })` (preset inválido) debe devolver `{ isError: true }` con mensaje legible, NO matar el server.

---

## 14. Versionado y evolución (resuelve audit punto M)

- **SemVer en `package.json`** del MCP.
- **Tools / resources se agregan** sin breaking en minor (1.1.0, 1.2.0).
- **Inputs/outputs de tools existentes cambian** solo en major (2.0.0). Si un cambio en Pizza Demo (ej. rename de columna) fuerza el ajuste, se documenta como breaking.
- **MCP capability negotiation:** el SDK lo maneja automático. No hay que customizar nada en v1.
- **Pizza Demo evoluciona más rápido que el MCP:** cuando agrega features (pickup, addons), el MCP no se entera hasta que Rafael decide exponerlos. No hay acoplamiento de schema en runtime.

---

## 15. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Pizza Demo sin datos reales (pre-pitch) | Tools devuelven counts en 0 | Aceptado. Queries funcionan contra DB vacía sin errores. |
| Cambio de schema en Pizza Demo rompe el MCP | Queries fallan en runtime | Devuelven `isError: true` con mensaje claro de Postgres. Rafael ajusta los constants. |
| Connection string filtrado en git | Acceso de terceros a la DB | `.gitignore` desde día 1. Si pasa, rotar password del rol `mcp_auditor` (no es service_role, solo SELECT). |
| Agente alucina y pide DELETE/UPDATE | Cero — DB rechaza | Defense-in-depth por permisos del rol. |
| Latencia alta de Supabase free tier | Tools lentas | Aceptado v1. Si pesa, agregar cache local en memoria con TTL corto. |
| El MCP no aparece en Claude Code | Frustración de setup | README incluye verificación con MCP Inspector ANTES de tocar config de Claude. |
| Output muy grande satura context | Performance degradada del agente | Cota dura en `detalle=true` (100 filas, 30KB max). Default es agregado. |

---

## 16. Métricas de éxito

Tras 4 semanas de uso (post-pitch):
- ¿Cuántas veces Rafael invocó las tools? (mental, no instrumentado en v1)
- ¿Sigue abriendo Supabase Studio para preguntas que las tools podrían cubrir? Si sí → gap en scope.
- ¿Pidió tools nuevas? Si sí, ¿cuáles? Input directo para v1.1.

Rafael es el único usuario; su feedback es la métrica. No hay analytics automatizada.

---

## 17. Roadmap explícito (qué viene en v1.1, no v1)

| Feature | Cuándo justifica | Esfuerzo estimado |
|---|---|---|
| Tool `query_catalog_funnel` (tokens → orders por funnel) | Cuando haya volumen real de tokens generados (>50/sem) | ~45 min |
| Tool `medir_latencias_operativas` (avg tiempo en cada estado) | Cuando Rafael quiera asesorar al dueño sobre operación | ~60 min |
| Tool `top_productos` | Cuando interese análisis de menú | ~30 min |
| Prompt `auditar_semana_completa` (orquesta varias tools) | Si Rafael repite la misma cadena cada semana | ~20 min |
| Multi-sede (param `sede`) | Cuando Pizza Demo agregue `branch_id` | ~30 min |
| Modo alerta (push notification proactiva en silencios) | Cuando v1 valide que la métrica importa | ~3h (cron + push) |
| Transport HTTP/SSE para acceso remoto (consultar desde celular, no solo desde laptop) | Cuando Rafael quiera auditar fuera de su entorno de desarrollo | ~4h (auth bearer + deploy a Fly/Railway) |

Cada uno reusa `src/db.ts`, `src/lib/ranges.ts`, `src/lib/errors.ts` ya armados.

---

## 18. Insight final

> El cliente real del MCP no es Pizzas Family. Es Rafael.
>
> No es para mostrarle métricas al dueño del restaurante (eso es trabajo de Pizza Demo). Es para que Rafael sepa, sin moverse de su Mac, si el cliente sigue vivo en el sistema y si vale la pena renovar el mes 2.
>
> El diseño correcto **no es 5 tools chicas ni 1 tool gorda**: es **2 tools composables bien diseñadas**, JSON estructurado de output, y 1 resource que documenta el schema. El LLM hace el resto.
