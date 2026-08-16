import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const legacyStatePath = join(
  homedir(),
  "Library",
  "Application Support",
  "calendar-tetris",
  "state.json",
);

/** Remove identifier-based state written by pre-0.1 development builds. */
export async function removeLegacyState(): Promise<void> {
  await rm(legacyStatePath, { force: true });
}
