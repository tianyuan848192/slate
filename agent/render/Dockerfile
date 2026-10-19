# 渲染机镜像（x86_64，部署时在 CodeBuild 上构建；GPU 实例都是 x86）。构建上下文由 infra/lib/render-image.ts 组装：
# agent/image 下的渲染代码和资源、agent/skills、agent/legacy-skills、agent/render。字体、风格库、three.js 和会话镜像用同一份。
FROM public.ecr.aws/ubuntu/ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=all
# libegl1、libgl1：NVIDIA 驱动（AgentCore 在实例上提供）要用的加载器；不装软件版的 Vulkan 驱动，免得悄悄退回 CPU
# tini 做 1 号进程，回收 Chrome 退出后留下的子进程（不回收的话一小时能积上千个僵尸进程）
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini \
      libegl1 libgl1 libgles2 fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir playwright==1.63.0 boto3 imageio-ffmpeg pillow numpy \
 && /venv/bin/playwright install --with-deps --no-shell chromium \
 && ln -sf "$(/venv/bin/python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" /usr/local/bin/ffmpeg \
 && mkdir -p /usr/share/fonts/google-noto-cjk \
 && ln -sf /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /usr/share/fonts/google-noto-cjk/NotoSansCJKsc-Regular.otf \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m render
COPY image/slate/ /opt/slate/slate/
COPY image/runtime/ /opt/slate/runtime/
COPY image/assets/ /opt/slate/assets/
COPY voices.json /opt/slate/voices.json
COPY image/film-core/ /opt/slate/film-core/
COPY image/vendor/three/ /opt/slate/node_modules/three/
COPY skills/ /.agents/skills/
COPY legacy-skills/ /opt/slate/legacy-skills/
# 第三方组件（影片风格公共库、three.js、字体等）的许可证原文，和会话镜像一样随镜像发布
COPY licenses/ /opt/slate/licenses/
COPY render/server.py render/worker.py render/localbrowser.py /opt/slate/render/
# 和会话镜像同样的算法：两边算出的镜头内容指纹一致，片段才能互相复用
RUN cd /opt/slate && find film-core node_modules assets -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 > /opt/slate/assets.sha
ENV PATH=/venv/bin:$PATH PYTHONPATH=/opt/slate SLATE_GPU_MODE=egl
USER render
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "/opt/slate/render/server.py"]
