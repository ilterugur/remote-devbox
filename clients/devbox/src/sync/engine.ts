/**
 * engine.ts — pluggable two-way sync engine behind one interface. Mutagen is the
 * default; Syncthing is the second impl. The CLI never branches on engine id — it
 * calls engineFor(syncEngineFor(cfg, profile)).
 */
import { die, type EngineId } from "../config";
import { MutagenEngine } from "./mutagen";
import { SyncthingEngine } from "./syncthing";

/** null means the engine could not prove a conflict count; recovery must fail closed. */
export type SyncStatus = { name: string; state: string; conflicts: number | null };
export type SyncUpOpts = { profile: string; host: string; localRoot: string; remoteRoot: string; ignores: string[] };

export interface SyncEngine {
  id: EngineId;
  up(o: SyncUpOpts): Promise<void>;
  down(profile: string): Promise<void>;
  status(): Promise<SyncStatus[]>;
  pause(profile: string): Promise<void>;
  resume(profile: string): Promise<void>;
}

/**
 * Patterns never synced. VCS is handled separately (engine-specific). Two groups:
 * heavy build/dependency dirs, and OS/editor cruft (macOS/Windows/Vim droppings).
 */
export const DEFAULT_IGNORES = [
  // build / dependency dirs
  "node_modules", "dist", "build", ".next", "target",
  // OS / editor cruft
  ".DS_Store", "._*", ".Spotlight-V100", ".Trashes", ".fseventsd",
  "Thumbs.db", "desktop.ini", "*.swp",
];

export function engineFor(id: EngineId): SyncEngine {
  if (id === "mutagen") return new MutagenEngine();
  if (id === "syncthing") return new SyncthingEngine();
  return die(`unknown sync engine "${id}"`);
}
