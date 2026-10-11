const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { requestJSON, uploadFile, redact } = require("./transport");
const { prepareReceipt, readReceipt } = require("./receipts");
const { EnvHttpProxyAgent } = require("undici");
const { publicationStatus, renderSummary } = require("./reporting");

const INPUTS = [
  "project_id",
  "game_endpoint",
  "file_path",
  "additional_files",
  "receipt",
  "changelog",
  "changelog_type",
  "display_name",
  "parent_file_id",
  "game_versions",
  "release_type",
  "manual_release",
  "relations",
];
const RELATION_TYPES = new Set([
  "embeddedLibrary",
  "incompatible",
  "optionalDependency",
  "requiredDependency",
  "tool",
]);

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
  const releaseType = inputs.release_type || "release";
  const changelogType = inputs.changelog_type || "markdown";
  const manualRelease = inputs.manual_release || "auto";
  if (!["auto", "true", "false"].includes(manualRelease))
    throw new Error("manual_release must be auto, true or false.");
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
  const selected = [
    file,
    ...(inputs.additional_files || "")
      .split(/\r?\n/)
      .filter((entry) => entry !== ""),
  ];
  const multiFile = selected.length > 1;
  if (!parentID && multiFile && manualRelease === "false")
    throw new Error(
      "manual_release: false is unsafe for a new main file with additional_files; use auto or true to hold the main file until every attachment is accepted and approved.",
    );
  const managed = multiFile || Boolean(inputs.receipt);
  if (
    managed && (inputs.receipt?.includes(inputs.token) ||
      entries.some((entry) => entry.entry.includes(inputs.token)))
  )
    throw new Error(
      "Receipt paths and version selections must not contain the API token.",
    );
  const shared = { changelog: inputs.changelog || "", changelogType, releaseType };
  if (projects.length) shared.relations = { projects };
  const seen = new Set();
  const files = [];
  for (const [index, selectedPath] of selected.entries()) {
    let blob, canonical;
    try {
      const stat = await fs.promises.stat(selectedPath);
      if (!stat.isFile()) throw new Error("not a regular file");
      await fs.promises.access(selectedPath, fs.constants.R_OK);
      canonical = await fs.promises.realpath(selectedPath);
      blob = await fs.openAsBlob(selectedPath);
    } catch (error) {
      throw new Error(
        `Upload file is not a readable regular file: ${selectedPath} (${error.code || error.message}).`,
      );
    }
    if (seen.has(canonical))
      throw new Error(`Duplicate upload path: ${selectedPath}.`);
    seen.add(canonical);
    const attachment = Boolean(parentID) || index > 0;
    const metadata = { ...shared };
    if (attachment) {
      metadata.displayName = path.basename(selectedPath);
      metadata.parentFileID = parentID;
    } else if (inputs.display_name) metadata.displayName = inputs.display_name;
    if (manualRelease !== "auto")
      metadata.isMarkedForManualRelease = manualRelease === "true";
    else if (!attachment && multiFile) metadata.isMarkedForManualRelease = true;
    let sha256;
    if (managed) {
      const hash = createHash("sha256");
      for await (const chunk of blob.stream()) hash.update(chunk);
      sha256 = hash.digest("hex");
      // A receipt contains the submitted metadata and paths, never credentials.
      if (
        selectedPath.includes(inputs.token) ||
        JSON.stringify(metadata).includes(inputs.token)
      )
        throw new Error(
          "Upload paths and metadata must not contain the API token when saving a receipt.",
        );
    }
    files.push({ path: selectedPath, blob, sha256, metadata });
  }
  if (inputs.receipt) {
    const receiptPath = await fs.promises.realpath(inputs.receipt);
    if (seen.has(receiptPath)) throw new Error("receipt cannot also be an upload file.");
  }
  return {
    base: new URL(`https://${endpoint}.curseforge.com`),
    projectID,
    files,
    entries,
    parentID,
    managed,
  };
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

function progressSummary(receipt, complete) {
  const accepted = receipt.data.files.filter((file) => file.state === "accepted");
  const pending = receipt.data.files.filter((file) => file.state !== "accepted");
  const describe = (files) => files
    .map((file) =>
      `${path.basename(file.path)}${file.id ? ` (ID ${file.id})` : ` (${file.state})`}`,
    ).join(", ") || "none";
  const retries = receipt.data.files.reduce(
    (sum, file) => sum + Math.max(0, file.attempts - 1), 0,
  );
  const held = receipt.data.selectedParentID === null &&
    receipt.data.files[0].metadata.isMarkedForManualRelease === true;
  return `${complete ? "Complete upload" : "Partial upload"}; parent ID: ${receipt.data.parentID || "not accepted"}; accepted: ${describe(accepted)}; pending: ${describe(pending)}; retry attempts: ${retries}; receipt: ${receipt.path}. ${held ? "The main file is configured to be held for manual release; approval and public visibility are unverified. After every required file is accepted and approved, release the held files from the dashboard." : "API acceptance does not confirm approval or public release."}`;
}

async function upload(
  inputs,
  {
    fetch: fetchOverride,
    catalogTimeoutMs = 30_000,
    uploadTimeoutMs = 600_000,
    now, wait, onReceipt, onProgress, onReport, receiptDirectory,
  } = {},
) {
  // Preserve a supplied receipt even when local preflight fails, without
  // trusting its contents or exposing a credential embedded in its path.
  if (inputs.receipt && (!inputs.token || !inputs.receipt.includes(inputs.token)))
    await onReceipt?.(path.resolve(inputs.receipt));
  const config = await validate(inputs);
  let dispatcher, receipt, reconciliation;
  let reportReceiptPath = inputs.receipt;
  let reportData = {
    selectedParentID: config.parentID,
    files: config.files.map((file) => ({
      path: file.path, metadata: file.metadata, id: null,
      state: inputs.receipt ? "unknown" : "pending", attempts: 0,
    })),
  };
  const ensureDispatcher = () => {
    if (!dispatcher) {
      try {
        dispatcher = new EnvHttpProxyAgent();
      } catch {
        // Proxy URLs can contain credentials; never include them in errors.
        throw new Error("Invalid HTTP_PROXY/HTTPS_PROXY configuration.");
      }
    }
    return dispatcher;
  };
  const fetch = fetchOverride || ((url, init) =>
    globalThis.fetch(url, { ...init, dispatcher: ensureDispatcher() }));
  try {
    const headers = { "X-Api-Token": inputs.token };
    let candidate, versions;
    if (inputs.receipt) {
      candidate = await readReceipt(inputs.receipt);
      // Numeric selections can be checked locally; named selections reuse the
      // trusted receipt's original catalog resolution without a network request.
      versions = config.entries.every((entry) => entry.versionID !== null)
        ? [...new Set(config.entries.map((entry) => entry.versionID))]
        : candidate.files?.[0]?.metadata?.gameVersions || [];
      if (
        !Array.isArray(versions) ||
        versions.some((id) => !Number.isSafeInteger(id) || id <= 0)
      )
        throw new Error("Receipt contains invalid game versions.");
    } else {
      versions = await resolveVersions(
        config.entries, config.base, headers, fetch, inputs.token, catalogTimeoutMs,
      );
    }
    if (!config.parentID && versions.length)
      config.files[0].metadata.gameVersions = versions;
    if (config.managed) {
      receipt = await prepareReceipt({
        projectID: config.projectID,
        endpoint: config.base.origin,
        selectedParentID: config.parentID,
        files: config.files,
        versionSelection: config.entries.map((entry) => entry.entry),
        receipt: inputs.receipt, candidate, receiptDirectory,
      });
      reportData = receipt.data;
      if (!inputs.receipt) await onReceipt?.(receipt.path);
    }
    const url = new URL(`/api/projects/${config.projectID}/upload-file`, config.base);
    let parentID = receipt?.data.parentID || config.parentID;
    let firstID;
    for (const [index, file] of config.files.entries()) {
      const record = reportData.files[index];
      if (record?.state === "accepted") {
        if (index === 0) firstID = record.id;
        continue;
      }
      if (config.parentID || index > 0) file.metadata.parentFileID = parentID;
      let id;
      try {
        // Local proxy validation cannot leave an upload marked in flight.
        if (!fetchOverride) ensureDispatcher();
        id = await uploadFile({
          fetch, url, headers,
          blob: file.blob,
          file: file.path,
          metadata: file.metadata,
          token: inputs.token,
          timeoutMs: uploadTimeoutMs,
          now, wait,
          onAttempt: async (attempt) => {
            if (record) {
              record.metadata = file.metadata;
              record.state = "uploading";
              record.attempts += 1;
              await receipt?.save();
            }
            if (attempt > 1)
              await onProgress?.(
                `Retrying attachment ${path.basename(file.path)} (attempt ${attempt}/7): parent unavailable or invalid (error 1012).`,
              );
          },
          onRetryableRejection: async () => {
            if (record) {
              record.state = "pending";
              await receipt?.save();
            }
          },
        });
      } catch (error) {
        if (record) {
          record.state = error.uncertain ? "uncertain" : "pending";
          try {
            await receipt?.save();
          } catch {
            reconciliation = { path: file.path, id: record.id };
            throw new Error(
              `${error.message} Receipt update failed; the saved in-flight state requires dashboard reconciliation.`,
            );
          }
        }
        throw error;
      }
      if (index === 0) firstID = id;
      if (!config.parentID && index === 0) {
        parentID = id;
        if (receipt) {
          receipt.data.parentID = id;
          for (const attachment of receipt.data.files.slice(1))
            attachment.metadata.parentFileID = id;
        }
      }
      if (record) {
        record.id = id;
        record.state = "accepted";
        try {
          await receipt?.save();
        } catch {
          reconciliation = { path: file.path, id };
          throw new Error(
            `File ${path.basename(file.path)} was accepted as ID ${id}, but saving the receipt failed. Check the dashboard and reconcile the saved in-flight entry before retrying.`,
          );
        }
      }
    }
    if (receipt) await onProgress?.(progressSummary(receipt, true));
    return String(firstID);
  } catch (error) {
    // Only receipt data that passed identity validation may supply remote IDs.
    if (error.receiptData) reportData = error.receiptData;
    if (error.receiptPath) reportReceiptPath = error.receiptPath;
    if (!receipt && !inputs.receipt && error.receiptPath)
      await onReceipt?.(error.receiptPath);
    if (receipt) error.message += ` ${progressSummary(receipt, false)}`;
    throw error;
  } finally {
    try {
      await dispatcher?.close();
    } finally {
      await onReport?.({
        ...reportData,
        receiptPath: receipt?.path || reportReceiptPath,
        reconciliation,
      });
    }
  }
}

async function runAction(core, options = {}) {
  let token = "";
  let inputs = {}, report;
  try {
    token = core.getInput("token");
    if (token) core.setSecret(token);
    inputs = { token };
    for (const name of INPUTS)
      inputs[name] = core.getInput(
        name,
        ["file_path", "additional_files", "receipt"].includes(name)
          ? { trimWhitespace: false } : undefined,
      );
    const id = await upload(inputs, {
      ...options,
      onReceipt: async (receiptPath) => {
        core.setOutput("receipt", receiptPath);
        await options.onReceipt?.(receiptPath);
      },
      onProgress: async (message) => {
        core.info?.(redact(message, token));
        await options.onProgress?.(redact(message, token));
      },
      onReport: (value) => { report = value; },
    });
    core.setOutput("id", id);
  } catch (error) {
    if (report) report.failed = true;
    core.setFailed(redact(error.message, token));
  } finally {
    report ||= {
      selectedParentID: null,
      failed: true,
      files: [inputs.file_path, ...(inputs.additional_files || "").split(/\r?\n/)]
        .filter(Boolean).map((file) => ({
          path: file, id: null, state: inputs.receipt ? "unknown" : "not attempted",
        })),
      receiptPath: inputs.receipt,
    };
    core.setOutput("publication_status", publicationStatus(report));
    if (core.summary && process.env.GITHUB_STEP_SUMMARY) {
      try {
        await core.summary.addRaw(renderSummary(report, token)).write();
      } catch {
        core.warning?.("Could not write the CurseForge job summary; check the action logs and saved receipt.");
      }
    }
  }
}

module.exports = { upload, runAction };
