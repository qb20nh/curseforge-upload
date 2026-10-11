const path = require("node:path");

const UNCERTAIN =
  " Upload result is uncertain; check the CurseForge dashboard's project files before retrying.";
const RESPONSE_LIMIT = 1024 * 1024;
const EXCERPT_LIMIT = 4096;
const RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

function redact(text, token) {
  return token ? String(text).split(token).join("[REDACTED]") : String(text);
}

function failure(
  message,
  { status = null, errorCode = null, uncertain = false, attempts = 1 } = {},
) {
  return Object.assign(new Error(message + (uncertain ? UNCERTAIN : "")), {
    status,
    errorCode,
    uncertain,
    attempts,
  });
}

async function responseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", complete: true, validUTF8: true };
  const chunks = [];
  let size = 0;
  let complete = false;
  let readError;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      const available = RESPONSE_LIMIT - size;
      const kept = Math.min(value.byteLength, available);
      // Copy only bounded bytes; a view could retain an oversized source chunk.
      chunks.push(Buffer.from(value.subarray(0, kept)));
      size += kept;
      // Read once past an exactly full buffer to distinguish EOF from truncation.
      if (value.byteLength > available) break;
    }
  } catch (error) {
    readError = error;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  let text, validUTF8 = true;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    validUTF8 = false;
    text = new TextDecoder().decode(bytes);
  }
  return { text, complete, readError, validUTF8 };
}

function excerpt(text, token) {
  let safe = redact(text, token);
  // A response cut off inside a credential must not expose its trailing prefix.
  if (token) {
    const longest = Math.min(token.length - 1, safe.length, EXCERPT_LIMIT);
    for (let length = longest; length > 0; length--) {
      if (safe.endsWith(token.slice(0, length))) {
        safe = safe.slice(0, -length) + "[REDACTED]";
        break;
      }
    }
  }
  return new TextDecoder().decode(Buffer.from(safe).subarray(0, EXCERPT_LIMIT), {
    stream: true,
  });
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
  try {
    let response;
    try {
      // Credentials stay on the original origin; report redirects ourselves.
      response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw failure(`${operation} failed: ${redact(error.message, token)}.`, {
        uncertain: uploading,
      });
    }
    const body = await responseBody(response);
    if (controller.signal.aborted) {
      throw failure(
        `${operation} failed (HTTP ${response.status}): deadline exceeded while reading JSON response.`,
        { status: response.status, uncertain: uploading },
      );
    }
    let data;
    if (body.complete && body.validUTF8) {
      try {
        data = JSON.parse(body.text);
      } catch {
        // A complete HTTP failure need not have a JSON body.
      }
    }
    if (!response.ok) {
      const description = body.readError
        ? excerpt(`Unable to read response: ${body.readError.message}`, token)
        : excerpt(body.text, token);
      throw failure(`${operation} failed (HTTP ${response.status}): ${description}`, {
        status: response.status,
        errorCode:
          body.complete && typeof data?.errorCode === "number"
            ? data.errorCode
            : null,
        uncertain:
          uploading &&
          (!body.complete || (response.status >= 300 && response.status < 400)),
      });
    }
    if (!body.complete || data === undefined) {
      const description = controller.signal.aborted
        ? "deadline exceeded while reading JSON response"
        : !body.complete && !body.readError
          ? "JSON response exceeds size limit"
          : "invalid or incomplete JSON response";
      throw failure(`${operation} failed (HTTP ${response.status}): ${description}.`, {
        status: response.status,
        uncertain: uploading,
      });
    }
    return { data, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadFile({
  fetch,
  url,
  headers,
  blob,
  file,
  metadata,
  token,
  timeoutMs = 600_000,
  now = () => performance.now(),
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onAttempt = async () => {},
  onRetryableRejection = async () => {},
}) {
  const deadline = now() + timeoutMs;
  const metadataJSON = JSON.stringify(metadata);
  const attachment = Object.hasOwn(metadata, "parentFileID");
  let attempts = 0;
  let lastFailure;
  const expired = () =>
    failure("Upload failed: per-file deadline exceeded before another request.", {
      status: lastFailure?.status ?? null,
      errorCode: lastFailure?.errorCode ?? null,
      attempts,
    });
  while (true) {
    if (deadline - now() <= 0) throw expired();
    const form = new FormData();
    form.append("file", blob, path.basename(file));
    form.append("metadata", metadataJSON);
    try {
      await onAttempt(attempts + 1);
    } catch (error) {
      throw failure(`Unable to record upload attempt: ${redact(error.message, token)}.`, {
        attempts,
      });
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw expired();
    attempts++;
    let result;
    try {
      result = await requestJSON(
        fetch,
        url,
        { method: "POST", headers, body: form },
        "Upload",
        token,
        remaining,
        true,
      );
    } catch (error) {
      error.attempts = attempts;
      lastFailure = error;
      if (
        !attachment ||
        error.status !== 400 ||
        error.errorCode !== 1012 ||
        error.uncertain ||
        attempts > RETRY_DELAYS.length
      ) {
        throw error;
      }
      try {
        // Persist the definitive rejection before an interruptible retry delay.
        await onRetryableRejection(attempts);
      } catch (saveError) {
        throw failure(
          `Unable to record rejected upload attempt: ${redact(saveError.message, token)}.`,
          { status: error.status, errorCode: error.errorCode, attempts },
        );
      }
      const remainingForDelay = deadline - now();
      if (remainingForDelay <= 0) throw expired();
      try {
        await wait(Math.min(RETRY_DELAYS[attempts - 1], remainingForDelay));
      } catch (waitError) {
        throw failure(`Upload retry wait failed: ${redact(waitError.message, token)}.`, {
          status: error.status,
          errorCode: error.errorCode,
          attempts,
        });
      }
      continue;
    }
    const id = result.data?.id;
    if (
      (typeof id !== "number" && typeof id !== "string") ||
      !/^\d+$/.test(String(id)) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) <= 0
    ) {
      throw failure(
        `Upload failed (HTTP ${result.status}): response must contain a positive safe-integer file ID.`,
        { status: result.status, uncertain: true, attempts },
      );
    }
    return Number(id);
  }
}

module.exports = { requestJSON, redact, UNCERTAIN, uploadFile };
