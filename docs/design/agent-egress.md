# Agent container egress

Issue [#25](https://github.com/ashigirl96/kurumi-v1/issues/25) requires a network boundary even when agent code ignores proxy environment variables. Agent Port remains the host-side owner of authentication, approvals, credential injection, RPC, and proxy traffic.

## Selected topology

Each runner generation gets its own Docker internal bridge and a fixed TCP relay. Admission probes use the same construction. The relay also joins the ordinary bridge and forwards only to the host's Agent Port.

```text
runner A -- private bridge A -- relay A -- host Agent Port
runner B -- private bridge B -- relay B -- host Agent Port
```

The private bridge uses `com.docker.network.bridge.gateway_mode_ipv4=isolated`. Unlike an ordinary internal bridge, this mode does not assign an address to the Linux bridge itself. IPv6 is disabled. Runners have no uplink, network-administration capabilities, or shared network with another runner. The relay has no credentials or workspace mount, and IP forwarding is disabled.

The private relay has the alias `host.docker.internal`, preserving the existing runner and gateway URLs. Resolve the real host address from the uplink before attaching that alias. Resolving afterward can select the relay itself. The relay's upstream is a fixed numeric address and Agent Port, not an address supplied by the client.

The host, Docker daemon, images, relay, and Agent Port are trusted. This boundary does not protect against a host administrator changing Docker configuration or a container escape. Gateway-approved outbound traffic remains possible through Agent Port.

## Prototype on macOS

The prototype ran on macOS arm64 with Docker Desktop 4.82.0 and Engine 29.6.1. It compared the same agent and probe before and after changing the Docker topology.

| Probe | Ordinary bridge control | Isolated bridge and relay |
| --- | --- | --- |
| Direct TCP to public numeric IP | HTTP 301 | curl exit 7 |
| Direct TCP to numeric host Web Port | HTTP 404 | curl exit 7 |
| Direct TCP to `host.docker.internal` Web Port | HTTP 404 | curl exit 7 |
| Anthropic request through Agent Port | HTTP 200, `anthropic/main` | HTTP 200, `anthropic/main` |
| TCP to a listening peer on another private bridge | Peer listener answered its local control | curl exit 7 |

The blocked-mode probe rejects the ordinary bridge. This negative control prevents a probe that always reports success from passing.

A separate DNS receiver recorded fresh query names. On a user-defined ordinary bridge, direct UDP and TCP queries and queries through Docker's embedded resolver all reached that receiver. The four corresponding isolated-network queries did not reach it. Direct requests failed, and the embedded resolver returned `SERVFAIL`. Merely observing `SERVFAIL` without the receiving-side control would not establish that queries stayed inside.

The ordinary bridge had no usable external IPv6 route. External IPv6 blocking therefore has no successful baseline comparison. Inspecting IPv6 disable settings and routes is a separate check, not a measured IPv6 Internet-connectivity result. Linux host reachability is also outside this macOS result.

## Repeat the TCP probe

Use the project's [live verification skill](../../.agents/skills/verify/SKILL.md) to start a disposable host, add `anthropic/main`, and create a running agent. Resolve the real host's numeric IPv4 address from a trusted uplink container, not the private relay alias.

```sh
.agents/skills/verify/lane.sh egress-probe 253 <numeric-host-ip> blocked
```

The probe disables proxies for the direct attempts, requires a TCP refusal or timeout rather than a DNS failure, and requires an authenticated gateway response with HTTP 200. It prints no credential values. The standalone script also accepts `open` for a disposable ordinary-bridge control. Do not attach a production runner to an open network for this control.

Repeat after host restart and adoption. Check the actual runner's network attachments and the gateway log, not just admission status. Admission's nonce establishes reachability, not the complete egress boundary.

Startup also waits for confirmed removal of rejected legacy runners, already-stopping runners, and orphans. Scheduling cleanup or revoking a token does not remove an old runner's direct network access. A delayed or failed removal keeps admission closed until cleanup succeeds.

## Tradeoffs

A plain internal network blocks Agent Port as well as direct egress. A shared internal network permits agent-to-agent connections. A privileged firewall namespace is a distinct alternative, but it was not the selected prototype and would add rule-installation and namespace-lifetime requirements.

Per-generation networks and relays keep cleanup and failures independent. They also consume Docker networks and address-pool capacity. Exhaustion must fail closed rather than place a runner on an ordinary bridge. Relay failure removes connectivity; it must never create another route.
