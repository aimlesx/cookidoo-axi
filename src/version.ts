import { readFileSync } from "node:fs";

function packageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(packageUrl, "utf8"));
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("version" in parsed)
    || typeof parsed.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.version)
  ) {
    throw new Error("cookidoo-axi package version is missing or invalid");
  }
  return parsed.version;
}

/** The package version is read from the single canonical package.json field. */
export const VERSION = packageVersion();
