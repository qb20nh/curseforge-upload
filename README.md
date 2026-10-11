# CurseForge Uploader

Upload a main file and its required attachments in one action invocation using the [CurseForge upload API](https://support.curseforge.com/en/support/solutions/articles/9000197321-curseforge-upload-api). This is the `qb20nh/curseforge-upload` fork of [itsmeow/curseforge-upload](https://github.com/itsmeow/curseforge-upload), preserving the MIT license and upstream attribution.

## v4 migration

v4.0.0 runs on Node 24 and replaces deprecated `request` with native `fetch`, `URL`, `FormData`, and file-backed `fs.openAsBlob`. The `punycode`, `url.parse()` and `util.isArray()` dependency warnings from v3 are removed. Updating the fork does not change workflows still referencing `itsmeow/curseforge-upload@v3.1.2`: switch their action reference to a published commit of this fork.

All existing input names and the string `id` output are preserved. Ordinary single-file workflows retain their publication behavior. Intentional changes:

- Invalid local inputs stop before any HTTP request. Project/parent IDs must be positive safe integers; the upload must be a readable regular file.
- Version entries are trimmed, empty entries ignored, and resolved IDs deduplicated in requested order. Missing or ambiguous names fail instead of silently dropping entries or choosing multiple matches.
- `parent_file_id` and nonempty `game_versions` are mutually exclusive. Child attachments inherit their parent's version selection.
- Redirects fail without forwarding the token. Only attachment HTTP 400 responses with complete JSON containing numeric `errorCode: 1012` can be retried.
- Only HTTP 2xx JSON responses containing a positive safe-integer file ID succeed. Failed actions emit no `id`.

Supported platforms are GitHub-hosted Ubuntu, Windows and macOS runners. Self-hosted runners must support Node 24 JavaScript actions (runner v2.327.1 or newer); the pinned checkout v6 example additionally needs v2.329.0 or newer. Development requires Node 24. The action runs its committed bundle without `npm install` in the consuming workflow.

## Inputs

| Input | Description | Default | Required |
| --- | --- | --- | --- |
| `token` | CurseForge **upload API token**, passed in `X-Api-Token`; use a repository secret. This is not a CurseForge for Studios API key. | — | Yes |
| `project_id` | Positive safe-integer project ID from the project sidebar. | — | Yes |
| `game_endpoint` | Single game DNS label, e.g. `minecraft`, `bukkit`, `kerbal`; normalized to lowercase. | — | Yes |
| `file_path` | Main file, or an attachment when `parent_file_id` is supplied. Readable regular file; absolute or relative to the working directory. Spaces are supported; its basename is the uploaded filename. | — | Yes |
| `additional_files` | Attachment paths, one exact path per line. No glob expansion, manifest syntax or file-type guessing. Duplicate paths and invalid files fail before uploads. | Omitted | No |
| `receipt` | Path to a saved upload receipt to resume with the same files and metadata. | Omitted | No |
| `game_versions` | Comma-separated positive numeric IDs, names/slugs, or `type:version` selections. | Omitted | No |
| `release_type` | `alpha`, `beta`, or `release`. | `release` | No |
| `manual_release` | `auto` preserves ordinary single-file behavior and requests a hold for a new main file with attachments. `true` requests a hold for every selected file. Explicit `false` is rejected for a new main file with attachments before requests. The API receives a Boolean, never `auto`. Dashboard release remains manual. | `auto` | No |
| `display_name` | New main file's display name; when omitted CurseForge uses the filename. Attachments use their filenames. | Omitted | No |
| `changelog` | Changelog text. | Empty | No |
| `changelog_type` | `text`, `html`, or `markdown`. | `markdown` | No |
| `relations` | Comma-separated `projectslug:relationType` pairs. Types: `embeddedLibrary`, `incompatible`, `optionalDependency`, `requiredDependency`, `tool`. | Omitted | No |
| `parent_file_id` | Positive safe-integer existing parent ID. `file_path` and every additional file become attachments and inherit its versions; omit `game_versions`. | Omitted | No |

## Publication policy

**Accepted** means the upload API returned a valid file ID. **Approved** means CurseForge moderation passed. **Released** means the file is public. An accepted upload establishes neither approval nor release; a dashboard file marked “Pending Release” can be an accepted file awaiting manual release.

| Selected files | `manual_release: auto` (default) | `true` | `false` |
| --- | --- | --- | --- |
| One new main file | No explicit hold; preserves existing publication behavior | Requests a main-file hold | Submits no-hold policy |
| New main with attachments | Requests a main-file hold; attachments receive no explicit hold | Requests a hold for every selected file | Rejected before requests |
| Attachments to `parent_file_id` | No explicit hold on selected attachments | Requests a hold for every selected attachment | Submits no-hold policy on selected attachments |

Existing-parent uploads do not change that parent's publication policy. If it is already public, adding attachments cannot retroactively prevent users seeing an incomplete set. The action does not verify the parent's current visibility.

The [official Upload API documentation](https://support.curseforge.com/en/support/solutions/articles/9000197321-curseforge-upload-api), checked 12 October 2026, documents `isMarkedForManualRelease` for `upload-file`. Its `update-file` operation changes changelog, display name, game versions, release classification and relations; it documents no hold toggle or publication operation. `releaseType` selects alpha/beta/release classification, not visibility. The documented upload-token API provides no file moderation/visibility read or atomic publication operation.

Automatic approval checks, publication and public-state confirmation cannot be delivered through that documented interface. The action adds no automatic-release input or approval wait. After all required files are accepted, verify each file's approval in the dashboard, manually release the held main or selected files held by explicit `true`, and verify every selected file is public. It makes several upload requests, not an atomic batch. Child moderation, visibility before the parent, and whether releasing a parent releases its children remain unverified; a main-file hold is not a verified guarantee about child visibility.

An authorized live check is still needed for attachment acceptance against an approved, unpublished parent and for parent/child publication behavior. Local tests establish request construction and reporting only. Error 1012 means an unavailable or invalid parent; malware scanning is one possible explanation, not a confirmed cause.

## Workflow example

Replace the branch reference below with the full approved, pushed commit SHA before using it in a consuming repository. This change does not create a tag or release.

```yaml
name: Build release
on: workflow_dispatch
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # Run your build to produce mod.jar, mod-sources.jar and evidence.zip.
      - name: Upload mod and required attachments
        id: mod
        uses: qb20nh/curseforge-upload@fix/publication-reporting # Replace with the full approved, pushed commit SHA
        with:
          file_path: build/libs/mod.jar
          additional_files: |
            build/libs/mod-sources.jar
            build/evidence.zip
          game_endpoint: minecraft
          project_id: '12345' # Replace with your project ID
          game_versions: 'Minecraft 1.20:1.20.1,Java 17,Fabric'
          relations: fabric-api:requiredDependency
          token: ${{ secrets.CF_API_TOKEN }}
      - name: Preserve upload receipt
        if: ${{ always() && steps.mod.outputs.receipt != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: curseforge-receipt
          path: ${{ steps.mod.outputs.receipt }}
          if-no-files-found: error
```

Create every selected file before invoking the action. It validates all files and metadata before uploading, accepts the main file once, then uploads attachments sequentially with its numeric ID. Attachment display names use their filenames; they share changelog and release metadata and inherit the parent's game versions. `display_name` applies only to a new main file.

One invocation handles one main-file family. Consumers select their files, restore build artifacts and receipts, and coordinate matrix jobs or cross-version releases. Project-specific target selection, standalone developer downloads and release-note policy remain in the consuming workflow.

Obtain the existing upload token at <https://www.curseforge.com/account/api-tokens> and store it as a repository secret. The action masks it immediately. It is sent only in the authentication header, never in URLs or metadata.

## Version selection

Numeric selections such as `123,456` need no catalog request. Names and slugs are case-sensitive exact matches. A catalog is fetched once per action invocation; type metadata is fetched once only if a named type is specified.

Minecraft and Bukkit can share version names, so `1.20.1` may be ambiguous. Use the precise catalog type name, slug, or ID: for example `Minecraft 1.20:1.20.1` or `<numeric-type-id>:1.20.1`. A requested selection must match exactly one type and version. Mixed selections retain order, with duplicate resolved IDs removed; commas and surrounding whitespace are accepted.

Catalogs use `https://<game_endpoint>.curseforge.com/api/game/versions` and `/api/game/version-types`, authenticated with `X-Api-Token`. Do not put the token in a query string.

Self-hosted runners can configure `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (including lowercase variants). Native fetch uses an explicit Undici environment proxy dispatcher for catalog and upload requests, preserving proxy routing throughout Node 24. TLS certificate verification stays enabled.

## Deadlines and results

Catalog requests have a 30-second deadline each. Each file has one 10-minute upload deadline shared by its requests, response parsing and retry delays. Uploads use native multipart fields `file` and `metadata`; FormData generates the Content-Type boundary automatically. Files remain backed by disk, so avoid modifying them while the action runs.

An attachment retries only after a complete HTTP 400 JSON response with numeric `errorCode` exactly `1012`. It makes at most seven attempts, waiting 2, 4, 8, 16, 30 and 30 seconds between them; the deadline can stop it earlier. Every allowed retry submits the same bytes and metadata. Main uploads, other errors, redirects and uncertain results are never automatically retried.

On complete upload success, `steps.<step-id>.outputs.id` is the accepted ID of `file_path` as a string. It is emitted only after every selected file has an accepted ID. Failure emits no successful `id`. Reports distinguish partial and complete uploads and include the parent ID, accepted/pending files, attempt counts and receipt path.

`steps.<step-id>.outputs.publication_status` is emitted on every action run, including validation and upload failures:

| Value | Meaning |
| --- | --- |
| `held` | The action succeeded, every selected upload was accepted, and its submitted metadata requested a hold for the new main file or for every selected existing-parent attachment. Includes the main-file hold selected by multi-file `auto`. Reports accepted upload policy, not an observed dashboard state or verified current visibility. |
| `pending_approval` | Requires verified server moderation status; never emitted by the current integration. |
| `public` | Requires verified public state for every selected file; never emitted by the current integration. |
| `unknown` | All other cases, including failures and accepted uploads without the explicit hold policy above. Approval and visibility are unverified. |

The job summary lists each filename, accepted ID when known, upload state, moderation (`unknown`) and publication (`held (requested)` only for an accepted file with explicit hold metadata, otherwise `unknown`). Hold reporting uses the metadata submitted during this invocation or the original metadata in its trusted saved receipt. Thus a completed default multi-file run can report overall `held` while individual attachments show `unknown`. This does not assert an observed “Pending Release” state, parent or child visibility, or atomic publication. The summary ends with a concrete next action: finish or reconcile uploads, or inspect approval and release in the dashboard.

Failures report the operation and HTTP status when received. Displayed response text is capped at 4 KiB and the token is redacted. HTTP 5xx server errors, timeouts, connection failures, unreadable or truncated error responses, and invalid success responses leave an **uncertain** upload result: the server may already have accepted the upload. A complete server-error response does not establish that no file was created. Check the project's files before retrying.

## Receipts and resume

Multi-file runs and runs using the `receipt` input expose `steps.<step-id>.outputs.receipt`, including failed uploads. Preserve that file with the always-run artifact step above. Receipt updates are atomic and saved after each accepted upload before the next file starts. Schema version 1 records the project (`projectID`), endpoint, selected parent (`selectedParentID`), accepted parent (`parentID`), the original game-version selections (`versionSelection`), and each file's path, SHA-256 hash, submitted metadata, accepted ID, state and attempts. Receipt JSON is limited to 8 MiB. It contains no credentials; retain it unchanged as trusted local state.

A supplied receipt path is still exposed after local preflight failures so the artifact step can preserve the existing file, unless the path contains the API token. Emitting that path does not establish that the receipt is valid.

Publication reporting keeps schema version 1 unchanged. Upload states `pending`, `uploading`, `accepted` and `uncertain` describe upload progress only. Neither an accepted receipt entry nor its saved hold metadata verifies approval or current publication state.

To resume, restore the identical upload files at the same paths, download the preserved receipt, and repeat the original file selections and metadata. The action checks paths, hashes, metadata, project, endpoint and parent identity before upload requests, reuses the accepted main and attachments, and uploads only missing files. Named game-version selections reuse the receipt's original catalog resolution without another catalog request. Local receipts cannot verify later changes or deletion on CurseForge.

For example, use a separate recovery workflow with the failed run ID as an input:

```yaml
name: Resume CurseForge upload
on:
  workflow_dispatch:
    inputs:
      receipt_run_id:
        description: Run ID containing the preserved curseforge-receipt artifact
        required: true
permissions:
  contents: read
  actions: read
jobs:
  resume:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      # Restore the original mod.jar, mod-sources.jar and evidence.zip at their original paths.
      - uses: actions/download-artifact@v4
        with:
          name: curseforge-receipt
          run-id: ${{ inputs.receipt_run_id }}
          github-token: ${{ github.token }}
          path: saved-receipt
      - name: Resume missing uploads
        id: mod
        uses: qb20nh/curseforge-upload@fix/publication-reporting # Replace with the full approved, pushed commit SHA
        with:
          receipt: saved-receipt/receipt.json
          file_path: build/libs/mod.jar
          additional_files: |
            build/libs/mod-sources.jar
            build/evidence.zip
          game_endpoint: minecraft
          project_id: '12345'
          game_versions: 'Minecraft 1.20:1.20.1,Java 17,Fabric'
          relations: fabric-api:requiredDependency
          token: ${{ secrets.CF_API_TOKEN }}
      - name: Preserve updated receipt
        if: ${{ always() && steps.mod.outputs.receipt != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: curseforge-receipt
          path: ${{ steps.mod.outputs.receipt }}
          if-no-files-found: error
```

A file in `uploading` or `uncertain` state blocks resume until you reconcile it in the CurseForge dashboard. After confirming acceptance, edit only that entry's `state` to `accepted` and `id` to the positive numeric remote file ID. Only after confirming no remote file was created may you set `state` to `pending` and `id` to `null`. Keep paths, hashes, metadata and other entries unchanged; a reconciled main ID automatically fills its pending attachments' parent references. Reuse the accepted parent; do not upload another main file for recovery.

Older action versions may have saved an HTTP 5xx upload as `pending`. Reconcile that file in the dashboard before resuming; updating the action cannot determine whether the earlier request created a file.

A workflow record proving this action was skipped is different from an uncertain upload. A skipped action made no upload requests and emits no action outputs; an invocation that started and lost its result must use the dashboard reconciliation above. A consumer's separate recovery approval for skipped jobs does not reconcile uncertain uploader results.

## Development and validation

```sh
node --version # Node 24
npm ci
npm run build
npm test
npm audit --omit=dev --audit-level=high
git diff --exit-code -- dist/
git ls-files --others -- dist/ # Must print nothing
```

The plain CommonJS implementation is in `upload.js`; `curseforge-upload.js` is the thin action entrypoint. `@actions/core` v3 exposes ESM exports and is bundled using dynamic import while keeping this project CommonJS. Commit the generated `dist/index.js` with code changes.

Tests use Node's built-in runner with `--throw-deprecation`, local HTTP servers, native multipart parsing, and a copied standalone bundle running as a child process with GitHub input/output files. They never contact CurseForge or require real credentials. CI runs the same checks on Ubuntu, Windows and macOS, with read-only repository permissions and no upload secrets. The unreadable-file test is skipped on Windows and for effective UID 0 on POSIX, where chmod cannot establish read denial. CI also runs the full suite as root on Ubuntu.

Local tests verify request construction and failure handling; they do not establish acceptance by the live CurseForge service. A real upload remains a separate service-acceptance check requiring approval. Tags, releases and changes to consuming repositories are also outside this implementation.
