const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const MAX_BYTES = 8 * 1024 * 1024;
const STATES = new Set(["pending", "uploading", "accepted", "uncertain"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function positiveID(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function invalid(message) {
  throw new Error(`Invalid upload receipt: ${message}.`);
}

async function readReceipt(receiptPath) {
  let handle;
  try {
    handle = await fs.open(receiptPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) invalid("a regular JSON file is required");
    if (stat.size > MAX_BYTES) invalid("file exceeds the 8 MiB size limit");
    const chunks = [];
    let size = 0;
    // Bound the actual read as well as the stat: the file may grow while open.
    while (size <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > MAX_BYTES) invalid("file exceeds the 8 MiB size limit");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      invalid("file is not valid JSON");
    }
  } catch (error) {
    error.receiptPath = receiptPath;
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateReceipt(data, config) {
  if (
    !exactKeys(data, [
      "version",
      "projectID",
      "endpoint",
      "selectedParentID",
      "parentID",
      "versionSelection",
      "files",
    ]) ||
    data.version !== 1
  )
    invalid("unsupported schema");
  if (
    !positiveID(data.projectID) ||
    typeof data.endpoint !== "string" ||
    data.projectID !== config.projectID ||
    data.endpoint !== config.endpoint ||
    data.selectedParentID !== config.selectedParentID ||
    (data.selectedParentID !== null && !positiveID(data.selectedParentID))
  )
    invalid("project, endpoint or selected parent does not match");
  if (
    !Array.isArray(data.versionSelection) ||
    !data.versionSelection.every((entry) => typeof entry === "string") ||
    !isDeepStrictEqual(data.versionSelection, config.versionSelection)
  )
    invalid("game version selection does not match");
  if (
    !Array.isArray(data.files) ||
    data.files.length === 0 ||
    data.files.length !== config.files.length ||
    (data.parentID !== null && !positiveID(data.parentID))
  )
    invalid("file list or parent ID is invalid");

  const existingParent = data.selectedParentID !== null;
  if (existingParent && data.parentID !== data.selectedParentID)
    invalid("existing parent identity does not match");
  const acceptedIDs = new Set(existingParent ? [data.parentID] : []);
  for (let index = 0; index < data.files.length; index++) {
    const file = data.files[index];
    const expected = config.files[index];
    if (
      !exactKeys(file, ["path", "sha256", "metadata", "id", "state", "attempts"]) ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !object(file.metadata) ||
      !STATES.has(file.state) ||
      !Number.isSafeInteger(file.attempts) ||
      file.attempts < 0 ||
      (file.state === "accepted" ? !positiveID(file.id) : file.id !== null)
    )
      invalid(`file ${index + 1} has an invalid ID, state or shape`);
    if (file.path !== expected.path || file.sha256 !== expected.sha256)
      invalid(`file ${index + 1} path or SHA-256 does not match`);
    const attachment = existingParent || index > 0;
    const metadata = attachment
      ? { ...expected.metadata, parentFileID: data.parentID }
      : expected.metadata;
    if (!isDeepStrictEqual(file.metadata, metadata))
      invalid(`file ${index + 1} metadata does not match`);
    if (file.state === "accepted") {
      if (acceptedIDs.has(file.id)) invalid("accepted file IDs must be unique");
      acceptedIDs.add(file.id);
      if (attachment && !existingParent && data.files[0].state !== "accepted")
        invalid("an accepted attachment requires an accepted main file");
    }
  }
  if (!existingParent) {
    const main = data.files[0];
    if (data.parentID !== (main.state === "accepted" ? main.id : null))
      invalid("new parent identity does not match the accepted main file");
  }
}

function reconcileMain(data) {
  if (
    data?.selectedParentID !== null ||
    data.parentID !== null ||
    !Array.isArray(data.files) ||
    data.files[0]?.state !== "accepted" ||
    !positiveID(data.files[0].id) ||
    !data.files.slice(1).every(
      (file) => file?.state !== "accepted" && file?.metadata?.parentFileID === null,
    )
  )
    return false;
  // A manually reconciled main ID also determines every pending attachment's parent.
  data.parentID = data.files[0].id;
  for (const file of data.files.slice(1)) file.metadata.parentFileID = data.parentID;
  return true;
}

async function separateFromUploads(receiptPath, files) {
  let receiptStat;
  let canonicalReceipt = path.resolve(receiptPath);
  try {
    canonicalReceipt = await fs.realpath(receiptPath);
    receiptStat = await fs.stat(receiptPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const file of files) {
    const canonicalFile = await fs.realpath(file.path);
    const fileStat = await fs.stat(file.path);
    if (
      canonicalFile === canonicalReceipt ||
      (receiptStat &&
        receiptStat.dev === fileStat.dev &&
        receiptStat.ino === fileStat.ino)
    )
      throw new Error("Receipt path must not refer to a selected upload file.");
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is unavailable on some filesystems, notably Windows.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(error.code))
      throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicSave(receiptPath, data) {
  const json = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(json) > MAX_BYTES)
    invalid("file exceeds the 8 MiB size limit");
  const directory = path.dirname(receiptPath);
  const temporary = path.join(directory, `.receipt-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(json);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, receiptPath);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function prepareReceipt(config) {
  let receiptPath = config.receipt;
  try {
    let data;
    let reconciled = false;
    if (config.receipt) {
      data = config.candidate || (await readReceipt(config.receipt));
      receiptPath = await fs.realpath(config.receipt);
      reconciled = reconcileMain(data);
      validateReceipt(data, config);
    } else {
      data = {
        version: 1,
        projectID: config.projectID,
        endpoint: config.endpoint,
        selectedParentID: config.selectedParentID,
        parentID: config.selectedParentID,
        versionSelection: config.versionSelection,
        files: config.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          metadata: file.metadata,
          id: null,
          state: "pending",
          attempts: 0,
        })),
      };
      // Separate owned receipt data from the caller's metadata objects.
      data = JSON.parse(JSON.stringify(data));
      validateReceipt(data, config);
      const directory = await fs.mkdtemp(
        path.join(
          path.resolve(config.receiptDirectory || process.env.RUNNER_TEMP || os.tmpdir()),
          "curseforge-upload-",
        ),
      );
      await fs.chmod(directory, 0o700);
      receiptPath = path.join(directory, "receipt.json");
      await syncDirectory(path.dirname(directory));
    }
    const save = async () => {
      try {
        validateReceipt(data, config);
        await separateFromUploads(receiptPath, config.files);
        await atomicSave(receiptPath, data);
      } catch (error) {
        error.receiptPath = receiptPath;
        throw error;
      }
    };
    await separateFromUploads(receiptPath, config.files);
    if (config.receipt) {
      const uploading = data.files.filter((file) => file.state === "uploading");
      for (const file of uploading) file.state = "uncertain";
      if (uploading.length || reconciled) await save();
      if (data.files.some((file) => file.state === "uncertain"))
        throw new Error(
          "Receipt contains an uncertain upload. Check the CurseForge dashboard and manually reconcile its ID and state before resuming.",
        );
    } else await save();
    return { path: receiptPath, data, save };
  } catch (error) {
    if (receiptPath) error.receiptPath = receiptPath;
    throw error;
  }
}

module.exports = { prepareReceipt, readReceipt };
