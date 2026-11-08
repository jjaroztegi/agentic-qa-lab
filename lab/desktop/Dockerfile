# Headless Linux desktop for desktop-app testing: Xvfb + openbox + AT-SPI accessibility bus,
# Java with the ATK bridge (Swing -> AT-SPI), agent-desktop, VNC/noVNC to watch, ffmpeg to record.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:99 TZ=Europe/Berlin
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc novnc websockify dbus-x11 at-spi2-core libatk-adaptor libatk-bridge2.0-0 \
      openjdk-21-jdk libatk-wrapper-java libatk-wrapper-java-jni fonts-dejavu xdotool x11-xserver-utils ffmpeg \
      curl ca-certificates gnupg procps \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs \
 && npm i -g agent-desktop@1.2.0 \
 && rm -rf /var/lib/apt/lists/*
# Turn on the Java -> ATK -> AT-SPI bridge for every JVM.
RUN for f in /etc/java-21-openjdk/accessibility.properties; do \
      sed -i 's/^#\?\s*assistive_technologies=.*/assistive_technologies=org.GNOME.Accessibility.AtkWrapper/' $f; \
      grep -q '^assistive_technologies' $f || echo 'assistive_technologies=org.GNOME.Accessibility.AtkWrapper' >> $f; done
COPY start.sh /usr/local/bin/start-desktop
COPY l2-client /usr/local/bin/l2-client
RUN chmod +x /usr/local/bin/start-desktop /usr/local/bin/l2-client && useradd -m -s /bin/bash qa
USER qa
WORKDIR /home/qa
EXPOSE 6080
CMD ["start-desktop"]
