// Fuente única de verdad para nombres de tabla y constantes del dominio Pizza Demo.
// Vivir acá hace que el futuro refactor a "config externa" cueste ~2h (ver PRD §7.3).

// --- Tablas legibles por el rol mcp_auditor ---
export const T_ORDERS = "orders";
export const T_ORDER_ITEMS = "order_items";
export const T_ORDER_TOKENS = "order_tokens";
export const T_ORDER_STATUS_EVENTS = "order_status_events";
export const T_CUSTOMERS = "customers";
export const T_PRODUCTS = "products";
export const T_PRODUCT_SIZES = "product_sizes";
export const T_SETTINGS = "settings";

// --- Status de orders (ver PRD §9.3 de Pizza Demo) ---
export const ORDER_STATUSES = [
  "new",
  "awaiting_payment",
  "payment_approved",
  "payment_rejected",
  "preparing",
  "ready",
  "on_the_way",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Status que NO cuentan para revenue (cancelado o pago rechazado).
export const STATUSES_EXCLUDED_FROM_REVENUE = ["cancelled", "payment_rejected"] as const;

// El único status que cuenta como "facturado real" (dinero que efectivamente entró).
export const STATUS_DELIVERED = "delivered" as const;

// --- Métodos de pago ---
export const PAYMENT_METHODS = ["cash", "bancolombia", "nequi", "llave"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// --- Tipos de entrega (feature pickup agregado 2026-05-08) ---
export const DELIVERY_TYPES = ["delivery", "pickup"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

// --- Zona horaria ---
// Pizza Demo opera en Colombia. UTC-5 todo el año (sin horario de verano).
export const TZ = "America/Bogota";
export const COLOMBIA_OFFSET = "-05:00";

// --- Horario pico para detect_activity_gaps ---
// JS Date.getUTCDay(): 0=domingo, 1=lunes, ..., 6=sábado.
// `null` = ese día no es horario pico (un silencio NO se considera abandono).
type TimeWindow = { start: string; end: string };
export const PEAK_HOURS: Record<number, TimeWindow | null> = {
  0: { start: "12:00", end: "21:00" }, // domingo
  1: null,                              // lunes
  2: null,                              // martes
  3: null,                              // miércoles
  4: null,                              // jueves
  5: { start: "18:00", end: "23:00" }, // viernes
  6: { start: "12:00", end: "23:00" }, // sábado
};

// Tope duro para outputs cuando se pide detail=true (ver PRD §6).
export const MAX_DETAIL_ROWS = 100;
