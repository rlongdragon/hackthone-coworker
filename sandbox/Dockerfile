# Coworker! agent sandbox image
# 每位員工的 AI 同事在這個容器裡執行指令(gVisor runtime,見 scripts/setup-gvisor.sh)
# build: docker build -t coworker-sandbox:latest sandbox/
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    # 基本 shell 工具
    bash coreutils findutils grep sed gawk curl ca-certificates \
    unzip zip xz-utils jq ripgrep file less \
    # 文書處理(docx/xlsx/pdf 靠 python 套件;pandoc 做格式轉換)
    pandoc \
    poppler-utils \
    # CJK PDF 產生:Noto CJK 字型 + weasyprint 執行期(pango/cairo)
    fonts-noto-cjk \
    libpango-1.0-0 libpangoft2-1.0-0 \
    # 腳本語言
    python3 python3-pip python3-venv \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    openpyxl python-docx python-pptx pypdf reportlab markdown weasyprint

# 一鍵 CJK PDF 轉換(pandoc + weasyprint,吃系統 Noto CJK 字型)
COPY doc2pdf /usr/local/bin/doc2pdf
RUN chmod 755 /usr/local/bin/doc2pdf

# 非 root 使用者;/workspace 掛 per-employee volume
RUN useradd -u 1000 -m -d /workspace -s /bin/bash agent \
    && mkdir -p /workspace/in /workspace/out /workspace/skills \
    && chown -R agent:agent /workspace

USER agent
WORKDIR /workspace

# 容器長駐,指令走 docker exec
CMD ["sleep", "infinity"]
