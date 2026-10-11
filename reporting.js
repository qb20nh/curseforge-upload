const path = require("node:path");
const { redact } = require("./transport");

function publicationStatus(report) {
  const { files, selectedParentID } = report;
  if (report.failed || !files.length || !files.every((file) => file.state === "accepted"))
    return "unknown";
  const heldMain = selectedParentID === null &&
    files[0].metadata?.isMarkedForManualRelease === true;
  const heldFiles = files.every(
    (file) => file.metadata?.isMarkedForManualRelease === true,
  );
  return heldMain || heldFiles ? "held" : "unknown";
}

function nextAction(report) {
  const uncertain = report.reconciliation ? [report.reconciliation] : report.files.filter(
    (file) => ["uploading", "uncertain"].includes(file.state),
  );
  if (uncertain.length) {
    const names = uncertain.map((file) =>
      `${path.basename(file.path)}${file.id ? ` (ID ${file.id})` : ""}`,
    ).join(", ");
    return `Reconcile ${names} in the CurseForge dashboard before ${report.receiptPath ? "resuming the saved receipt" : "retrying the upload"}.`;
  }
  if (report.files.some((file) => file.state === "unknown"))
    return "Fix the reported error and validate the saved receipt in the CurseForge dashboard before resuming.";
  if (!report.files.length || report.files.some((file) => file.state === "not attempted"))
    return "Fix the reported input error before rerunning the action.";
  if (!report.files.every((file) => file.state === "accepted"))
    return report.receiptPath
      ? "Fix the reported error, then resume only missing files using the saved receipt."
      : "Fix the reported error before retrying the upload.";
  if (report.failed && report.receiptPath)
    return "Reconcile the saved receipt with the accepted file IDs in the CurseForge dashboard before resuming.";
  return publicationStatus(report) === "held"
    ? "Check every selected file's approval in the CurseForge dashboard, release the held files only after the complete set is approved, then verify every selected file is public."
    : "Verify approval and publication of every selected file in the CurseForge dashboard.";
}

function renderSummary(report, token) {
  // Actions' summary helpers accept raw HTML; escape every user-controlled value.
  const escape = (value) => redact(value, token)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const status = publicationStatus(report);
  const rows = report.files.map((file) => {
    const publication = file.state === "accepted" &&
      file.metadata?.isMarkedForManualRelease === true
      ? "held (requested)" : "unknown";
    const cells = [path.basename(file.path), file.id || "unknown", file.state,
      "unknown", publication].map((value) => `<td>${escape(value)}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  });
  let summary = `<h3>CurseForge upload</h3>\n<p>Publication status: ${status}. Approval and public visibility are unverified; a hold reflects the requested upload policy.</p>\n`;
  summary += "<table><tr><th>File</th><th>ID</th><th>Upload</th><th>Moderation</th><th>Publication</th></tr>" + rows.join("") + "</table>\n";
  if (report.selectedParentID)
    summary += `<p>Existing parent ID: ${escape(report.selectedParentID)}. Its visibility is unverified; adding attachments cannot guarantee that the parent stays private.</p>\n`;
  if (report.receiptPath)
    summary += `<p>Receipt: <code>${escape(report.receiptPath)}</code></p>\n`;
  return summary + `<p>Next action: ${escape(nextAction(report))}</p>\n`;
}

module.exports = { publicationStatus, renderSummary };
