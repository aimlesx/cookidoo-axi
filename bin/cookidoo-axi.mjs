#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.some((argument) => ["-v", "-V", "--version"].includes(argument))) {
  const { VERSION } = await import("../dist/version.js");
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const { run } = await import("../dist/cli.js");
await run(args, { executablePath: process.argv[1] });
