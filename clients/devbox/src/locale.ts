import { spawnSync } from "node:child_process";

const FALLBACKS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
	darwin: ["UTF-8", "en_US.UTF-8", "C.UTF-8"],
	linux: ["C.UTF-8", "C.utf8", "en_US.UTF-8", "en_US.utf8"],
};
const OTHER_FALLBACKS = ["C.UTF-8", "en_US.UTF-8", "UTF-8"];
const SAFE_LOCALE_NAME = /^[A-Za-z0-9_.@-]+$/;

function localeKey(locale: string): string {
	return locale.trim().toLowerCase().replace(/utf-8/g, "utf8");
}

function isUtf8Locale(locale: string): boolean {
	return /(?:^|[._-])utf-?8(?:$|@)/i.test(locale);
}

function supportedUtf8Locales(locales: readonly string[]): Map<string, string> {
	const supported = new Map<string, string>();
	for (const locale of locales) {
		const trimmed = locale.trim();
		if (SAFE_LOCALE_NAME.test(trimmed) && isUtf8Locale(trimmed)) {
			supported.set(localeKey(trimmed), trimmed);
		}
	}
	return supported;
}

/**
 * Build an isolated child environment with one locale known to be supported by the
 * current platform. LC_ALL wins over every category, while setting LANG and LC_CTYPE
 * keeps tools that inspect those variables directly on the same UTF-8 choice.
 */
export function normalizeChildLocaleEnv(
	parentEnv: NodeJS.ProcessEnv,
	supportedLocales: readonly string[],
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const supported = supportedUtf8Locales(supportedLocales);
	const requested = [parentEnv.LC_ALL, parentEnv.LC_CTYPE, parentEnv.LANG];
	let selected: string | undefined;

	for (const locale of requested) {
		if (!locale || !isUtf8Locale(locale)) continue;
		// macOS accepts this built-in locale even on releases where `locale -a`
		// omits it. Do not generalize by suffix: en_TR.UTF-8 is not equivalent.
		if (platform === "darwin" && locale.trim().toUpperCase() === "UTF-8") {
			selected = "UTF-8";
			break;
		}
		selected = supported.get(localeKey(locale));
		if (selected) break;
	}

	if (!selected) {
		const fallbacks = FALLBACKS[platform] ?? OTHER_FALLBACKS;
		for (const fallback of fallbacks) {
			selected = supported.get(localeKey(fallback));
			if (selected) break;
		}
		selected ??= fallbacks[0];
	}

	return { ...parentEnv, LC_ALL: selected, LANG: selected, LC_CTYPE: selected };
}

let cachedSupportedLocales: string[] | undefined;

function discoverSupportedLocales(parentEnv: NodeJS.ProcessEnv): string[] {
	if (cachedSupportedLocales) return cachedSupportedLocales;
	// `locale -a` is the bootstrap probe. POSIX C is universally available and avoids
	// asking the probe itself to initialize the unsupported locale we are repairing.
	const probeEnv = { ...parentEnv, LC_ALL: "C", LANG: "C", LC_CTYPE: "C" };
	const result = spawnSync("locale", ["-a"], {
		encoding: "utf8",
		env: probeEnv,
	});
	cachedSupportedLocales =
		result.status === 0 && result.stdout
			? result.stdout.split(/\r?\n/).filter(Boolean)
			: [];
	return cachedSupportedLocales;
}

/** Child-only environment for CLI subprocesses; never mutates process.env. */
export function childProcessEnv(
	parentEnv: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	return normalizeChildLocaleEnv(
		parentEnv,
		discoverSupportedLocales(parentEnv),
		platform,
	);
}
