// Test-only interception: production still constructs and validates CurseForge HTTPS URLs.
if (process.env.TEST_OUTPUT_EOL) {
  Object.defineProperty(require("node:os"), "EOL", {
    value: process.env.TEST_OUTPUT_EOL,
  });
  require("node:module").syncBuiltinESMExports();
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "minecraft.curseforge.com"
  )
    throw new Error("Unexpected action destination");
  return nativeFetch(process.env.TEST_HTTP_BASE + target.pathname, options);
};
