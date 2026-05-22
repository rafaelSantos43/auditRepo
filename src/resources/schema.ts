// Resource MCP: pizza-demo://schema
// ---
// Auto-documentación del schema de Pizza Demo relevante para el auditor.
// Es un Resource (no Tool) porque es data estática de referencia: el LLM
// la lee para saber qué tablas/columnas existen antes de pedir queries.
//
// Contrato en PRD §5.3.

import { DELIVERY_TYPES, ORDER_STATUSES, PAYMENT_METHODS } from "../constants.ts";

export const SCHEMA_RESOURCE_URI = "pizza-demo://schema";

export const schemaResourceConfig = {
  title: "Schema de Pizza Demo",
  description:
    "Snapshot del schema (tablas y columnas) de la Supabase de Pizza Demo que el auditor puede leer. Consultalo para saber qué datos hay disponibles antes de invocar las tools.",
  mimeType: "application/json",
};

// El contenido se arma a partir de constants.ts para no desincronizarse
// cuando cambien los valores permitidos.
const schemaContent = {
  source:
    "Snapshot manual del schema de Pizza Demo al 2026-05-21. Actualizar cuando el sistema auditado cambie sus columnas.",
  readable_tables: {
    orders: {
      relevant_columns: [
        "id",
        "status",
        "payment_method",
        "delivery_type",
        "total_cents",
        "delayed",
        "eta_at",
        "created_at",
        "delivered_at",
      ],
      status_values: [...ORDER_STATUSES],
      payment_methods: [...PAYMENT_METHODS],
      delivery_types: [...DELIVERY_TYPES],
    },
    order_tokens: {
      relevant_columns: ["customer_id", "expires_at", "used_at", "created_at"],
    },
    customers: {
      relevant_columns: ["id", "phone"],
    },
  },
  non_readable_tables: ["profiles"],
  notes: [
    "Moneda: COP, almacenada en *_cents pero NO usa centavos. 1000_cents = $1.000 COP.",
    "Timestamps en UTC en la DB. Convertir a America/Bogota para outputs al usuario.",
    "delivery_type agregado en feature pickup 2026-05-08 — puede estar NULL en rows viejas.",
  ],
};

// Callback que el SDK invoca cuando el cliente lee el resource.
export function readSchemaResource(uri: URL) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(schemaContent, null, 2),
      },
    ],
  };
}
