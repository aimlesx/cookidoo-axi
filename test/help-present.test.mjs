import assert from "node:assert/strict";
import test from "node:test";

import { OPENAPI_MANIFEST } from "../dist/api/spec.js";
import { groupHelp, operationHelp } from "../dist/cli/help.js";
import {
  bodyVariantContracts,
  collectionView,
  effectiveSafetyPolicy,
  operationCatalog,
  operationDescription,
  schemaHelpLabel,
} from "../dist/cli/present.js";

const operations = OPENAPI_MANIFEST.operations;

function operation(operationId) {
  const value = operations.find((candidate) => candidate.operationId === operationId);
  assert.ok(value, `missing operation ${operationId}`);
  return value;
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replaceAll("_", "-").toLowerCase();
}

test("auth onboarding prefers one task-shaped protected read over prerequisite status probes", () => {
  const auth = groupHelp(["auth"], operations);
  assert.match(auth, /profile get-localized/u);
  assert.match(auth, /status and login are not prerequisites/u);
  assert.match(auth, /status\s+Prompt-free summary; inspect Keychain only on request/u);
  assert.match(auth, /Bare auth status reads no Keychain records/u);
  assert.match(auth, /reports their states as not-checked/u);
  assert.match(auth, /--inspect session\|market\|feed for one record/u);
  assert.match(auth, /--inspect all reads all three\s+sequentially/u);
  assert.match(auth, /Allow approves one access/u);
  assert.match(auth, /Always Allow trusts the executable identified/u);
  assert.match(auth, /may prompt if the executable changes/u);
  assert.match(auth, /authorization applies to the exact Node binary/u);
  assert.match(auth, /not only this CLI/u);
  assert.doesNotMatch(auth, /Examples:\n[\s\S]*auth status/u);

  const status = groupHelp(["auth", "status"], operations);
  assert.match(status, /\[--inspect session\|market\|feed\|all\]/u);
  assert.match(status, /Without --inspect, request no Keychain access/u);
  assert.match(status, /states as not-checked/u);
  assert.match(status, /--inspect session\|market\|feed decrypts only that selected record/u);
  assert.match(status, /--inspect all\s+decrypts all three sequentially/u);
  assert.match(status, /prefer cookidoo-axi profile get-localized/u);
  assert.match(status, /Always Allow trusts the executable identified/u);
  assert.match(status, /may prompt again if the executable changes/u);
  assert.match(status, /authorization applies to that exact Node binary/u);

  const login = groupHelp(["auth", "login"], operations);
  assert.match(login, /Protected reads already log in/u);
  assert.match(login, /profile get-localized/u);

  const imported = groupHelp(["auth", "import-env"], operations);
  assert.match(imported, /Next, run cookidoo-axi profile get-localized/u);
  assert.match(imported, /Always Allow trusts the executable/u);
  assert.match(imported, /may prompt if the executable changes/u);
  assert.match(imported, /authorization applies to that Node binary/u);
  assert.match(status, /auth status --inspect session --profile work/u);
  assert.match(login, /auth login --profile work/u);
  assert.match(groupHelp(["auth", "clear-session"], operations), /--confirm session:work/u);
  assert.match(groupHelp(["auth", "remove"], operations), /auth remove --profile work --confirm work/u);
});

test("all 58 focused help pages enumerate bounded path, query, and body contracts", () => {
  assert.equal(operations.length, 58);
  for (const current of operations) {
    const help = operationHelp(current);
    assert.ok(help.length < 4_000, `${current.operationId} help is not bounded: ${help.length}`);
    assert.match(help, new RegExp(`OpenAPI: ${current.operationId} · ${current.method}`));
    assert.doesNotMatch(help, /--<body-property>/u, current.operationId);

    for (const parameter of current.parameters.filter((entry) => entry.in === "path")) {
      const input = parameter.name === "lang" ? "--lang" : `<${parameter.name}>`;
      assert.ok(
        help.includes(`${input} <${schemaHelpLabel(parameter.schema)}>`),
        `${current.operationId} omits path contract ${parameter.name}`,
      );
    }
    for (const parameter of current.parameters.filter((entry) => entry.in === "query")) {
      const input = parameter.name === "filters" ? "--filter <key=value>" : `--${kebab(parameter.name)}`;
      assert.ok(
        help.includes(`${input} <${schemaHelpLabel(parameter.schema)}>`),
        `${current.operationId} omits query contract ${parameter.name}`,
      );
    }
    for (const media of Object.values(current.requestBody?.content ?? {})) {
      assert.ok(help.includes(`schema: <${schemaHelpLabel(media.schema)}>`), current.operationId);
      const variants = bodyVariantContracts(media.schema);
      for (const [name, schema] of Object.entries(media.bodyProperties)) {
        const linePrefix = `--${kebab(name)} <${schemaHelpLabel(schema)}> (`;
        assert.ok(help.includes(linePrefix), `${current.operationId} omits body property ${name}`);
        const requiredIn = variants.filter((variant) => variant.required.includes(name));
        if (requiredIn.length === variants.length && variants.length > 0) {
          const line = help.split("\n").find((entry) => entry.includes(linePrefix));
          assert.match(line, /\(required(?:;|\))/u, `${current.operationId}.${name}`);
        }
      }
    }

    const policy = effectiveSafetyPolicy(current);
    const cases = [policy.default, ...policy.conditionalCases];
    assert.equal(
      help.includes("--confirm"),
      cases.some((entry) => entry.requiresConfirmation),
      `${current.operationId} confirmation disclosure`,
    );
    assert.equal(
      help.includes("--allow-unverified"),
      cases.some((entry) => entry.allowUnverifiedRequired),
      `${current.operationId} unverified disclosure`,
    );
  }
});

test("focused examples expose exact constraints and a valid ISO feed cursor", () => {
  const created = operationHelp(operation("createCreatedRecipe"));
  assert.match(created, /--recipe-name <string; minLength=1; maxLength=120> \(required in variant 1\)/u);
  assert.match(created, /--recipe-url <string; format=uri> \(required in variant 2\)/u);
  assert.match(created, /1: requires recipeName; properties recipeName/u);
  assert.doesNotMatch(created, /--confirm/u);

  const recipe = operationHelp(operation("getRecipe"));
  assert.match(recipe, /<recipeId> <string; pattern=\^r\[0-9\]\+\$>/u);
  assert.doesNotMatch(recipe, /--dry-run|--confirm/u);

  const lists = operationHelp(operation("listCustomLists"));
  assert.match(lists, /--page <integer; min=0; default=0> \(optional\)/u);

  const feed = operationHelp(operation("getCollectionFeedPage"));
  assert.match(feed, /--limit <string; enum="small"\|"medium"\|"large"; default="medium">/u);
  assert.match(feed, /--page-before-seconds <integer; min=0>/u);
  const cursor = feed.match(/  cookidoo-axi feed page --page-before '([^']+)'/u)?.[1];
  assert.equal(cursor, "2026-08-17T00:00:00Z");
  assert.equal(new Date(cursor).toISOString(), "2026-08-17T00:00:00.000Z");
});

test("operation-list help documents bounded discovery filters", () => {
  const help = groupHelp(["operation", "list"], operations);
  assert.match(help, /--group <group>/u);
  assert.match(help, /--risk <level>/u);
  assert.match(help, /--query <text>/u);
  assert.match(help, /read, write, destructive, external, device, unverified/u);
  assert.match(help, /operation list --group created --risk write/u);
});

test("focused utility help provides two realistic examples for only that command", () => {
  for (const path of [
    ["auth", "doctor"],
    ["auth", "import-env"],
    ["auth", "import-feed-env"],
    ["auth", "status"],
    ["auth", "login"],
    ["auth", "clear-session"],
    ["auth", "remove"],
    ["operation", "list"],
    ["operation", "describe"],
    ["skill", "install"],
    ["skill", "remove"],
    ["created", "publish"],
    ["created", "unpublish"],
    ["created", "import"],
  ]) {
    const help = groupHelp(path, operations);
    const examples = help.split("\n").filter((line) => line.startsWith("  cookidoo-axi "));
    assert.ok(examples.length >= 2 && examples.length <= 3, `${path.join(" ")}: ${examples.length}`);
    assert.ok(
      examples.every((line) => line.startsWith(`  cookidoo-axi ${path.join(" ")}`)),
      `${path.join(" ")} includes an unrelated focused example`,
    );
  }
});

test("every ordinary API group help level provides two or three scoped examples", () => {
  const groups = new Map();
  for (const current of operations) {
    for (let length = 1; length < current.command.length; length += 1) {
      const path = current.command.slice(0, length);
      groups.set(path.join("\0"), path);
    }
  }
  for (const path of groups.values()) {
    const help = groupHelp(path, operations);
    const examples = help.split("\n").filter((line) => line.startsWith("  cookidoo-axi "));
    assert.ok(examples.length >= 2 && examples.length <= 3, `${path.join(" ")}: ${examples.length}`);
    assert.ok(
      examples.every((line) => line.startsWith(`  cookidoo-axi ${path.join(" ")} `)),
      `${path.join(" ")} includes an unrelated group example`,
    );
  }
});

test("utility group help keeps all examples scoped to the requested group", () => {
  for (const path of [["auth"], ["operation"], ["skill"]]) {
    const examples = groupHelp(path, operations).split("\n")
      .filter((line) => line.startsWith("  cookidoo-axi "));
    assert.ok(examples.length >= 2 && examples.length <= 3, path.join(" "));
    assert.ok(examples.every((line) =>
      line.startsWith(`  cookidoo-axi ${path.join(" ")} `)), path.join(" "));
  }
});

test("skill help requires an explicit cross-agent root and exact child confirmation", () => {
  const root = groupHelp(["skill"], operations);
  assert.match(root, /--skills-directory <path>/u);
  assert.match(root, /Codex `.agents\/skills` or Claude Code `.claude\/skills`/u);
  assert.match(root, /always <skills-directory>\/cookidoo-axi/u);
  assert.match(root, /No hooks/u);
  assert.match(root, /API-only safety flags such as --dry-run/u);

  const install = groupHelp(["skill", "install"], operations);
  assert.match(install, /exact bundled SKILL\.md/u);
  assert.match(install, /SHA-256/u);
  assert.match(install, /unmanaged, modified, legacy, symlinked/u);

  const remove = groupHelp(["skill", "remove"], operations);
  assert.match(remove, /--confirm <absolute-skill-directory>/u);
  assert.match(remove, /skills root is never removed/u);
  assert.match(remove, /including when the managed child is already absent/u);
});

test("collection views preserve provider pagination and extension metadata", () => {
  const providerPage = {
    customlists: [{ id: "L21" }],
    page: {
      page: 1,
      totalPages: 2,
      totalElements: 21,
      providerPageToken: "page-token",
    },
    links: { self: "/lists?page=1", previous: "/lists?page=0" },
    providerCursor: "cursor-21",
  };
  const finalPage = collectionView(providerPage, "listCustomLists");
  assert.deepEqual(finalPage, {
    items: [{ id: "L21" }],
    total: 21,
    hasMore: false,
    envelope: {
      page: providerPage.page,
      links: providerPage.links,
      providerCursor: "cursor-21",
    },
  });

  const explicitFalse = collectionView({
    data: [{ id: "r1" }],
    hasMore: false,
    _links: { next: { href: "/search?page=2" } },
    page: { page: 0, totalPages: 3, totalElements: 3 },
  }, "search");
  assert.equal(explicitFalse?.hasMore, false);

  const firstPage = collectionView({
    customlists: [{ id: "L1" }],
    page: { page: 0, totalPages: 2, totalElements: 21 },
  }, "listCustomLists");
  assert.equal(firstPage?.hasMore, true);

  const emptyLaterPage = collectionView({
    data: [],
    page: { page: 3 },
    links: { self: "/search?page=3" },
    providerCursor: "cursor-after-results",
  }, "search");
  assert.equal(emptyLaterPage?.total, null);
  assert.equal(emptyLaterPage?.hasMore, null);
  assert.deepEqual(emptyLaterPage?.envelope, {
    page: { page: 3 },
    links: { self: "/search?page=3" },
    providerCursor: "cursor-after-results",
  });
});

test("confirmation help always comes from the exact dry run and is absent for unguarded writes", () => {
  const guarded = operationHelp(operation("removeRecipesFromShoppingList"));
  assert.match(guarded, /data\.safety\.confirmationTarget/u);
  assert.match(guarded, /verbatim into --confirm/u);
  assert.doesNotMatch(guarded, /shopping-recipes:remove:|--confirm <recipeIDs>/u);

  const privateWrite = operationHelp(operation("createCreatedRecipe"));
  assert.doesNotMatch(privateWrite, /--confirm|confirmationTarget/u);

  const unverifiedOnly = operationHelp(operation("movePlannedRecipe"));
  assert.match(unverifiedOnly, /--allow-unverified/u);
  assert.doesNotMatch(unverifiedOnly, /--confirm|confirmationTarget/u);

  for (const command of ["publish", "unpublish", "import"]) {
    const help = groupHelp(["created", command], operations);
    assert.match(help, /data\.safety\.confirmationTarget/u);
    assert.match(help, /verbatim into --confirm/u);
    assert.doesNotMatch(help, /created-import:<url>|created-recipe:<customerRecipeId>/u);
  }
});

test("operation descriptions contain constructible request variants and response media schemas", () => {
  const created = operationDescription(operation("createCreatedRecipe"));
  const createdBody = created.request.bodies[0];
  assert.equal(createdBody.mediaType, "application/json");
  assert.equal(createdBody.required, true);
  assert.deepEqual(createdBody.variants, [
    {
      variant: 1,
      required: ["recipeName"],
      properties: ["recipeName"],
      additionalProperties: false,
    },
    {
      variant: 2,
      required: ["recipeUrl"],
      properties: ["partnerId", "recipeUrl", "servingSize"],
      additionalProperties: false,
    },
  ]);
  assert.deepEqual(createdBody.example, { recipeName: "Synthetic recipe" });
  const recipeName = createdBody.properties.find((property) => property.name === "recipeName");
  assert.equal(recipeName.requirement, "variant-dependent");
  assert.deepEqual(recipeName.requiredInVariants, [1]);
  assert.equal(recipeName.schema.minLength, 1);

  const recipe = operationDescription(operation("getRecipe"));
  const success = recipe.response.statuses.find((status) => status.status === "200");
  assert.equal(success.content[0].mediaType, "application/json");
  assert.equal(success.content[0].schema.ref, "OfficialRecipe");
  assert.deepEqual(
    success.content[0].schema.properties.map((property) => property.name),
    ["id", "name", "recipeIngredientGroups"],
  );

  const feed = operationDescription(operation("getCollectionFeedPage"));
  const redirect = feed.response.statuses.find((status) => status.status === "303");
  assert.equal(redirect.headers[0].name, "Location");
  assert.equal(redirect.headers[0].schema.format, "uri");
});

test("operation descriptions expose live compatibility provenance at the affected media entry", () => {
  const description = operationDescription(operation("patchCreatedRecipe"));
  const success = description.response.statuses.find((status) => status.status === "200");
  const vendor = success.content.find((entry) =>
    entry.mediaType === "application/vnd.vorwerk.customer-recipe.full+json");
  assert.equal(vendor.source, "compatibility-override");
  assert.equal(vendor.copySchemaFrom, "application/json");
  assert.equal(vendor.observedAt, "2026-08-18");
});

test("structured discovery reports effective semantic and conditional safety policy", () => {
  const shopping = operationDescription(operation("removeRecipesFromShoppingList")).safety;
  assert.equal(shopping.upstream.destructive, false);
  assert.equal(shopping.effectivePolicy.default.level, "destructive");
  assert.equal(shopping.effectivePolicy.default.destructive, true);
  assert.match(shopping.effectivePolicy.default.semanticOverrides[0], /deletes user state/u);
  assert.equal(
    shopping.effectivePolicy.default.confirmation.outputField,
    "data.safety.confirmationTarget",
  );

  const patch = operationDescription(operation("patchCreatedRecipe")).safety;
  assert.equal(patch.level, "private-write");
  assert.equal(patch.requiresConfirmation, false);
  assert.equal(patch.conditionallyGuarded, true);
  assert.equal(patch.effectivePolicy.default.requiresConfirmation, false);
  assert.equal(patch.effectivePolicy.conditionalCases[0].level, "external");
  assert.equal(patch.effectivePolicy.conditionalCases[0].requiresConfirmation, true);
  assert.equal(
    patch.effectivePolicy.conditionalCases[0].confirmation.outputField,
    "data.safety.confirmationTarget",
  );

  const createdList = operationDescription(operation("listCreatedRecipes")).safety;
  assert.equal(createdList.level, "read");
  assert.equal(createdList.advertisedOnlyGate, true);
  assert.equal(createdList.effectivePolicy.conditionalCases[0].allowUnverifiedRequired, true);

  const unverified = operationDescription(operation("movePlannedRecipe")).safety;
  assert.equal(unverified.effectivePolicy.default.allowUnverifiedRequired, true);
  assert.equal(unverified.effectivePolicy.default.requiresConfirmation, false);
  assert.equal(unverified.effectivePolicy.default.confirmation, undefined);

  const catalog = operationCatalog(operations).operations;
  assert.deepEqual(operationCatalog(operations).source, {
    generatedFrom: "cookidoo-openapi/openapi.yaml",
    repository: "https://github.com/aimlesx/cookidoo-openapi",
    commit: "69bb43119b162ad8fea48ddb6a436d2074013972",
    path: "openapi.yaml",
    sha256: "d04829c9140ccba4003e0f0ce39883158e73ac8f9e42ae2c8fc365a28b1fa5aa",
  });
  const shoppingCatalog = catalog.find((entry) =>
    entry.operationId === "removeRecipesFromShoppingList");
  assert.equal(shoppingCatalog.risk, "destructive");
  assert.equal(shoppingCatalog.destructive, true);
  assert.equal(shoppingCatalog.guarded, true);

  const patchCatalog = catalog.find((entry) => entry.operationId === "patchCreatedRecipe");
  assert.deepEqual(patchCatalog.risks, ["private-write", "external"]);
  assert.deepEqual(patchCatalog.taskCommands, [
    "cookidoo-axi created publish <customerRecipeId>",
    "cookidoo-axi created unpublish <customerRecipeId>",
  ]);

  const createdListCatalog = catalog.find((entry) => entry.operationId === "listCreatedRecipes");
  assert.equal(createdListCatalog.requiresAllowUnverified, true);
  assert.deepEqual(createdListCatalog.taskCommands, [
    "cookidoo-axi created import --recipe-url <https-url>",
  ]);

  const advertisedDestructive = catalog.find((entry) => entry.operationId === "revokeSharedList");
  assert.equal(advertisedDestructive.risk, "external");
  assert.equal(advertisedDestructive.destructive, true);
  assert.equal(advertisedDestructive.requiresAllowUnverified, true);
});

test("all structured operation descriptions are total, complete by status, and bounded", () => {
  for (const current of operations) {
    const description = operationDescription(current);
    const serialized = JSON.stringify(description);
    assert.ok(serialized.length < 15_000, `${current.operationId}: ${serialized.length}`);
    assert.equal(description.request.parameters.length, current.parameters.length, current.operationId);
    assert.deepEqual(
      description.response.statuses.map((status) => status.status),
      Object.keys(current.responses),
      current.operationId,
    );
    for (const [index, media] of Object.values(current.requestBody?.content ?? {}).entries()) {
      assert.deepEqual(
        description.request.bodies[index].properties.map((property) => property.name),
        Object.keys(media.bodyProperties),
        current.operationId,
      );
    }
  }
});
