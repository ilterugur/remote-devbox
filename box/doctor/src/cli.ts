import { runCommand } from "./collect";
import { formatHuman, formatJson, createHealthDocument } from "./report";
import { createSnapshot } from "./snapshot";
import { readHealthSnapshot } from "./document";
import { collectProfileComponents, systemProfileProbe } from "./profile";
import { userInfo } from "node:os";

const HEALTH_FACTS_PATH = "/etc/remote-devbox/health-components.json";
const HEALTH_SNAPSHOT_PATH = "/run/remote-devbox/health.json";

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === "snapshot") {
    if (rest.length) {
      console.error("doctor: snapshot takes no arguments");
      process.exit(2);
    }
    if (process.getuid?.() !== 0) {
      console.error("doctor: snapshot must run as root through devbox-health-snapshot.service");
      process.exit(1);
    }
    try {
      await createSnapshot({
        factsPath: HEALTH_FACTS_PATH,
        outputPath: HEALTH_SNAPSHOT_PATH,
        runner: runCommand,
      });
      return;
    } catch (err) {
      console.error(`doctor: snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (cmd !== "report" && cmd !== undefined) {
    console.error(`unknown command: ${cmd} (this build supports: report, snapshot)`);
    process.exit(2);
  }
  let json = false;
  let profile = userInfo().username;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--profile") {
      const value = rest[++index];
      if (!value) {
        console.error("doctor: --profile requires a value");
        process.exit(2);
      }
      profile = value;
    } else {
      console.error(`doctor: unknown report argument '${arg}'`);
      process.exit(2);
    }
  }
  if (profile !== userInfo().username) {
    console.error("doctor: --profile must name the invoking account");
    process.exit(2);
  }
  try {
    const now = new Date();
    const snapshot = readHealthSnapshot(HEALTH_SNAPSHOT_PATH, { profile, now });
    const local = await collectProfileComponents(profile, systemProfileProbe(profile));
    const document = createHealthDocument(now.toISOString(), [...snapshot.components, ...local]);
    console.log(json ? formatJson(document) : formatHuman(document));
    if (document.status === "failed" || document.status === "blocked") process.exitCode = 1;
  } catch (err) {
    console.error(
      `doctor: failed to collect health: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

main();
