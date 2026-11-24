@echo off
rem 由「数字人工坊」生成 · 需要本机安装 ffmpeg（winget install ffmpeg）
setlocal
cd /d "%~dp0"
rem 请把本脚本、sub.srt 与素材放同一目录
rem 用法：先从「数字人工坊」导出字幕为 sub.srt，再双击或 cmd 运行本脚本

rem 主画面（形象）：口播-正面.mp4 循环，配音盖满
rem 配音：配音.wav
rem 副画面（按段切入）：5.0s-13.0s 分镜1.png
ffmpeg -y ^
  -stream_loop -1 -i "口播-正面.mp4" ^
  -i "配音.wav" ^
  -loop 1 -i "分镜1.png" ^
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg];[bg][2:v]overlay=enable='between(t,5.00,13.00)'[o1];[o1]subtitles=sub.srt:fontsdir=fonts:force_style='FontName=Noto Sans SC Thin Thin,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1'[vout]" ^
  -map "[vout]" -map 1:a -c:a aac -b:a 192k -shortest "digital-out.mp4"

rem 输出：digital-out.mp4；如缺字幕样式字体，改 sub.srt 同名字体名
endlocal