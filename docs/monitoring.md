# Monitoring

An agent box stalls differently from a server. The load is dozens of long-lived agent
sessions and their browsers rather than one service with a request rate, so the thing that
goes wrong is almost never "a process crashed" — it is "everything got slow at once", and
the cause is usually a limit nobody was watching.

Three stalls on this box, all on 2026-09-04, all diagnosed by hand:

| Symptom | Actual cause | The signal that named it |
| --- | --- | --- |
| load 78, 97% kernel CPU, 500 MB/s of reads | the agent fleet's slice had `MemorySwapMax=4G`, so it could not shed cold pages and the kernel reclaimed its page cache to 45 MiB instead | `memory.swap.events: max 103701842, fail 103702118` |
| box slow for ~30 minutes, twice | one headless Chrome renderer grew 300 MB → 9 GB because a Puppeteer driver reloaded the same page in place and Chrome cached every prior copy | per-process RSS over time |
| root filesystem at 90% | a dev PostgreSQL could not archive WAL and kept 325 GB of it | `pg_stat_archiver.failed_count`, `pg_wal` size |

Not one of those is visible in a summary of totals. `free` and `uptime` said "memory is
tight and the box is busy" in all three cases, which is where the hour of hunting started
rather than ended. This role exists so the next one is a chart.

## What it installs

netdata, from the vendor's apt repository, configured for three things the box needed and
did not have:

- **Per-process memory over time** (`apps.plugin`) — `app.<group>_mem_usage` and
  `_swap_usage`. This is what names a ballooning renderer while it is still 2 GB.
- **Per-cgroup accounting** (`cgroups.plugin`) — `systemd.service.memory.ram.usage` per
  unit, so the agent fleet, the Codex host and each Remote Control session are separable.
- **PSI** — `system.memory_some_pressure`. The "agony phase": the kernel is stalling
  allocations but has not killed anything, which is what an hour of unexplained slowness
  actually is.

netdata v2 charts a cgroup's usage but not what the kernel does when that cgroup reaches
one of its **own** ceilings, and those counters are precisely what named the first stall.
`roles/monitoring/files/devbox-cgroup-limits.plugin` adds them as an external plugin:

| Context | Source | Answers |
| --- | --- | --- |
| `devbox.cgroup_swap_refusals` | `memory.swap.events` | is a cgroup's own `MemorySwapMax` refusing swap-outs? |
| `devbox.cgroup_swap_utilization` | `memory.swap.current` / `.max` | how close is it to that ceiling? |
| `devbox.cgroup_limit_events` | `memory.events` | is it being throttled at `MemoryHigh`, or blocked at `MemoryMax`? |
| `devbox.cgroup_memory_pressure` | `memory.pressure` | is it stalling, independently of the host? |

It reads only world-readable files under `/sys/fs/cgroup` and runs as the unprivileged
`netdata` user with no capabilities.

## Alarms

`roles/monitoring/templates/health-devbox.conf.j2`, thresholds taken from the measurements
above rather than from a template:

| Alarm | Fires on |
| --- | --- |
| `devbox_memory_pressure` | host memory PSI `some avg10` > 20% (crit 50%) |
| `devbox_cgroup_swap_refused` | any swap-out refused by a cgroup's own ceiling in the last minute |
| `devbox_cgroup_swap_exhausted` | a cgroup past 85% of its own swap ceiling (crit 97%) — the leading indicator for the one above |
| `devbox_cgroup_throttled` | > 100k `MemoryHigh` throttle events in a minute: reclaim running continuously with the hard wall never reached |
| `devbox_process_group_memory` | one process group over 8 GiB (crit 16 GiB) |
| `devbox_disk_fill` | filesystem over 75% (crit 88%), well before the stock 90% |

## The fleet cap

`paseo_resources` is sized against a measured session count — this repo's own history says
"27.9 GB across 14 sessions" — but nothing on the box refuses session 15, and Paseo has no
concurrency knob to add one. On 2026-09-04 the fleet had grown to 20 sessions holding
33.9 GB of anonymous heap under a 34G `MemoryHigh`, so it sat permanently in reclaim and
stalled every session at once.

```yaml
developers:
  - user: dev-a
    agent_fleet:
      max_sessions: 18      # the count the ceiling below was measured against
    paseo_resources:
      memory_high: 34G
      memory_max: 36G
```

The declared count is rendered into an alarm bound to that developer's own fleet cgroup, so
the ceiling and the number it was derived from live in one place and cannot drift apart
unnoticed. Omit `agent_fleet` and the fleet is still charted — nothing invents a threshold
nobody measured. `devbox.cgroup_sessions` also carries a `processes` dimension: a fleet
grows in both at once, while a jump in processes alone is one session spawning helpers.

This warns rather than refuses. A reaper that parks idle sessions is the other half and is
not built: doing it behind Paseo's back would leave its state inconsistent, so it needs
either Paseo's API or an explicit decision about which sessions are disposable.

### Reading a developer's own fleet cgroup

systemd delegates `user@<uid>.service` to that developer and gives its `app.slice` mode
0750, so the cgroup holding the fleet — its ceilings and its limit counters — is unreadable
outside the developer's group. netdata's own systemd-unit collector cannot see it either.
The role joins the `netdata` service account to the group of each developer that runs a
fleet. Blast radius is exactly "files that developer made group-readable": homes here are
0700, so nothing inside one is exposed, and no other developer gains anything.

## Why alarms rather than an automatic killer

`systemd-oomd` runs here, with `ManagedOOMMemoryPressure=kill` at 90% for 20s on each
developer's `user@<uid>.service`. It never fired during the 2026-09-04 stall, and that was
correct: the fleet is essentially all of that user manager's memory, and
`paseo-daemon.service` carries `ManagedOOMPreference=omit` on purpose, because killing it
kills every live session at once. Every other child is small. oomd had nothing it was
allowed to kill, so it did nothing.

That is the shape of the problem, not a misconfiguration: a fleet-driven stall has no
proportionate victim. Adding a second killer (`nohang`, `earlyoom`) puts it in front of the
same choice. What resolves these is capacity and ceilings that fit — and a signal that
arrives while there is still time to act, which is what this role provides. oomd stays as
the emergency brake for everything else below the user manager.

## Reaching it

`access` uses the same vocabulary as `desktop.access`, and works the same way: the agent
binds only the addresses named, so a path left out has **no listener at all** rather than a
listener behind a firewall rule. The apply asserts what was actually bound and fails if it
does not match.

```yaml
host:
  monitoring:
    enabled: true
    access: [tunnel]      # tunnel | tailnet | unsafe-public
    port: 19999           # optional
    retention_days: 14    # optional
    memory_max: 768M      # optional; the monitor's own hard ceiling
```

With `tunnel` — the default — the box listens on `127.0.0.1:19999` only. The client CLI
publishes a launchd SSH forward for it (one per box, on the default profile), so:

```bash
devbox agent up          # publishes the forward
open http://localhost:19999
```

No Tailscale, no inbound port, nothing on the network. Without the CLI, the same thing by
hand:

```bash
ssh -N -L 19999:127.0.0.1:19999 <operator>@<box>
```

`tailnet` adds a bind on the box's Tailscale address for reading it from a phone.
`unsafe-public` is named the way it is on purpose.

## Cost

Measured on this box: **165 MiB RSS**, ~1% of one core, with `MemoryMax=768M`,
`Nice=10`, `CPUWeight=20` and `OOMPolicy=continue` on its unit — a monitor that can
exhaust the host it watches is worse than no monitor. Machine learning and eBPF collectors
are off (the failure modes here are read off explicit counters, not inferred).

Cloud registration is refused: the agent is unclaimed (`/api/v1/aclk` reads
`agent-claimed: false`, `claimed-id: null`, `online: false`), `cloud.d` holds no key
material, and every established socket on the box is loopback. Note that the API's
`cloud-enabled` field stays `true` regardless — it reports what the binary was built with,
not a decision, which is why the refusal is asserted against the claim state instead.

Retention is tiered: 2 days per-second, `retention_days` per-minute, six times that
per-hour — enough to compare a stall against the same hour a week earlier.

## Why not something lighter

[Beszel](https://beszel.dev) is 20× smaller and genuinely nice, but its metric set is
fixed: host CPU/RAM/disk/network plus per-container stats, no PSI, no systemd cgroups, no
per-process. Custom metrics have been [an open request since 2024](https://github.com/henrygd/beszel/issues/337)
with [a draft PR](https://github.com/henrygd/beszel/pull/792) unmerged, so it cannot be
configured into covering any of the three stalls above — it would have reported "swap full,
load high", which is what we already knew.

[Coroot](https://coroot.com) is the closest alternative and would have caught the first
stall: its node-agent treats systemd units as containers and exports per-cgroup PSI, and it
has [a built-in memory-stall inspection](https://coroot.com/blog/memory-stall-the-agony-before-oom/).
It does not export swap counters or per-process memory, and its server needs ClickHouse
plus Prometheus. It is the better fit for a container fleet with a service map; this box is
systemd units.

A Prometheus/VictoriaMetrics stack covers everything with `node_exporter` +
`cgroup-exporter` (or cAdvisor) + `systemd_exporter`, at the cost of five components and
writing the dashboards and alert rules. Worth revisiting if these metrics ever need to
leave the box.
