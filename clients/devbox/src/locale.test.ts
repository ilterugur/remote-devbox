import { describe, expect, test } from "bun:test";
import { normalizeChildLocaleEnv } from "./locale";

describe("normalizeChildLocaleEnv", () => {
	test("preserves a supported UTF-8 locale through its platform alias", () => {
		const parent = { PATH: "/bin", LC_ALL: "en_US.UTF8", LANG: "tr_TR.UTF-8" };

		const child = normalizeChildLocaleEnv(
			parent,
			["C", "en_US.UTF-8"],
			"darwin",
		);

		expect(child).toEqual({
			PATH: "/bin",
			LC_ALL: "en_US.UTF-8",
			LANG: "en_US.UTF-8",
			LC_CTYPE: "en_US.UTF-8",
		});
		expect(parent).toEqual({
			PATH: "/bin",
			LC_ALL: "en_US.UTF8",
			LANG: "tr_TR.UTF-8",
		});
	});

	test("preserves macOS UTF-8 when the platform supports it but locale -a omits it", () => {
		const child = normalizeChildLocaleEnv(
			{ LC_ALL: "UTF-8", LANG: "en_US.UTF-8" },
			["C", "en_US.UTF-8"],
			"darwin",
		);

		expect(child.LC_ALL).toBe("UTF-8");
		expect(child.LANG).toBe("UTF-8");
		expect(child.LC_CTYPE).toBe("UTF-8");
	});

	test("uses LC_ALL then LC_CTYPE then LANG when choosing a supported UTF-8 locale", () => {
		const child = normalizeChildLocaleEnv(
			{ LC_ALL: "missing.UTF-8", LC_CTYPE: "tr_TR.UTF8", LANG: "en_US.UTF-8" },
			["C", "tr_TR.UTF-8", "en_US.UTF-8"],
			"darwin",
		);

		expect(child.LC_ALL).toBe("tr_TR.UTF-8");
		expect(child.LANG).toBe("tr_TR.UTF-8");
		expect(child.LC_CTYPE).toBe("tr_TR.UTF-8");
	});

	test("rejects an unsupported macOS locale even when its name ends in UTF-8", () => {
		const child = normalizeChildLocaleEnv(
			{ LC_ALL: "en_TR.UTF-8", LANG: "en_TR.UTF8" },
			["C", "en_US.UTF-8", "UTF-8"],
			"darwin",
		);

		expect(child.LC_ALL).toBe("UTF-8");
		expect(child.LANG).toBe("UTF-8");
		expect(child.LC_CTYPE).toBe("UTF-8");
	});

	test("selects the installed Linux UTF-8 fallback spelling deterministically", () => {
		const child = normalizeChildLocaleEnv(
			{ LANG: "unsupported.UTF-8" },
			["C", "C.utf8", "en_US.utf8"],
			"linux",
		);

		expect(child.LC_ALL).toBe("C.utf8");
		expect(child.LANG).toBe("C.utf8");
		expect(child.LC_CTYPE).toBe("C.utf8");
	});
});
