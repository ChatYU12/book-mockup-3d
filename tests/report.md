# 书籍 3D 效果图工具 · 独立验收报告

- 生成时间：2026-10-30T04:17:15.008Z（Asia/Shanghai）
- 被测文件：`index.html`（716.1 KB，sha256:a374ec4936a4，mtime 2026-10-30T03:17:47.684Z）
- 浏览器：Chrome Chrome/156.0.8078.48（headless，puppeteer-core）
- WebGL：ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version) / WebGL 2.0 (OpenGL ES 3.0 Chromium)
- 视口：1440×900 @1x；机器负载（1/5/15min，运行开始前）：3.23 / 4.07 / 5.54
- 用法：`node tests/gen-images.mjs` 生成 fixtures，`node tests/verify.mjs` 跑全部 8 条
- 结论：**8/8 条 PASS**

| # | 验收项 | 结论 | 通过子项 | 用时 |
| --- | --- | --- | --- | --- |
| 1 | 上传两张图后 5 秒内书模出现在画面（阈值 ≤5000ms） | **PASS** | 7/7 | 4912 ms |
| 2 | 书模三边比例 185:260:10，误差 <1%（以封面宽度为基准） | **PASS** | 6/6 | 1491 ms |
| 3 | 预设视角 ≥4 种，切换后 300ms 内完成重绘 | **PASS** | 17/17 | 11858 ms |
| 4 | 透明 PNG：四角 alpha=0、无灰底、有抗锯齿过渡、无纯白/纯黑描边、有 alpha 阴影 | **PASS** | 10/10 | 3500 ms |
| 5 | 导出长边 2000/3000/4000 的实际像素尺寸正确，4000 不报错不崩溃 | **PASS** | 8/8 | 13542 ms |
| 6 | 内置背景 ≥4 款（不透明 + 色相符合），自定义背景可用 | **PASS** | 14/14 | 14744 ms |
| 7 | 封面右边缘与书脊左边缘接缝不错位（无 1px 以上错位/白缝） | **PASS** | 13/13 | 18955 ms |
| 8 | 上传 1:10 书脊图必须出现比例警告，且不静默拉伸 | **PASS** | 8/8 | 5102 ms |

## 视觉与观感观察汇总（自动量 + 建议人眼复核）

- **检查 1** — 应用内部标记（performance.now() 绝对值，非时长）：firstFrame=1048，upload:composite=2996，upload:firstframe=3052。运行前 load=3.23 / 4.07 / 5.54；本机同时有其它浏览器/自动化实例占 CPU 时计时会偏悲观（同一构建在 load≈18 时首次上传 3.8–4.7s，load≈2.8 时 0.5s）。
- **检查 4** — 透明导出外框 12px 完全透明（内容未触边）。
- **检查 4** — 接触阴影（仅统计 0<alpha<255 的半透明像素）alpha 层次 94 级，相邻像素最大跳变 145/255；层次多在 12 级以上即不算"脏台阶"。
- **检查 4** — 轮廓半透明边缘亮度/内侧亮度 = 99%（正常范围，无暗边迹象）。
- **检查 5** — 导出画幅 2000×1642，长宽比 1.218（等于预览画布宽高比）。若想要固定的成品画幅（如正方形或 185:260），取景会随窗口尺寸变化——不作为验收判据，仅提示。
- **检查 7** — 滚轮放大 5 档后到达缩放上限，折角处的彩条竖带在屏上只有 11px 宽（12 道条每道约 0.9px）——fixtures 的彩条是 0.3mm 级的细条纹，正常缩放下必然融合成一条彩色细边，属于测试图的物理尺度限制，不是渲染缺陷。

> 自动判据只能覆盖像素级可量的部分（灰底、白边、阴影存在性、色相、接缝相位等）。纸页纹理是否细腻、折角高光是否自然、阴影是否"脏"这类观感问题，请人眼复核：
> `shots/10-preset-*.png`（5 个视角）、`shots/21-transparent-on-checker.png`（透明导出叠棋盘格，最容易看出灰底/白边）、`shots/35-export-bg-*.png`（带背景成品）、`shots/41-seam-closeup-crop.png`（折角接缝特写）。

## 逐条明细

### 1. 上传两张图后 5 秒内书模出现在画面（阈值 ≤5000ms） — ✅ PASS

- ✅ window.__book3d.ready 在 10s 内 resolve — `0.1ms`
- ✅ 同页重复上传 loadImage×2 耗时（热态；此时画面本就未变，无法用视觉判据） — `699ms`
- ✅ loadImage("cover") 返回尺寸 — `{"w":1850,"h":2600,"ratioBad":false}`
- ✅ loadImage("spine") 返回尺寸 — `{"w":100,"h":2600,"ratioBad":false}`
- ✅ getState().cover 已记录 — `{"w":1850,"h":2600}`
- ✅ 开页 → 拖入两张图，书模出现在画面 ≤5000ms（首次冷启动，墙钟） — `2055ms（其中 loadImage×2 = 2055ms）`
- ✅ 页面状态已就绪（供后续检查使用） — `{"cover":{"w":1850,"h":2600},"spine":{"w":100,"h":2600}}`
- ⚠️ 观察：应用内部标记（performance.now() 绝对值，非时长）：firstFrame=1048，upload:composite=2996，upload:firstframe=3052。运行前 load=3.23 / 4.07 / 5.54；本机同时有其它浏览器/自动化实例占 CPU 时计时会偏悲观（同一构建在 load≈18 时首次上传 3.8–4.7s，load≈2.8 时 0.5s）。

证据：[`01-after-upload.png`](shots/01-after-upload.png)

### 2. 书模三边比例 185:260:10，误差 <1%（以封面宽度为基准） — ✅ PASS

- ✅ getDims().measured 三个方向都有正值 — `{"x":185,"y":260,"z":10}`
- ✅ getDims().nominal 为 {W:185,H:260,T:10} — `{"W":185,"H":260,"T":10}`
- ✅ 高/宽 = 1.40541（期望 260/185=1.40541，误差 0% < 1%） — `y=260 期望 260`
- ✅ 厚/宽 = 0.05405（期望 10/185=0.05405，误差 0% < 1%） — `z=10 期望 10`
- ✅ state.cover 尺寸与 185:260 一致（确认贴的是 1850×2600 那张） — `{"w":1850,"h":2600}`
- ✅ state.spine 尺寸与 10:260 一致 — `{"w":100,"h":2600}`

证据：[`02-dims-state.png`](shots/02-dims-state.png)

### 3. 预设视角 ≥4 种，切换后 300ms 内完成重绘 — ✅ PASS

- ✅ 页面上能识别的预设控件 ≥4 个 — `10 个：front / 正面 / left30 / 左前30 / left45 / 左前45 / table / 平放 / stack2 / 堆叠`
- ✅ setPreset('front') 后 getState().preset 回读一致 — `front`
- ✅ setPreset('front') → 下一帧出现新姿态 ≤300ms — `37ms`
- ✅ setPreset('front') 动画到位（画面停止变化）≤300ms + 1 帧量化容差 — `87.2ms（帧间隔 98.9ms，容差 99ms，3 帧内收敛）`
- ✅ setPreset('left30') 后 getState().preset 回读一致 — `left30`
- ✅ setPreset('left30') → 下一帧出现新姿态 ≤300ms — `2.4ms`
- ✅ setPreset('left30') 动画到位（画面停止变化）≤300ms + 1 帧量化容差 — `50.9ms（帧间隔 142.5ms，容差 143ms，3 帧内收敛）`
- ✅ setPreset('left45') 后 getState().preset 回读一致 — `left45`
- ✅ setPreset('left45') → 下一帧出现新姿态 ≤300ms — `38.4ms`
- ✅ setPreset('left45') 动画到位（画面停止变化）≤300ms + 1 帧量化容差 — `87.4ms（帧间隔 48.1ms，容差 48ms，3 帧内收敛）`
- ✅ setPreset('table') 后 getState().preset 回读一致 — `table`
- ✅ setPreset('table') → 下一帧出现新姿态 ≤300ms — `38.8ms`
- ✅ setPreset('table') 动画到位（画面停止变化）≤300ms + 1 帧量化容差 — `87.5ms（帧间隔 145.1ms，容差 145ms，3 帧内收敛）`
- ✅ setPreset('stack2') 后 getState().preset 回读一致 — `stack2`
- ✅ setPreset('stack2') → 下一帧出现新姿态 ≤300ms — `114.5ms`
- ✅ setPreset('stack2') 动画到位（画面停止变化）≤300ms + 1 帧量化容差 — `201.4ms（帧间隔 87.9ms，容差 88ms，3 帧内收敛）`
- ✅ ≥4 种预设终态画面两两可区分（相邻截图平均色差 >1.5/255） — `front:99 left30:12.41 left45:16.33 table:30.71 stack2:8.02`

证据：[`10-preset-front.png`](shots/10-preset-front.png)、[`10-preset-left30.png`](shots/10-preset-left30.png)、[`10-preset-left45.png`](shots/10-preset-left45.png)、[`10-preset-table.png`](shots/10-preset-table.png)、[`10-preset-stack2.png`](shots/10-preset-stack2.png)

### 4. 透明 PNG：四角 alpha=0、无灰底、有抗锯齿过渡、无纯白/纯黑描边、有 alpha 阴影 — ✅ PASS

- ✅ 左上角 alpha=0（无底色） — `rgba(0,0,0,0)`
- ✅ 右上角 alpha=0（无底色） — `rgba(0,0,0,0)`
- ✅ 左下角 alpha=0（无底色） — `rgba(0,0,0,0)`
- ✅ 右下角 alpha=0（无底色） — `rgba(0,0,0,0)`
- ✅ 四角 60×60 区域平均 alpha <3（不是灰底/白底透视） — `0`
- ✅ 存在轮廓抗锯齿过渡像素（0<alpha<255） — `55571 个（占 1.69%）`
- ✅ 能找到书模轮廓（不透明像素边界的像素数 >0） — `3763 个`
- ✅ 轮廓上不存在"alpha=255 的近白描边"（占比 <2%） — `0/3763 = 0%`
- ✅ 轮廓上不存在"alpha=255 的近黑描边" — `0/3763`
- ✅ 书模下方存在 alpha 渐变的接触阴影像素（0<alpha<255 且暗） — `33357 个，平均亮度 1`
- ⚠️ 观察：透明导出外框 12px 完全透明（内容未触边）。
- ⚠️ 观察：接触阴影（仅统计 0<alpha<255 的半透明像素）alpha 层次 94 级，相邻像素最大跳变 145/255；层次多在 12 级以上即不算"脏台阶"。
- ⚠️ 观察：轮廓半透明边缘亮度/内侧亮度 = 99%（正常范围，无暗边迹象）。

证据：[`20-export-transparent-2000.png`](shots/20-export-transparent-2000.png)、[`21-transparent-on-checker.png`](shots/21-transparent-on-checker.png)

### 5. 导出长边 2000/3000/4000 的实际像素尺寸正确，4000 不报错不崩溃 — ✅ PASS

- ✅ longEdge=2000 导出未抛错 — `1864ms, 0.39MB`
- ✅ longEdge=2000 实际像素长边 = 2000 — `2000×1642`
- ✅ longEdge=3000 导出未抛错 — `4098ms, 0.72MB`
- ✅ longEdge=3000 实际像素长边 = 3000 — `3000×2464`
- ✅ longEdge=4000 导出未抛错 — `7543ms, 1.11MB`
- ✅ longEdge=4000 实际像素长边 = 4000 — `4000×3285`
- ✅ 三档全部产出且页面仍存活 — `[{"le":2000,"w":2000,"h":1642,"ms":1864,"mb":0.39},{"le":3000,"w":3000,"h":2464,"ms":4098,"mb":0.72},{"le":4000,"w":4000,"h":3285,"ms":7543,"mb":1.11}]`
- ✅ 4000 导出后页面/WebGL 上下文仍然可用
- ⚠️ 观察：导出画幅 2000×1642，长宽比 1.218（等于预览画布宽高比）。若想要固定的成品画幅（如正方形或 185:260），取景会随窗口尺寸变化——不作为验收判据，仅提示。

### 6. 内置背景 ≥4 款（不透明 + 色相符合），自定义背景可用 — ✅ PASS

- ✅ 背景 studio：四角 alpha=255（不透明） — `[255,255,255,255]`
- ✅ 背景 studio：三通道接近（max-min ≤12） — `TL=219,218,214 BR=228,227,223`
- ✅ 背景 studio：亮度落在 200–245（浅灰影棚） — `TL=219,218,214 BR=228,227,223`
- ✅ 背景 white：四角 alpha=255（不透明） — `[255,255,255,255]`
- ✅ 背景 white：R,G,B 均 >250 — `TL=254,254,253 BR=254,254,254`
- ✅ 背景 wood：四角 alpha=255（不透明） — `[255,255,255,255]`
- ✅ 背景 wood：R>G>B（木质偏棕） — `R=119 G=87 B=62`
- ✅ 背景 gradient：四角 alpha=255（不透明） — `[255,255,255,255]`
- ✅ 背景 gradient：上下两端不同色（渐变可见） — `TL=250,246,237 BL=195,206,201`
- ✅ 内置背景款数 ≥4 — `4 款：studio/white/wood/gradient`
- ✅ loadCustomBackground 返回 1600×1200 — `{"w":1600,"h":1200}`
- ✅ 自定义背景导出四角 alpha=255 — `[255,255,255,255]`
- ✅ getState().bg === "custom" — `custom`
- ✅ 导出画面里能看到自定义背景的特征色（橙框/青绿底） — `橙 30.22% / 青 40.92%`

证据：[`30-bg-studio.png`](shots/30-bg-studio.png)、[`35-export-bg-studio.png`](shots/35-export-bg-studio.png)、[`30-bg-white.png`](shots/30-bg-white.png)、[`35-export-bg-white.png`](shots/35-export-bg-white.png)、[`30-bg-wood.png`](shots/30-bg-wood.png)、[`35-export-bg-wood.png`](shots/35-export-bg-wood.png)、[`30-bg-gradient.png`](shots/30-bg-gradient.png)、[`35-export-bg-gradient.png`](shots/35-export-bg-gradient.png)、[`34-bg-custom.png`](shots/34-bg-custom.png)、[`35-export-bg-custom.png`](shots/35-export-bg-custom.png)

### 7. 封面右边缘与书脊左边缘接缝不错位（无 1px 以上错位/白缝） — ✅ PASS

- ✅ getSeamSample() 可用并返回数据 — `keys=coverW,rows`
- ✅ getSeamSample 能提取出跨接缝的列像素（形状：flat 列数组 ×7） — `7 列`
- ✅ 接缝样本有一定宽度（≥5 列，否则 1px 级判据变弱） — `7 列`
- ✅ 接缝各列都保留彩条色度（无灰缝/白缝/黑缝） — `最小色度 161 / 最大 242`
- ✅ 接缝列像素都能归到三种彩条色（无混色/错色 ⇒ UV 无偏移） — `最大色距 47`
- ✅ 彩条游程宽度一致（宽度差 ≤1 列 ⇒ 无 1px 级错位/重复列） — `游程 2×3 0×3 1×1，中间段宽度差 0`
- ✅ 彩条颜色按三色周期连续（无跳条 ⇒ 无整条错位） — `step=1,1`
- ✅ 接缝正好落在彩条交界（两侧列颜色不同 ⇒ 无 1px 级 UV 偏移） — `左 2 / 右 0`
- ✅ 接缝相位正确（封面末条=蓝 → 书脊首条=红，与 fixtures 设计一致） — `得到 2→0（期望 2→0）`
- ✅ 接缝两侧边缘列是纯彩条色（未出现半像素混合 ⇒ 贴图 UV 偏移 ≈ 0） — `封面末列 [31,95,208] / 书脊首列 [224,27,27]`
- ✅ 接缝特写裁切区域内确实含有彩条竖带（特写拍到了折角，不是空背景） — `竖带 12px，饱和列占比峰值 0.62`
- ✅ 特写里能看到彩条色相变化（红黄蓝序列在渲染色上确实存在） — `色相 41,40,40,39,7,35,321,32,32,309,24,35,281,18,10，跨度 314°`
- ✅ 拖拽可旋转（附：滚轮缩放与拖拽交互可用） — `拖拽前后画面差 22.98/255`
- ⚠️ 观察：滚轮放大 5 档后到达缩放上限，折角处的彩条竖带在屏上只有 11px 宽（12 道条每道约 0.9px）——fixtures 的彩条是 0.3mm 级的细条纹，正常缩放下必然融合成一条彩色细边，属于测试图的物理尺度限制，不是渲染缺陷。

证据：[`40-seam-closeup.png`](shots/40-seam-closeup.png)、[`41-seam-closeup-crop.png`](shots/41-seam-closeup-crop.png)、[`42-after-drag.png`](shots/42-after-drag.png)

### 8. 上传 1:10 书脊图必须出现比例警告，且不静默拉伸 — ✅ PASS

- ✅ 1:10 的坏书脊图已被接收（100×1000） — `{"w":100,"h":1000,"ratioBad":true}`
- ✅ loadImage 返回 ratioBad=true — `true`
- ✅ 出现"上传后才新增"的可见比例警告（含偏差/不匹配/不是 10:260 等语义） — `「书脊图比例不是 10 : 260」 @ P.warn-title`
- ✅ （辅助）页面上存在提及"比例/宽高比/10 : 260"的可见文本 — `「01 平面图 已就位 封面 185 × 260 mm 1850 × 2600 px · 0.712 : 1 书脊 10 × 260 mm 100 × 1000 px · 比例 1 : 10 · 偏差 160% 请上传已裁到成品尺寸的图，不要带出血线或裁切线。两张图在接缝处的图案要能接上。 书脊图比例不是 10 : 26」`
- ✅ （前置）上传正常书脊图时没有误报警告 — `无警告`
- ✅ 警告文案明确点出比例偏差（不是只显示目标尺寸） — `含"偏差"`
- ✅ getState().spineMode 仍为 "crop"（未静默拉伸） — `crop`
- ✅ 厚度比例未被坏图拉宽（10mm 固定，厚度/宽 前后一致） — `0.05405 → 0.05405`

证据：[`50-ratio-warning.png`](shots/50-ratio-warning.png)

## 调试契约核对

- 存在（12）：`ready`、`loadImage`、`loadCustomBackground`、`setPreset`、`setBackground`、`setLongEdge`、`getState`、`getDims`、`renderExport`、`getSeamSample`、`perf`、`tick`
- 缺失：无

## 应用内部计时（`__book3d.perf()`，供 Lead 定位性能）

```json
{
  "marks": {
    "t0": 655.5999999940395,
    "boot": 0,
    "renderer": 541,
    "env": 798,
    "lights": 800,
    "paper": 902,
    "materials": 938,
    "bind": 949,
    "firstFrame": 1048,
    "upload:composite": 75242,
    "export": {
      "size": [
        1200,
        985
      ],
      "setup": 7,
      "render": 1,
      "toDataURL": 150,
      "readPixels": 3
    },
    "upload:firstframe": 75243
  },
  "gl": "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5300M, Unspecified Version)"
}
```

## 局限与说明

- 检查 1 的"书模出现"用书模画布中心区域截图与上传前基线的平均色差 >3/255 判定（WebGL 画布无法直接读像素时最稳的代理指标），并记录 Node 侧时间戳。
- 检查 3 的 300ms 用页面内 `gl.readPixels`（56×56 中心块）+ rAF 循环量动画到位时间：连续 3 帧、且帧间平均色差 <1/255（肉眼不可辨）即视为到位，不受 CDP 截图延迟影响；判据另加一个渲染帧间隔的量化容差（headless 被其它进程抢占时帧间隔可达数百 ms，此时只能保证「最后一次可见变化不晚于 300ms + 1 帧」）；读不到像素时才退回截图对比。
- 检查 7 的自动化判据是像素级的"接缝两侧颜色/相位连续 + 无灰缝白缝"，1px 级错位以游程宽度差 ≤1 列、色差不超过彩条内部跳变来表达；另附折角特写截图供人眼复核。
- 检查 4 的"白边"判据：轮廓上紧邻半透明像素的 alpha=255 像素中，近白（min channel >235）占比 <2%；黑边为 0。
- 截图命名：`10-preset-*` 五个预设、`30-bg-*` 四款内置背景 + `34-bg-custom`、`20/21` 透明导出与棋盘格合成、`40/41` 接缝特写。

## 产物

- 导出件：`shots/20-export-transparent-2000.png`、`21-transparent-on-checker.png`、`35-export-bg-<id>.png`、`export-transparent-3000.png`、`export-transparent-4000.png`
- 截图：`shots/00-before-upload.png` … `shots/60-final.png`
