// Test-only interception: production still constructs and validates CurseForge HTTPS URLs.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "minecraft.curseforge.com"
  )
    throw Error("Unexpected action destination");
  return nativeFetch(process.env.TEST_HTTP_BASE + target.pathname, options);
};
