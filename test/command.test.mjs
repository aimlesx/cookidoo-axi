import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  commandArgument,
  commandContextTokens,
  commandLiteral,
  commandLiterals,
  quotePosixArgument,
  renderCommand,
  renderContextualCommand,
} from "../dist/cli/command.js";

test("all runtime arguments are single-quoted, including provider IDs and shell metacharacters", () => {
  assert.equal(quotePosixArgument("r123"), "'r123'");
  assert.equal(
    quotePosixArgument("a&b?*[x]% $HOME;whoami"),
    "'a&b?*[x]% $HOME;whoami'",
  );
  assert.equal(quotePosixArgument("it's"), `'it'"'"'s'`);
  assert.equal(quotePosixArgument("line one\nline two\tend"), "'line one\nline two\tend'");
  assert.throws(() => quotePosixArgument("cannot\0render"), /cannot contain NUL/u);
});

test("the rendered command preserves adversarial arguments through a real POSIX shell", () => {
  const arguments_ = [
    "custom&printf INJECTED",
    "query?*[abc]",
    "$(printf INJECTED)",
    "semi; printf INJECTED",
    "line one\nline two",
    "quote'and space",
  ];
  const command = renderCommand([
    commandArgument(process.execPath),
    commandLiteral("-e"),
    commandArgument("process.stdout.write(JSON.stringify(process.argv.slice(1)))"),
    ...arguments_.map(commandArgument),
  ]);

  const stdout = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  assert.equal(stdout, JSON.stringify(arguments_));
  assert.deepEqual(JSON.parse(stdout), arguments_);
});

test("static tokens reject shell syntax instead of accidentally treating data as syntax", () => {
  const unsafeTokens = [
    "x&whoami",
    "x?",
    "*",
    "two words",
    "$(id)",
    "a;b",
    "line\nbreak",
    "",
  ];
  for (const unsafe of unsafeTokens) {
    assert.throws(
      () => commandLiteral(unsafe),
      /use commandArgument\(\) for runtime values/u,
    );
  }
  assert.deepEqual(
    commandLiterals(["cookidoo-axi", "organize", "custom-list", "--max-items"])
      .map(({ value }) => value),
    ["cookidoo-axi", "organize", "custom-list", "--max-items"],
  );
  assert.throws(
    () => renderCommand([{ kind: "literal", value: "forged&token" }]),
    /use commandArgument\(\) for runtime values/u,
  );
});

test("contextual commands preserve non-default output, account, locale, and bounds safely", () => {
  const options = {
    profile: "work & home",
    lang: "en?glob",
    output: "json",
    maxItems: 7,
    timeoutMs: 1_234,
    fields: ["id", "name with space"],
  };
  const command = renderContextualCommand([
    ...commandLiterals(["cookidoo-axi", "organize", "custom-list", "get"]),
    commandArgument("provider*id"),
  ], options);
  assert.equal(
    command,
    "cookidoo-axi organize custom-list get 'provider*id' --profile 'work & home' --lang 'en?glob' --output 'json' --max-items '7' --timeout-ms '1234' --fields 'id,name with space'",
  );

  assert.deepEqual(commandContextTokens({
    profile: "default",
    lang: "pl",
    output: "toon",
    maxItems: 20,
  }), []);
  assert.equal(
    renderContextualCommand(
      [commandLiteral("cookidoo-axi"), commandLiteral("auth"), commandLiteral("status")],
      { profile: "default", lang: "pl", output: "toon", maxItems: 20 },
      {
        profile: true,
        lang: false,
        output: true,
        maxItems: false,
        timeoutMs: false,
        fields: false,
        includeDefaults: true,
      },
    ),
    "cookidoo-axi auth status --profile 'default' --output 'toon'",
  );
});

test("full-command rendering can preserve parsed options and append --full once", () => {
  const command = renderContextualCommand([
    ...commandLiterals(["cookidoo-axi", "created", "list"]),
    commandLiteral("--full"),
  ], {
    profile: "work",
    lang: "de",
    output: "json",
    maxItems: 5,
    fields: ["id", "name"],
    full: false,
  });
  assert.equal(
    command,
    "cookidoo-axi created list --full --profile 'work' --lang 'de' --output 'json' --max-items '5' --fields 'id,name'",
  );
});
