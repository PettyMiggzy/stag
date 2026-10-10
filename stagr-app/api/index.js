// One serverless function handles every /api/* route (see vercel.json rewrites).
import { handle } from '../lib/router.js';
import '../lib/routes/auth.js';
import '../lib/routes/customers.js';
import '../lib/routes/sales.js';
import '../lib/routes/work.js';
import '../lib/routes/billing.js';
import '../lib/routes/comms.js';
import '../lib/routes/automations.js';
import '../lib/routes/insights.js';
export default handle;
