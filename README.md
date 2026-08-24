# cookidoo-axi

`cookidoo-axi` is an unofficial, agent-friendly CLI for Apple Silicon Macs and
the Polish Cookidoo web API modeled by the `cookidoo-openapi` specification. It
maps all 58 OpenAPI operations while putting request validation, bounded
output, and mutation safety in front of the transport.

It is not affiliated with or supported by Vorwerk, Thermomix, or Cookidoo. Use
it only with accounts and resources you are authorized to access.

The current `0.1.0-beta.3` line is a Homebrew-distributed beta for Apple
Silicon (arm64), tested on macOS 15, and scoped to the Polish Cookidoo
platform. Treat its API and output contract as pre-stable until a later
non-prerelease version. Intel Macs, older macOS releases, and other Cookidoo
markets are unsupported.

## Requirements and installation

- An Apple Silicon Mac (arm64) running macOS 15 or newer
- [Homebrew](https://brew.sh/)
- An authorized Cookidoo account for protected market operations

Install the supported beta from the public Homebrew tap:

```sh
brew install aimlesx/tap/cookidoo-axi
cookidoo-axi --version
```

The Formula supplies its required Node.js runtime. This beta is not published
to npm, and source-checkout installation is not a supported distribution path.

Upgrade after a new release reaches the tap:

```sh
brew update
brew upgrade aimlesx/tap/cookidoo-axi
```

Before uninstalling, remove every profile whose Keychain records should be
deleted. Repeat the exact-confirmed command with each profile name:

```sh
cookidoo-axi auth remove --profile default --confirm default
brew uninstall cookidoo-axi
```

`auth remove` deletes only this tool's market-credential, cookie-session, and
feed-credential records for that exact profile. Homebrew uninstall deliberately
does not remove Keychain records. If you uninstall first, reinstall the Formula
before using `auth remove`; do not perform a broad Keychain deletion.

Authenticated API operations are fixed to the exact origin
`https://cookidoo.pl`. The separate browser login flow follows only three exact
HTTPS hosts (`cookidoo.pl`, the Cookidoo CIAM host, and `eu.login.vorwerk.com`)
and submits credentials only to the generated form action on that allowlist.
Other markets and wildcard identity hosts are deliberately unsupported.

## Credentials and login

Import the existing local environment file once, then make a direct read-only
protected request. Protected reads create and verify a cookie session
automatically when one is not cached:

```sh
cookidoo-axi auth import-env --env-file .env
cookidoo-axi profile get-localized
```

`auth status` and `auth login` are optional diagnostic/eager-session commands,
not prerequisites for protected requests. Bare `auth status` is prompt-free: it
does not open Keychain and reports the market-credential, cookie-session, and
feed-credential states as `not-checked`. Add `--inspect session`, `--inspect
market`, or `--inspect feed` to decrypt only that selected record. `--inspect
all` decrypts all three records sequentially so authorization prompts cannot
overlap. Only explicit inspections request Keychain reads.

`auth import-env` reads a bounded, owner-only (`0600`), regular, non-symlink file without evaluating
shell syntax. It returns only the selected variable names and writes the email
and password directly to the `cookidoo-axi.credentials.v1` macOS Keychain
service. It does not edit or delete the source file. The complete serialized
cookie jar is stored separately in `cookidoo-axi.cookie-session.v1`; cookies
are never flattened, printed, or written to a project file.

When macOS asks for Keychain access, **Allow** approves that access once.
**Always Allow** authorizes the executable identified in the dialog for future
access to that exact Keychain item. Market credentials, cookie sessions, and
feed credentials are separate items, so each can prompt once. macOS may ask
again if the executable changes.
Choose it only when the displayed requester is expected and trusted, and reject
unexpected requesters. With the current Homebrew installation, a dialog that
identifies Node.js grants that exact Node executable access—not only this CLI—so
other scripts run by that Node binary share the authorization. Use **Allow** if
you do not accept that tradeoff. Separate credential, session, and feed items
can each produce their own prompt.

A Homebrew Formula makes command discovery and the Node runtime deterministic,
but it does not turn this JavaScript CLI into a separately signed macOS
executable. Keychain therefore still identifies the Homebrew-managed Node
binary as the requester. Homebrew/Node upgrades can change that identity, and
Always Allow remains broader than this one CLI. Use Allow unless that tradeoff
is acceptable.

Local Codex commands normally run inside the macOS Seatbelt sandbox. That
sandbox cannot see the login Keychain used by this CLI, so a protected command
must run outside it with command-scoped approval. `cookidoo-axi` detects
`CODEX_SANDBOX=seatbelt` before native Keychain access and returns
`KEYCHAIN_SANDBOXED`; it never treats the isolated view as proof that records
are missing. Formula resolution, `auth doctor`, bare `auth status`, help,
operation discovery, and API operation dry runs remain safe inside the sandbox
because they do not access a Keychain item. Auth utilities reject `--dry-run`
instead of treating it as validation. Do not re-import credentials in response to
a sandboxed failure.

Replacing an existing Keychain record requires
`--confirm replace:market:<profile>`. A successful replacement also removes the
old cached cookie session so credentials and session identity cannot diverge.

Protected commands create a fresh browser-cookie session automatically when
needed. A session is accepted only after `GET /community/profile/pl` succeeds as
an identity-bearing protected JSON read; marker-cookie presence alone is not
treated as proof.

The three feed operations use a distinct Basic scheme whose credential
acquisition is not documented by the upstream specification. If independently
supplied feed credentials are available, import them into a separate Keychain
namespace:

```sh
cookidoo-axi auth import-feed-env --env-file ./feed.env
```

The file must contain `COOKIDOO_FEED_USERNAME` and
`COOKIDOO_FEED_PASSWORD`. Account credentials are never reused as feed
credentials.

Credential deletion is exact-confirmed:

```sh
cookidoo-axi auth clear-session --confirm session:default
cookidoo-axi auth remove --profile default --confirm default
```

## Safety, privacy, and responsible use

The CLI has no telemetry or analytics. It reads credentials only from an
explicitly selected import file and stores credentials and cookie sessions as
separate macOS Keychain items. Protected API traffic is limited to the fixed
Cookidoo origin; login traffic is limited to the exact identity hosts listed
above. Structured output is recursively redacted, but command arguments,
shell history, redirected output, and files supplied with `--data` remain the
operator's responsibility. Redaction targets credential-shaped keys and URL
parameters; recipe text and other requested account content are still returned
and may be private. Use a dedicated profile for each account and never share a
Keychain item, session export, debug transcript, or `.env` file.

This tool does not control a Thermomix or start appliance programs. Recipe,
ingredient, timing, temperature, accessory, allergen, and nutrition data may be
incomplete, user-authored, stale, or mistranscribed. Verify safety-critical
instructions in the official Cookidoo/app appliance interface and the device
manual; check allergens and food-safety temperatures independently. Do not use
an agent-generated command as a substitute for supervision of an appliance.

Use only your own authorized accounts and resources. Respect platform terms,
rate limits, copyright, privacy, and technical access controls; do not use this
client to bypass controls or perform bulk collection. Destructive and public
operations remain the caller's responsibility even when the CLI requires an
exact confirmation. Security reports should follow [`SECURITY.md`](SECURITY.md).

An unofficial-project disclaimer is not permission from the platform owner.
Review the applicable
[Cookidoo terms](https://cookidoo.pl/consent/web/documents/pl-PL/latest/tos),
copyright, contract, and trademark rules before use. This project does not make
a legal conclusion about whether a particular interoperability use is permitted.

## Discovering and invoking the API

The bare command and bare `auth status` show compact context without opening
Keychain. Use `profile get-localized` for a direct read-only
authentication/session check; status inspection is optional diagnostics, not an
onboarding prerequisite. Inspect one record with `auth status --inspect
session|market|feed`, or all three sequentially with `--inspect all`. Focused
discovery is available without network access:

```sh
cookidoo-axi
cookidoo-axi profile get-localized
cookidoo-axi --help
cookidoo-axi created --help
cookidoo-axi created create --help
cookidoo-axi operation list --full
cookidoo-axi operation describe createCreatedRecipe
```

The friendly command groups cover the entire specification:

| Group | Capabilities |
| --- | --- |
| `recipe` | Official recipe and recipe-cluster reads |
| `search` | Recipe, stripe, and ingredient search |
| `created` | List, create, copy, read, edit, publish, unpublish, public read, delete, guarded import-like mode |
| `organize` | Bookmarks, custom lists, managed lists, moves, and shares |
| `planning` | Week/day reads, add/remove/move recipes |
| `shopping` | Recipes, ingredients, additional items, ownership, clear |
| `note` | Create, read, update, and delete recipe notes |
| `rating` | Aggregate read and user rating write |
| `profile` | Community profile reads and update |
| `subscription` | Subscription read |
| `device` | Versions, guarded link, and unlink |
| `feed` | Basic-auth bootstrap, list, and page reads |
| `operation` | Exact OpenAPI lookup and full-surface escape hatch |

Examples:

```sh
cookidoo-axi profile get-localized
cookidoo-axi search recipes --query risotto --limit 5
cookidoo-axi recipe get r123456 --fields id,name,totalTime
cookidoo-axi created list --max-items 10
cookidoo-axi created create --recipe-name "Private AXI draft" --dry-run
cookidoo-axi operation run getRecipe r123456 --output json
```

Every path and query value is derived from the generated manifest. Request
bodies can use schema-derived top-level flags, repeatable `--set path=value`,
or exactly one complete JSON source:

```sh
cookidoo-axi created create --recipe-name "Private draft" --dry-run
cookidoo-axi planning add --recipe-ids r123456 --day-key 2026-08-21 --dry-run
cookidoo-axi operation run movePlannedRecipe --data @request.json --dry-run
```

`--data` accepts inline JSON, `@file`, or `-` for stdin and is capped at 1 MiB.
Search filters use repeatable `--filter key=value`; duplicate emitted query keys
fail closed. The schema's extensible filter map accepts bounded, safe extension
names, but their semantics remain opaque. Search pagination is not auto-followed. Feed page
timestamps prefer ISO 8601; numeric values require the explicit
`--page-before-seconds` or `--page-before-milliseconds` flag.

## Mutation safety

Dry-run validates paths, query parameters, JSON Schema, and every safety gate,
then returns before Keychain access, login, or network dispatch:

```sh
cookidoo-axi created delete 01ARZ3NDEKTSV4RRFFQ69G5FAV --dry-run
```

The result supplies the exact confirmation token when one is required:

```sh
cookidoo-axi created delete 01ARZ3NDEKTSV4RRFFQ69G5FAV \
  --confirm created-recipe:01ARZ3NDEKTSV4RRFFQ69G5FAV:delete
```

Safety properties:

- no mutation is automatically retried;
- cookie-auth mutations perform a protected read before their single dispatch;
- timeouts, lost connections, and ambiguous server failures return a
  reconciliation instruction instead of guessing or replaying;
- destructive, externally visible, rating, and device actions require an exact
  request-derived confirmation;
- advertised-only mutations are blocked unless `--allow-unverified` is also
  present;
- shopping POST removals are treated as destructive even though their HTTP verb
  is POST;
- ordinary created-recipe content edits are private writes, while publication
  state is exposed only through the guarded `created publish` and
  `created unpublish` commands;
- the mutation-sounding query parameters on the created-recipe list are removed
  from the normal list path and exposed only as guarded `created import`.

The raw `operation run` path uses the same canonical request validation and
safety metadata; it cannot weaken risk flags or replace an operation's method,
path, or command identity.

## Output contract

Structured stdout defaults to strict TOON 4.1 and can be changed to compact JSON
with `--output json`. Results use a stable envelope with:

- `data` and `kind`;
- explicit `completeness` (`empty`, `complete`, `partial`, or `unknown`);
- local item/content `truncation` and an exact `--full` escape hatch;
- requested-field `selection` metadata;
- conservative recursive secret `redaction` metadata;
- bounded `context` and at most three `next` commands.

Collections, nested arrays, and wide objects are bounded by default, and strings
display at most 500 Unicode code points. Use `--max-items`, `--fields`, or
`--full` deliberately. Known collection operations use an ID-and-discriminator
agent-default projection; `context.projection` lists it, while `--fields`
overrides it and `--full` bypasses local presentation bounds (the transport's
8 MiB response cap still applies).
TOON output is decoded again in strict mode before it reaches stdout. Human
debug diagnostics go only to stderr; structured errors use stdout like other
agent-facing results. Usage failures exit `2`; operational, auth, and transport
failures exit `1`.

The default format is an interoperability choice, not a claim that TOON is
smaller for every response or model tokenizer. Agents with a measured JSON
advantage for their actual trajectory should select `--output json`.

## Agent skill integration

The portable agent skill is shared by Codex and Claude Code. It dynamically
discovers the current CLI surface and deliberately executes only the installed
Homebrew Formula, never this source checkout.

### From this source repository

The canonical skill is committed at `skills/cookidoo-axi/SKILL.md`. Git-tracked
discovery links expose that one file without duplicated instructions:

- Codex: `.agents/skills/cookidoo-axi`
- Claude Code: `.claude/skills/cookidoo-axi`

Opening this repository in either agent is sufficient; do not run a skill
installer inside this checkout.

For a manual Git-based copy, use a trusted checkout pinned to a release tag or
commit and copy only `skills/cookidoo-axi/SKILL.md` into the selected agent's
`cookidoo-axi` skill directory. This is an optional, unmanaged alternative: the
CLI will not fetch a mutable branch, and `skill install`/`skill remove` will
refuse to overwrite or remove the manual copy.

### From an installed release

The Homebrew release bundles the same canonical skill. Install it into one or
both existing, non-symlink skills directories. The directory flag names the
parent skills root; the command creates its `cookidoo-axi` child:

```sh
mkdir -p /absolute/path/to/repo/.agents/skills
cookidoo-axi skill install \
  --skills-directory /absolute/path/to/repo/.agents/skills

mkdir -p /absolute/path/to/repo/.claude/skills
cookidoo-axi skill install \
  --skills-directory /absolute/path/to/repo/.claude/skills
```

Installation is idempotent for an unchanged managed copy and refuses to
overwrite an unowned skill. It does not add project hooks. Removal requires the
exact installed child path and removes only a copy owned by this CLI:

```sh
cookidoo-axi skill remove \
  --skills-directory /absolute/path/to/repo/.agents/skills \
  --confirm /absolute/path/to/repo/.agents/skills/cookidoo-axi
```

Repeat the removal with `.claude/skills` when both copies were installed.

### Breaking beta migration

The former `setup codex`, `setup remove`, and `hook session-start` integration
is replaced by the portable `skill` commands and no longer installs a Codex
hook. Before upgrading a beta installation that used `setup codex`, remove its
generated skill and hook with that currently installed beta:

```sh
cookidoo-axi setup remove --directory /absolute/path/to/repo \
  --confirm /absolute/path/to/repo
brew update
brew upgrade aimlesx/tap/cookidoo-axi
```

Then use `skill install` for the chosen Codex and/or Claude Code skills root as
shown above. Repositories that never used the legacy setup require no cleanup.
If the new installer reports `LEGACY_SKILL_CONFLICT`, it intentionally leaves
the old integration untouched, including `.codex/hooks.json`. Use the retained
`0.1.0-beta.1` executable to run the legacy removal, or manually review and
remove only the legacy `SKILL.md` carrying
`<!-- generated-by: cookidoo-axi -->` and the
`SessionStart` handler whose status is
`Loading cookidoo-axi context [managed:v1]`; preserve every unrelated hook and
file before running `skill install`.

## License

Original work in this repository is available under the [MIT License](LICENSE).
See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
provenance, trademark, and bundled-specification notices.
