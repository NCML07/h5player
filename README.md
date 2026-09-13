# h5player 抖音兼容修改版 / Douyin Compatibility Fork

## 中文

本仓库基于 [xxxily/h5player](https://github.com/xxxily/h5player) 修改，只加入针对最新版抖音网页版播放器的兼容代码。

### 安装

请先安装 [Tampermonkey](https://www.tampermonkey.net/) 或其他用户脚本管理器，然后点击下面的链接：

**[点击这里直接安装脚本](https://raw.githubusercontent.com/NCML07/h5player/master/dist/h5player.user.js)**

### 主要修改

- 兼容抖音新版 React/WebCodecs MediaStream 播放器
- 使用 Float32 安全倍速值，避免倍速队列卡住
- 恢复数字键 1–4 的单击、双击和长按倍速累加功能
- 改进新视频播放前的倍速预设、活动视频识别、进度跳转和高倍速防重置

### 已知问题

- 当前版本仍存在抖音旧模式视频播放卡顿的问题。
- 倍速设置过高时，可能出现音画不同步的现象。

### 问题反馈

如遇问题，可以在本仓库的 [Issues](https://github.com/NCML07/h5player/issues) 中提交反馈。本仓库是个人维护的兼容修改版，**不保证所有问题都会得到修复**。

## English

This repository is a modified fork of [xxxily/h5player](https://github.com/xxxily/h5player). It only adds compatibility code for the latest Douyin web player.

### Installation

Install [Tampermonkey](https://www.tampermonkey.net/) or another userscript manager first, then use the link below:

**[Install the userscript directly](https://raw.githubusercontent.com/NCML07/h5player/master/dist/h5player.user.js)**

### Changes

- Supports Douyin's latest React/WebCodecs MediaStream player
- Uses Float32-safe playback-rate values to prevent rate-control queues from hanging
- Restores single-press, double-press, and long-press speed accumulation for number keys 1–4
- Improves pre-play rate priming, active-video detection, seeking, and high-speed reset protection

### Known issues

- Videos using Douyin's legacy playback mode may still stutter.
- Very high playback speeds may cause audio and video to become out of sync.

### Issues

If you encounter a problem, you may report it in this repository's [Issues](https://github.com/NCML07/h5player/issues). This is a personally maintained compatibility fork, and **fixes are not guaranteed**.

## License

This fork follows the license of the upstream project.
