// Tool MCP: query_orders
// ---
// Consulta y agrega pedidos de Pizza Demo en un rango de tiempo.
// Soporta filtros (status, payment_method, delivery_type, delayed),
// agrupación por dimensión, y opcionalmente devuelve raw rows (con tope).
//
// Contrato completo en PRD §5.2.
// Reglas que aplican: RULES §3 (diseño de tools), §5 (errores), §6 (token budget).

import { z } from "zod";

import { sql } from "../db.ts";
import {
  DELIVERY_TYPES,
  MAX_DETAIL_ROWS,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  STATUSES_EXCLUDED_FROM_REVENUE,
  STATUS_DELIVERED,
  T_ORDERS,
  TZ,
} from "../constants.ts";
import { toErrorResult, toSuccessResult, type McpToolResult } from "../lib/errors.ts";
import { parseRange } from "../lib/ranges.ts";

// Texto que el agente lee para decidir cuándo invocar la tool (RULES §3).
export const queryOrdersDescription =
  "Consulta y agrega pedidos de Pizza Demo en un rango de tiempo. Úsala para " +
  "responder preguntas cuantitativas: cuántos pedidos hubo, distribución por " +
  "estado / método de pago / tipo de entrega, ticket promedio, total facturado, " +
  "pedidos retrasados. Aplica filtros opcionales y agrupa por una dimensión. " +
  "NO la uses para detectar huecos de actividad — para eso existe detect_activity_gaps.";

// =====================================================================
// Schema de input (ZodRawShape — el SDK lo envuelve internamente)
// =====================================================================

const groupByValues = [
  "status",
  "payment_method",
  "delivery_type",
  "weekday",
  "hour_of_day",
  "none",
] as const;

export const queryOrdersInputSchema = {
  preset: z
    .enum(["hoy", "ayer", "semana", "mes"])
    .optional()
    .describe(
      "Rango pre-definido. Mutuamente excluyente con from/to. Default: ninguno (debes pasar preset O from+to).",
    ),
  from: z
    .string()
    .optional()
    .describe("Inicio del rango en ISO 8601 (ej: 2026-05-15T00:00:00Z). Requiere `to`."),
  to: z
    .string()
    .optional()
    .describe("Fin del rango en ISO 8601. Requiere `from`."),

  filters: z
    .object({
      status: z.array(z.enum(ORDER_STATUSES)).optional(),
      payment_method: z.array(z.enum(PAYMENT_METHODS)).optional(),
      delivery_type: z.array(z.enum(DELIVERY_TYPES)).optional(),
      delayed: z.boolean().optional(),
    })
    .optional()
    .describe("Filtros opcionales combinados con AND."),

  groupBy: z
    .enum(groupByValues)
    .optional()
    .describe(
      "Agrupar el resultado por esta dimensión. `none` (default) no agrupa. Usá `weekday` u `hour_of_day` para detectar patrones temporales.",
    ),

  detail: z
    .boolean()
    .optional()
    .describe(
      `Si true, incluye raw rows en el output (máximo ${MAX_DETAIL_ROWS} filas). Default false (solo agregados).`,
    ),
};

// Tipo del input ya validado.
type Input = {
  preset?: "hoy" | "ayer" | "semana" | "mes";
  from?: string;
  to?: string;
  filters?: {
    status?: readonly (typeof ORDER_STATUSES)[number][];
    payment_method?: readonly (typeof PAYMENT_METHODS)[number][];
    delivery_type?: readonly (typeof DELIVERY_TYPES)[number][];
    delayed?: boolean;
  };
  groupBy?: (typeof groupByValues)[number];
  detail?: boolean;
};

// =====================================================================
// Shape del output (estable — los consumidores lo dependen)
// =====================================================================

type Output = {
  range: { from: string; to: string; timezone: string; label: string };
  applied_filters: NonNullable<Input["filters"]>;
  summary: {
    total_orders: number;
    revenue_real_cop: number;
    revenue_gross_cop: number;
    avg_ticket_cop: number;
    delayed_orders: number;
    delayed_pct: number;
  };
  groups?: Array<{
    key: string;
    count: number;
    revenue_gross_cop: number;
  }>;
  detail?: Array<{
    id: string;
    created_at: string;
    status: string;
    payment_method: string;
    delivery_type: string | null;
    total_cents: number;
    delayed: boolean;
  }>;
  total_available?: number; // solo si detail truncó (filas reales > tope)
};

// =====================================================================
// Handler — esto es lo que el SDK invoca cuando el LLM llama la tool
// =====================================================================

export async function handleQueryOrders(input: Input): Promise<McpToolResult> {
  try {
    // 1. Resolver rango (tira Error si es inválido).
    const range = parseRange({
      preset: input.preset,
      from: input.from,
      to: input.to,
    });

    const filters = input.filters ?? {};
    const groupBy = input.groupBy ?? "none";
    const wantDetail = input.detail === true;

    // ===================================================================
    // 1. Resumen — UNA query con todos los agregados del rango.
    // ===================================================================
    const where = buildWhereClause(range.from, range.to, filters);

    const [row] = await sql<
      {
        total_orders: number;
        revenue_real_cents: string;
        revenue_gross_cents: string;
        delivered_count: number;
        delayed_count: number;
      }[]
    >`
      SELECT
        COUNT(*)::int AS total_orders,
        COALESCE(SUM(CASE WHEN status = ${STATUS_DELIVERED} THEN total_cents ELSE 0 END), 0)::bigint AS revenue_real_cents,
        COALESCE(SUM(CASE WHEN status NOT IN ${sql([...STATUSES_EXCLUDED_FROM_REVENUE])} THEN total_cents ELSE 0 END), 0)::bigint AS revenue_gross_cents,
        COUNT(*) FILTER (WHERE status = ${STATUS_DELIVERED})::int AS delivered_count,
        COUNT(*) FILTER (WHERE delayed = true)::int AS delayed_count
      FROM ${sql(T_ORDERS)}
      ${where}
    `;

    if (!row) {
      throw new Error("La query de resumen no devolvió filas (inesperado).");
    }

    const revenueRealCop = Number(row.revenue_real_cents);
    const revenueGrossCop = Number(row.revenue_gross_cents);

    const summary = {
      total_orders: row.total_orders,
      revenue_real_cop: revenueRealCop,
      revenue_gross_cop: revenueGrossCop,
      avg_ticket_cop:
        row.delivered_count > 0
          ? Math.round(revenueRealCop / row.delivered_count)
          : 0,
      delayed_orders: row.delayed_count,
      delayed_pct:
        row.total_orders > 0
          ? Math.round((row.delayed_count / row.total_orders) * 1000) / 10
          : 0,
    };

    // ===================================================================
    // 2. Grupos — breakdown por dimensión (solo si groupBy != "none").
    // ===================================================================
    let groups: Output["groups"] | undefined = undefined;
    if (groupBy !== "none") {
      const dimensionSql = mapDimensionToSql(groupBy);
      const rows = await sql<
        { key: string; count: number; revenue_gross_cents: string }[]
      >`
        SELECT
          ${dimensionSql} AS key,
          COUNT(*)::int AS count,
          COALESCE(SUM(CASE WHEN status NOT IN ${sql([...STATUSES_EXCLUDED_FROM_REVENUE])} THEN total_cents ELSE 0 END), 0)::bigint AS revenue_gross_cents
        FROM ${sql(T_ORDERS)}
        ${where}
        GROUP BY 1
        ORDER BY count DESC
      `;

      groups = rows.map((r) => ({
        key: r.key,
        count: r.count,
        revenue_gross_cop: Number(r.revenue_gross_cents),
      }));
    }

    // ===================================================================
    // 3. Detalle — raw rows con tope duro (solo si detail === true).
    // ===================================================================
    let detail: Output["detail"] | undefined = undefined;
    let total_available: number | undefined = undefined;
    if (wantDetail) {
      const rows = await sql<
        {
          id: string;
          created_at: Date;
          status: string;
          payment_method: string;
          delivery_type: string | null;
          total_cents: number;
          delayed: boolean;
        }[]
      >`
        SELECT id, created_at, status, payment_method, delivery_type, total_cents, delayed
        FROM ${sql(T_ORDERS)}
        ${where}
        ORDER BY created_at DESC
        LIMIT ${MAX_DETAIL_ROWS}
      `;

      detail = rows.map((r) => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        status: r.status,
        payment_method: r.payment_method,
        delivery_type: r.delivery_type,
        total_cents: r.total_cents,
        delayed: r.delayed,
      }));

      // Si llenamos el tope, puede haber más filas — contamos el total real
      // para avisarle al LLM que truncamos.
      if (detail.length === MAX_DETAIL_ROWS) {
        const [count] = await sql<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM ${sql(T_ORDERS)} ${where}
        `;
        total_available = count?.total ?? detail.length;
      }
    }

    // ===================================================================
    // Armar el output final
    // ===================================================================
    const output: Output = {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timezone: TZ,
        label: range.label,
      },
      applied_filters: filters,
      summary,
      ...(groups !== undefined && { groups }),
      ...(detail !== undefined && { detail }),
      ...(total_available !== undefined && { total_available }),
    };

    return toSuccessResult(output);
  } catch (err) {
    return toErrorResult(err);
  }
}

// =====================================================================
// Helpers para componer SQL de forma segura.
// =====================================================================

/**
 * Devuelve un fragmento WHERE seguro listo para interpolar:
 *
 *   const where = buildWhereClause(range.from, range.to, filters);
 *   await sql`SELECT ... FROM orders ${where}`;
 *
 * Los filtros se aplican con AND. Si un filtro array está vacío o undefined,
 * NO se agrega la cláusula correspondiente.
 */
function buildWhereClause(
  from: Date,
  to: Date,
  filters: NonNullable<Input["filters"]>,
) {
  const conds: ReturnType<typeof sql>[] = [];

  conds.push(sql`created_at >= ${from}`);
  conds.push(sql`created_at <= ${to}`);

  if (filters.status && filters.status.length > 0) {
    conds.push(sql`status IN ${sql(filters.status)}`);
  }
  if (filters.payment_method && filters.payment_method.length > 0) {
    conds.push(sql`payment_method IN ${sql(filters.payment_method)}`);
  }
  if (filters.delivery_type && filters.delivery_type.length > 0) {
    conds.push(sql`delivery_type IN ${sql(filters.delivery_type)}`);
  }
  if (filters.delayed !== undefined) {
    conds.push(sql`delayed = ${filters.delayed}`);
  }

  // Combinar con AND. postgres-js no tiene un helper directo,
  // así que armamos el fragmento manualmente.
  let where = sql`WHERE ${conds[0]!}`;
  for (let i = 1; i < conds.length; i++) {
    where = sql`${where} AND ${conds[i]!}`;
  }
  return where;
}

/**
 * Convierte la dimensión de `groupBy` a la expresión SQL del GROUP BY key.
 * Para weekday / hour_of_day se aplica la conversión a TZ Colombia.
 */
function mapDimensionToSql(dim: (typeof groupByValues)[number]) {
  switch (dim) {
    case "status":
      return sql`status::text`;
    case "payment_method":
      return sql`payment_method::text`;
    case "delivery_type":
      return sql`COALESCE(delivery_type, 'unknown')::text`;
    case "weekday":
      // EXTRACT(DOW): 0=domingo, 6=sábado. Lo devolvemos como string para uniformidad.
      return sql`EXTRACT(DOW FROM created_at AT TIME ZONE ${TZ})::text`;
    case "hour_of_day":
      return sql`EXTRACT(HOUR FROM created_at AT TIME ZONE ${TZ})::text`;
    case "none":
      // No debería llegar acá — el caller chequea antes.
      throw new Error("mapDimensionToSql: dimension 'none' no aplica");
  }
}
