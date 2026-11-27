// Hard limits, enforced in code. The model cannot talk its way past these.
export const MAX_FILE_BYTES = 200_000;
const BLOCK_PATH = /(^|\/)(\.env[^/]*|\.git|\.github|\.claude|node_modules|api|admin|__pycache__)(\/|$)|payment|checkout|stripe|square|paypal|venmo|cashapp|wallet|crypto|contract|secret|credential|password|passwd|token|api[-_]?key|invoice|billing|stagr|\.(key|pem|p12|sh|py)$|package(-lock)?\.json$|dockerfile|vercel\.json|render\.yaml|ecosystem\.config|\.\.\/|^\/|\/\//i;
const ALLOW_EXT = /\.(html?|css|md|txt|json|svg|xml|webmanifest)$/i;
const ALLOW_SPECIAL = /^content\.py$/; // junk site copy lives here
const BLOCK_CONTENT = /(0x[0-9a-fA-F]{40}|sk-ant-|sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY|seed phrase|mnemonic|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_|xox[bp]-|\b\d{9,10}:AA[A-Za-z0-9_-]{30,})/;
export function pathAllowed(p) {
  if (typeof p !== "string" || !p || p.length > 200) return "bad path";
  if (ALLOW_SPECIAL.test(p)) return null;
  if (BLOCK_PATH.test(p)) return "that file is off limits (money, keys, server code and settings are never touched)";
  if (!(ALLOW_EXT.test(p) || ALLOW_SPECIAL.test(p))) return "only page text, styling and data files can be changed";
  return null;
}
export function contentAllowed(c) {
  if (typeof c !== "string") return "bad content";
  if (Buffer.byteLength(c) > MAX_FILE_BYTES) return "file too large";
  if (BLOCK_CONTENT.test(c)) return "content looks like a wallet address or secret key, which is never allowed";
  return null;
}
export const readAllowed = (p) => (typeof p === "string" && p.length < 200 && !/(^|\/)(\.env[^/]*|\.git|\.claude)(\/|$)|\.\.\/|^\/|secret|credential|password|\.(key|pem)$/i.test(p)) ? null : "that file cannot be read";
