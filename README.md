# CurseForge Uploader

Upload one file to the [CurseForge upload API](https://support.curseforge.com/en/support/solutions/articles/9000197321-curseforge-api). This is the `qb20nh/curseforge-upload` fork of [itsmeow/curseforge-upload](https://github.com/itsmeow/curseforge-upload), preserving the MIT license and upstream attribution.

## v4 migration

v4.0.0 runs on Node 24 and replaces deprecated `request` with native `fetch`, `URL`, `FormData`, and file-backed `fs.openAsBlob`. The `punycode`, `url.parse()` and `util.isArray()` dependency warnings from v3 are removed. Updating the fork does not change workflows still referencing `itsmeow/curseforge-upload@v3.1.2`: switch their action reference to a published commit of this fork.

All existing input names and the string `id` output are preserved. Valid existing workflows retain their defaults. Intentional changes:

- Invalid local inputs stop before any HTTP request. Project/parent IDs must be positive safe integers; the upload must be a readable regular file.
- Version entries are trimmed, empty entries ignored, and resolved IDs deduplicated in requested order. Missing or ambiguous names fail instead of silently dropping entries or choosing multiple matches.
- `parent_file_id` and nonempty `game_versions` are mutually exclusive. Child attachments inherit their parent's version selection.
- Redirects fail without forwarding the token. There are no automatic upload retries.
- Only HTTP 2xx JSON responses containing a positive safe-integer file ID succeed. Failed actions emit no `id`.

Supported platforms are GitHub-hosted Ubuntu, Windows and macOS runners. Self-hosted runners must support Node 24 JavaScript actions (runner v2.327.1 or newer); the pinned checkout v6 example additionally needs v2.329.0 or newer. Development requires Node 24. The action runs its committed bundle without `npm install` in the consuming workflow.

## Inputs

| Input | Description | Default | Required |
| --- | --- | --- | --- |
| `token` | CurseForge **upload API token**, passed in `X-Api-Token`; use a repository secret. This is not a CurseForge for Studios API key. | — | Yes |
| `project_id` | Positive safe-integer project ID from the project sidebar. | — | Yes |
| `game_endpoint` | Single game DNS label, e.g. `minecraft`, `bukkit`, `kerbal`; normalized to lowercase. | — | Yes |
| `file_path` | Readable regular file; absolute or relative to the current working directory. Spaces are supported; the uploaded filename is its basename. | — | Yes |
| `game_versions` | Comma-separated positive numeric IDs, names/slugs, or `type:version` selections. | Omitted | No |
| `release_type` | `alpha`, `beta`, or `release`. | `release` | No |
| `display_name` | Display name; when omitted CurseForge uses the filename. | Omitted | No |
| `changelog` | Changelog text. | Empty | No |
| `changelog_type` | `text`, `html`, or `markdown`. | `markdown` | No |
| `relations` | Comma-separated `projectslug:relationType` pairs. Types: `embeddedLibrary`, `incompatible`, `optionalDependency`, `requiredDependency`, `tool`. | Omitted | No |
| `parent_file_id` | Positive safe-integer parent file ID for an attachment. Omit `game_versions`. | Omitted | No |

## Workflow example

Pin the action to a full commit SHA from this fork. The example SHA below is the v4 implementation/bundle commit; it must be pushed to the fork before another repository can use it. No v4 tag or release is created by this change.

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
      # Prepare Java and run your existing build here to produce mod.jar.
      - name: Export build paths
        id: build
        shell: bash
        run: echo "file=build/libs/mod.jar" >> "$GITHUB_OUTPUT"
      - name: Upload primary mod
        id: mod
        uses: qb20nh/curseforge-upload@ca94ed0392ea2a4d975f0eef5e02f7805aa30469 # v4 implementation
        with:
          file_path: ${{ steps.build.outputs.file }}
          game_endpoint: minecraft
          project_id: '12345' # Replace with your project ID
          game_versions: 'Minecraft 1.20:1.20.1,Java 17,Fabric'
          relations: fabric-api:requiredDependency
          token: ${{ secrets.CF_API_TOKEN }}
      - name: Upload sources attachment
        uses: qb20nh/curseforge-upload@ca94ed0392ea2a4d975f0eef5e02f7805aa30469 # v4 implementation
        with:
          file_path: build/libs/mod-sources.jar
          game_endpoint: minecraft
          project_id: '12345'
          parent_file_id: ${{ steps.mod.outputs.id }}
          token: ${{ secrets.CF_API_TOKEN }}
      - name: Upload evidence attachment
        uses: qb20nh/curseforge-upload@ca94ed0392ea2a4d975f0eef5e02f7805aa30469 # v4 implementation
        with:
          file_path: build/evidence.zip
          game_endpoint: minecraft
          project_id: '12345'
          parent_file_id: ${{ steps.mod.outputs.id }}
          token: ${{ secrets.CF_API_TOKEN }}
```

Each invocation uploads exactly one file. The primary mod is uploaded first; separate sources-JAR and evidence-ZIP steps refer to its returned ID. Create those files in your own build before uploading.

Obtain the existing upload token at <https://www.curseforge.com/account/api-tokens> and store it as a repository secret. The action masks it immediately. It is sent only in the authentication header, never in URLs or metadata.

## Version selection

Numeric selections such as `123,456` need no catalog request. Names and slugs are case-sensitive exact matches. A catalog is fetched once per action invocation; type metadata is fetched once only if a named type is specified.

Minecraft and Bukkit can share version names, so `1.20.1` may be ambiguous. Use the precise catalog type name, slug, or ID: for example `Minecraft 1.20:1.20.1` or `<numeric-type-id>:1.20.1`. A requested selection must match exactly one type and version. Mixed selections retain order, with duplicate resolved IDs removed; commas and surrounding whitespace are accepted.

Catalogs use `https://<game_endpoint>.curseforge.com/api/game/versions` and `/api/game/version-types`, authenticated with `X-Api-Token`. Do not put the token in a query string.

Self-hosted runners can configure `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (including lowercase variants). Native fetch uses an explicit Undici environment proxy dispatcher for catalog and upload requests, preserving proxy routing throughout Node 24. TLS certificate verification stays enabled.

## Deadlines and results

Catalog requests have a 30-second deadline each. The upload has a 10-minute deadline including response parsing. Uploads use native multipart fields `file` and `metadata`; FormData generates the Content-Type boundary automatically. Upload file contents are backed by the file on disk, so avoid modifying it while the action runs.

On success, `steps.<step-id>.outputs.id` is the accepted file ID as a string. API acceptance does not mean moderation is complete: CurseForge moderation may still be pending.

Failures report the operation and HTTP status when received. Displayed response text is capped at 4 KiB and the token is redacted. After a timeout, connection loss, or invalid success response, the result is **uncertain**: the server may already have accepted the upload. Check the project's files before retrying. There is exactly one upload attempt per invocation.

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
