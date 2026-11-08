#!/usr/bin/env bash
# One D-Bus session shared by the AT-SPI bus, the apps and agent-desktop (docker exec sources it).
# Several desktops can share the host network (one per isolated run): display and ports come from env.
set -e
N=${QA_DISPLAY_NUM:-99}; VNC=${QA_VNC_PORT:-5900}; WEB=${QA_NOVNC_PORT:-6080}
eval "$(dbus-launch --sh-syntax)"
printf 'export DBUS_SESSION_BUS_ADDRESS=%q\nexport DISPLAY=:%s\nexport NO_AT_BRIDGE=0\nexport GTK_MODULES=gail:atk-bridge\n' "$DBUS_SESSION_BUS_ADDRESS" "$N" > ~/.desktop-env
export DISPLAY=:$N
Xvfb ":$N" -screen 0 1920x1080x24 -nolisten tcp &
sleep 1
/usr/libexec/at-spi-bus-launcher --launch-immediately &
openbox &
xsetroot -solid '#1b2124' 2>/dev/null || true
x11vnc -display ":$N" -rfbport "$VNC" -forever -shared -nopw -quiet -localhost &
websockify --web /usr/share/novnc "127.0.0.1:$WEB" "localhost:$VNC" &
wait
