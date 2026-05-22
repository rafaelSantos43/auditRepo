# RULES — Protocolo de desarrollo del MCP server

> **Lectura obligatoria antes de escribir código.** Estas reglas son innegociables y definen cómo se diseña, implementa y mantiene el Pizza Demo Auditor (servidor MCP).
>
> **Objetivos del protocolo:**
> 1. Seguridad — el MCP es read-only y no expone superficies de ataque.
> 2. Eficiencia de tokens — outputs estructurados y acotados, no inflados.
> 3. Control humano — Rafael aprueba decisiones arquitectónicas, no cada línea.
> 4. Alineación con el [PRD](PRD.md) — RULES define el *cómo*, PRD define el *qué*.

---

## 1. Principios rectores

1. **Esquemas y contratos primero, lógica después.** Antes de implementar una tool, defino: `name`, `description`, `inputSchema` (Zod), `outputSchema` (estructura JSON). La lógica viene cuando el contrato está claro.
2. **Tools atómicas en responsabilidad, no en superficie.** Una tool tiene UN propósito (Single Responsibility) pero puede aceptar parámetros que la hacen flexible. Ejemplo: `query_orders` con `filtros` y `groupBy` es atómica (consulta `orders`) y composable (cubre N preguntas). NO es una "navaja suiza" — sigue teniendo un dominio claro.
3. **Outputs estructurados (JSON), no markdown pre-formateado.** El LLM compone, filtra y reformatea según necesidad. Markdown raw destruye composabilidad — alineado con [PRD §5.2](PRD.md).
4. **Stateless por default.** El server NO guarda estado de conversación. Cada invocación es autocontenida.
5. **Acceso a env vars críticos exige justificación documentada** (`DATABASE_URL` es el único permitido en v1). Cualquier nuevo secret requiere entrada en este RULES + en `.env.example`.
6. **El MCP NO escribe datos.** Read-only por diseño Y por permisos de DB (rol `mcp_auditor` con `GRANT SELECT`). Cualquier propuesta de mutación se rechaza por defecto.

---

## 2. Arquitectura y layering

### Flujo del request

```
Claude Code / Inspector              (cliente MCP)
        │
        │  JSON-RPC sobre stdio
        ▼
src/index.ts                         (registro + dispatch)
        │
        │  llamada a handler con args
        ▼
src/tools/<tool>.ts                  (handler de la tool)
        │
        │  Zod parse de args entrantes
        ▼
src/lib/ranges.ts, errors.ts         (helpers puros)
        │
        │  query parametrizada
        ▼
src/db.ts                            (cliente postgres + TLS)
        │
        ▼
Supabase (Pizza Demo)                (rol mcp_auditor, SELECT only)
```

**Reglas de capa:**
- Una capa NO puede saltar otras. Un handler de tool NO llama directo a `postgres`; pasa por `src/db.ts`.
- `src/db.ts` NO conoce el dominio (no sabe qué es un "pedido"). Solo abre conexión y ejecuta SQL parametrizado.
- `src/lib/` son helpers puros sin side effects (parseo de rangos, manejo de errores).
- `src/index.ts` NO contiene lógica de negocio. Solo registra tools/resources y delega.

### Estructura de archivos (alineada con [PRD §7.2](PRD.md))

```
src/
├── index.ts              # Entry: server MCP + registro tools/resources
├── db.ts                 # Cliente postgres + helper query<T>
├── constants.ts          # T_ORDERS, PEAK_HOURS, etc.
├── tools/
│   └── <tool-name>.ts    # 1 tool = 1 archivo. Exporta { schema, handler }
├── resources/
│   └── <name>.ts         # 1 resource = 1 archivo
└── lib/
    ├── ranges.ts         # Parseo preset/desde/hasta en America/Bogota
    └── errors.ts         # toErrorResult(err) → { isError: true, content }
```

**Por qué NO `src/features/<feature>/`:** esa convención viene de Next.js (sistemas grandes con N módulos). Para un MCP de 2 tools, agrega ceremonia sin valor. Si el server crece a 8+ tools, se reconsidera.

---

## 3. Diseño de tools

### Naming
- `snake_case` con verbo de acción + objeto. Ejemplos: `query_orders`, `detect_activity_gaps`.
- En **inglés** (ver política de idioma en §8). El dominio en español va en `.describe()` y mensajes de error.
- Suficientemente descriptivo para que un agente sin haber leído este RULES infiera cuándo usarla.

### `description` (campo crítico — prompt engineering del MCP)

El campo `description` de cada tool es lo que el LLM lee para decidir si invocarla. Es **prompt engineering**, no documentación de dev.

**Patrón obligatorio:**
1. Una frase que explica **cuándo** usar la tool (no solo qué hace).
2. 1-3 ejemplos de preguntas del usuario que la dispararían.
3. Mención explícita de qué NO hace (para evitar uso incorrecto).

Ejemplo concreto:
> Consulta y agrega pedidos de Pizza Demo en un rango de tiempo. Úsala para responder preguntas cuantitativas: cuántos pedidos hubo, distribución por estado/método de pago/tipo de entrega, ticket promedio, total facturado, retrasos. NO la uses para detectar huecos de actividad — para eso existe `detect_activity_gaps`.

### Composabilidad
- Una tool debe ser componible con otras invocaciones suyas o de otras tools.
- Si dos tools devuelven shapes parecidos pero una agrega una dimensión más, **es señal de que falta un parámetro** en la primera (no de que falta una tool nueva).

### Inputs
- Schema definido con Zod, exportado a JSON Schema para el MCP SDK.
- Parámetros opcionales con defaults sensatos. Si un default tiene impacto en el output, va documentado en la `description`.
- **NO** discriminated unions complicadas en inputs — el LLM las maneja mal. Preferir parámetros opcionales mutuamente excluyentes y validarlos en el handler (ej: `preset?` XOR `desde?+hasta?`).

### Outputs
- JSON estructurado con shape tipado y estable.
- Tamaño acotado: agregaciones por default, raw rows solo con flag explícito y cap duro (ver [PRD §5.5](PRD.md)).
- Si la output incluye fechas, siempre en ISO 8601 con timezone explícito.

---

## 4. Diseño de resources

### Cuándo usar resource vs tool

| Situación | Primitive |
|---|---|
| El cliente necesita **leer** un dato relativamente estático (schema, settings, docs) | Resource |
| El cliente necesita **invocar una acción** con parámetros (query, filtro, cálculo) | Tool |
| El dato cambia frecuentemente pero el cliente lo consulta seguido | Tool (devolver fresh) |
| El cliente necesita "saber qué hay" antes de actuar | Resource (auto-doc) |

### Naming de URIs
- Esquema jerárquico: `<dominio>://<sección>/<recurso>`.
- Ejemplo válido: `pizza-demo://schema`, `pizza-demo://settings/zonas` (futuro).
- Ejemplo inválido: `schema`, `data://stuff` (sin contexto).

---

## 5. Validación y manejo de errores

### Validación en bordes (Zod obligatorio)
- Todo argumento de tool pasa por `schema.safeParse()` antes de cualquier query.
- Si la validación falla, devolver `isError: true` con el mensaje formateado de Zod.
- NO usar `parse()` (throwea) — usar `safeParse()` (devuelve resultado tipado).

### Contrato de errores (alineado con [PRD §5.4](PRD.md))

Las tools **NUNCA throwean** al stdio. Devuelven:

```ts
{
  content: [{ type: "text", text: "Mensaje legible del error" }],
  isError: true
}
```

Casos cubiertos:
- Input inválido (Zod) → mensaje describe el campo y la regla violada.
- SQL falla (timeout, columna inexistente) → mensaje incluye el error de Postgres.
- Conexión a Supabase caída → mensaje explícito + sugerencia ("verificá DATABASE_URL").
- Excepción no manejada → catch global en el handler, log a stderr, mensaje genérico al cliente.

**Anti-patrón prohibido:** dejar que una excepción mate el process stdio. Eso rompe la conexión MCP y obliga a reiniciar Claude Code.

---

## 6. Token budget y eficiencia

- **Default = agregado.** Counts, sums, breakdowns. Pocos bytes, mucha señal.
- **Detalle = opt-in con cap.** Parámetro `detalle: true` activa raw rows, máximo 100 por tool, 30KB por respuesta.
- **Si el LLM necesita más, paginar:** parámetro `pagina?: number` y `total_disponible` en el output. NO devolver "los siguientes 100 cuando me lo pidas" sin paginación explícita.
- **Nunca devolver datos personales completos.** `customers.phone` se ofusca si aparece en outputs (`+57XXX...XX95`). El MCP es para auditoría agregada, no para identificar individuos.

---

## 7. Stack permitido

| Categoría | Permitido | Prohibido |
|---|---|---|
| SDK MCP | `@modelcontextprotocol/sdk` (oficial) | Cualquier SDK no-oficial o reimplementación manual del protocolo |
| Runtime | Bun ≥ 1.0 | Node directo (sin transpile) — Bun corre TS nativo y unifica DX |
| Lenguaje | TypeScript `strict: true` | JavaScript puro, TypeScript laxo |
| Validación | Zod | `joi`, `yup`, validators caseros |
| DB driver | `postgres` (porsager/postgres) | `pg` directo (menos seguro contra injection), `prisma`/`drizzle` (overkill para read-only) |
| HTTP client | `fetch` nativo | `axios`, `node-fetch` |
| Logging | `console.error` a stderr | Cualquier librería de logger |

**Reglas de `any`:**
- Cero `any` implícitos (`strict: true` lo fuerza).
- `any` explícito permitido SOLO con comentario `// any: <razón concreta>`. Si la razón es "no sé el tipo", NO está justificado.

### Consulta obligatoria de documentación oficial antes de usar

**Antes de escribir código que use cualquier librería de §7, hay que ir a la documentación oficial más reciente.** Sin excepciones.

**Por qué es no-negociable:**
- El cutoff de conocimiento del agente IA (y de cualquier dev humano) **siempre queda atrás del mundo real**. APIs cambian, métodos se deprecan, breaking changes ocurren entre minor versions.
- MCP SDK, Zod, y `postgres` están en evolución activa (Zod v4 ya introdujo breaking changes vs v3; el SDK de MCP cambió `Server` por `McpServer` en versiones recientes).
- Código basado en memoria desactualizada **compila pero falla en runtime** o usa métodos ya removidos — los errores son confusos y caros de debugear.

**Procedimiento obligatorio antes de cada librería nueva o método no usado antes:**

1. **Ir al sitio oficial / repo de la librería.** Fuentes válidas:
   - `@modelcontextprotocol/sdk` → https://modelcontextprotocol.io/docs + https://github.com/modelcontextprotocol/typescript-sdk
   - `zod` → https://zod.dev + https://github.com/colinhacks/zod
   - `postgres` → https://github.com/porsager/postgres (README)
2. **Verificar la versión instalada** en `package.json` y que coincida con la doc que estoy leyendo.
3. **Confirmar que la API que voy a usar NO está marcada como `@deprecated`** ni en notas de "removed in vX".
4. **Si encuentro discrepancia** entre lo que pensaba usar y lo que la doc dice → me adapto a la doc, no al revés.
5. **Documentar la verificación** en el commit message o en un comment al lado del uso si la API es no-obvia: `// verificado contra @modelcontextprotocol/sdk v1.x docs, 2026-MM-DD`.

**Lo que NO cuenta como "verificación":**
- ❌ Asumir basándose en memoria ("creo que era así").
- ❌ Buscar en Stack Overflow respuestas viejas (suelen estar desactualizadas).
- ❌ Copiar de tutoriales sin verificar la versión que mostraban.
- ❌ Leer solo el TypeScript declaration (`.d.ts`) — los tipos pueden estar correctos pero el método deprecated en docs.

**Cuándo se puede saltar este paso:**
- Métodos de la stdlib de TypeScript / Bun / Node nativos (`Map`, `Array.prototype.filter`, `path.join`) — son estables.
- Re-uso de patrón ya verificado en el mismo repo en este mismo PR.

Si el agente IA no puede acceder a internet en la sesión → debe **pausar y pedirle al humano que verifique** la API que está por usar, en lugar de avanzar a ciegas.

---

## 8. Convenciones de naming e idioma

### Idioma (regla dura)

**Comentarios y documentación de código → ESPAÑOL. Todo lo demás → INGLÉS.**

| Qué | Idioma | Ejemplo |
|---|---|---|
| Comentarios (`//`, `/* */`, JSDoc) | **Español** | `// Recortar al rango efectivamente pedido` |
| Nombres de archivos | Inglés | `query-orders.ts`, `detect-activity-gaps.ts` |
| Identificadores (funciones, variables, tipos) | Inglés | `handleQueryOrders`, `buildWhereClause`, `windowMs` |
| Tool names (protocolo MCP) | Inglés | `query_orders`, `detect_activity_gaps` |
| Campos de input/output de tools | Inglés | `from`, `to`, `groupBy`, `revenue_real_cop`, `gaps` |
| Resource URIs | Inglés | `pizza-demo://schema` |
| Strings de `.describe()` (las lee el agente) | Inglés o español, consistente — hoy **español** porque Rafael interactúa en español | `"Consulta pedidos en un rango..."` |
| Mensajes de error (los lee Rafael) | **Español** | `"El rango es inválido"` |

**Por qué:** el código en inglés es estándar de la industria y "paz visual" para Rafael; los comentarios en español le sirven para aprender/mantener. Los valores de datos del dominio que sean español natural (ej. `weekday: "viernes"`) pueden quedar en español porque son data, no código.

### Convenciones de forma

| Categoría | Convención | Ejemplo |
|---|---|---|
| Tools (protocolo MCP) | `snake_case` con verbo | `query_orders`, `detect_activity_gaps` |
| Resources (URIs) | `dominio://seccion/recurso` | `pizza-demo://schema` |
| Archivos `.ts` | `kebab-case` | `query-orders.ts`, `detect-activity-gaps.ts` |
| Constantes | `UPPER_SNAKE_CASE` | `T_ORDERS`, `PEAK_HOURS` |
| Variables / funciones TS | `camelCase` | `parseRange`, `buildWhereClause` |
| Tipos / interfaces TS | `PascalCase` | `ResolvedRange`, `Gap` |

---

## 9. Cross-platform

El MCP corre en Mac, Linux y Windows (ver [PRD §9](PRD.md)). Reglas:

- **Path handling:** usar `path.join()` de Node/Bun. Nunca concatenar strings con `/` ni `\`.
- **Line endings:** LF en repo (`.gitattributes` con `* text=auto eol=lf` si se necesita).
- **Env vars:** acceder vía `process.env`, idéntico en los 3 SOs.
- **NO scripts shell** en el código del MCP. Si hace falta automatización, scripts portables en Bun (`.ts`).
- **README documenta los 3 SOs** con paths de config de Claude Code por plataforma (ver [PRD §9.1](PRD.md)).

---

## 10. Interacción humano-IA (cuándo parar a preguntar)

### Tareas donde el agente IA ejecuta directo
- Implementar una tool ya definida en el PRD (schema + descripción ya aprobada).
- Refactorizar mientras no cambia la API pública (signatures de tools/resources).
- Agregar tests, mejorar mensajes de error, escribir documentación.
- Aplicar las RULES (formatear, organizar, ajustar naming).

### Tareas que exigen aprobación previa
- **Agregar/quitar una tool o resource** del scope v1.
- **Cambiar el shape de input o output** de una tool existente.
- **Agregar una dependencia** fuera de §7.
- **Acceder a nuevos secrets / env vars.**
- **Cambiar la decisión "no agnóstico"** (ver [PRD §7.3](PRD.md)).
- **Cualquier operación destructiva** (borrar archivos, dropear constraints, modificar `.git`).

### Patrón de comunicación
- Si el agente no está seguro, **propone con justificación y pregunta**, no asume.
- Si el agente está seguro de una mejora menor (typo, formato, comment), la hace y la menciona en el resumen final.

---

## 11. Checklist de pre-entrega (verificar ANTES de marcar una tool como done)

Cada tool nueva debe pasar TODOS los items:

- [ ] `inputSchema` Zod completo con `.describe()` en cada campo (esto se inyecta al JSON Schema visible al LLM).
- [ ] `description` de la tool explica **cuándo** invocarla, con 1-3 ejemplos de preguntas que la disparan.
- [ ] Argumentos entrantes parseados con `schema.safeParse()` antes de cualquier query.
- [ ] Todos los errores potenciales (input, SQL, conexión, excepción) envueltos en `{ isError: true }`.
- [ ] Output JSON estructurado con shape tipado, NO markdown pre-formateado.
- [ ] Tamaño de output acotado (cap explícito si hay `detalle: true`).
- [ ] SQL parametrizada con `postgres` template literals (cero string concat).
- [ ] Nombres de tabla referenciados desde `src/constants.ts`, no inline.
- [ ] **APIs de librerías externas verificadas contra docs oficiales recientes** (ver §7 — sin deprecated ni APIs imaginarias).
- [ ] `bunx tsc --noEmit` exit 0.
- [ ] Probada manualmente con MCP Inspector: input válido, input inválido (debe devolver error legible), DB con/sin datos.
- [ ] La tool aparece y se invoca correctamente desde Claude Code en al menos un SO (idealmente los 3).

---

## 12. Testing manual obligatorio (MCP Inspector)

Antes de conectar el server a Claude Code, validar con MCP Inspector:

```bash
npx @modelcontextprotocol/inspector bun run src/index.ts
```

**Casos a verificar manualmente por cada tool:**
1. Lista de tools y resources aparece correctamente.
2. Invocación con input válido → output JSON parseable.
3. Invocación con input inválido (campo faltante, tipo incorrecto, rango imposible) → `isError: true` con mensaje claro.
4. Resource `pizza-demo://schema` se lee y devuelve el JSON esperado.

**Después de eso**, recién conectar a Claude Code editando el config del SO correspondiente.

---

## 13. Anti-patrones explícitamente prohibidos

- ❌ Markdown pre-formateado como output de tools (rompe composabilidad).
- ❌ Una sola tool gigante con switch case interno por tipo de query (= mala SRP).
- ❌ Inyección SQL via string concat (= bug + vector de ataque).
- ❌ `console.log` (escribe a stdout, rompe protocolo MCP — usar `console.error`).
- ❌ Throws sin captura que matan el process stdio.
- ❌ Service role key como `DATABASE_URL` (= bypass de seguridad innecesario).
- ❌ Logs que imprimen `DATABASE_URL` u otros secrets.
- ❌ `any` sin comentario justificando.
- ❌ Dependencias fuera de §7 sin entrada en RULES + PRD.
- ❌ Asumir paths POSIX en código (rompe Windows).
- ❌ Tools que mutan datos en Supabase (read-only es ley).

---

## 14. Cómo se actualiza este documento

- Cambios menores (typos, ejemplos, clarificaciones): commit directo con mensaje `docs: clarify <tema>`.
- Cambios estructurales (nueva sección, nueva regla, cambio de decisión): se propone, se justifica, se aprueba ANTES del commit.
- Cuando el PRD cambia una decisión que RULES referencia, actualizar ambos en el mismo commit.

**Última actualización:** 2026-05-21 — versión inicial post-audit, alineada con PRD v1.0.
