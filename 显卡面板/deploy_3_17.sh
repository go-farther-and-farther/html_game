set -eu
candidate="$HOME/apps/gpu_panel_unified.py.candidate-3.17"
target="$HOME/apps/gpu_panel_unified.py"
expected_new="a09612ab27afe5ff75d8747c81a58de24589d26566338f5f583d5f21eae8848c"
expected_old="e5a66fcc626f0318882239bcf279ed84439a9b278563a0afbcf9340de9157f95"
prior_backup="$target.bak-20260926-3.16-before-3.17"
backup="$target.bak-20260926-3.16-before-3.17-redeploy"
check_files() {
  test "$(sha256sum "$candidate" | awk '{print $1}')" = "$expected_new"
  test "$(sha256sum "$target" | awk '{print $1}')" = "$expected_old"
  test "$(sha256sum "$prior_backup" | awk '{print $1}')" = "$expected_old"
}
check_files
old_health=$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/health)
printf '%s' "$old_health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("version")=="gpuPanelUnified/3.16", d; assert d.get("llm_url")=="http://127.0.0.1:8000", d'
systemctl is-active --quiet gpu-panel
test ! -e "$backup"
# Authenticate before touching the live source; the password prompt can wait safely.
sudo -v
# Revalidate every live condition after authentication, immediately before restart.
check_files
old_health=$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/health)
printf '%s' "$old_health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("version")=="gpuPanelUnified/3.16", d; assert d.get("llm_url")=="http://127.0.0.1:8000", d'
systemctl is-active --quiet gpu-panel
old_latest=$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/latest)
in_flight=$(printf '%s' "$old_latest" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("llama") or {}).get("proxy",{}).get("in_flight",0))')
printf 'Immediately before restart proxy in_flight=%s\n' "$in_flight"
test "$in_flight" = "0"
cp -p "$target" "$backup"
mv -f "$candidate" "$target"
if ! sudo systemctl restart gpu-panel; then
  cp -p "$backup" "$target"
  sudo systemctl restart gpu-panel || true
  echo 'Restart failed; restored previous source.' >&2
  exit 1
fi
health=''
version=''
for i in $(seq 1 20); do
  health=$(curl -fsS --max-time 3 http://127.0.0.1:8081/api/health 2>/dev/null || true)
  version=$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version", ""))' 2>/dev/null || true)
  if [ "$version" = "gpuPanelUnified/3.17" ]; then break; fi
  sleep 1
done
if [ "$version" != "gpuPanelUnified/3.17" ]; then
  cp -p "$backup" "$target"
  sudo systemctl restart gpu-panel || true
  echo "Health version check failed ($version); restored previous source." >&2
  exit 1
fi
summary=''
for i in $(seq 1 25); do
  latest=$(curl -fsS --max-time 3 http://127.0.0.1:8081/api/latest 2>/dev/null || true)
  if summary=$(printf '%s' "$latest" | python3 -c 'import json,sys; d=json.load(sys.stdin); x=d.get("llama") or {}; print("kind=%s source=%s context=%s running=%s waiting=%s kv=%s" % (x.get("kind"), x.get("telemetry_source"), x.get("context_limit"), x.get("running"), x.get("waiting"), x.get("kv_cache_pct"))); assert x.get("kind")=="vllm"; assert x.get("telemetry_source")=="engine"; assert x.get("context_limit")==163840; assert x.get("running") is not None and x.get("waiting") is not None and x.get("kv_cache_pct") is not None' 2>/dev/null); then break; fi
  sleep 1
done
if [ -z "$summary" ]; then
  cp -p "$backup" "$target"
  sudo systemctl restart gpu-panel || true
  echo 'Native vLLM telemetry did not verify; restored previous source.' >&2
  exit 1
fi
printf 'Health: %s\n' "$health"
printf 'Native telemetry: %s\n' "$summary"
printf 'Backup: %s\n' "$backup"
printf 'Installed SHA256: %s\n' "$(sha256sum "$target" | awk '{print $1}')"