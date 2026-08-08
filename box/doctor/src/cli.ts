import { collect } from "./collect";
import { formatHuman, formatJson, healthDocumentFromEvidence } from "./report";

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd !== "report" && cmd !== undefined) {
    console.error(`unknown command: ${cmd} (this build supports: report)`);
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
