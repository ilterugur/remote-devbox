import { expect, test } from "bun:test";
import { buildTunnelArgs, listenerName, matchListener, parseListeners, renderListeners } from "./ui";

// Real `ss -Hltnp` output from a provisioned box, including the shapes that broke naive
// parsing: an IPv6 address whose brackets contain colons, and an interface-scoped one.
const SS = `
LISTEN 0      4096                    127.0.0.54:53    0.0.0.0:*
LISTEN 0      2048                     127.0.0.1:9077  0.0.0.0:* users:(("python",pid=495621,fd=22))
LISTEN 0      4096                       0.0.0.0:22    0.0.0.0:*
LISTEN 0      32                         0.0.0.0:2022  0.0.0.0:*
LISTEN 0      2                     100.64.0.5:3389  0.0.0.0:*
LISTEN 0      511                        0.0.0.0:19077 0.0.0.0:* users:(("next-server (v1",pid=208897,fd=21))
LISTEN 0      2                        127.0.0.1:3389  0.0.0.0:*
LISTEN 0      200                      127.0.0.1:5432  0.0.0.0:* users:(("postgres",pid=495695,fd=8))
LISTEN 0      2048                       0.0.0.0:9119  0.0.0.0:* users:(("hermes",pid=208645,fd=7))
LISTEN 0      200                          [::1]:5432     [::]:* users:(("postgres",pid=495695,fd=7))
`;

const list = parseListeners(SS);
const ports = list.map((l) => l.port);

test("the ports you already reach the box through are not offered", () => {
  expect(ports).not.toContain(22);
  expect(ports).not.toContain(2022);
  expect(ports).not.toContain(53);
});

// hidepid means another developer's process has no name here; tunnelling into it would
// be tunnelling into their work.
test("someone else's non-loopback listener is not offered", () => {
  expect(list.find((l) => l.port === 3389 && !l.loopback)).toBeUndefined();
  expect(list.find((l) => l.port === 3389 && l.loopback)).toBeDefined();
});

test("a listener bound to every interface is still offered when it is ours", () => {
  const hermes = list.find((l) => l.port === 9119);
  expect(hermes?.loopback).toBe(false);
  expect(hermes?.proc).toBe("hermes");
});

test("loopback services come first, then by port, so the order does not shift between runs", () => {
  expect(ports).toEqual([3389, 5432, 9077, 9119, 19077]);
});

test("an IPv6 address does not lose its port to the brackets", () => {
  expect(parseListeners("LISTEN 0 200 [::1]:5433 [::]:* users:((\"pg\",pid=1,fd=7))")).toEqual([
    { addr: "[::1]", port: 5433, proc: "pg", loopback: true },
  ]);
});

test("a port this project owns is named for what it is, not for its process", () => {
  expect(listenerName(list.find((l) => l.port === 3389)!)).toBe("desktop");
  expect(listenerName(list.find((l) => l.port === 9077)!)).toBe("python");
});

test("a service is found by name or by port", () => {
  expect(matchListener(list, "hermes")).toEqual({ listener: list.find((l) => l.port === 9119)! });
  expect(matchListener(list, "9077")).toEqual({ listener: list.find((l) => l.port === 9077)! });
});

// Two rows for one service would make an unambiguous name look ambiguous.
test("a service on both IPv4 and IPv6 loopback is one entry, not two", () => {
  expect(list.filter((l) => l.port === 5432)).toHaveLength(1);
  expect(matchListener(list, "postgres")).toEqual({ listener: list.find((l) => l.port === 5432)! });
});

test("an unknown service suggests, and a dead port says so", () => {
  const unknown = matchListener(list, "grafana");
  expect("error" in unknown && unknown.error).toContain("no service called 'grafana'");
  const dead = matchListener(list, "8080");
  expect("error" in dead && dead.error).toContain("nothing is listening on port 8080");
});

test("a partial name resolves when it is unambiguous", () => {
  expect(matchListener(list, "next")).toEqual({ listener: list.find((l) => l.port === 19077)! });
});

// `ss` cuts the name off at a fixed width, mid-word: "next-server (v1".
test("a process name truncated by ss is not carried into the service name", () => {
  expect(listenerName(list.find((l) => l.port === 19077)!)).toBe("next-server");
});

// Binding the local end to 127.0.0.1 rather than every interface: a tunnel that listens
// on 0.0.0.0 re-publishes the box's private service to whatever network the laptop is on.
test("the tunnel binds loopback on both ends", () => {
  expect(buildTunnelArgs("devbox-dev-a", 9077, 9077)).toEqual([
    "-N",
    "-L",
    "127.0.0.1:9077:127.0.0.1:9077",
    "devbox-dev-a",
  ]);
});

test("an empty box says so rather than printing an empty list", () => {
  expect(renderListeners([])).toContain("nothing is listening");
});
