#!/usr/bin/env bash
# Shared POS deploy helpers. Source from deploy-pos-terminal.sh / deploy-pos-all.sh.

pos_deploy_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
}

pos_deploy_version() {
  node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version"
}

pos_build_appimage() {
  local api_base="${1:-http://192.168.1.10:4000/api}"
  local till_code="${2:-T1}"
  echo "== Build POS v$(pos_deploy_version) (till ${till_code}) =="
  VITE_API_BASE_URL="$api_base" VITE_POS_TILL_CODE="$till_code" npm run build
  npx electron-builder --publish never --linux AppImage
}

pos_appimage_path() {
  local root="$1"
  local version="$2"
  echo "$root/release/$version/CogniPOS Register-Linux-$version.AppImage"
}

pos_stop_remote() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  echo "== Stop POS on ${user}@${host} =="
  ssh $ssh_opts "${user}@${host}" 'bash -s' <<'REMOTE'
set +e
mypid=$$
for pid in $(pgrep -x electropos-pos 2>/dev/null); do
  [ "$pid" = "$mypid" ] && continue
  kill -9 "$pid" 2>/dev/null
done
for pid in $(pgrep -f 'electropos-new\.AppImage --no-sandbox' 2>/dev/null); do
  [ "$pid" = "$mypid" ] && continue
  kill -9 "$pid" 2>/dev/null
done
sleep 2
exit 0
REMOTE
}

pos_install_remote() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local display="${4:-:0}"
  local xauthority="${5:-/home/${user}/.Xauthority}"
  local remote_app="/home/${user}/electropos-new.AppImage"
  local remote_staging="${remote_app}.incoming"
  local remote_icon="/home/${user}/.local/share/icons/electropos-pos.png"
  local remote_desktop="/home/${user}/Desktop/CogniPOS Register.desktop"
  local remote_applications="/home/${user}/.local/share/applications/cognipos-register.desktop"
  local app_image="$6"
  local app_icon="$7"
  local terminal_name="${8:-POS}"

  echo "== Prepare remote launcher directories on ${user}@${host} =="
  ssh $ssh_opts "${user}@${host}" "mkdir -p ~/.local/share/icons ~/.local/share/applications ~/Desktop"

  echo "== Copy AppImage and icon to ${user}@${host} (${terminal_name}) =="
  scp $ssh_opts "$app_image" "${user}@${host}:${remote_staging}"
  scp $ssh_opts "$app_icon" "${user}@${host}:${remote_icon}"

  echo "== Install, create desktop shortcut, and restart POS on ${terminal_name} =="
  ssh $ssh_opts "${user}@${host}" "
    mv -f \"$remote_staging\" \"$remote_app\"
    chmod 644 \"$remote_icon\"
    chmod +x \"$remote_app\"
    cat > \"$remote_desktop\" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=CogniPOS Register
Comment=Launch CogniPOS Register
Exec=${remote_app} --no-sandbox --disable-gpu
Icon=${remote_icon}
Terminal=false
Categories=Office;PointOfSale;
StartupNotify=true
DESKTOP
    cp -f \"$remote_desktop\" \"$remote_applications\"
    chmod +x \"$remote_desktop\" \"$remote_applications\"
    if command -v gio >/dev/null 2>&1; then
      gio set \"$remote_desktop\" metadata::trusted true 2>/dev/null || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database \"\$HOME/.local/share/applications\" 2>/dev/null || true
    fi
    nohup env DISPLAY=\"$display\" XAUTHORITY=\"$xauthority\" \"$remote_app\" --no-sandbox --disable-gpu > /home/${user}/electropos.log 2>&1 < /dev/null &
    sleep 2
    echo REMOTE_PROCESS:
    pgrep -af 'electropos-new\.AppImage --no-sandbox|electropos-pos' || true
    echo REMOTE_LOG:
    tail -n 25 /home/${user}/electropos.log || true
  "
}

pos_deploy_one_terminal() {
  local terminal_name="$1"
  local host="$2"
  local user="$3"
  local till_code="$4"
  local api_base="${5:-http://192.168.1.10:4000/api}"
  local skip_build="${6:-0}"
  local ssh_opts="${7:--o StrictHostKeyChecking=no}"
  local display="${8:-:0}"
  local xauthority="${9:-/home/${user}/.Xauthority}"

  local root
  root="$(pos_deploy_root)"
  cd "$root"

  local version
  version="$(pos_deploy_version)"
  local app_image
  app_image="$(pos_appimage_path "$root" "$version")"
  local app_icon="$root/src/assets/appIcon.png"

  if [[ "$skip_build" != "1" ]]; then
    pos_build_appimage "$api_base" "$till_code"
  else
    echo "== Skip build (using existing AppImage for till ${till_code}) =="
  fi

  if [[ ! -f "$app_image" ]]; then
    echo "ERROR: AppImage not found: $app_image" >&2
    return 1
  fi
  if [[ ! -f "$app_icon" ]]; then
    echo "ERROR: App icon not found: $app_icon" >&2
    return 1
  fi

  pos_stop_remote "$ssh_opts" "$user" "$host"
  pos_install_remote "$ssh_opts" "$user" "$host" "$display" "$xauthority" "$app_image" "$app_icon" "$terminal_name"

  echo "Deploy complete: ${terminal_name} (${till_code}) @ ${host} — POS v${version}"
}
