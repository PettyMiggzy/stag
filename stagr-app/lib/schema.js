import { query } from './db.js';
// Idempotent schema. Every business-owned table has tenant_id and an index starting with it.
const STATEMENTS = [
`CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  plan TEXT NOT NULL DEFAULT 'pro', tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0, brand_color TEXT NOT NULL DEFAULT '#39ff14',
  quote_seq INT NOT NULL DEFAULT 1000, invoice_seq INT NOT NULL DEFAULT 1000, job_seq INT NOT NULL DEFAULT 1000,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'worker', phone TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS users_tenant ON users(tenant_id)`,
`CREATE TABLE IF NOT EXISTS login_fails (key TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS login_fails_key ON login_fails(key, at)`,
`CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tags TEXT[] NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT '', sms_opt_in BOOLEAN NOT NULL DEFAULT false, sms_opt_in_at TIMESTAMPTZ, sms_opt_out_at TIMESTAMPTZ,
  email_opt_out BOOLEAN NOT NULL DEFAULT false, archived BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS customers_tenant ON customers(tenant_id, created_at DESC)`,
`CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', zip TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`,
`CREATE INDEX IF NOT EXISTS properties_tenant ON properties(tenant_id, customer_id)`,
`CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true)`,
`CREATE INDEX IF NOT EXISTS services_tenant ON services(tenant_id)`,
`CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
  photos JSONB NOT NULL DEFAULT '[]'::jsonb, contacted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS requests_tenant ON requests(tenant_id, created_at DESC)`,
`CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, number INT NOT NULL, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL, request_id INT REFERENCES requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft', items JSONB NOT NULL DEFAULT '[]'::jsonb, discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0, tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  deposit NUMERIC(10,2) NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ, viewed_at TIMESTAMPTZ, decided_at TIMESTAMPTZ, signed_name TEXT NOT NULL DEFAULT '', client_note TEXT NOT NULL DEFAULT '')`,
`CREATE INDEX IF NOT EXISTS quotes_tenant ON quotes(tenant_id, created_at DESC)`,
`CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, number INT NOT NULL, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL, quote_id INT REFERENCES quotes(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', items JSONB NOT NULL DEFAULT '[]'::jsonb,
  recurrence JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ)`,
`CREATE INDEX IF NOT EXISTS jobs_tenant ON jobs(tenant_id, created_at DESC)`,
`CREATE TABLE IF NOT EXISTS visits (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ, assigned INT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT NOT NULL DEFAULT '', checklist JSONB NOT NULL DEFAULT '[]'::jsonb, photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  reminder_sent_at TIMESTAMPTZ, completed_at TIMESTAMPTZ)`,
`CREATE INDEX IF NOT EXISTS visits_tenant ON visits(tenant_id, starts_at)`,
`CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, number INT NOT NULL, customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id INT REFERENCES jobs(id) ON DELETE SET NULL, quote_id INT REFERENCES quotes(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'draft',
  items JSONB NOT NULL DEFAULT '[]'::jsonb, discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0, tax_pct NUMERIC(5,2) NOT NULL DEFAULT 0, due_date DATE,
  message TEXT NOT NULL DEFAULT '', token TEXT NOT NULL UNIQUE, payments JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ, viewed_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, last_reminder_at TIMESTAMPTZ)`,
`CREATE INDEX IF NOT EXISTS invoices_tenant ON invoices(tenant_id, created_at DESC)`,
`CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'sms', direction TEXT NOT NULL DEFAULT 'out', kind TEXT NOT NULL DEFAULT 'manual', body TEXT NOT NULL, to_addr TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', provider_id TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS messages_tenant ON messages(tenant_id, created_at DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS messages_ref ON messages(tenant_id, ref) WHERE ref <> ''`,
`CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, kind TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb, last_run_at TIMESTAMPTZ, UNIQUE (tenant_id, kind))`,
`CREATE TABLE IF NOT EXISTS activity (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, customer_id INT, type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '',
  user_id INT, at TIMESTAMPTZ NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS activity_tenant ON activity(tenant_id, customer_id, at DESC)`,
`CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id INT NOT NULL, visit_id INT, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ)`,
`CREATE INDEX IF NOT EXISTS time_tenant ON time_entries(tenant_id, started_at DESC)`,
`CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY, tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, job_id INT, description TEXT NOT NULL DEFAULT '', amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  incurred_on DATE NOT NULL DEFAULT current_date, user_id INT)`,
`CREATE INDEX IF NOT EXISTS expenses_tenant ON expenses(tenant_id, incurred_on DESC)`
];
let done = null;
export function ensureSchema() {
  if (!done) done = (async () => { for (const s of STATEMENTS) await query(s); })().catch(e => { done = null; throw e; });
  return done;
}
