import { mkdir, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { OperationalError, UsageError } from "./errors.js";
import {
  commandArgument,
  commandLiteral,
  renderCommand,
} from "./cli/command.js";

const STATUS_MARKER = "Loading cookidoo-axi context [managed:v1]";
const SKILL_MARKER = "<!-- generated-by: cookidoo-axi -->";

interface HookHandler {
  type?: string;
  command?: string;
  statusMessage?: string;
  additionalContextLimit?: number;
  timeout?: number;
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface HooksFile {
  description?: string;
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export async function installCodexIntegration(input: {
  directory: string;
  executablePath: string;
}): Promise<Record<string, unknown>> {
  const root = await resolveDirectory(input.directory);
  const hooksPath = join(root, ".codex", "hooks.json");
  const skillPath = join(root, ".agents", "skills", "cookidoo-axi", "SKILL.md");
  await assertSafeTarget(root, hooksPath);
  await assertSafeTarget(root, skillPath);
  const hooks = await readHooks(hooksPath);
  const sessionStart = removeGeneratedHandlers(hooks.hooks?.SessionStart ?? []);
  sessionStart.push({
    matcher: "startup|resume",
    hooks: [{
      type: "command",
      command: renderCommand([
        commandArgument(resolve(input.executablePath)),
        commandLiteral("hook"),
        commandLiteral("session-start"),
      ]),
      statusMessage: STATUS_MARKER,
      additionalContextLimit: 1000,
      timeout: 3
    }]
  });
  const updated: HooksFile = {
    ...hooks,
    description: hooks.description ?? "Optional lifecycle hooks for this workspace.",
    hooks: { ...(hooks.hooks ?? {}), SessionStart: sessionStart }
  };

  await mkdir(dirname(hooksPath), { recursive: true });
  await mkdir(dirname(skillPath), { recursive: true });
  await assertSafeTarget(root, hooksPath);
  await assertSafeTarget(root, skillPath);
  await assertSkillOwnedOrAbsent(skillPath);
  await atomicWrite(hooksPath, `${JSON.stringify(updated, null, 2)}\n`);
  await atomicWrite(skillPath, skillDocument(resolve(input.executablePath)));
  return {
    result: "installed",
    scope: root,
    files: [relativeToRoot(root, hooksPath), relativeToRoot(root, skillPath)],
    hookTrustRequired: true,
    codexUiActions: [
      { input: "/hooks", description: "Review the installed workspace hook in Codex." },
      { input: "$cookidoo-axi", description: "Invoke the installed Codex skill." },
    ],
  };
}

export async function removeCodexIntegration(input: {
  directory: string;
  confirm?: string;
}): Promise<Record<string, unknown>> {
  const root = await resolveDirectory(input.directory);
  if (input.confirm !== root) {
    throw new UsageError("CONFIRMATION_REQUIRED", `Removal requires --confirm ${JSON.stringify(root)}`);
  }
  const hooksPath = join(root, ".codex", "hooks.json");
  const skillPath = join(root, ".agents", "skills", "cookidoo-axi", "SKILL.md");
  await assertSafeTarget(root, hooksPath);
  await assertSafeTarget(root, skillPath);
  const removed: string[] = [];

  const hooks = await readHooks(hooksPath);
  const existing = hooks.hooks?.SessionStart ?? [];
  const filtered = removeGeneratedHandlers(existing);
  if (filtered.length !== existing.length || countHandlers(filtered) !== countHandlers(existing)) {
    const nextHooks = { ...(hooks.hooks ?? {}) };
    if (filtered.length) nextHooks.SessionStart = filtered;
    else delete nextHooks.SessionStart;
    await atomicWrite(hooksPath, `${JSON.stringify({ ...hooks, hooks: nextHooks }, null, 2)}\n`);
    removed.push(relativeToRoot(root, hooksPath));
  }

  if (await isOwnedSkill(skillPath)) {
    await unlink(skillPath);
    removed.push(relativeToRoot(root, skillPath));
  }
  return { result: removed.length ? "removed" : "already_absent", scope: root, files: removed };
}

export function sessionStartContext(executablePath: string): Record<string, unknown> {
  const executable = collapseHome(resolve(executablePath));
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        `${executable} provides bounded Cookidoo API access for the Polish market.`,
        "Credentials and cookie sessions are stored in macOS Keychain; stdout defaults to TOON.",
        "Run `cookidoo-axi` for Keychain-free scope, then `cookidoo-axi profile get-localized`",
        "for a direct read-only protected check; protected reads log in automatically.",
        "Bare `auth status` is prompt-free and reports not-checked. Optional `--inspect`",
        "decrypts only session, market, or feed; `--inspect all` does all three sequentially.",
        "In a macOS prompt, Allow approves one access; Always Allow trusts the identified",
        "executable for that item, and macOS may prompt again if the executable changes.",
        "If the requester is Node.js, that trust applies to the exact Node binary, not only",
        "this CLI; use Allow unless that broader local trust is acceptable.",
        "Always dry-run or supply exact confirmations for guarded mutations."
      ].join(" ")
    }
  };
}

async function resolveDirectory(value: string): Promise<string> {
  const path = resolve(value);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("not a direct directory");
    return await realpath(path);
  } catch {
    throw new UsageError("INVALID_DIRECTORY", `Directory must be an existing non-symlink directory: ${path}`);
  }
}

async function assertSafeTarget(root: string, target: string): Promise<void> {
  if (!target.startsWith(`${root}/`)) {
    throw new OperationalError("UNSAFE_SETUP_PATH", "Generated setup paths must remain inside the selected directory");
  }
  const relative = target.slice(root.length + 1).split("/");
  let current = root;
  for (const segment of relative) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new OperationalError("UNSAFE_SETUP_PATH", `Refusing to follow a setup symlink: ${current}`);
      }
      if (current !== target && !metadata.isDirectory()) {
        throw new OperationalError("UNSAFE_SETUP_PATH", `Setup parent is not a directory: ${current}`);
      }
      if (current === target && !metadata.isFile()) {
        throw new OperationalError("UNSAFE_SETUP_PATH", `Setup target is not a regular file: ${current}`);
      }
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }
}

async function readHooks(path: string): Promise<HooksFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(parsed) || (parsed.hooks !== undefined && !isObject(parsed.hooks))) {
      throw new Error("expected an object with an optional hooks object");
    }
    return parsed as HooksFile;
  } catch (error) {
    if (isNotFound(error)) return {};
    if (error instanceof SyntaxError) {
      throw new OperationalError("INVALID_HOOKS_FILE", `Refusing to overwrite invalid JSON: ${path}`);
    }
    if (error instanceof OperationalError) throw error;
    throw new OperationalError("HOOKS_READ_FAILED", `Could not safely read ${path}`);
  }
}

function removeGeneratedHandlers(groups: HookMatcher[]): HookMatcher[] {
  return groups.flatMap((group) => {
    const original = group.hooks ?? [];
    const handlers = original.filter((handler) => handler.statusMessage !== STATUS_MARKER);
    if (handlers.length === original.length) return [group];
    if (handlers.length === 0) return [];
    return [{ ...group, hooks: handlers }];
  });
}

function countHandlers(groups: HookMatcher[]): number {
  return groups.reduce((total, group) => total + (group.hooks?.length ?? 0), 0);
}

async function assertSkillOwnedOrAbsent(path: string): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    if (!content.includes(SKILL_MARKER)) {
      throw new OperationalError("SKILL_EXISTS", `Refusing to overwrite an unowned skill: ${path}`);
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function isOwnedSkill(path: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(SKILL_MARKER);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw new OperationalError("SKILL_READ_FAILED", `Could not safely read ${path}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function skillDocument(executablePath: string): string {
  const executable = renderCommand([commandArgument(executablePath)]);
  return `---
name: cookidoo-axi
description: Safely query and manage an authorized Cookidoo account with the cookidoo-axi CLI. Use for Cookidoo recipes, search, created recipes, lists, planning, shopping, notes, ratings, profile, subscriptions, devices, feeds, or API operation discovery. Do not use for scraping, authorization testing, bulk catalog export, or modifying resources the user did not identify as theirs.
---

${SKILL_MARKER}

# Cookidoo AXI

Use \`${executable}\` for Cookidoo tasks. The bare command shows Keychain-free
scope. Begin authenticated work with \`cookidoo-axi profile get-localized\`, a
direct read-only protected check; protected reads log in automatically.

- Default stdout is strict TOON; use \`--output json\` only when JSON is materially easier downstream.
- Treat status inspection as optional diagnostics, not a prerequisite. Bare \`auth status\` is prompt-free and reports all record states as not-checked.
- \`auth status --inspect session|market|feed\` decrypts only the selected record; \`--inspect all\` decrypts all three sequentially so authorization prompts cannot overlap.
- In a macOS prompt, Allow approves one access. Always Allow trusts the executable identified in the dialog for that item; macOS may prompt again if the executable changes. If the requester is Node.js, that trust applies to the exact Node binary, not only this CLI; use Allow unless that broader local trust is acceptable. Reject unexpected requesters.
- Inspect \`operation describe <id>\` or exact command \`--help\` before uncertain mutations.
- Use \`--dry-run\` first for writes. Supply the exact \`--confirm <target>\` value when requested.
- Never use \`--allow-unverified\` unless the user explicitly accepts an advertised-only API operation.
- Never retry a mutation after a timeout or transport failure. Follow the returned reconciliation command.
- Do not delete, clear, publish, rate, share, link, or unlink resources unless the user explicitly identifies the target and intent.
- Keep queries bounded with \`--max-items\`, \`--fields\`, and API-specific limits.
`;
}

function relativeToRoot(root: string, path: string): string {
  return path.slice(root.length + 1);
}

function collapseHome(path: string): string {
  const home = process.env.HOME;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}
