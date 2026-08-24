import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { parse, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commandArgument,
  commandLiteral,
  renderCommand,
} from "./cli/command.js";
import { OperationalError, UsageError } from "./errors.js";
import { VERSION } from "./version.js";

const SKILL_NAME = "cookidoo-axi";
const SKILL_FILE = "SKILL.md";
const MANIFEST_FILE = ".cookidoo-axi-managed.json";
const MANIFEST_SCHEMA_VERSION = 1;
const LEGACY_SKILL_MARKER = "<!-- generated-by: cookidoo-axi -->";
const BUNDLED_SKILL_PATH = fileURLToPath(
  new URL(`../skills/${SKILL_NAME}/${SKILL_FILE}`, import.meta.url),
);

interface ManagedSkillManifest {
  readonly schemaVersion: 1;
  readonly name: "cookidoo-axi";
  readonly hash: {
    readonly algorithm: "sha256";
    readonly value: string;
  };
  readonly installer: {
    readonly name: "cookidoo-axi";
    readonly version: string;
  };
}

interface ExistingManagedSkill {
  readonly manifest: ManagedSkillManifest;
  readonly skillBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

export interface SkillInstallResult {
  readonly result: "installed" | "updated" | "already_current";
  readonly skillsDirectory: string;
  readonly skillDirectory: string;
  readonly files: readonly ["SKILL.md", ".cookidoo-axi-managed.json"];
  readonly hash: ManagedSkillManifest["hash"];
  readonly installer: ManagedSkillManifest["installer"];
  readonly removeCommand: string;
}

export interface SkillRemoveResult {
  readonly result: "removed" | "already_absent";
  readonly skillsDirectory: string;
  readonly skillDirectory: string;
  readonly files: readonly string[];
}

export async function installSkill(input: {
  readonly skillsDirectory: string;
}): Promise<SkillInstallResult> {
  const skillsDirectory = await resolveSkillsDirectory(input.skillsDirectory);
  const skillDirectory = join(skillsDirectory, SKILL_NAME);
  const sourceBytes = await readBundledSkill();
  const sourceHash = sha256(sourceBytes);
  const manifest = managedManifest(sourceHash);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const existing = await inspectManagedSkill(skillDirectory);
  let result: SkillInstallResult["result"];

  if (existing === undefined) {
    await installNewSkillDirectory(skillDirectory, sourceBytes, manifestBytes);
    result = "installed";
  } else if (
    existing.manifest.hash.value === sourceHash
    && existing.manifest.installer.version === VERSION
  ) {
    result = "already_current";
  } else {
    await updateManagedSkill(skillDirectory, existing.skillBytes, sourceBytes, manifestBytes);
    result = "updated";
  }

  return {
    result,
    skillsDirectory,
    skillDirectory,
    files: [SKILL_FILE, MANIFEST_FILE],
    hash: manifest.hash,
    installer: manifest.installer,
    removeCommand: renderCommand([
      commandLiteral("cookidoo-axi"),
      commandLiteral("skill"),
      commandLiteral("remove"),
      commandLiteral("--skills-directory"),
      commandArgument(skillsDirectory),
      commandLiteral("--confirm"),
      commandArgument(skillDirectory),
    ]),
  };
}

export async function removeSkill(input: {
  readonly skillsDirectory: string;
  readonly confirm?: string;
}): Promise<SkillRemoveResult> {
  const skillsDirectory = await resolveSkillsDirectory(input.skillsDirectory);
  const skillDirectory = join(skillsDirectory, SKILL_NAME);
  if (input.confirm !== skillDirectory) {
    throw new UsageError({
      code: "CONFIRMATION_REQUIRED",
      message: `Skill removal requires --confirm ${JSON.stringify(skillDirectory)}.`,
      suggestion: renderCommand([
        commandLiteral("cookidoo-axi"),
        commandLiteral("skill"),
        commandLiteral("remove"),
        commandLiteral("--skills-directory"),
        commandArgument(skillsDirectory),
        commandLiteral("--confirm"),
        commandArgument(skillDirectory),
      ]),
      details: { expected: skillDirectory },
    });
  }

  const existing = await inspectManagedSkill(skillDirectory);
  if (existing === undefined) {
    return {
      result: "already_absent",
      skillsDirectory,
      skillDirectory,
      files: [],
    };
  }

  const skillPath = join(skillDirectory, SKILL_FILE);
  const manifestPath = join(skillDirectory, MANIFEST_FILE);
  let skillDeleted = false;
  let manifestDeleted = false;
  try {
    await unlink(skillPath);
    skillDeleted = true;
    await unlink(manifestPath);
    manifestDeleted = true;
    await rmdir(skillDirectory);
  } catch {
    try {
      if (skillDeleted) await writeExclusive(skillPath, existing.skillBytes);
      if (manifestDeleted) await writeExclusive(manifestPath, existing.manifestBytes);
    } catch {
      throw new OperationalError({
        code: "SKILL_REMOVE_INCOMPLETE",
        message: "The managed cookidoo-axi skill removal failed and could not be rolled back.",
        suggestion: "Preserve and inspect the exact skill directory before any further lifecycle command.",
        details: { skillDirectory },
      });
    }
    throw new OperationalError({
      code: "SKILL_REMOVE_FAILED",
      message: "The managed cookidoo-axi skill could not be removed and was restored.",
      suggestion: "Inspect the exact skill directory before retrying removal.",
      details: { skillDirectory },
    });
  }
  return {
    result: "removed",
    skillsDirectory,
    skillDirectory,
    files: [SKILL_FILE, MANIFEST_FILE],
  };
}

async function resolveSkillsDirectory(value: string): Promise<string> {
  const requested = resolve(value);
  try {
    await assertNoSymlinkComponents(requested);
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a direct directory");
    return await realpath(requested);
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw new OperationalError({
      code: "SKILLS_DIRECTORY_UNAVAILABLE",
      message: `The explicit skills directory is missing, inaccessible, or not a directory: ${requested}`,
      suggestion: "Create the intended Codex or Claude skills root, then retry with its direct path.",
      details: { skillsDirectory: requested },
    });
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  const segments = path.slice(root.length).split("/").filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new OperationalError({
        code: "UNSAFE_SKILL_PATH",
        message: `Refusing to follow a symlink in the skills-directory path: ${current}`,
        suggestion: "Use the canonical direct path to an existing skills directory.",
        details: { path: current },
      });
    }
    if (current !== path && !metadata.isDirectory()) {
      throw new OperationalError({
        code: "UNSAFE_SKILL_PATH",
        message: `A skills-directory parent component is not a directory: ${current}`,
        suggestion: "Use the canonical direct path to an existing skills directory.",
        details: { path: current },
      });
    }
  }
}

/** Read and validate the package-owned skill source. The path parameter is for offline tests. */
export async function readBundledSkill(
  sourcePath: string = BUNDLED_SKILL_PATH,
): Promise<Uint8Array> {
  try {
    const resolvedSource = resolve(sourcePath);
    await assertNoSymlinkComponents(resolvedSource);
    const bytes = await readRegularFileNoFollow(resolvedSource);
    if (bytes.byteLength === 0) throw new Error("empty bundled skill");
    return bytes;
  } catch {
    throw new OperationalError({
      code: "BUNDLED_SKILL_UNAVAILABLE",
      message: "The installed cookidoo-axi package does not contain a readable bundled skill.",
      suggestion: "Reinstall cookidoo-axi from the supported Homebrew package.",
    });
  }
}

async function inspectManagedSkill(skillDirectory: string): Promise<ExistingManagedSkill | undefined> {
  let metadata;
  try {
    metadata = await lstat(skillDirectory);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw skillInspectionFailure(skillDirectory);
  }
  if (metadata.isSymbolicLink()) {
    throw new OperationalError({
      code: "UNSAFE_SKILL_PATH",
      message: `Refusing to follow a skill-directory symlink: ${skillDirectory}`,
      suggestion: "Choose a skills directory without a cookidoo-axi symlink target.",
      details: { skillDirectory },
    });
  }
  if (!metadata.isDirectory()) {
    throw new OperationalError({
      code: "SKILL_UNMANAGED",
      message: `The cookidoo-axi skill target is not a managed directory: ${skillDirectory}`,
      suggestion: "Move the existing target aside, then retry installation.",
      details: { skillDirectory },
    });
  }

  let entries: string[];
  try {
    entries = (await readdir(skillDirectory)).sort();
  } catch {
    throw skillInspectionFailure(skillDirectory);
  }
  const skillPresent = entries.includes(SKILL_FILE);
  const manifestPresent = entries.includes(MANIFEST_FILE);

  if (!manifestPresent) {
    if (skillPresent) {
      let skillBytes: Uint8Array;
      try {
        skillBytes = await readManagedFile(join(skillDirectory, SKILL_FILE), skillDirectory);
      } catch (error) {
        if (error instanceof OperationalError) throw error;
        throw skillInspectionFailure(skillDirectory);
      }
      if (Buffer.from(skillBytes).includes(LEGACY_SKILL_MARKER)) {
        throw new OperationalError({
          code: "LEGACY_SKILL_CONFLICT",
          message: `A legacy generated cookidoo-axi skill exists without managed metadata: ${skillDirectory}`,
          suggestion: "Remove the legacy integration explicitly, then run the new skill install command.",
          details: { skillDirectory },
        });
      }
    }
    throw new OperationalError({
      code: "SKILL_UNMANAGED",
      message: `An unmanaged cookidoo-axi skill directory already exists: ${skillDirectory}`,
      suggestion: "Move the existing directory aside or choose a different skills directory.",
      details: { skillDirectory },
    });
  }

  const extras = entries.filter((entry) => entry !== SKILL_FILE && entry !== MANIFEST_FILE);
  if (extras.length > 0) {
    throw new OperationalError({
      code: "SKILL_EXTRA_FILES",
      message: `The managed cookidoo-axi skill directory contains unowned files: ${skillDirectory}`,
      suggestion: "Move the extra files aside before updating or removing the managed skill.",
      details: { skillDirectory, files: extras },
    });
  }
  if (!skillPresent) throw invalidManifest(skillDirectory);

  let skillBytes: Uint8Array;
  let manifestBytes: Uint8Array;
  try {
    [skillBytes, manifestBytes] = await Promise.all([
      readManagedFile(join(skillDirectory, SKILL_FILE), skillDirectory),
      readManagedFile(join(skillDirectory, MANIFEST_FILE), skillDirectory),
    ]);
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw skillInspectionFailure(skillDirectory);
  }
  const manifest = parseManagedManifest(manifestBytes, skillDirectory);
  if (sha256(skillBytes) !== manifest.hash.value) {
    throw new OperationalError({
      code: "SKILL_MODIFIED",
      message: `The managed cookidoo-axi skill has been modified: ${join(skillDirectory, SKILL_FILE)}`,
      suggestion: "Preserve or move the modified skill before installing or removing it.",
      details: { skillDirectory },
    });
  }
  return { manifest, skillBytes, manifestBytes };
}

function parseManagedManifest(bytes: Uint8Array, skillDirectory: string): ManagedSkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidManifest(skillDirectory);
  }
  if (!isObject(parsed) || !isObject(parsed.hash) || !isObject(parsed.installer)) {
    throw invalidManifest(skillDirectory);
  }
  const valid = parsed.schemaVersion === MANIFEST_SCHEMA_VERSION
    && parsed.name === SKILL_NAME
    && parsed.hash.algorithm === "sha256"
    && typeof parsed.hash.value === "string"
    && /^[a-f0-9]{64}$/u.test(parsed.hash.value)
    && parsed.installer.name === SKILL_NAME
    && typeof parsed.installer.version === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.installer.version)
    && Object.keys(parsed).sort().join("\0") === "hash\0installer\0name\0schemaVersion"
    && Object.keys(parsed.hash).sort().join("\0") === "algorithm\0value"
    && Object.keys(parsed.installer).sort().join("\0") === "name\0version";
  if (!valid) throw invalidManifest(skillDirectory);
  return parsed as unknown as ManagedSkillManifest;
}

function invalidManifest(skillDirectory: string): OperationalError {
  return new OperationalError({
    code: "SKILL_MANIFEST_INVALID",
    message: `The cookidoo-axi managed-skill metadata is invalid: ${join(skillDirectory, MANIFEST_FILE)}`,
    suggestion: "Inspect and preserve the directory before replacing the invalid metadata.",
    details: { skillDirectory },
  });
}

function skillInspectionFailure(skillDirectory: string): OperationalError {
  return new OperationalError({
    code: "SKILL_INSPECTION_FAILED",
    message: `The cookidoo-axi skill directory could not be inspected safely: ${skillDirectory}`,
    suggestion: "Check directory permissions and ensure no path component is a symlink.",
    details: { skillDirectory },
  });
}

function managedManifest(hash: string): ManagedSkillManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: SKILL_NAME,
    hash: { algorithm: "sha256", value: hash },
    installer: { name: SKILL_NAME, version: VERSION },
  };
}

async function installNewSkillDirectory(
  skillDirectory: string,
  skillBytes: Uint8Array,
  manifestBytes: Uint8Array,
): Promise<void> {
  let directoryCreated = false;
  let skillWritten = false;
  let manifestWritten = false;
  try {
    await mkdir(skillDirectory, { mode: 0o755 });
    directoryCreated = true;
    await writeExclusive(join(skillDirectory, SKILL_FILE), skillBytes);
    skillWritten = true;
    await writeExclusive(join(skillDirectory, MANIFEST_FILE), manifestBytes);
    manifestWritten = true;
  } catch (error) {
    if (directoryCreated) {
      if (skillWritten) await unlink(join(skillDirectory, SKILL_FILE)).catch(() => undefined);
      if (manifestWritten) await unlink(join(skillDirectory, MANIFEST_FILE)).catch(() => undefined);
      await rmdir(skillDirectory).catch(() => undefined);
    }
    if (isAlreadyExists(error)) {
      throw new OperationalError({
        code: "SKILL_INSTALL_RACE",
        message: `The cookidoo-axi skill target changed during installation: ${skillDirectory}`,
        suggestion: "Inspect the target directory before retrying installation.",
        details: { skillDirectory },
      });
    }
    throw new OperationalError({
      code: "SKILL_INSTALL_FAILED",
      message: `The cookidoo-axi skill could not be installed: ${skillDirectory}`,
      suggestion: "Check directory permissions and available disk space, then retry.",
      details: { skillDirectory },
    });
  }
}

async function updateManagedSkill(
  skillDirectory: string,
  previousSkillBytes: Uint8Array,
  skillBytes: Uint8Array,
  manifestBytes: Uint8Array,
): Promise<void> {
  const skillPath = join(skillDirectory, SKILL_FILE);
  try {
    await atomicWrite(skillPath, skillBytes);
    await atomicWrite(join(skillDirectory, MANIFEST_FILE), manifestBytes);
  } catch {
    try {
      await atomicWrite(skillPath, previousSkillBytes);
    } catch {
      throw new OperationalError({
        code: "SKILL_UPDATE_INCOMPLETE",
        message: `The cookidoo-axi skill update could not be rolled back: ${skillDirectory}`,
        suggestion: "Preserve and inspect the skill directory before any further lifecycle command.",
        details: { skillDirectory },
      });
    }
    throw new OperationalError({
      code: "SKILL_UPDATE_FAILED",
      message: `The cookidoo-axi skill could not be updated: ${skillDirectory}`,
      suggestion: "Check directory permissions and available disk space, then retry.",
      details: { skillDirectory },
    });
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let temporaryWritten = false;
  try {
    await writeExclusive(temporary, bytes);
    temporaryWritten = true;
    await rename(temporary, path);
  } catch (error) {
    if (temporaryWritten) await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle !== undefined) await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function readRegularFileNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readManagedFile(path: string, skillDirectory: string): Promise<Uint8Array> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new OperationalError({
      code: "UNSAFE_SKILL_PATH",
      message: `A managed skill entry is not a direct regular file: ${path}`,
      suggestion: "Preserve and inspect the exact skill directory before retrying.",
      details: { skillDirectory, path },
    });
  }
  return readRegularFileNoFollow(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isObject(error) && ["EEXIST", "ENOTEMPTY"].includes(String(error.code));
}
