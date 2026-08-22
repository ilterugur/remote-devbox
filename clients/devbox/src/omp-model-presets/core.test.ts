import { describe, expect, test } from "bun:test";

import {
  MODEL_ROLE_IDS,
  PRESET_STATE_CUSTOM_TYPE,
  createPresetController,
  latestPresetState,
  parsePresetDocument,
  type OmpModelPresetRuntime,
  type OmpThinkingLevel,
  type PresetState,
} from "./core";

const roles = (selector = "provider/primary:xhigh") =>
  Object.fromEntries(MODEL_ROLE_IDS.map((role) => [role, selector])) as Record<(typeof MODEL_ROLE_IDS)[number], string>;

const rawDocument = () => ({
  default_preset: "balanced",
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
