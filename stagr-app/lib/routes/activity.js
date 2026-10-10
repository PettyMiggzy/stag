import { sql } from '../db.js';
export const logActivity = (tid, customerId, type, text, userId = null) =>
  sql`INSERT INTO activity (tenant_id, customer_id, type, text, user_id) VALUES (${tid}, ${customerId ?? null}, ${type}, ${String(text).slice(0, 300)}, ${userId})`;
