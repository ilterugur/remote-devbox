import { collect } from "./collect";
import { runCommand } from "./collect";
import { formatHuman, formatJson, healthDocumentFromEvidence } from "./report";
import { createSnapshot } from "./snapshot";

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
  const json = rest.includes("--json");
  try {
    const health = await collect({
      profileHome: process.env.HOME ?? "/root",
      activityWindowSec: 10 * 60,
      idleAfterSec: 30 * 60,
    });
    const document = healthDocumentFromEvidence(health);
    console.log(json ? formatJson(document) : formatHuman(document));
  } catch (err) {
    console.error(
      `doctor: failed to collect health: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

main();
