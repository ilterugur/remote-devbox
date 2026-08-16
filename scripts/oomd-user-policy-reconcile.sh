#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: oomd-user-policy-reconcile <uid> <enabled:true|false> <pressure-limit-percent> <duration-seconds>" >&2
  exit 64
fi

uid=$1
enabled=$2
pressure_limit=$3
duration_sec=$4

if [[ ! "$uid" =~ ^[0-9]+$ ]]; then
  echo "uid must be numeric" >&2
  exit 64
fi
case "$enabled" in
  true | false) ;;
  *)
    echo "enabled must be true or false" >&2
    exit 64
    ;;
esac
if [[ ! "$pressure_limit" =~ ^([0-9]|[1-9][0-9]|100)(\.[0-9]+)?%$ ]]; then
  echo "pressure limit must be a percentage from 0% through 100%" >&2
  exit 64
fi
if [[ ! "$duration_sec" =~ ^[0-9]+$ ]] || [ "$duration_sec" -lt 1 ]; then
  echo "duration must be a positive integer number of seconds" >&2
  exit 64
fi

slice="user-$uid.slice"
manager="user@$uid.service"

# Neutralize the root-owned ancestor first. A preference set by a UID-owned child
# is ignored when oomd calculates candidates for an ancestor owned by root.
systemctl set-property "$slice" \
  ManagedOOMSwap=auto \
  ManagedOOMMemoryPressure=auto \
  ManagedOOMMemoryPressureLimit=0% \
  ManagedOOMMemoryPressureDurationSec=

if [ "$enabled" = true ]; then
  # Monitor at the UID-owned boundary so UID-owned child preferences are eligible.
  # Swap killing stays off because swap candidate preferences require root ownership.
  systemctl set-property "$manager" \
    ManagedOOMSwap=auto \
    ManagedOOMMemoryPressure=kill \
    ManagedOOMMemoryPressureLimit="$pressure_limit" \
    ManagedOOMMemoryPressureDurationSec="${duration_sec}s"
else
  systemctl set-property "$manager" \
    ManagedOOMSwap=auto \
    ManagedOOMMemoryPressure=auto \
    ManagedOOMMemoryPressureLimit=0% \
    ManagedOOMMemoryPressureDurationSec=
fi
