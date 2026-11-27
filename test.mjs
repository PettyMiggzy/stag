import { pathAllowed, contentAllowed } from "./guard.mjs";
let f = 0; const t = (n, c) => { console.log(c ? "PASS" : "FAIL", n); if (!c) f++; };
for (const p of ["index.html", "areas/tampa/index.html", "assets/site.css", "content.py", "data/spring/jobs.json"]) t("allows " + p, pathAllowed(p) === null);
for (const p of ["api/lead.js", "admin/index.html", ".env", "package.json", "assets/payment.html", "checkout/index.html", "wallet.js", "../x.html", "/etc/passwd", "build.py", "assets/stripe.js", "Dockerfile", ".github/workflows/a.yml", "stagr/app.js", "assets/app.js", "secrets.json", "data/token-list.json"]) t("blocks " + p, pathAllowed(p) !== null);
t("blocks eth address", contentAllowed("send to 0x72938daaf3c2fa4bef722e1263a5766755788392") !== null);
t("blocks anthropic key", contentAllowed("sk-ant-api03-abcdefghijklmnopqrstuvwxyz") !== null);
t("blocks telegram token", contentAllowed("1234567890:AAFakeFakeFakeFakeFakeFakeFakeFake123") !== null);
t("allows normal copy", contentAllowed("<h1>Fast junk removal in Spring, TX</h1>") === null);
console.log(f ? f + " failed" : "all passed"); process.exit(f ? 1 : 0);
