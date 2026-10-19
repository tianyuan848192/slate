# Slate：Harness 会话的自定义镜像（linux/arm64）
# 构建上下文是 agent/（这样才能把 agent/skills 打进镜像）：docker build -f agent/image/Dockerfile agent
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

RUN dnf install -y python3.12 python3.12-pip tar gzip findutils procps-ng which file \
      google-noto-sans-cjk-sc-fonts \
 && dnf clean all \
 && ln -sf /usr/bin/python3.12 /usr/local/bin/python3 && ln -sf /usr/bin/python3.12 /usr/local/bin/python

RUN python3.12 -m pip install --no-cache-dir boto3 bedrock-agentcore playwright imageio-ffmpeg pillow numpy jsonschema \
      python-docx pypdf openpyxl \
 && ln -sf "$(python3.12 -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" /usr/local/bin/ffmpeg

COPY image/slate/ /opt/slate/slate/
COPY image/runtime/ /opt/slate/runtime/
COPY image/assets/ /opt/slate/assets/
# 配音音色目录（MiniMax 中国区），slate-voice 用
COPY voices.json /opt/slate/voices.json
# 影片风格（film-*）页面里的 /core/ 和 /node_modules/three/；第三方许可证原文放在 /opt/slate/licenses/
COPY image/film-core/ /opt/slate/film-core/
COPY image/vendor/three/ /opt/slate/node_modules/three/
COPY licenses/ /opt/slate/licenses/
RUN python3.12 /opt/slate/assets/make_bgm.py /opt/slate/assets/bgm \
 && for c in sync:slate.sync:main voice:slate.voice:main render:slate.render:main qa:slate.qa:main look:slate.look:main \
             browse:slate.browse:main compose:slate.compose:main event:slate.event:event_main \
             publish:slate.event:publish_main say:slate.event:say_main refs:slate.refs:main model:slate.model:main style:slate.style:main \
             image:slate.image:main; do \
      name=${c%%:*}; rest=${c#*:}; mod=${rest%%:*}; fn=${rest#*:}; \
      printf '#!/bin/sh\nPYTHONPATH=/opt/slate exec python3.12 -c "import sys; sys.argv[0]=\\"slate-%s\\"; from %s import %s; %s()" "$@"\n' \
        "$name" "$mod" "$fn" "$fn" > /usr/local/bin/slate-$name && chmod +x /usr/local/bin/slate-$name; \
    done

# 官方 Skill 库（含导演手册）：Harness 会自动把 /.agents/skills/ 下的 Skill 登记为原生 Skill
COPY skills/ /.agents/skills/
# 已下架的旧风格：不再登记为 Skill，只给老任务修改和重渲染时加载
COPY legacy-skills/ /opt/slate/legacy-skills/

# 公共库、three.js、字体和背景音乐的摘要：slate-render 算内容哈希时用，换了这些文件，旧片段就不再复用
RUN cd /opt/slate && find film-core node_modules assets -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 > /opt/slate/assets.sha

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/opt/slate
WORKDIR /root
