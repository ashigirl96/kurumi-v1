#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
usage: lane.sh <command> <lane> [args]
  up <lane>                  build the image and runner, start the host, wait until admission is open
  doctor <lane>              read-only health check of the lane
  kurumi <lane> <args...>    run the kurumi CLI against the lane
  add-key <lane>             add the keychain subscription token as anthropic/main (auto-grant)
  chat <lane> <agent> <line> send one line and wait for the reply; prints the transcript path
  probe <lane>               from the lane's one agent container, POST /v1/messages (max_tokens 1) through the gateway
  consent <lane> <url>       complete Google consent (flags: --account <n>, --uncheck <service>, --cancel)
  google-client <lane>       pipe the keychain Google OAuth client into account set-client
  down <lane>                stop the host, remove its containers and home; keep evidence
  smoke <lane>               up, add-key, agent create, one chat round trip, gateway log, down
EOF
  exit 2
}

[ $# -ge 2 ] || usage
command=$1 lane=$2
shift 2
case $lane in '' | *[!0-9]*) usage ;; esac

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# kurumi.sock lives in KURUMI_HOME, and macOS caps a socket path at 104 bytes.
root=/tmp/kurumi-verify/lane-$lane
home=$root/home
evidence=$root/evidence
export KURUMI_HOME="$home"
export KURUMI_AGENT_PORT=$((41000 + 10 * lane)) KURUMI_WEB_PORT=$((41001 + 10 * lane))
export KURUMI_AGENT_IMAGE="${KURUMI_AGENT_IMAGE:-kurumi-agent:verify-$(git -C "$repo" rev-parse --short HEAD)}"
reply_timeout=${KURUMI_VERIFY_REPLY_TIMEOUT:-180}

die() {
  echo "lane $lane: $*" >&2
  exit 1
}

kurumi() { bun "$repo/apps/cli/src/main.ts" "$@"; }

host_pid() {
  [ -f "$home/kurumi.lock" ] || return 0
  pid=$(tr -d '[:space:]' <"$home/kurumi.lock")
  [ -n "$pid" ] || return 0
  case $(ps -p "$pid" -o command= 2>/dev/null) in
    *apps/host/src/main.ts*) echo "$pid" ;;
  esac
}

install_label() {
  printf %s "$(cd "$home" && pwd -P)" | shasum -a 256 | cut -c1-24
}

admission() { kurumi gateway status 2>/dev/null | awk '$1 == "admission" { print $2 }'; }

up() {
  pid=$(host_pid)
  [ -z "$pid" ] || die "host pid $pid already runs in $home; run down first"
  mkdir -p "$home" "$evidence"
  # A checkout whose node_modules predates a new workspace package cannot import it.
  (cd "$repo" && bun install --frozen-lockfile >/dev/null)
  docker build -q -t "$KURUMI_AGENT_IMAGE" "$repo/container" >/dev/null
  bun "$repo/scripts/build-runner.ts" >/dev/null
  started=$(grep -c '"kind":"host.runtime"' "$evidence/host.log" 2>/dev/null || true)
  nohup bun "$repo/apps/host/src/main.ts" >>"$evidence/host.log" 2>&1 &
  spawned=$!
  waited=0
  until [ "$(grep -c '"kind":"host.runtime"' "$evidence/host.log")" -gt "${started:-0}" ] &&
    [ "$(admission)" = open ]; do
    kill -0 "$spawned" 2>/dev/null || { tail -20 "$evidence/host.log" >&2; die "host exited during startup"; }
    [ "$waited" -lt 120 ] || die "host not ready after 120s; see $evidence/host.log"
    sleep 1
    waited=$((waited + 1))
  done
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) lane $lane ready: pid $(host_pid), agent port $KURUMI_AGENT_PORT, web port $KURUMI_WEB_PORT, image $KURUMI_AGENT_IMAGE, install $(install_label)" |
    tee -a "$evidence/lane.txt"
}

doctor() {
  failed=0
  check() {
    if [ -n "$2" ]; then echo "ok    $1: $2"; else
      echo "FAIL  $1"
      failed=1
    fi
  }
  pid=$(host_pid)
  check "host process (lock $home/kurumi.lock)" "$pid"
  if [ -n "$pid" ]; then
    check "host answers status" "$(kurumi status >/dev/null 2>&1 && echo yes)"
    check "gateway admission open" "$([ "$(admission)" = open ] && echo open)"
    check "agent port $KURUMI_AGENT_PORT owned by host" "$(lsof -nP -a -p "$pid" -iTCP:"$KURUMI_AGENT_PORT" -sTCP:LISTEN >/dev/null 2>&1 && echo "pid $pid")"
  fi
  check "image $KURUMI_AGENT_IMAGE" "$(docker image inspect -f '{{.Id}}' "$KURUMI_AGENT_IMAGE" 2>/dev/null | cut -c8-19)"
  [ -d "$home" ] && echo "info  containers: $(docker ps -a --filter "label=kurumi.install=$(install_label)" --format '{{.Names}}={{.Status}}' | tr '\n' ' ')"
  return "$failed"
}

add_key() {
  security find-generic-password -s kurumi-live-claude -w |
    kurumi account add-key anthropic --label main --auto-grant
}

google_client() {
  kurumi account --help 2>&1 | grep -Eq '^  set-client([[:space:]]|$)' ||
    die "account set-client is unavailable; implement that command before google-client can run"
  client_id=$(security find-generic-password -s kurumi-live-google-client-id -w) ||
    die "keychain item kurumi-live-google-client-id is unavailable"
  client_secret=$(security find-generic-password -s kurumi-live-google-client-secret -w) ||
    die "keychain item kurumi-live-google-client-secret is unavailable"
  printf '%s\n%s' "$client_id" "$client_secret" |
    bun -e 'const [clientId, clientSecret] = (await Bun.stdin.text()).split("\n"); process.stdout.write(JSON.stringify({ clientId, clientSecret }))' |
    kurumi account set-client google
}

chat() {
  [ $# -eq 2 ] || usage
  mkdir -p "$evidence"
  transcript=$evidence/chat-$(date -u +%Y%m%dT%H%M%SZ).txt
  : >"$transcript"
  {
    printf '%s\n' "$2"
    waited=0
    # The first line is the queued receipt; any other line is a reply or an error.
    until grep -qv '^queued (session ' "$transcript" || [ "$waited" -ge "$reply_timeout" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    sleep 3
  } | kurumi chat "$1" >>"$transcript" 2>&1 || true
  sed 's/^/  | /' "$transcript"
  head -1 "$transcript" | grep -q '^queued (session ' && [ "$(wc -l <"$transcript")" -ge 2 ] ||
    die "no reply within ${reply_timeout}s; see $transcript and $evidence/host.log"
  echo "transcript: $transcript"
}

probe() {
  containers=$(docker ps -q --filter "label=kurumi.install=$(install_label)" --filter label=kurumi.role=agent)
  [ "$(echo "$containers" | grep -c .)" -eq 1 ] ||
    die "probe needs exactly one running agent container; chat once first"
  # curl reads the proxy and the kurumi CA from the container env; the selector rides as the bearer token.
  docker exec "$containers" sh -c 'curl -sS -o /dev/null -D - -w "status=%{http_code} time=%{time_total}s\n" \
    https://api.anthropic.com/v1/messages \
    -H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"$1\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"' \
    probe "${KURUMI_VERIFY_PROBE_MODEL:-claude-haiku-4-5}" | grep -iE '^(x-kurumi-account|status=)'
}

down() {
  agent-browser --session "kurumi-verify-$lane" close >/dev/null
  pid=$(host_pid)
  if [ -n "$pid" ]; then
    kill -TERM "$pid"
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 30 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    ! kill -0 "$pid" 2>/dev/null || die "host pid $pid did not exit after SIGTERM"
  fi
  if [ -d "$home" ]; then
    # SIGTERM leaves agent containers running, so remove them by this lane's install label.
    ids=$(docker ps -aq --filter "label=kurumi.install=$(install_label)")
    [ -z "$ids" ] || echo "$ids" | xargs docker rm -f >/dev/null
    rm -rf "$home"
  fi
  echo "lane $lane down; evidence kept in $evidence"
}

smoke() {
  trap down EXIT
  up
  doctor
  add_key | tee "$evidence/add-key.txt"
  kurumi agent create --name work | tee "$evidence/agent.json"
  chat work 'Reply with exactly one word: kurumi'
  kurumi gateway log | tee "$evidence/gateway-log.txt"
  grep -Eq 'anthropic/main +anthropic-api +injected +200 .* POST +api\.anthropic\.com/v1/messages' "$evidence/gateway-log.txt" ||
    die "no injected 200 POST /v1/messages row for anthropic/main in $evidence/gateway-log.txt"
  echo "smoke passed; evidence in $evidence"
}

case $command in
  up) up ;;
  doctor) doctor ;;
  kurumi) kurumi "$@" ;;
  add-key) add_key ;;
  chat) chat "$@" ;;
  probe) probe ;;
  consent) exec bun "$repo/.agents/skills/verify/consent.ts" "$lane" "$@" ;;
  google-client) google_client ;;
  down) down ;;
  smoke) smoke ;;
  *) usage ;;
esac
