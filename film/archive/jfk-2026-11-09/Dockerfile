FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends libfontconfig1 libasound2t64 libudev1 libcap2 \
    libvulkan1 mesa-vulkan-drivers libegl1 libgl1 libx11-6 libxcursor1 libxrandr2 libxi6 libxkbcommon0 libwayland-client0 \
    fonts-dejavu-core fonts-noto-core ca-certificates curl git ffmpeg && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/.raea/bin:$PATH
WORKDIR /work
