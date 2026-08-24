import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import YAML from "yaml";
import { commandMap } from "./command-map.mjs";

const sourcePath = resolve(
  process.env.COOKIDOO_OPENAPI_PATH ?? "../cookidoo-openapi/openapi.yaml"
);
const outputPath = resolve("src/generated/openapi-manifest.json");
const sourceRepository = "https://github.com/aimlesx/cookidoo-openapi";
const sourceCommit = "6d54f2a8fa79894f4b81dba4d47a52610096d503";
const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}
const sourceDocument = await readFile(sourcePath);
const document = YAML.parse(sourceDocument.toString("utf8"));
const methods = ["get", "post", "put", "patch", "delete"];

// Narrow, additive live-compatibility facts belong to the CLI rather than the
// user's upstream specification checkout. Each override copies an existing
// schema and can only add a media type to an already-declared success status.
const responseCompatibility = Object.freeze({
  patchCreatedRecipe: Object.freeze({
    "200": Object.freeze({
      addMediaType: "application/vnd.vorwerk.customer-recipe.full+json",
      copySchemaFrom: "application/json",
      observedAt: "2026-08-18"
    })
  })
});

function localRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value?.[key], document);
}

function resolveRef(value) {
  let current = value;
  const seen = new Set();
  while (current?.$ref) {
    if (seen.has(current.$ref)) throw new Error(`Circular direct ref: ${current.$ref}`);
    seen.add(current.$ref);
    current = localRef(current.$ref);
    if (!current) throw new Error(`Unresolved local ref: ${value.$ref}`);
  }
  return current;
}

function requestBody(operation) {
  const body = resolveRef(operation.requestBody);
  if (!body) return null;
  return {
    required: body.required === true,
    content: Object.fromEntries(
      Object.entries(body.content ?? {}).map(([mediaType, media]) => [
        mediaType,
        {
          schema: media.schema ?? {},
          bodyProperties: collectBodyProperties(media.schema ?? {}),
          example: media.example
        }
      ])
    )
  };
}

function collectBodyProperties(schema, seen = new Set()) {
  if (schema?.$ref) {
    if (seen.has(schema.$ref)) return {};
    const target = localRef(schema.$ref);
    if (!target) throw new Error(`Unresolved schema ref: ${schema.$ref}`);
    return collectBodyProperties(target, new Set([...seen, schema.$ref]));
  }
  const properties = { ...(schema?.properties ?? {}) };
  for (const branchKey of ["oneOf", "anyOf", "allOf"]) {
    for (const branch of schema?.[branchKey] ?? []) {
      Object.assign(properties, collectBodyProperties(branch, seen));
    }
  }
  return properties;
}

function securityKind(operation) {
  if (Array.isArray(operation.security) && operation.security.length === 0) return "public";
  const names = (operation.security ?? document.security ?? []).flatMap(Object.keys);
  if (names.includes("basicAuth")) return "basic";
  if (names.includes("cookieSession")) return "cookie";
  return "none";
}

function responses(operationId, source) {
  const result = structuredClone(source ?? {});
  const overrides = responseCompatibility[operationId] ?? {};
  for (const [status, override] of Object.entries(overrides)) {
    const content = result?.[status]?.content;
    const sourceMedia = content?.[override.copySchemaFrom];
    if (!sourceMedia || content[override.addMediaType]) {
      throw new Error(`Invalid response compatibility override for ${operationId} ${status}`);
    }
    content[override.addMediaType] = structuredClone(sourceMedia);
  }
  return result;
}

const operations = [];
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const method of methods) {
    const operation = pathItem[method];
    if (!operation) continue;
    const operationId = operation.operationId;
    if (!operationId || !commandMap[operationId]) {
      throw new Error(`No command mapping for ${operationId ?? `${method} ${path}`}`);
    }
    const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
      .map(resolveRef)
      .map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required === true,
        description: parameter.description,
        schema: resolveRef(parameter.schema) ?? {}
      }));
    const metadata = operation["x-cookidoo"] ?? {};
    operations.push({
      operationId,
      command: commandMap[operationId],
      tag: operation.tags?.[0] ?? "Other",
      method: method.toUpperCase(),
      path,
      summary: operation.summary ?? operationId,
      description: operation.description,
      parameters,
      requestBody: requestBody(operation),
      responses: responses(operationId, operation.responses),
      security: securityKind(operation),
      status: metadata.status ?? "unknown",
      responseShape: metadata.responseShape ?? "unknown",
      risk: metadata.risk ?? {
        effect: method === "get" ? "read" : "unknown",
        destructive: method === "delete",
        externallyVisible: false,
        exercised: false
      }
    });
  }
}

const operationIds = new Set(operations.map(({ operationId }) => operationId));
const staleMappings = Object.keys(commandMap).filter((id) => !operationIds.has(id));
if (staleMappings.length) throw new Error(`Stale command mappings: ${staleMappings.join(", ")}`);
if (operations.length !== 58) throw new Error(`Expected 58 operations, found ${operations.length}`);

const manifest = {
  generatedFrom: "cookidoo-openapi/openapi.yaml",
  source: {
    repository: sourceRepository,
    commit: sourceCommit,
    path: "openapi.yaml",
    sha256: createHash("sha256").update(sourceDocument).digest("hex")
  },
  openapi: document.openapi,
  apiVersion: document.info?.version,
  server: document.servers?.[0]?.url,
  authentication: document["x-cookidoo-authentication"] ?? {},
  protocol: document["x-cookidoo-protocol-behavior"] ?? {},
  compatibilityOverrides: { responses: responseCompatibility },
  components: {
    schemas: document.components?.schemas ?? {},
    responses: document.components?.responses ?? {},
    securitySchemes: document.components?.securitySchemes ?? {}
  },
  operations
};

const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
if (checkOnly) {
  const existingManifest = await readFile(outputPath, "utf8");
  if (existingManifest !== serializedManifest) {
    throw new Error(
      `Bundled manifest is stale; run npm run generate using ${sourcePath}`,
    );
  }
  process.stderr.write(`verified ${operations.length} operations against ${sourcePath}\n`);
} else {
  await writeFile(outputPath, serializedManifest, "utf8");
  process.stderr.write(`generated ${operations.length} operations from ${sourcePath}\n`);
}
