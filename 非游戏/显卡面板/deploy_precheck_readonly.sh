set -u
candidate="$HOME/apps/gpu_panel_unified.py.candidate-3.17"
target="$HOME/apps/gpu_panel_unified.py"
printf 'candidate hash: '; sha256sum "$candidate"
printf 'source hash: '; sha256sum "$target"
actual_candidate=$(sha256sum "$candidate" | awk '{print $1}')
actual_old=$(sha256sum "$target" | awk '{print $1}')
[ "$actual_candidate" = "A09612AB27AFE5FF75D8747C81A58DE24589D26566338F5F583D5F21EAE8848C" ] && echo candidate_hash=OK || echo candidate_hash=FAIL
[ "$actual_old" = "e5a66fcc626f0318882239bcf279ed84439a9b278563a0afbcf9340de9157f95" ] && echo source_hash=OK || echo source_hash=FAIL
old_health=$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/health)
printf '%s' "$old_health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("health",d.get("version"),d.get("llm_url")); assert d.get("version")=="gpuPanelUnified/3.16"; assert d.get("llm_url")=="http://127.0.0.1:8000"' && echo health_precheck=OK || echo health_precheck=FAIL
systemctl is-active --quiet gpu-panel; echo "service_active_check_exit=$?"
old_latest=$(curl -fsS --max-time 5 http://127.0.0.1:8081/api/latest)
in_flight=$(printf '%s' "$old_latest" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("llama") or {}).get("proxy",{}).get("in_flight",0))')
echo "in_flight=$in_flight"
[ "$in_flight" = "0" ] && echo in_flight_check=OK || echo in_flight_check=FAIL
backup="$target.bak-20260926-3.16-before-3.17"
[ ! -e "$backup" ] && echo backup_destination=FREE || echo backup_destination=EXISTS