import { describe, expect, test } from "bun:test";

import {
  MODEL_ROLE_IDS,
  PRESET_STATE_CUSTOM_TYPE,
  createPresetController,
  formatPresetDetails,
  formatPresetList,
  latestPresetState,
  parsePresetDocument,
  presetNamesForShow,
  toOmpRetrySettings,
  type OmpModelPresetRuntime,
  type OmpThinkingLevel,
  type PresetState,
} from "./core";

const roles = (selector = "provider/primary:xhigh") =>
  Object.fromEntries(MODEL_ROLE_IDS.map((role) => [role, selector])) as Record<(typeof MODEL_ROLE_IDS)[number], string>;

const rawDocument = () => ({
  default_preset: "balanced",
  aliases: {
    codex: "alternate",
    claude: "balanced",
  },
  presets: {
    balanced: {
      ...roles(),
      smol: "provider/small:medium",
      tiny: "provider/small:medium",
      commit: "provider/small:medium",
    },
    alternate: roles("provider/alternate:high"),
  },
});

const rawRetryPolicy = () => ({
  model_fallback: true,
  usage_aware_fallback: true,
  usage_reserve_pct: 1,
  usage_reserve_policy: "auto",
  fallback_revert_policy: "cooldown-expiry",
  fallback_chains: {
    "openai-codex/gpt-5.6-sol": ["anthropic/claude-opus-5:xhigh", "opencode-zen/mimo-v2.5-free"],
    "anthropic/claude-opus-5": ["openai-codex/gpt-5.6-sol:xhigh", "opencode-zen/mimo-v2.5-free"],
  },
});

class FakeRuntime implements OmpModelPresetRuntime<string> {
  events: string[] = [];
  model = "provider/original";
  thinking: OmpThinkingLevel = "low";
  roles: Record<string, string> | null = null;
  states: PresetState[] = [];
  failSetModelFor: string | null = null;
  beforeSetModel: ((model: string) => Promise<void>) | null = null;
  readonly catalog = new Map<string, readonly OmpThinkingLevel[]>([
    ["provider/primary", ["medium", "high", "xhigh"]],
    ["provider/small", ["medium"]],
    ["provider/alternate", ["high"]],
  ]);

  async resolveModel(selector: string) {
    this.events.push(`resolve:${selector}`);
    const supportedThinking = this.catalog.get(selector);
    return supportedThinking ? { model: selector, supportedThinking } : undefined;
  }

  currentModel() {
    return this.model;
  }

  currentThinking() {
    return this.thinking;
  }

  async replaceRoles(value: Record<string, string>) {
    this.events.push("replaceRoles");
    this.roles = { ...value };
  }

  async clearRoles() {
    this.events.push("clearRoles");
    this.roles = null;
  }

  async setModel(model: string) {
    this.events.push(`setModel:${model}`);
    await this.beforeSetModel?.(model);
    if (this.failSetModelFor === model) return false;
    this.model = model;
    return true;
  }

  async setThinking(level: OmpThinkingLevel) {
    this.events.push(`setThinking:${level}`);
    this.thinking = level;
  }

  async appendState(state: PresetState) {
    this.events.push(`appendState:${state.preset ?? "reset"}`);
    this.states.push(state);
  }
}

describe("parsePresetDocument", () => {
  test("accepts only a complete declarative preset document", () => {
    const parsed = parsePresetDocument(rawDocument());

    expect(parsed.defaultPreset).toBe("balanced");
    expect(Object.keys(parsed.presets)).toEqual(["balanced", "alternate"]);
    expect(parsed.presets.balanced?.roles.default).toEqual({
      selector: "provider/primary:xhigh",
      modelSelector: "provider/primary",
      thinking: "xhigh",
    });
  });

  test("parses aliases and rejects collisions, reserved names, or unknown targets", () => {
    const parsed = parsePresetDocument(rawDocument());

    expect(parsed.aliases).toEqual({ codex: "alternate", claude: "balanced" });
    expect(() =>
      parsePresetDocument({ ...rawDocument(), aliases: { balanced: "alternate" } }),
    ).toThrow("collides");
    expect(() =>
      parsePresetDocument({ ...rawDocument(), aliases: { codex: "missing" } }),
    ).toThrow("not declared");
    expect(() =>
      parsePresetDocument({ ...rawDocument(), aliases: { reset: "balanced" } }),
    ).toThrow("reserved");
  });

  test("keeps prototype-named canonical presets addressable", async () => {
    const document = parsePresetDocument({
      default_preset: "constructor",
      presets: { constructor: roles() },
    });
    const runtime = new FakeRuntime();
    const controller = createPresetController(document, runtime);

    await controller.apply("constructor");

    expect(controller.status().activePreset).toBe("constructor");
    expect(runtime.states).toEqual([{ version: 1, preset: "constructor" }]);
  });

  test("preserves a bare task selector so the bundled task agent can keep auto thinking", () => {
    const document = rawDocument();
    document.presets.balanced.task = "provider/primary";

    const parsed = parsePresetDocument(document);

    expect(parsed.presets.balanced?.roles.task).toEqual({
      selector: "provider/primary",
      modelSelector: "provider/primary",
    });
    expect(parsed.presets.balanced?.selectors.task).toBe("provider/primary");
  });

  test("parses a complete quota-aware retry policy without changing preset data", () => {
    const parsed = parsePresetDocument({ ...rawDocument(), retry: rawRetryPolicy() });

    expect(parsed.retry).toEqual({
      modelFallback: true,
      usageAwareFallback: true,
      usageReservePct: 1,
      usageReservePolicy: "auto",
      fallbackRevertPolicy: "cooldown-expiry",
      fallbackChains: {
        "openai-codex/gpt-5.6-sol": ["anthropic/claude-opus-5:xhigh", "opencode-zen/mimo-v2.5-free"],
        "anthropic/claude-opus-5": ["openai-codex/gpt-5.6-sol:xhigh", "opencode-zen/mimo-v2.5-free"],
      },
    });
    expect(parsed.presets.balanced?.selectors.default).toBe("provider/primary:xhigh");
  });

  test("rejects malformed retry percentages, unknown fields, and unsafe fallback selectors", () => {
    const badPercentage = rawRetryPolicy();
    badPercentage.usage_reserve_pct = 0;
    expect(() => parsePresetDocument({ ...rawDocument(), retry: badPercentage })).toThrow("usage_reserve_pct");

    const unknown = { ...rawRetryPolicy(), surprise: true };
    expect(() => parsePresetDocument({ ...rawDocument(), retry: unknown })).toThrow("surprise");

    const unsafe = rawRetryPolicy();
    unsafe.fallback_chains["openai-codex/gpt-5.6-sol"] = [" anthropic/claude-opus-5:xhigh"];
    expect(() => parsePresetDocument({ ...rawDocument(), retry: unsafe })).toThrow("fallback_chains");
  });

  test("rejects missing, extra, or malformed roles and thinking levels", () => {
    const missing = rawDocument();
    delete (missing.presets.balanced as Record<string, string>).advisor;
    expect(() => parsePresetDocument(missing)).toThrow("advisor");

    const extra = rawDocument();
    (extra.presets.balanced as Record<string, string>).surprise = "provider/primary:xhigh";
    expect(() => parsePresetDocument(extra)).toThrow("surprise");

    const invalidThinking = rawDocument();
    invalidThinking.presets.balanced.default = "provider/primary:extreme";
    expect(() => parsePresetDocument(invalidThinking)).toThrow("thinking level");
  });
});

describe("OMP retry settings", () => {
  test("maps the declarative retry policy to OMP 18.0.5 setting paths", () => {
    const policy = parsePresetDocument({ ...rawDocument(), retry: rawRetryPolicy() }).retry!;

    expect(toOmpRetrySettings(policy)).toEqual({
      "retry.modelFallback": true,
      "retry.usageAwareFallback": true,
      "retry.usageReservePct": 1,
      "retry.usageReservePolicy": "auto",
      "retry.fallbackRevertPolicy": "cooldown-expiry",
      "retry.fallbackChains": rawRetryPolicy().fallback_chains,
    });
  });
});

describe("preset list", () => {
  test("marks the active and default presets", () => {
    expect(
      formatPresetList(["balanced", "codex", "claude"], {
        activePreset: "balanced",
        defaultPreset: "balanced",
      }),
    ).toBe("OMP presets:\n- balanced (active, default)\n- codex\n- claude");
  });

  test("shows only the default marker after the override is reset", () => {
    expect(
      formatPresetList(["balanced", "codex"], {
        activePreset: null,
        defaultPreset: "balanced",
      }),
    ).toBe("OMP presets (override reset):\n- balanced (default)\n- codex");
  });
});

describe("preset details", () => {
  test("shows every role for one preset with active and default markers", () => {
    const document = parsePresetDocument(rawDocument());

    expect(
      formatPresetDetails(document, ["balanced"], {
        activePreset: "balanced",
        defaultPreset: "balanced",
      }),
    ).toBe(
      [
        "OMP preset: balanced (active, default)",
        "- default: provider/primary:xhigh",
        "- smol: provider/small:medium",
        "- slow: provider/primary:xhigh",
        "- vision: provider/primary:xhigh",
        "- plan: provider/primary:xhigh",
        "- designer: provider/primary:xhigh",
        "- commit: provider/small:medium",
        "- tiny: provider/small:medium",
        "- task: provider/primary:xhigh",
        "- advisor: provider/primary:xhigh",
      ].join("\n"),
    );
  });

  test("shows all presets and rejects unknown names", () => {
    const document = parsePresetDocument(rawDocument());
    const output = formatPresetDetails(document, Object.keys(document.presets), {
      activePreset: "alternate",
      defaultPreset: "balanced",
    });

    expect(output).toContain("OMP preset: balanced (default)");
    expect(output).toContain("\n\nOMP preset: alternate (active)\n");
    expect(() =>
      formatPresetDetails(document, ["missing"], {
        activePreset: "alternate",
        defaultPreset: "balanced",
      }),
    ).toThrow("unknown OMP model preset 'missing'");
  });

  test("selects canonical presets through active names, aliases, or all", () => {
    const document = parsePresetDocument(rawDocument());
    const names = ["balanced", "alternate"];

    expect(presetNamesForShow("", names, "balanced", document.aliases)).toEqual(["balanced"]);
    expect(presetNamesForShow("codex", names, "balanced", document.aliases)).toEqual(["alternate"]);
    expect(presetNamesForShow("all", names, "balanced", document.aliases)).toEqual(names);
    expect(() => presetNamesForShow("", names, null, document.aliases)).toThrow("no active OMP model preset");
    expect(() => presetNamesForShow("missing", names, "balanced", document.aliases)).toThrow(
      "unknown OMP model preset 'missing'",
    );
  });
});

describe("latestPresetState", () => {
  test("returns the latest valid extension state and ignores unrelated entries", () => {
    expect(
      latestPresetState([
        { customType: PRESET_STATE_CUSTOM_TYPE, data: { version: 1, preset: "balanced" } },
        { customType: "something-else", data: { version: 1, preset: "ignored" } },
        { customType: PRESET_STATE_CUSTOM_TYPE, data: { version: 1, preset: "alternate" } },
      ]),
    ).toEqual({ version: 1, preset: "alternate" });
  });
});

describe("preset controller", () => {
  test("resolves and validates every role before mutating runtime state", async () => {
    const runtime = new FakeRuntime();
    runtime.catalog.delete("provider/small");
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    await expect(controller.apply("balanced")).rejects.toThrow("provider/small");
    expect(runtime.events.every((event) => event.startsWith("resolve:"))).toBe(true);
    expect(runtime.roles).toBeNull();
    expect(runtime.model).toBe("provider/original");
    expect(runtime.states).toEqual([]);
  });

  test("applies a full role replacement, main model, thinking, and durable state", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    await controller.apply("balanced");

    expect(runtime.roles).toEqual(rawDocument().presets.balanced);
    expect(runtime.model).toBe("provider/primary");
    expect(runtime.thinking).toBe("xhigh");
    expect(runtime.states).toEqual([{ version: 1, preset: "balanced" }]);
    expect(controller.status()).toEqual({ activePreset: "balanced", defaultPreset: "balanced" });
    expect(runtime.events.indexOf("replaceRoles")).toBeLessThan(runtime.events.indexOf("setModel:provider/primary"));
  });

  test("applies aliases as canonical presets and records only the canonical name", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    await controller.apply("codex");

    expect(runtime.roles).toEqual(rawDocument().presets.alternate);
    expect(runtime.states).toEqual([{ version: 1, preset: "alternate" }]);
    expect(controller.status().activePreset).toBe("alternate");
  });

  test("rejects unsupported thinking before any mutation", async () => {
    const runtime = new FakeRuntime();
    runtime.catalog.set("provider/primary", ["high"]);
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    await expect(controller.apply("balanced")).rejects.toThrow("xhigh");
    expect(runtime.roles).toBeNull();
    expect(runtime.events.some((event) => event.startsWith("setModel:"))).toBe(false);
  });

  test("rolls role overrides back when the main model cannot be selected", async () => {
    const runtime = new FakeRuntime();
    runtime.failSetModelFor = "provider/alternate";
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);
    await controller.apply("balanced");
    const originalRoles = { ...runtime.roles };
    const originalStateCount = runtime.states.length;

    await expect(controller.apply("alternate")).rejects.toThrow("could not select");
    expect(runtime.roles).toEqual(originalRoles);
    expect(runtime.model).toBe("provider/primary");
    expect(runtime.thinking).toBe("xhigh");
    expect(runtime.states).toHaveLength(originalStateCount);
    expect(controller.status().activePreset).toBe("balanced");
  });

  test("serializes overlapping switches", async () => {
    const runtime = new FakeRuntime();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtime.beforeSetModel = async (model) => {
      if (model === "provider/primary") await firstBlocked;
    };
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    const first = controller.apply("balanced");
    await Bun.sleep(0);
    const second = controller.apply("alternate");
    await Bun.sleep(0);
    expect(runtime.events).not.toContain("resolve:provider/alternate");

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(runtime.model).toBe("provider/alternate");
    expect(controller.status().activePreset).toBe("alternate");
  });

  test("applies the default only to a new unmanaged session", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    expect(await controller.initializeNewSession([])).toBe(true);
    expect(runtime.states.at(-1)).toEqual({ version: 1, preset: "balanced" });

    const managedRuntime = new FakeRuntime();
    const managedController = createPresetController(parsePresetDocument(rawDocument()), managedRuntime);
    expect(
      await managedController.initializeNewSession([
        { customType: PRESET_STATE_CUSTOM_TYPE, data: { version: 1, preset: "alternate" } },
      ]),
    ).toBe(false);
    expect(managedRuntime.events).toEqual([]);
  });

  test("restores role overrides without changing the session's current model", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    expect(
      await controller.restore([
        { customType: PRESET_STATE_CUSTOM_TYPE, data: { version: 1, preset: "alternate" } },
      ]),
    ).toBe(true);
    expect(runtime.roles).toEqual(rawDocument().presets.alternate);
    expect(runtime.model).toBe("provider/original");
    expect(runtime.thinking).toBe("low");
    expect(runtime.states).toEqual([]);
    expect(controller.status().activePreset).toBe("alternate");
  });

  test("restores legacy alias state as its canonical preset", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);

    expect(
      await controller.restore([
        { customType: PRESET_STATE_CUSTOM_TYPE, data: { version: 1, preset: "codex" } },
      ]),
    ).toBe(true);
    expect(runtime.roles).toEqual(rawDocument().presets.alternate);
    expect(controller.status().activePreset).toBe("alternate");
    expect(runtime.states).toEqual([{ version: 1, preset: "alternate" }]);
  });

  test("clears stale role overrides when switching to an unmanaged imported session", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);
    await controller.apply("balanced");
    runtime.events = [];

    expect(await controller.restore([])).toBe(false);

    expect(runtime.roles).toBeNull();
    expect(runtime.model).toBe("provider/primary");
    expect(runtime.thinking).toBe("xhigh");
    expect(runtime.events).toEqual(["clearRoles"]);
    expect(controller.status().activePreset).toBeNull();
  });

  test("reset clears only the runtime override and records an unmanaged state", async () => {
    const runtime = new FakeRuntime();
    const controller = createPresetController(parsePresetDocument(rawDocument()), runtime);
    await controller.apply("balanced");

    await controller.reset();

    expect(runtime.roles).toBeNull();
    expect(runtime.model).toBe("provider/primary");
    expect(runtime.states.at(-1)).toEqual({ version: 1, preset: null });
    expect(controller.status().activePreset).toBeNull();
  });
});
