const fs = require("node:fs");
const path = require("node:path");

const INPUTS = [
  "project_id",
  "game_endpoint",
  "file_path",
  "changelog",
  "changelog_type",
  "display_name",
  "parent_file_id",
  "game_versions",
  "release_type",
  "relations",
];
const RELATION_TYPES = new Set([
  "embeddedLibrary",
  "incompatible",
  "optionalDependency",
  "requiredDependency",
  "tool",
]);
const UNCERTAIN =
  " Upload result is uncertain; check project files before retrying.";

function positiveID(value, label) {
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  ) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function redact(text, token) {
  return token ? String(text).split(token).join("[REDACTED]") : String(text);
}

function versionEntries(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const pair = entry.split(":").map((part) => part.trim());
      if (pair.length > 2 || pair.some((part) => !part))
        throw new Error(
          `Invalid game_versions entry "${entry}"; use type:version or a version.`,
        );
      const [type, version] = pair.length === 2 ? pair : [null, pair[0]];
      const numeric = (part) => part !== null && /^[+-]?\d+$/.test(part);
      const versionID = numeric(version)
        ? positiveID(version, "Game version ID")
        : null;
      const typeID = numeric(type)
        ? positiveID(type, "Game version type ID")
        : null;
      return { entry, type, version, typeID, versionID };
    });
}

async function validate(inputs) {
  if (!inputs.token) throw new Error("token is required.");
  const projectID = positiveID(inputs.project_id || "", "project_id");
  const endpoint = (inputs.game_endpoint || "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(endpoint))
    throw new Error("game_endpoint must be one valid DNS label.");
  const file = inputs.file_path;
  if (!file) throw new Error("file_path is required.");
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    await fs.promises.access(file, fs.constants.R_OK);
  } catch (error) {
    throw new Error(
      `Upload file is not a readable regular file: ${file} (${error.code || error.message}).`,
    );
  }
  const releaseType = inputs.release_type || "release";
  const changelogType = inputs.changelog_type || "markdown";
  if (!["alpha", "beta", "release"].includes(releaseType))
    throw new Error("release_type must be alpha, beta or release.");
  if (!["text", "html", "markdown"].includes(changelogType))
    throw new Error("changelog_type must be text, html or markdown.");
  const parentID = inputs.parent_file_id
    ? positiveID(inputs.parent_file_id, "parent_file_id")
    : null;
  if (parentID && (inputs.game_versions || "").trim())
    throw new Error(
      "parent_file_id and game_versions cannot both be specified; attachments inherit parent versions.",
    );
  const entries = versionEntries(inputs.game_versions || "");
  const projects = (inputs.relations || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const pair = entry.split(":").map((part) => part.trim());
      if (pair.length !== 2 || !pair[0] || !RELATION_TYPES.has(pair[1]))
        throw new Error(
          `Invalid relation "${entry}"; use slug:relationType with a documented relation type.`,
        );
      return { slug: pair[0], type: pair[1] };
    });
  const metadata = {
    changelog: inputs.changelog || "",
    changelogType,
    releaseType,
  };
  if (inputs.display_name) metadata.displayName = inputs.display_name;
  if (parentID) metadata.parentFileID = parentID;
  if (projects.length) metadata.relations = { projects };
  // Open the file before any catalog request; FormData later streams its backing file.
  const blob = await fs.openAsBlob(file);
  return {
    base: new URL(`https://${endpoint}.curseforge.com`),
    projectID,
    file,
    blob,
    metadata,
    entries,
  };
}

async function responseExcerpt(response, token) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const limit = 4096 + Buffer.byteLength(token);
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, limit - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel();
  }
  // Read beyond the display limit so a token crossing that limit is redacted whole.
  const redacted = Buffer.from(
    redact(Buffer.concat(chunks).toString("utf8"), token),
  );
  return new TextDecoder().decode(redacted.subarray(0, 4096), { stream: true });
}

async function requestJSON(
  fetch,
  url,
  init,
  operation,
  token,
  timeoutMs,
  uploading = false,
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Deadline exceeded (${timeoutMs} ms).`)),
    timeoutMs,
  );
  timer.unref();
  const uncertain = uploading ? UNCERTAIN : "";
  try {
    let response;
    try {
      // Inspect 3xx ourselves to report the status, without following credentials.
      response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `${operation} failed: ${redact(error.message, token)}.${uncertain}`,
      );
    }
    if (!response.ok) {
      let excerpt;
      try {
        excerpt = await responseExcerpt(response, token);
      } catch (error) {
        excerpt = `Unable to read response: ${redact(error.message, token)}`;
      }
      throw new Error(
        `${operation} failed (HTTP ${response.status}): ${excerpt}`,
      );
    }
    try {
      return { data: await response.json(), status: response.status };
    } catch (error) {
      throw new Error(
        `${operation} failed (HTTP ${response.status}): ${controller.signal.aborted ? "deadline exceeded while reading JSON response" : "invalid or incomplete JSON response"}.${uncertain}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function uniqueMatch(matches, label) {
  if (matches.length === 0) throw new Error(`${label} not found.`);
  if (matches.length !== 1)
    throw new Error(
      `${label} is ambiguous; use a unique type:version selection or numeric ID.`,
    );
  return matches[0];
}

async function resolveVersions(
  entries,
  base,
  headers,
  fetch,
  token,
  timeoutMs,
) {
  let catalog = [],
    types = [];
  if (
    entries.some((entry) => entry.type !== null || entry.versionID === null)
  ) {
    const result = await requestJSON(
      fetch,
      new URL("/api/game/versions", base),
      { headers },
      "Version catalog request",
      token,
      timeoutMs,
    );
    if (!Array.isArray(result.data))
      throw new Error(
        `Version catalog request failed (HTTP ${result.status}): expected a JSON array.`,
      );
    catalog = result.data;
  }
  if (entries.some((entry) => entry.type !== null && entry.typeID === null)) {
    const result = await requestJSON(
      fetch,
      new URL("/api/game/version-types", base),
      { headers },
      "Version type catalog request",
      token,
      timeoutMs,
    );
    if (!Array.isArray(result.data))
      throw new Error(
        `Version type catalog request failed (HTTP ${result.status}): expected a JSON array.`,
      );
    types = result.data;
  }
  const ids = entries.map((entry) => {
    if (entry.type === null && entry.versionID !== null) return entry.versionID;
    let typeID = entry.typeID;
    if (entry.type !== null && typeID === null) {
      const type = uniqueMatch(
        types.filter(
          (value) =>
            value && (value.name === entry.type || value.slug === entry.type),
        ),
        `Version type "${entry.type}"`,
      );
      typeID = positiveID(type.id, "Resolved version type ID");
    }
    const version = uniqueMatch(
      catalog.filter(
        (value) =>
          value &&
          (entry.versionID !== null
            ? String(value.id) === String(entry.versionID)
            : value.name === entry.version || value.slug === entry.version) &&
          (entry.type === null ||
            String(value.gameVersionTypeID) === String(typeID)),
      ),
      `Game version "${entry.entry}"`,
    );
    return positiveID(version.id, "Resolved game version ID");
  });
  return [...new Set(ids)];
}

async function upload(
  inputs,
  {
    fetch = globalThis.fetch,
    catalogTimeoutMs = 30_000,
    uploadTimeoutMs = 600_000,
  } = {},
) {
  const config = await validate(inputs);
  const headers = { "X-Api-Token": inputs.token };
  const versions = await resolveVersions(
    config.entries,
    config.base,
    headers,
    fetch,
    inputs.token,
    catalogTimeoutMs,
  );
  if (versions.length) config.metadata.gameVersions = versions;
  const form = new FormData();
  form.append("file", config.blob, path.basename(config.file));
  form.append("metadata", JSON.stringify(config.metadata));
  // One POST only: retrying a request with a lost response can create duplicate files.
  const result = await requestJSON(
    fetch,
    new URL(`/api/projects/${config.projectID}/upload-file`, config.base),
    { method: "POST", headers, body: form },
    "Upload",
    inputs.token,
    uploadTimeoutMs,
    true,
  );
  try {
    if (
      typeof result.data?.id !== "number" &&
      typeof result.data?.id !== "string"
    )
      throw new Error("missing file ID");
    return String(positiveID(result.data.id, "Response file ID"));
  } catch {
    throw new Error(
      `Upload failed (HTTP ${result.status}): response must contain a positive safe-integer file ID.${UNCERTAIN}`,
    );
  }
}

async function runAction(core, options) {
  let token = "";
  try {
    token = core.getInput("token");
    if (token) core.setSecret(token);
    const inputs = { token };
    for (const name of INPUTS) inputs[name] = core.getInput(name);
    const id = await upload(inputs, options);
    core.setOutput("id", id);
  } catch (error) {
    core.setFailed(redact(error.message, token));
  }
}

module.exports = { upload, runAction };
