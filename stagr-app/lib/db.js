// One tagged-template `sql` for both local Postgres (pg) and Neon (serverless http).
//   sql`SELECT * FROM customers WHERE tenant_id = ${tid}`  ->  array of rows
// Every query on tenant data MUST filter by tenant_id. The isolation test in test/run.mjs checks this.
import pg from 'pg';
let impl = null;
function make() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  if (/neon\.tech/.test(url) && !process.env.FORCE_PG) {
    return import('@neondatabase/serverless').then(m => m.neon(url));
  }
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const run = async (strings, ...vals) => {
    let text = strings[0];
    for (let i = 0; i < vals.length; i++) text += '$' + (i + 1) + strings[i + 1];
    const params = vals.map(v => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) ? JSON.stringify(v) : v);
    const r = await pool.query(text, params);
    return r.rows;
  };
  run.__query = async (text, params) => (await pool.query(text, params)).rows;
  return Promise.resolve(run);
}
export async function sql(strings, ...vals) {
  if (!impl) impl = make();
  const f = await impl;
  return f(strings, ...vals);
}
// Plain parameterized query (used for DDL and dynamic SQL): query('SELECT ... $1', [v])
export async function query(text, params = []) {
  if (!impl) impl = make();
  const f = await impl;
  if (typeof f.query === 'function') return f.query(text, params);
  return f.__query(text, params);
}
export const closeDb = async () => {};
