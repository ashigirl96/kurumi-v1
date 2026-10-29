#!/bin/sh
set -eu

[ "$#" -eq 4 ] || { echo 'usage: egress-probe.sh <container> <numeric-host-ip> <web-port> <open|blocked>' >&2; exit 2; }
container=$1 host_ip=$2 web_port=$3 expected=$4
case "$host_ip" in '' | *[!0-9.]*) echo 'host IP must be numeric IPv4' >&2; exit 2 ;; esac
printf '%s\n' "$host_ip" | awk -F . 'NF != 4 { exit 1 } { for (i = 1; i <= NF; i++) if ($i !~ /^(0|[1-9][0-9]*)$/ || $i > 255) exit 1 }' ||
  { echo 'host IP must be numeric IPv4' >&2; exit 2; }
case "$web_port" in '' | *[!0-9]*) echo 'invalid web port' >&2; exit 2 ;; esac
[ "$web_port" -ge 1 ] && [ "$web_port" -le 65535 ] || { echo 'invalid web port' >&2; exit 2; }
case "$expected" in open | blocked) ;; *) echo 'expected open or blocked' >&2; exit 2 ;; esac

docker exec "$container" sh -eu -c '
expected=$1 host_ip=$2 web_port=$3 model=$4
for url in https://1.1.1.1/ "http://$host_ip:$web_port/" "http://host.docker.internal:$web_port/"; do
  code=0
  result=$(curl --noproxy "*" -ksS -o /dev/null --connect-timeout 2 --max-time 4 -w "%{http_code} %{remote_ip}" "$url" 2>/dev/null) || code=$?
  status=${result%% *} remote=${result#* }
  printf "direct %s exit=%s http=%s remote=%s expected=%s\n" "$url" "$code" "$status" "$remote" "$expected"
  if [ "$expected" = open ]; then [ "$code" -eq 0 ]; else
    case "$code" in 7|28) ;; *) echo "not a TCP refusal or timeout" >&2; exit 1 ;; esac
    [ -z "$remote" ] || { echo "TCP connected before the request failed" >&2; exit 1; }
  fi
done
headers=$(curl --fail -sS --connect-timeout 5 --max-time 30 -o /dev/null -D - -w "status=%{http_code}\n" https://api.anthropic.com/v1/messages -H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
printf "%s\n" "$headers" | grep -iE "^(x-kurumi-account|status=)"
printf "%s\n" "$headers" | grep -iq "^x-kurumi-account: anthropic/main[[:space:]]*$"
printf "%s\n" "$headers" | grep -q "^status=200$"
' probe "$expected" "$host_ip" "$web_port" "${KURUMI_VERIFY_PROBE_MODEL:-claude-haiku-4-5}"
