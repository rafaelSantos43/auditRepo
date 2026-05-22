# ENGRAM — Memoria persistente del MCP server (Pizza Demo Auditor)

> **Qué es esto:** memoria viva de este proyecto (el servidor MCP que audita Pizza Demo). Cada decisión no trivial, cada "por qué sí" y cada "por qué no" se registra acá. Evita perder contexto entre sesiones y que un agente repita preguntas ya resueltas.
>
> **Cómo se usa:**
> - El que retoma el proyecto (humano o IA) lee este archivo ANTES de empezar.
> - Decisión nueva → agregar entrada con fecha.
> - Decisión que cambia → actualizar la entrada (tachar con ~~strikethrough~~ si quedó obsoleta).
> - Prohibido entradas vagas tipo "mejoramos el código". Cada entrada responde: **qué + por qué**.

---

## Contexto del proyecto

- **Producto:** Pizza Demo Auditor — servidor MCP local que se conecta a la Supabase de Pizza Demo (read-only) y expone tools de auditoría.
- **Para quién:** Rafael (backend@codecraftdev.com), único usuario. NO es para el dueño del restaurante.
- **Problema que resuelve:** después del mes 1, ¿el cliente sigue usando Pizza Demo o volvió al chat de WhatsApp? Evidencia objetiva para justificar la renovación de los $99k COP/mes.
- **Sistema auditado:** Pizza Demo (SaaS single-tenant para Pizzas Family). Vive en repo separado.
- **Documentos de referencia:** [PRD.md](PRD.md) (fuente de verdad funcional), [RULES.md](RULES.md) (reglas de código no negociables).

---

## Stack tecnológico (bloqueado)

- TypeScript estricto (`strict: true`, `noUncheckedIndexedAccess`, etc.)
- Bun como runtime + package manager (corre `.ts` directo, sin build)
- `@modelcontextprotocol/sdk` v1.29.0 (oficial) — transport stdio
- `postgres` (porsager) v3.4.9 — driver con template literals parametrizados
- `zod` v4.4.3 — validación de inputs
- Supabase (la DB de Pizza Demo), conexión read-only

---

## Decisiones tomadas (log en orden cronológico inverso)

### 2026-05-22 — Output de fechas: hora local Colombia con offset explícito (`toColombiaISO`)

**Qué:** se agregó `toColombiaISO(date)` en [src/lib/ranges.ts](../src/lib/ranges.ts) y se usa en todos los outputs de las dos tools (range.from/to, detail.created_at, y los gaps). Convierte un instante UTC a ISO 8601 con offset `-05:00` explícito. Ej: `2026-05-22T16:19:38Z` → `2026-05-22T11:19:38-05:00`.

**Por qué:** Rafael creó un pedido a las 11:19am y el audit lo mostraba como `16:19:38`. No era un bug: la DB guarda UTC y el output crudo mostraba UTC. La hora cruda confunde. Mostrar la hora de pared de Colombia con el offset `-05:00` deja el output legible Y sin ambigüedad (parseable, no como un `...Z`). Colombia es UTC-5 fijo (sin DST), así que restar 5h y leer los componentes UTC es exacto.

### 2026-05-22 — Fix de visibilidad de filas: `ALTER ROLE mcp_auditor BYPASSRLS`

**Qué:** un pedido real creado en producción no aparecía en el audit. Causa: RLS (Row Level Security) en la tabla `orders` filtraba las filas para el rol `mcp_auditor`. Fix aplicado en Supabase (server-side, una sola vez): `ALTER ROLE mcp_auditor BYPASSRLS;`.

**Por qué:** hay dos capas de seguridad en Postgres — `GRANT` controla acceso a la TABLA, y RLS filtra QUÉ FILAS ve cada rol. El rol tenía el GRANT SELECT pero las policies RLS (escritas para la app, que filtran por `auth.uid()`) le devolvían cero filas. `BYPASSRLS` le dice "saltate las policies de fila". Es seguro acá porque el rol es **read-only** (solo SELECT): puede ver todo pero no puede modificar nada. Es server-side: NO se re-corre al cambiar de máquina (Windows, etc.) — vive en la config de Supabase, no en el cliente.

### 2026-05-21 — Convención de idioma: código en inglés, comentarios en español

**Qué:** todos los nombres de archivos, identificadores (funciones/variables/tipos), tool names de MCP y campos de input/output van en **inglés**. Comentarios y documentación de código van en **español**. Las `.describe()` de tools y los mensajes de error quedan en español (el agente y Rafael interactúan en español). Documentado en [RULES.md §8](RULES.md).

**Cambios:** se renombró todo el código que estaba en español:
- Archivos: `consultar-pedidos.ts` → `query-orders.ts`, `detectar-silencios.ts` → `detect-activity-gaps.ts`, `rangos.ts` → `ranges.ts`.
- Tool names: `consultar_pedidos` → `query_orders`, `detectar_silencios_operativos` → `detect_activity_gaps`.
- Identificadores: `parseRango` → `parseRange`, `BUSINESS_HOURS_PICO` → `PEAK_HOURS`, `STATUSES_EXCLUIDOS_REVENUE` → `STATUSES_EXCLUDED_FROM_REVENUE`, etc.
- Campos de output: `facturado_real_cop` → `revenue_real_cop`, `pedidos_retrasados` → `delayed_orders`, `silencios` → `gaps`, etc.

**Por qué:** Rafael dijo textual que **odia ver nombres de archivos en español**; pasarlos a inglés le dio "paz visual". El código en inglés es estándar de industria; los comentarios en español le sirven para leer/aprender/mantener. PRD y RULES se actualizaron para reflejar la convención.

**Decisión no trivial:** los valores de datos del dominio que son español natural (ej. `weekday: "viernes"`) se dejan en español porque son data, no código.

### 2026-05-21 — Modo de colaboración: yo escribo el código difícil + explico, Rafael aprende leyendo

**Qué:** para código que requiere skills que Rafael no domina (SQL de agregación), el agente IA escribe el código completo y lo explica en español llano, línea por línea. Rafael aprende por lectura comentada + preguntas, no peleando con sintaxis.

**Por qué:** se intentó primero el enfoque "mezcla" (Rafael escribe las tools, yo reviso). Rafael tiene 3 años de React Native y buen criterio de producto/arquitectura, PERO no sabe SQL analítico — las queries complejas de Pizza Demo fueron IA-generadas, no escritas por él. Después de 3 intentos con bugs (paréntesis, typos, condición copiada), dijo *"no sé leer eso, ni siquiera sé qué estoy haciendo"*. Pedirle producir lo que todavía no puede leer = frustración, no aprendizaje. "Primero leer y entender, después escribir."

**Cómo aplica:** para skills que SÍ domina (producto, arquitectura, decisiones de diseño) se colabora como pares. Para skills-gap, modo enseñanza sin presión.

### 2026-05-21 — Regla: verificar docs oficiales de librerías antes de usarlas

**Qué:** [RULES.md §7](RULES.md) ahora exige ir a la documentación oficial más reciente de cualquier librería ANTES de escribir código que la use. Procedimiento de 5 pasos + lista de qué NO cuenta como verificación (memoria, Stack Overflow viejo, copiar tutoriales).

**Por qué:** Rafael lo pidió. El cutoff de conocimiento del agente queda atrás del mundo real; MCP SDK, Zod y postgres evolucionan rápido. Código basado en memoria desactualizada compila pero falla en runtime. Se validó en la práctica: una WebFetch resumió mal el nombre del paquete del SDK como `@modelcontextprotocol/server`; verificando con WebSearch + el package.json instalado se confirmó que es `@modelcontextprotocol/sdk`.

### 2026-05-21 — Tools v1: 2 composables con output JSON (no markdown)

**Qué:** v1 tiene 2 tools + 1 resource:
- `query_orders` — consulta/agrega pedidos con filtros + agrupación + detalle opcional. Cubre todas las preguntas cuantitativas sobre `orders`.
- `detect_activity_gaps` — detecta ventanas de horario pico sin pedidos (señal de abandono operativo).
- Resource `pizza-demo://schema` — auto-doc del schema relevante.

**Por qué (decisiones del audit del PRD):**
- **Output JSON estructurado, NO markdown pre-formateado.** Markdown raw destruye composabilidad — el LLM no puede filtrar/comparar. JSON deja que el LLM presente como quiera.
- **2 tools composables, no 5 chicas ni 2 gordas.** `query_orders` con `filters` + `groupBy` cubre N preguntas componiendo parámetros. `detect_activity_gaps` se separa porque su lógica es estructuralmente distinta.
- **Definiciones explícitas de revenue:** `revenue_real` = solo `delivered` (plata que entró); `revenue_gross` = todos menos cancelled/rejected. Resuelve ambigüedad de "facturado".
- **Token budget:** default agregado; `detail: true` con cap duro de 100 filas / ~30KB.
- **Contrato de error:** las tools NUNCA throwean al stdio; devuelven `{ isError: true, content }`.

### 2026-05-21 — `detect_activity_gaps`: lógica en TypeScript, no SQL con generate_series

**Qué:** la tool trae los timestamps de pedidos con un SELECT simple y calcula los huecos en TypeScript (iteración día-por-día, patrón cursor buscando gaps >= ventana).

**Por qué:** el PRD original planteaba `generate_series` + LEFT JOIN en SQL. Para una pizzería (cientos de pedidos) traer timestamps y procesarlos en TS es igual de rápido y MUCHO más legible/mantenible. Decisión consciente de legibilidad sobre "puro SQL". Además Rafael entiende mejor JS que SQL — el código le sirve para aprender.

### 2026-05-21 — Acceso a DB: rol Postgres read-only dedicado, no service_role

**Qué:** el MCP se conecta con un rol `mcp_auditor` que tiene solo `GRANT SELECT` sobre las tablas operativas, `REVOKE ALL` sobre `profiles`. Connection string en `.env.local` (gitignored). SQL del setup en `.env.example` y README.

**Por qué:** defense-in-depth. Si el agente alucina un DELETE/UPDATE, la DB lo rechaza por permisos. El MCP es read-only por diseño Y por permisos. Nunca usar la service_role key (bypass innecesario).

### 2026-05-21 — Cross-platform (Mac/Linux/Windows), transport stdio

**Qué:** el MCP corre en los 3 SOs. Transport stdio (local, lanzado por Claude Code como subprocess). [RULES.md §9](RULES.md) + [PRD.md §9](PRD.md) documentan paths de config de Claude por plataforma.

**Por qué:** Rafael pidió que no fuera Mac-only. Bun + TS + las deps son cross-platform nativas. stdio es estándar POSIX/Win32. HTTP/SSE remoto queda como roadmap v1.1 (acceso desde celular).

### 2026-05-21 — Decisión: específico a Pizza Demo, NO agnóstico

**Qué:** las SQL hardcodean tablas/columnas de Pizza Demo. NO se construye un sistema de adapters/config para múltiples clientes.

**Por qué:** solo hay 1 cliente. Abstraer sin un 2do caso real es adivinanza (YAGNI). Higiene mínima desde día 1 (SQL parametrizada, nombres de tabla en `constants.ts`, SQL en archivos aparte) hace que migrar a config externa cueste ~2h cuando aparezca el cliente #2. Multi-sede también diferido (ver PRD §11): cuando Pizza Demo agregue `branch_id`, se suma un param `sede?` (~30 min).

### 2026-05-21 — Estructura del repo: PRD/RULES/ENGRAM en docs/, código en src/

**Qué:** `docs/` tiene PRD.md, RULES.md, ENGRAM.md (de ESTE proyecto). El código en `src/` con `tools/`, `resources/`, `lib/`, `constants.ts`, `db.ts`, `index.ts`. Estructura NO usa `src/features/[name]/` (eso es de Next.js, over-engineering para 2 tools).

**Por qué:** Rafael pidió mover el PRD del MCP a `docs/` y borrar los docs de Pizza Demo (PRD/EMGRAM del cliente) que estaban ahí de referencia. El schema relevante ya quedó extraído dentro del PRD del MCP (§5.3 + §7.4), así que no se necesitan los docs del cliente en este repo.

---

## Estado actual de implementación

**Hecho (v1 funcional end-to-end):**
- Init del repo: `package.json`, `tsconfig.json` (strict), `.gitignore`, `.env.example`. Deps instaladas.
- Infra: `src/constants.ts`, `src/db.ts`, `src/lib/errors.ts`, `src/lib/ranges.ts` (incl. `toColombiaISO`).
- Tool `query_orders` ([src/tools/query-orders.ts](../src/tools/query-orders.ts)) — completa, tsc limpio.
- Tool `detect_activity_gaps` ([src/tools/detect-activity-gaps.ts](../src/tools/detect-activity-gaps.ts)) — completa, tsc limpio.
- Resource `pizza-demo://schema` ([src/resources/schema.ts](../src/resources/schema.ts)).
- `src/index.ts` — server MCP registrando 2 tools + resource, transport stdio.
- `README.md` + [WINDOWS_SETUP.md](WINDOWS_SETUP.md) cross-platform.
- Setup en Supabase hecho: rol `mcp_auditor` read-only creado, `BYPASSRLS` aplicado, `DATABASE_URL` en `.env.local`.
- **Verificado contra la DB real:** `check-db` conecta OK; `query_orders` devolvió un pedido real (revenue_gross 24000, hora correcta en `-05:00`); MCP Inspector lista las 2 tools + resource.
- Repo en GitHub: `rafaelSantos43/auditRepo`.

**Pendiente:**
- Correr en la máquina Windows siguiendo [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

---

## Constraints que NO se pueden olvidar

- El MCP es **read-only**. Cualquier propuesta de mutación se rechaza.
- Outputs en **JSON estructurado**, nunca markdown pre-formateado.
- `console.error` (stderr) para logs — `console.log` (stdout) rompe el protocolo MCP.
- Las tools nunca throwean al stdio — `{ isError: true }`.
- Código en inglés, comentarios en español.
- Verificar docs oficiales antes de usar APIs de librerías.
- Moneda COP en `*_cents` pero SIN centavos reales (1000_cents = $1.000 COP).
- Fechas en UTC en la DB; convertir a America/Bogota (UTC-5 fijo) para outputs.

---

## Preguntas abiertas

- [ ] Connection string real del rol `mcp_auditor` (lo crea Rafael en Supabase).
- [ ] ¿Las `.describe()` de las tools quedan en español o inglés? Hoy español (Rafael interactúa en español). Reevaluar si se comparte el MCP.
