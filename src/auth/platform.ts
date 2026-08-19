import { AuthError } from "./errors.js";

export function assertDarwin(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new AuthError({
      code: "UNSUPPORTED_PLATFORM",
      message: "cookidoo-axi credential storage is supported only on macOS.",
      suggestion: "Run cookidoo-axi on macOS with Keychain access available.",
    });
  }
}
