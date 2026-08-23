/** OMP 17.4.2's built-in role contract. Preset names and model selectors remain inventory data. */
export const MODEL_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "designer",
  "commit",
  "tiny",
  "task",
  "advisor",
] as const;

export const OMP_THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PRESET_STATE_CUSTOM_TYPE = "omp-model-presets/state";
export const PRESET_STATE_VERSION = 1 as const;

export type OmpModelRole = (typeof MODEL_ROLE_IDS)[number];
export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];
export type OmpRoleSelectors = Record<OmpModelRole, string>;

export interface ParsedRoleSelection {
  selector: string;
  modelSelector: string;
  thinking: OmpThinkingLevel;
}

export interface ParsedPreset {
  roles: Record<OmpModelRole, ParsedRoleSelection>;
  selectors: OmpRoleSelectors;
}

export type OmpUsageReservePolicy = "confirm" | "auto" | "fail-closed";
export type OmpFallbackRevertPolicy = "cooldown-expiry" | "never";

export interface ParsedRetryPolicy {
  modelFallback: boolean;
  usageAwareFallback: boolean;
  usageReservePct: number;
  usageReservePolicy: OmpUsageReservePolicy;
  fallbackRevertPolicy: OmpFallbackRevertPolicy;
  fallbackChains: Record<string, string[]>;
}

export type OmpRetrySettings = {
  "retry.modelFallback": boolean;
  "retry.usageAwareFallback": boolean;
  "retry.usageReservePct": number;
  "retry.usageReservePolicy": OmpUsageReservePolicy;
  "retry.fallbackRevertPolicy": OmpFallbackRevertPolicy;
  "retry.fallbackChains": Record<string, string[]>;
};

export interface ParsedPresetDocument {
  defaultPreset: string;
  presets: Record<string, ParsedPreset>;
  retry?: ParsedRetryPolicy;
}

export interface PresetState {
  version: typeof PRESET_STATE_VERSION;
  preset: string | null;
}

export interface SessionEntryLike {
  customType?: unknown;
  data?: unknown;
}

export interface ResolvedOmpModel<Model> {
  model: Model;
  supportedThinking?: readonly OmpThinkingLevel[];
}

type MaybePromise<T> = T | Promise<T>;

export interface OmpModelPresetRuntime<Model> {
  resolveModel(selector: string): MaybePromise<ResolvedOmpModel<Model> | undefined>;
  currentModel(): Model;
  currentThinking(): OmpThinkingLevel;
  replaceRoles(roles: OmpRoleSelectors): MaybePromise<void>;
  clearRoles(): MaybePromise<void>;
  setModel(model: Model): MaybePromise<boolean>;
  setThinking(level: OmpThinkingLevel): MaybePromise<void>;
  appendState(state: PresetState): MaybePromise<void>;
}

export interface OmpModelPresetController {
  list(): string[];
  status(): { activePreset: string | null; defaultPreset: string };
  apply(name: string): Promise<void>;
  reset(): Promise<void>;
  initializeNewSession(entries: readonly SessionEntryLike[]): Promise<boolean>;
  restore(entries: readonly SessionEntryLike[]): Promise<boolean>;
}

export function toOmpRetrySettings(policy: ParsedRetryPolicy): OmpRetrySettings {
  return {
    "retry.modelFallback": policy.modelFallback,
    "retry.usageAwareFallback": policy.usageAwareFallback,
    "retry.usageReservePct": policy.usageReservePct,
    "retry.usageReservePolicy": policy.usageReservePolicy,
    "retry.fallbackRevertPolicy": policy.fallbackRevertPolicy,
    "retry.fallbackChains": Object.fromEntries(
      Object.entries(policy.fallbackChains).map(([selector, fallbacks]) => [selector, [...fallbacks]]),
    ),
  };
}

export function formatPresetList(
  names: readonly string[],
  status: { activePreset: string | null; defaultPreset: string },
): string {
  const header = status.activePreset === null ? "OMP presets (override reset):" : "OMP presets:";
  const rows = names.map((name) => {
    const markers = [
      ...(name === status.activePreset ? ["active"] : []),
      ...(name === status.defaultPreset ? ["default"] : []),
    ];
    return `- ${name}${markers.length > 0 ? ` (${markers.join(", ")})` : ""}`;
  });
  return [header, ...rows].join("\n");
}

const PRESET_NAME_RE = /^[a-z][a-z0-9-]*$/;
const THINKING_LEVEL_SET = new Set<string>(OMP_THINKING_LEVELS);
const ROLE_SET = new Set<string>(MODEL_ROLE_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSelection(value: unknown, path: string): ParsedRoleSelection {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${path} must be a non-empty model selector`);
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${path} must end with a supported thinking level`);
  }
  const modelSelector = value.slice(0, separator);
  const thinking = value.slice(separator + 1);
  if (!THINKING_LEVEL_SET.has(thinking)) {
    throw new Error(`${path} has unsupported thinking level '${thinking}'`);
  }
  return { selector: value, modelSelector, thinking: thinking as OmpThinkingLevel };
}

function parseRetryPolicy(raw: unknown): ParsedRetryPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("retry must be a mapping");
  const allowed = new Set([
    "model_fallback",
    "usage_aware_fallback",
    "usage_reserve_pct",
    "usage_reserve_policy",
    "fallback_revert_policy",
    "fallback_chains",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`unknown OMP retry field '${key}'`);
  }
  if (typeof raw.model_fallback !== "boolean") throw new Error("retry.model_fallback must be true or false");
  if (typeof raw.usage_aware_fallback !== "boolean") throw new Error("retry.usage_aware_fallback must be true or false");
  if (!(typeof raw.usage_reserve_pct === "number" && Number.isInteger(raw.usage_reserve_pct) && raw.usage_reserve_pct >= 1 && raw.usage_reserve_pct <= 100)) {
    throw new Error("retry.usage_reserve_pct must be an integer in 1..100");
  }
  if (!["confirm", "auto", "fail-closed"].includes(String(raw.usage_reserve_policy))) {
    throw new Error("retry.usage_reserve_policy is unsupported");
  }
  if (!["cooldown-expiry", "never"].includes(String(raw.fallback_revert_policy))) {
    throw new Error("retry.fallback_revert_policy is unsupported");
  }
  if (!isRecord(raw.fallback_chains) || Object.keys(raw.fallback_chains).length === 0) {
    throw new Error("retry.fallback_chains must be a non-empty mapping");
  }
  const fallbackChains: Record<string, string[]> = {};
  for (const [selector, rawFallbacks] of Object.entries(raw.fallback_chains)) {
    if (selector.length === 0 || selector.trim() !== selector || !Array.isArray(rawFallbacks) || rawFallbacks.length === 0) {
      throw new Error(`retry.fallback_chains '${selector}' is invalid`);
    }
    const fallbacks: string[] = [];
    for (const fallback of rawFallbacks) {
      if (typeof fallback !== "string" || fallback.length === 0 || fallback.trim() !== fallback || fallbacks.includes(fallback)) {
        throw new Error(`retry.fallback_chains '${selector}' contains an invalid fallback selector`);
      }
      fallbacks.push(fallback);
    }
    fallbackChains[selector] = fallbacks;
  }
  return {
    modelFallback: raw.model_fallback,
    usageAwareFallback: raw.usage_aware_fallback,
    usageReservePct: raw.usage_reserve_pct,
    usageReservePolicy: raw.usage_reserve_policy as OmpUsageReservePolicy,
    fallbackRevertPolicy: raw.fallback_revert_policy as OmpFallbackRevertPolicy,
    fallbackChains,
  };
}

export function parsePresetDocument(raw: unknown): ParsedPresetDocument {
  if (!isRecord(raw)) throw new Error("OMP model preset document must be a mapping");
  for (const key of Object.keys(raw)) {
    if (key !== "default_preset" && key !== "presets" && key !== "retry") throw new Error(`unknown OMP model preset field '${key}'`);
  }
  if (typeof raw.default_preset !== "string" || !PRESET_NAME_RE.test(raw.default_preset)) {
    throw new Error("default_preset must be a safe preset name");
  }
  if (!isRecord(raw.presets) || Object.keys(raw.presets).length === 0) {
    throw new Error("presets must be a non-empty mapping");
  }
  if (!Object.hasOwn(raw.presets, raw.default_preset)) {
    throw new Error(`default preset '${raw.default_preset}' is not declared`);
  }

  const presets: Record<string, ParsedPreset> = {};
  for (const [presetName, rawRoles] of Object.entries(raw.presets)) {
    if (!PRESET_NAME_RE.test(presetName)) throw new Error(`unsafe preset name '${presetName}'`);
    if (!isRecord(rawRoles)) throw new Error(`preset '${presetName}' must be a role mapping`);
    for (const key of Object.keys(rawRoles)) {
      if (!ROLE_SET.has(key)) throw new Error(`preset '${presetName}' has unknown role '${key}'`);
    }

    const parsedRoles = {} as Record<OmpModelRole, ParsedRoleSelection>;
    const selectors = {} as OmpRoleSelectors;
    for (const role of MODEL_ROLE_IDS) {
      if (!Object.hasOwn(rawRoles, role)) throw new Error(`preset '${presetName}' is missing role '${role}'`);
      const parsed = parseSelection(rawRoles[role], `preset '${presetName}' role '${role}'`);
      parsedRoles[role] = parsed;
      selectors[role] = parsed.selector;
    }
    presets[presetName] = { roles: parsedRoles, selectors };
  }

  const retry = parseRetryPolicy(raw.retry);
  return { defaultPreset: raw.default_preset, presets, ...(retry ? { retry } : {}) };
}

function parseState(value: unknown): PresetState | undefined {
  if (!isRecord(value) || value.version !== PRESET_STATE_VERSION) return undefined;
  if (value.preset !== null && typeof value.preset !== "string") return undefined;
  return { version: PRESET_STATE_VERSION, preset: value.preset };
}

export function latestPresetState(entries: readonly SessionEntryLike[]): PresetState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.customType !== PRESET_STATE_CUSTOM_TYPE) continue;
    const state = parseState(entry.data);
    if (state) return state;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPresetController<Model>(
  document: ParsedPresetDocument,
  runtime: OmpModelPresetRuntime<Model>,
): OmpModelPresetController {
  let activePreset: string | null = null;
  let activeRoles: OmpRoleSelectors | null = null;
  let queue: Promise<void> = Promise.resolve();

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const validated = async (name: string): Promise<{ preset: ParsedPreset; models: Record<OmpModelRole, Model> }> => {
    const preset = document.presets[name];
    if (!preset) throw new Error(`unknown OMP model preset '${name}'`);

    const models = {} as Record<OmpModelRole, Model>;
    for (const role of MODEL_ROLE_IDS) {
      const selection = preset.roles[role];
      const resolved = await runtime.resolveModel(selection.modelSelector);
      if (!resolved) throw new Error(`model '${selection.modelSelector}' for role '${role}' is unavailable or unauthenticated`);
      if (resolved.supportedThinking && !resolved.supportedThinking.includes(selection.thinking)) {
        throw new Error(
          `thinking level '${selection.thinking}' is unsupported by '${selection.modelSelector}' for role '${role}'`,
        );
      }
      models[role] = resolved.model;
    }
    return { preset, models };
  };

  const restoreRoles = async (roles: OmpRoleSelectors | null): Promise<void> => {
    if (roles) await runtime.replaceRoles(roles);
    else await runtime.clearRoles();
  };

  const applyUnlocked = async (name: string): Promise<void> => {
    const { preset, models } = await validated(name);
    const previousPreset = activePreset;
    const previousRoles = activeRoles;
    const previousModel = runtime.currentModel();
    const previousThinking = runtime.currentThinking();

    try {
      await runtime.replaceRoles(preset.selectors);
      if (!(await runtime.setModel(models.default))) {
        throw new Error(`could not select model '${preset.roles.default.modelSelector}'`);
      }
      await runtime.setThinking(preset.roles.default.thinking);
      await runtime.appendState({ version: PRESET_STATE_VERSION, preset: name });
      activePreset = name;
      activeRoles = { ...preset.selectors };
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        await restoreRoles(previousRoles);
      } catch (rollbackError) {
        rollbackErrors.push(`roles: ${errorMessage(rollbackError)}`);
      }
      try {
        if (!(await runtime.setModel(previousModel))) rollbackErrors.push("model: previous model was rejected");
      } catch (rollbackError) {
        rollbackErrors.push(`model: ${errorMessage(rollbackError)}`);
      }
      try {
        await runtime.setThinking(previousThinking);
      } catch (rollbackError) {
        rollbackErrors.push(`thinking: ${errorMessage(rollbackError)}`);
      }
      activePreset = previousPreset;
      activeRoles = previousRoles;
      const suffix = rollbackErrors.length > 0 ? `; rollback failed (${rollbackErrors.join(", ")})` : "";
      throw new Error(`${errorMessage(error)}${suffix}`);
    }
  };

  return {
    list: () => Object.keys(document.presets),
    status: () => ({ activePreset, defaultPreset: document.defaultPreset }),
    apply: (name) => exclusive(() => applyUnlocked(name)),
    reset: () =>
      exclusive(async () => {
        await runtime.clearRoles();
        await runtime.appendState({ version: PRESET_STATE_VERSION, preset: null });
        activePreset = null;
        activeRoles = null;
      }),
    initializeNewSession: (entries) =>
      exclusive(async () => {
        if (latestPresetState(entries) !== undefined) return false;
        await applyUnlocked(document.defaultPreset);
        return true;
      }),
    restore: (entries) =>
      exclusive(async () => {
        const state = latestPresetState(entries);
        if (!state) {
          if (activeRoles) await runtime.clearRoles();
          activePreset = null;
          activeRoles = null;
          return false;
        }
        if (state.preset === null) {
          await runtime.clearRoles();
          activePreset = null;
          activeRoles = null;
          return true;
        }
        const { preset } = await validated(state.preset);
        await runtime.replaceRoles(preset.selectors);
        activePreset = state.preset;
        activeRoles = { ...preset.selectors };
        return true;
      }),
  };
}
