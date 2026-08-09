import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { HealthDocument } from "./types";
import { collectHostDocument, type CommandRunner } from "./collect";
import { parseHealthFacts } from "./facts";

export function writeHealthSnapshot(path: string, document: HealthDocument): void {
  const temporary = `${path}.${process.pid}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export interface CreateSnapshotOptions {
  factsPath: string;
  outputPath: string;
  runner: CommandRunner;
  now?: Date;
}

export async function createSnapshot(options: CreateSnapshotOptions): Promise<HealthDocument> {
  const facts = parseHealthFacts(JSON.parse(readFileSync(options.factsPath, "utf8")));
  const document = await collectHostDocument(facts, options.runner, options.now);
  writeHealthSnapshot(options.outputPath, document);
  return document;
}
