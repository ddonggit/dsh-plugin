# Penpot 海报设计配方

## 先决条件

1. 先调用 `penpot_status`，确认 `state` 是 `running`，拿到 `publicUri`。
2. 让用户在浏览器直接打开 `publicUri`（独立端口 3300，不经过 DSH 的 `/penpot` 子路径），登录 Penpot，新建或打开一个设计文件。
3. 首次使用先在账号 **Settings → Integrations → MCP Server** 启用并生成 MCP Key；打开设计文件后插件会自动连接（工具栏绿点 MCP），不需要点 Connect，保持标签页可见；没有绿点就刷新文件页。
4. 先调用 `mcp__penpot__high_level_overview`，再调用 `mcp__penpot__penpot_api_info` 核对当前版本 API。
5. 用 `mcp__penpot__execute_code` 写图层；导出先试 `mcp__penpot__export_shape`，失败就按下面“导出”章节的 SVG 兜底，不要反复重试空文件。

没有打开的文件、MCP 未启用、或标签页休眠时，`execute_code` 会失败。先用 `execute_code` 返回 1 自检，不要假装已经画好。

## 画布尺寸（单位 px）

| 用途 | 尺寸 |
|---|---|
| 竖版社媒 3:4 | 1080 × 1440 |
| 手机全屏 9:16 | 1080 × 1920 |
| A4 300dpi | 2480 × 3508 |
| A3 300dpi | 3508 × 4961 |
| 电商主图 1:1 | 2000 × 2000 |

印刷尺寸换算：`mm × 11.811 = px`（300dpi）。出血另加 3mm（约 35px），在 Penpot 里先做出血画板，最终由 CorelDRAW 裁切。

## 生成原则

- **所有元素都做成 Penpot 原生图层**：文字用 Text，形状用 Rectangle/Ellipse/Path，不要整张图贴 PNG。这样用户还能改字、改色、改位置。
- 一个海报放在一个 Board 里；所有元素 `board.appendChild(...)`，坐标相对 Board。
- 先背景，再主视觉/色块，再标题，最后价格/按钮/二维码。
- 中文标题优先用大字号、短句、两行以内；正文不小于 28px。
- 颜色一次定 3–4 个：底色、主色、强调色、文字色。不要超过 4 个主色。
- 需要“高级感”时用大留白、细描边、单色渐变；需要“促销感”时用高对比色块、超大数字、斜切标签。
- 不要一次画几十个装饰元素；先出可读的版式，再让用户决定加细节。

## 最小可用代码模板

```js
const W = 1080;
const H = 1440;

const board = penpot.createBoard();
board.name = "海报-夏日促销";
board.resize(W, H);
board.x = 0;
board.y = 0;
board.fills = [{ fillColor: "#0B0B0F" }];

function rect(name, x, y, w, h, fill, radius = 0) {
  const shape = penpot.createRectangle();
  shape.name = name;
  shape.resize(w, h);
  shape.fills = [{ fillColor: fill }];
  if (radius) shape.borderRadius = radius;
  board.appendChild(shape);
  shape.x = x;
  shape.y = y;
  return shape;
}

function text(content, x, y, w, h, size, color, weight = "700") {
  const shape = penpot.createText(content);
  if (!shape) throw new Error("createText returned null");
  shape.name = content.slice(0, 20);
  shape.growType = "fixed";
  shape.resize(w, h);
  shape.fontSize = String(size);
  shape.fontWeight = weight;
  shape.lineHeight = "1.1";
  shape.fills = [{ fillColor: color }];
  board.appendChild(shape);
  shape.x = x;
  shape.y = y;
  return shape;
}

// 背景渐变
const bg = penpot.createRectangle();
bg.name = "背景";
bg.resize(W, H);
bg.fills = [{
  fillColorGradient: {
    type: "linear",
    startX: 0, startY: 0, endX: W, endY: H,
    width: 1,
    stops: [
      { color: "#101828", opacity: 1, offset: 0 },
      { color: "#1D2939", opacity: 1, offset: 1 }
    ]
  }
}];
board.appendChild(bg);
bg.x = 0;
bg.y = 0;

// 主色块
rect("主色块", 72, 96, 936, 420, "#F97316", 28);

// 标题（默认字体没有中文字形时，先上传中文字体再设置 fontFamily）
const title = text("夏日\n特惠", 112, 150, 760, 300, 132, "#FFFFFF");
title.align = "left";

// 副标题
text("全场低至 5 折 · 仅限 3 天", 116, 470, 820, 80, 38, "#FFFFFF", "500");

// 价格
text("¥99", 112, 760, 600, 180, 150, "#FDE68A", "800");
text("起", 560, 880, 120, 60, 44, "#FDE68A", "500");

// 行动按钮
rect("按钮", 112, 1160, 520, 100, "#FFFFFF", 50);
text("立即抢购", 170, 1183, 420, 60, 40, "#111827", "700");

// 底部信息
text("活动时间：6.1 - 6.3 ｜ 门店及小程序同步", 112, 1300, 860, 50, 28, "#D0D5DD", "400");
```

运行后检查：Board 是否在视口内、文字有没有被裁切、中文是否显示方框。若中文方框，先让用户上传字体（团队设置 → Fonts → 上传 TTF/WOFF），再设置：

```js
title.fontFamily = "Noto Sans SC"; // 用字体列表里显示的确切名称
```

## 版式变体

### 1. 大字促销（电商/朋友圈）
- 背景：深色或高饱和纯色。
- 顶部 20%：品牌名/活动名，小字。
- 中部 50%：2 行超大标题（120–180px），一行强调色。
- 下部：价格数字 + 小字“起”，按钮或二维码。
- 用一条斜切色块或圆形光斑打破呆板，但不要遮挡文字。

### 2. 杂志留白（品牌/艺术展）
- 背景：米白/浅灰。
- 左侧 60% 放主标题，字号大但行距松。
- 右侧放一张产品图/几何形，留出 80–120px 边距。
- 只用黑、白、一个低饱和强调色；细线分隔。

### 3. 双色波普（餐饮/活动）
- 背景：荧光黄/粉。
- 黑色粗描边形状 + 重复圆点/条纹。
- 标题用描边或阴影，价格用大圆盘。
- 控制元素数量，避免廉价感。

## 图片和二维码

- 图片：优先让用户在 Penpot 里拖入，或用 MCP 的 `import_image`（仅本地 MCP 模式可读本地文件）。代码里用 `penpot.uploadMediaUrl(name, url)` 得到 `imageData`，再 `shape.fills = [{ fillOpacity: 1, fillImage: imageData }]`。
- 二维码：不要用 AI 生成假二维码。用真实链接生成二维码 PNG，再作为图片图层放入；或留一个白色方块 + 文字“二维码位置”，让用户替换。
- 产品图不要拉伸变形：按原比例缩放，必要时用 `clipContent` 的 Board 做裁切框。

## 导出（重要：2.18.6 的 MCP 导出可能失败）

`mcp__penpot__export_shape` 在当前 Penpot 2.18.6 + MCP 2.17.0 上可能返回 `Input Bit Array is empty` 或 0 字节；`board.export()` 也可能返回空。不要反复重试同一个调用，按下面顺序换路。

1. 先试 `mcp__penpot__export_shape`：`shapeId` 传 `board.id`（不是页面 id），`format` 只支持 `png` / `svg`。
   - 预览/发朋友圈：`png`，scale 1–2。
   - 给 CorelDRAW/印刷：`svg`。
2. 如果报错或文件为 0 字节，改用 `execute_code` 生成 SVG。插件沙箱没有 `TextEncoder`，用手写 UTF-8：

```js
function utf8(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

const svg = await penpot.generateMarkup([board], { type: "svg" });
await penpot.uploadMediaData("poster.svg", utf8(svg), "image/svg+xml");
```

上传成功后，Penpot 会把 SVG 渲染成图片资源。本机 Docker 部署可在 `/var/lib/docker/volumes/dsh-penpot_penpot_assets/_data` 下找新生成的 PNG（用 `file` 或 `identify` 确认尺寸），复制出来即可；不要假设别的机器上目录名一样。

3. PDF：`export_shape` 不支持 PDF。用浏览器/Chromium 把 PNG 以 A4 210×297mm 嵌入生成 PDF，或用 Inkscape 转。需要分层源文件时，让用户在 Penpot 里 **File → Export → .penpot**。
4. 导出后告诉用户文件在哪里、是什么格式、能不能再编辑；没真正生成文件就不要报路径。

## 印刷和 CorelDRAW 边界

- Penpot 是 RGB 工作流，没有原生 CMYK/专色；印刷前在 CorelDRAW/Acrobat/Illustrator 转 CMYK、加出血、检查黑色叠印。
- Penpot 导出的 PDF 不含专业印前设置；不要声称“直接可印刷”。
- 文字转曲：Penpot 2.x 可右键 **Flatten** 把文字转成路径；转曲前先复制一份，保留可编辑文字版。
- 和 CorelDRAW 互通：用 SVG（矢量、可编辑）或 PDF；`.penpot` 文件 CorelDRAW 打不开。
- 中文字体必须嵌入/转曲，否则印刷厂可能缺字体。

## 交付话术

完成后用中文告诉用户：
- 画板尺寸和用途；
- 哪些文字/颜色/形状可以直接改；
- 导出了什么格式，在哪里；
- 印刷前还需要在 CorelDRAW 做什么（CMYK、出血、转曲）。

不要只说“已完成”，也不要编造导出文件路径。