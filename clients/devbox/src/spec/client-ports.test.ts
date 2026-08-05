import { describe, expect, test } from "bun:test";
import { assignClientPorts, DEFAULT_CLIENT_PORT } from "./client-ports";

const dev = (user: string, desktopEnabled: boolean, clientPort?: number) => ({ user, desktopEnabled, clientPort });

describe("assignClientPorts", () => {
  test("gives the first desktop developer 3389 and counts up from there", () => {
    const got = assignClientPorts([dev("ilterugur", true), dev("emre", true)]);
    expect(got.get("ilterugur")).toBe(DEFAULT_CLIENT_PORT);
    expect(got.get("emre")).toBe(DEFAULT_CLIENT_PORT + 1);
  });

  test("skips developers without a desktop entirely", () => {
    const got = assignClientPorts([dev("nodesk", false), dev("ilterugur", true)]);
    expect(got.has("nodesk")).toBe(false);
    expect(got.get("ilterugur")).toBe(DEFAULT_CLIENT_PORT);
  });

  test("an explicit port wins, and is not handed to anyone else", () => {
    const got = assignClientPorts([dev("a", true, 3390), dev("b", true), dev("c", true)]);
    expect(got.get("a")).toBe(3390);
    expect(got.get("b")).toBe(3389);
    expect(got.get("c")).toBe(3391);
  });
});
