import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ThinkingLevel,
} from "@oh-my-pi/pi-coding-agent";

import {
  PRESET_STATE_CUSTOM_TYPE,
  OMP_MODEL_PRESETS_OMP_VERSION,
  createPresetController,
  formatPresetDetails,
  formatPresetList,
  parsePresetDocument,
  presetNamesForShow,
  toOmpRetrySettings,
  type OmpModelPresetRuntime,
  type OmpThinkingLevel,
  type PresetState,
} from "./core";

type OmpModel = NonNullable<ExtensionContext["model"]>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ompModelPresets(pi: ExtensionAPI): void {
  if (VERSION !== OMP_MODEL_PRESETS_OMP_VERSION) {
    throw new Error(`omp-model-presets supports OMP ${OMP_MODEL_PRESETS_OMP_VERSION}; found ${VERSION}`);
  }

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required for omp-model-presets");
  const document = parsePresetDocument(JSON.parse(readFileSync(join(agentDir, "model-presets.json"), "utf8")));
  if (document.retry) {
    for (const [path, value] of Object.entries(toOmpRetrySettings(document.retry))) {
      pi.pi.settings.override(path as Parameters<typeof pi.pi.settings.override>[0], value);
    }
  }
  let context: ExtensionContext | undefined;

  const currentContext = (): ExtensionContext => {
    if (!context) throw new Error("OMP session context is not ready");
    return context;
  };

  const runtime: OmpModelPresetRuntime<OmpModel> = {
    resolveModel(selector) {
      const model = currentContext().models.resolve(selector);
      if (!model) return undefined;
      const efforts = getSupportedEfforts(model) as readonly OmpThinkingLevel[];
      return { model, supportedThinking: ["inherit", "off", ...efforts] };
    },
    currentModel() {
      const model = currentContext().models.current() ?? currentContext().model;
      if (!model) throw new Error("OMP session has no current model");
      return model;
    },
    currentThinking() {
      return (pi.getThinkingLevel() ?? "inherit") as OmpThinkingLevel;
    },
    replaceRoles(roles) {
      pi.pi.settings.override("modelRoles", roles);
    },
    clearRoles() {
      pi.pi.settings.clearOverride("modelRoles");
    },
    setModel(model) {
      return pi.setModel(model);
    },
    setThinking(level) {
      pi.setThinkingLevel(level as ThinkingLevel);
    },
    appendState(state: PresetState) {
      pi.appendEntry(PRESET_STATE_CUSTOM_TYPE, state);
    },
  };
  const controller = createPresetController(document, runtime);
  const aliases = Object.keys(document.aliases);

  const useContext = async <T>(ctx: ExtensionContext, operation: () => Promise<T>): Promise<T> => {
    context = ctx;
    return operation();
  };

  const notifyFailure = (ctx: ExtensionContext, operation: string, error: unknown): void => {
    pi.logger.warn(`omp-model-presets ${operation} failed: ${message(error)}`);
    ctx.ui.notify(`Preset ${operation} failed: ${message(error)}`, "error");
  };

  pi.registerCommand("preset", {
    description: "Show or switch the declarative OMP model-role preset",
    getArgumentCompletions: (prefix) =>
      [
        "status",
        "list",
        "show",
        "show all",
        ...controller.list().map((name) => `show ${name}`),
        ...aliases.map((name) => `show ${name}`),
        "reset",
        ...controller.list(),
        ...aliases,
      ]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const requested = args.trim() || "status";
      try {
        await useContext(ctx, async () => {
          if (requested === "status") {
            const status = controller.status();
            ctx.ui.notify(
              status.activePreset
                ? `OMP preset: ${status.activePreset} (default: ${status.defaultPreset})`
                : `OMP preset override is reset (default: ${status.defaultPreset})`,
              "info",
            );
            return;
          }
          if (requested === "list") {
            ctx.ui.notify(formatPresetList(controller.list(), controller.status()), "info");
            return;
          }
          if (requested === "show" || requested.startsWith("show ")) {
            const argument = requested.slice("show".length).trim();
            const status = controller.status();
            const names = presetNamesForShow(argument, controller.list(), status.activePreset, document.aliases);
            ctx.ui.notify(formatPresetDetails(document, names, status), "info");
            return;
          }
          if (requested === "reset") {
            await controller.reset();
            ctx.ui.notify("OMP model-role preset override reset", "info");
            return;
          }
          await controller.apply(requested);
          ctx.ui.notify(`OMP model-role preset switched to ${controller.status().activePreset}`, "info");
        });
      } catch (error) {
        notifyFailure(ctx, requested, error);
      }
    },
  });

  const restore = async (ctx: ExtensionContext, initializeWhenEmpty: boolean): Promise<void> => {
    try {
      await useContext(ctx, async () => {
        const entries = ctx.sessionManager.getEntries();
        if (initializeWhenEmpty && entries.length === 0) await controller.initializeNewSession(entries);
        else await controller.restore(entries);
      });
    } catch (error) {
      notifyFailure(ctx, "restore", error);
    }
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx, true));
  pi.on("session_switch", async (event, ctx) => restore(ctx, event.reason === "new"));
}
