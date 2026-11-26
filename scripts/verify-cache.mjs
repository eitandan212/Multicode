// Checks prompt caching against the real Anthropic API. Needs ANTHROPIC_API_KEY; there is no
// fallback: without a key it stops. Usage: npm run build && ANTHROPIC_API_KEY=... npm run verify:cache
import { checkCaching } from "../dist/server/cacheCheck.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set. This check runs only against the real Anthropic API.");
  process.exit(2);
}
const r = await checkCaching({
  id: "verify",
  kind: "anthropic",
  label: "Anthropic",
  apiKey,
  defaultModel: process.env.MODEL || "claude-opus-5-5",
});
console.log(`model ${r.model}`);
console.log(`call 1: ${r.first.input} input, ${r.first.cached} from cache`);
console.log(`call 2: ${r.second.input} input, ${r.second.cached} from cache`);
console.log(r.message);
process.exit(r.ok ? 0 : 1);
