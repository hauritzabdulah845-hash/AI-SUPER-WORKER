#!/usr/bin/env bash
# 由「数字人工坊」生成 · 需要本机安装 ffmpeg（macOS: brew install ffmpeg / Windows: winget install ffmpeg）
set -euo pipefail
cd "$(dirname "$0")"
# 请把本脚本、sub.srt 与素材放同一目录
# 用法：先从「数字人工坊」导出字幕为 sub.srt，再执行 bash make-digital.sh

# 主画面（形象）：口播-正面.mp4 循环，配音盖满
# 配音：配音.wav
# 副画面（按段切入）：5.0s-13.0s 分镜1.png
ffmpeg -y \
  -stream_loop -1 -i "口播-正面.mp4" \
  -i "配音.wav" \
  -loop 1 -i "分镜1.png" \
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg];[bg][2:v]overlay=enable='between(t,5.00,13.00)'[o1];[o1]subtitles=sub.srt:fontsdir=fonts:force_style='FontName=Noto Sans SC Thin Thin,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1'[vout]" \
  -map "[vout]" -map 1:a -c:a aac -b:a 192k -shortest "digital-out.mp4"

# 输出：digital-out.mp4；字幕字体「Noto Sans SC Thin Thin」，字体目录 fonts。
# 中文显示成方块时：把中文字体文件放进 fonts/ 目录（脚本已带 fontsdir=fonts），
# 或把 filter 里的 FontName 改成本机已装字体（macOS 常用 PingFang SC，Linux 常用 Noto Sans CJK SC）。