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
  if [[ -n "${VITE_POS_TERMINAL_PROFILE:-}" ]]; then
    echo "   terminal profile: ${VITE_POS_TERMINAL_PROFILE}"
    VITE_API_BASE_URL="$api_base" VITE_POS_TILL_CODE="$till_code" VITE_POS_TERMINAL_PROFILE="$VITE_POS_TERMINAL_PROFILE" npm run build
  else
    VITE_API_BASE_URL="$api_base" VITE_POS_TILL_CODE="$till_code" npm run build
  fi
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

pos_install_autostart_remote() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local display="${4:-:0}"
  local xauthority="${5:-/home/${user}/.Xauthority}"

  local remote_app="/home/${user}/electropos-new.AppImage"
  local remote_launch="/home/${user}/cognipos-launch.sh"
  local remote_autostart="/home/${user}/.config/autostart/cognipos-register.desktop"
  local remote_icon="/home/${user}/.local/share/icons/electropos-pos.png"
  local remote_log="/home/${user}/electropos.log"

  echo "== Install login autostart on ${user}@${host} =="
  ssh $ssh_opts "${user}@${host}" "
    set -e
    mkdir -p \"\$HOME/.config/autostart\"
    cat > \"$remote_launch\" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
APP=\"REMOTE_APP\"
LOG=\"REMOTE_LOG\"
export DISPLAY=\"REMOTE_DISPLAY\"
export XAUTHORITY=\"REMOTE_XAUTHORITY\"

if pgrep -f 'electropos-new.AppImage' >/dev/null 2>&1; then
  exit 0
fi

x_num=\"\${DISPLAY#:}\"
x_num=\"\${x_num%%.*}\"
for _ in \$(seq 1 90); do
  if [ -S \"/tmp/.X11-unix/X\${x_num}\" ]; then
    break
  fi
  sleep 1
done
sleep 3

if [ -x \"\$HOME/bin/ncr-map-operator-touch.sh\" ]; then
  \"\$HOME/bin/ncr-map-operator-touch.sh\" >> \"\$LOG\" 2>&1 || true
fi

if [ ! -x \"\$APP\" ]; then
  echo \"[\$(date -Is)] CogniPOS autostart: AppImage missing: \$APP\" >> \"\$LOG\"
  exit 1
fi

nohup \"\$APP\" --no-sandbox --disable-gpu >> \"\$LOG\" 2>&1 < /dev/null &
LAUNCH
    sed -i \
      -e 's|REMOTE_APP|${remote_app}|g' \
      -e 's|REMOTE_LOG|${remote_log}|g' \
      -e 's|REMOTE_DISPLAY|${display}|g' \
      -e 's|REMOTE_XAUTHORITY|${xauthority}|g' \
      \"$remote_launch\"
    chmod +x \"$remote_launch\"
    cat > \"$remote_autostart\" <<AUTOSTART
[Desktop Entry]
Type=Application
Version=1.0
Name=CogniPOS Register
Comment=Launch CogniPOS Register when you log in
Exec=${remote_launch}
Icon=${remote_icon}
Terminal=false
Categories=Office;PointOfSale;
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
AUTOSTART
    chmod 644 \"$remote_autostart\"
    echo \"Autostart installed: $remote_autostart\"
  "
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
  pos_install_autostart_remote "$ssh_opts" "$user" "$host" "$display" "$xauthority"
}

pos_install_ncr_printer_udev() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local rules_src="$4"

  if [[ ! -f "$rules_src" ]]; then
    echo "WARN: udev rules not found: $rules_src" >&2
    return 0
  fi

  echo "== Install NCR receipt printer udev rule on ${user}@${host} =="
  scp $ssh_opts "$rules_src" "${user}@${host}:/tmp/99-ncr-pos-printer.rules"
  ssh $ssh_opts "${user}@${host}" '
    if sudo -n true 2>/dev/null; then
      sudo install -m 644 /tmp/99-ncr-pos-printer.rules /etc/udev/rules.d/99-ncr-pos-printer.rules
      sudo udevadm control --reload-rules
      sudo udevadm trigger --subsystem-match=usb
      rm -f /tmp/99-ncr-pos-printer.rules
      echo "NCR printer udev rule installed"
    else
      echo "NOTE: sudo password required to install udev rule. On the NCR run:"
      echo "  sudo install -m 644 /tmp/99-ncr-pos-printer.rules /etc/udev/rules.d/99-ncr-pos-printer.rules"
      echo "  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=usb"
    fi
  '
}

pos_install_posiflex_serial_udev() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local rules_src="$4"

  if [[ ! -f "$rules_src" ]]; then
    echo "WARN: udev rules not found: $rules_src" >&2
    return 0
  fi

  echo "== Install Posiflex serial printer udev rule on ${user}@${host} =="
  scp $ssh_opts "$rules_src" "${user}@${host}:/tmp/99-posiflex-serial.rules"
  ssh $ssh_opts "${user}@${host}" "
    if sudo -n true 2>/dev/null; then
      sudo install -m 644 /tmp/99-posiflex-serial.rules /etc/udev/rules.d/99-posiflex-serial.rules
      sudo udevadm control --reload-rules
      sudo udevadm trigger --subsystem-match=tty
      sudo usermod -aG dialout ${user} 2>/dev/null || true
      rm -f /tmp/99-posiflex-serial.rules
      echo 'Posiflex serial udev rule installed (log out/in if dialout was just added)'
    else
      echo 'NOTE: sudo password required on the till. Run:'
      echo '  sudo install -m 644 /tmp/99-posiflex-serial.rules /etc/udev/rules.d/99-posiflex-serial.rules'
      echo '  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty'
      echo '  sudo usermod -aG dialout ${user}'
    fi
  "
}

pos_install_ncr_line_display_udev() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local rules_src="$4"

  if [[ ! -f "$rules_src" ]]; then
    echo "WARN: udev rules not found: $rules_src" >&2
    return 0
  fi

  echo "== Install NCR line display udev rule on ${user}@${host} =="
  scp $ssh_opts "$rules_src" "${user}@${host}:/tmp/99-ncr-line-display.rules"
  ssh $ssh_opts "${user}@${host}" '
    if sudo -n true 2>/dev/null; then
      sudo install -m 644 /tmp/99-ncr-line-display.rules /etc/udev/rules.d/99-ncr-line-display.rules
      sudo udevadm control --reload-rules
      sudo udevadm trigger --subsystem-match=hidraw
      rm -f /tmp/99-ncr-line-display.rules
      echo "udev rule installed"
    else
      echo "NOTE: sudo password required to install udev rule. On the NCR run:"
      echo "  sudo install -m 644 /tmp/99-ncr-line-display.rules /etc/udev/rules.d/99-ncr-line-display.rules"
      echo "  sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw"
    fi
  '
}

pos_install_ncr_operator_touch() {
  local ssh_opts="$1"
  local user="$2"
  local host="$3"
  local script_src="$4"
  local display="${5:-:0}"

  if [[ ! -f "$script_src" ]]; then
    echo "WARN: touch map script not found: $script_src" >&2
    return 0
  fi

  local remote_script="/home/${user}/bin/ncr-map-operator-touch.sh"
  local remote_autostart="/home/${user}/.config/autostart/ncr-map-operator-touch.desktop"

  echo "== Install NCR operator touch mapping on ${user}@${host} =="
  scp $ssh_opts "$script_src" "${user}@${host}:/tmp/ncr-map-operator-touch.sh"
  ssh $ssh_opts "${user}@${host}" "
    set -e
    mkdir -p \"\$HOME/bin\" \"\$HOME/.config/autostart\"
    install -m 755 /tmp/ncr-map-operator-touch.sh \"$remote_script\"
    rm -f /tmp/ncr-map-operator-touch.sh
    cat > \"$remote_autostart\" <<AUTOSTART
[Desktop Entry]
Type=Application
Version=1.0
Name=NCR operator touch map
Comment=Map CoolTouch to primary display when customer monitor is connected
Exec=${remote_script}
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=4
AUTOSTART
    chmod 644 \"$remote_autostart\"
    DISPLAY=\"$display\" XAUTHORITY=\"/home/${user}/.Xauthority\" \"$remote_script\" || true
    echo \"Operator touch map installed: $remote_script\"
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
