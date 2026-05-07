"""Generate polished docx + diagram images for the mock-research deliverables.

Run from project root:
    python3 scripts/generate_deliverables.py

Outputs:
    images/decision-matrix.png
    images/coverage-matrix.png
    images/pipeline.png
    images/timeline.png
    images/route-tradeoff.png
    docs/技术调研报告.docx
    docs/OKR-2026-05.docx
"""
from pathlib import Path

import matplotlib as mpl
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import numpy as np
from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# ------------------------------------------------------------ paths & fonts

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "images"
DOCS = ROOT / "docs"
IMG.mkdir(exist_ok=True)
DOCS.mkdir(exist_ok=True)

mpl.rcParams["font.sans-serif"] = ["Hiragino Sans GB", "PingFang SC", "Heiti SC", "Arial Unicode MS"]
mpl.rcParams["axes.unicode_minus"] = False
mpl.rcParams["font.size"] = 11

# Brand-ish palette
NAVY = "#1f3b5c"
TEAL = "#2a9d8f"
AMBER = "#e9c46a"
CORAL = "#e76f51"
SLATE = "#5b6b7d"
PAPER = "#fafafa"
INK = "#222"

# --------------------------------------------------------- IMAGE 1: matrix

def draw_decision_matrix():
    routes = [
        "A 2D 纯叠加",
        "B 2D Mesh Warp",
        "C PSD Displacement",
        "D AI 分割+自动位移",
        "E 全 3D 渲染",
        "F 3D Plane+Pose",
        "G SMPL 重建",
        "H SD Inpaint",
        "I VTON 模型",
        "J 商业 API",
    ]
    dims = ["真实感", "通用性", "性能", "易实现", "纯前端"]
    # 1 (worst) -> 5 (best); 纯前端列：1=必须后端，5=纯前端
    scores = np.array([
        [1, 5, 5, 5, 5],
        [2, 3, 5, 4, 5],
        [4, 2, 5, 3, 5],
        [3, 5, 2, 2, 3],
        [3, 2, 4, 3, 5],
        [3, 5, 3, 3, 5],
        [4, 5, 2, 1, 1],
        [5, 5, 2, 3, 1],
        [5, 4, 2, 3, 1],
        [4, 2, 5, 5, 2],
    ])
    fig, ax = plt.subplots(figsize=(8.5, 6.2), dpi=170)
    cmap = mpl.colors.LinearSegmentedColormap.from_list(
        "score", ["#fde7e1", "#f8c8b8", "#f4a58c", "#e98169", TEAL]
    )
    ax.imshow(scores, cmap=cmap, aspect="auto", vmin=1, vmax=5)
    ax.set_xticks(range(len(dims)))
    ax.set_xticklabels(dims, fontsize=11)
    ax.set_yticks(range(len(routes)))
    ax.set_yticklabels(routes, fontsize=10.5)
    ax.tick_params(top=True, bottom=False, labeltop=True, labelbottom=False, length=0)
    for i in range(len(routes)):
        for j in range(len(dims)):
            v = scores[i, j]
            ax.text(j, i, "★" * v, ha="center", va="center",
                    color=INK if v >= 3 else SLATE, fontsize=9)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_xticks(np.arange(-.5, len(dims), 1), minor=True)
    ax.set_yticks(np.arange(-.5, len(routes), 1), minor=True)
    ax.grid(which="minor", color="white", linewidth=2)
    ax.tick_params(which="minor", length=0)
    plt.suptitle("技术路线决策矩阵", fontsize=15, fontweight="bold", color=NAVY, y=1.02)
    ax.set_title("分数越高越好；末列越高表示越接近纯前端", fontsize=10, color=SLATE, pad=22)
    plt.tight_layout()
    out = IMG / "decision-matrix.png"
    plt.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close()
    return out

# --------------------------------------------------------- IMAGE 2: coverage

def draw_coverage_matrix():
    routes = ["A 叠加", "B Mesh Warp", "C PSD Displ", "D 自动位移",
              "E 全 3D", "F 3D Plane", "G SMPL", "H SD Inpaint",
              "I VTON", "J 商业 API"]
    subs = ["① 区域识别", "② 形状/褶皱", "③ 图案变形", "④ 光影融合", "⑤ 交互调整"]
    # 0 = 不解决, 1 = 部分/手动, 2 = 完全解决
    cov = np.array([
        [1, 0, 0, 0, 2],
        [1, 0, 2, 0, 2],
        [2, 2, 2, 2, 2],
        [2, 2, 2, 1, 2],
        [2, 2, 2, 2, 2],
        [2, 1, 2, 1, 2],
        [2, 2, 2, 2, 2],
        [2, 2, 2, 2, 1],
        [2, 2, 2, 2, 0],
        [2, 2, 2, 2, 1],
    ])
    fig, ax = plt.subplots(figsize=(8.5, 5.8), dpi=170)
    palette = ["#f3f4f6", "#fde4d3", TEAL]
    cmap = mpl.colors.ListedColormap(palette)
    ax.imshow(cov, cmap=cmap, aspect="auto", vmin=0, vmax=2)
    labels = {0: "—", 1: "部分", 2: "●"}
    for i in range(len(routes)):
        for j in range(len(subs)):
            v = cov[i, j]
            ax.text(j, i, labels[v], ha="center", va="center",
                    color="white" if v == 2 else INK, fontsize=10, fontweight="bold")
    ax.set_xticks(range(len(subs)))
    ax.set_xticklabels(subs)
    ax.set_yticks(range(len(routes)))
    ax.set_yticklabels(routes)
    ax.tick_params(top=True, bottom=False, labeltop=True, labelbottom=False, length=0)
    for sp in ax.spines.values():
        sp.set_visible(False)
    ax.set_xticks(np.arange(-.5, len(subs), 1), minor=True)
    ax.set_yticks(np.arange(-.5, len(routes), 1), minor=True)
    ax.grid(which="minor", color="white", linewidth=2)
    ax.tick_params(which="minor", length=0)
    plt.suptitle("方案对 5 个子问题的覆盖度", fontsize=15, fontweight="bold", color=NAVY, y=1.02)
    plt.tight_layout()
    out = IMG / "coverage-matrix.png"
    plt.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close()
    return out

# --------------------------------------------------------- IMAGE 3: pipeline

def draw_pipeline():
    fig, ax = plt.subplots(figsize=(11, 5.4), dpi=170)
    ax.set_xlim(0, 11)
    ax.set_ylim(0, 5.4)
    ax.axis("off")

    def box(x, y, w, h, text, color, text_color="white"):
        ax.add_patch(mpatches.FancyBboxPatch(
            (x, y), w, h, boxstyle="round,pad=0.04,rounding_size=0.18",
            linewidth=0, facecolor=color))
        ax.text(x + w/2, y + h/2, text, ha="center", va="center",
                color=text_color, fontsize=10.5, fontweight="bold")

    def arrow(x1, y1, x2, y2):
        ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="-|>", color=SLATE, lw=1.5))

    # left input column: assets
    assets = [
        ("base.jpg\n模特原图", 0.4, 4.1),
        ("mask.png\n衣服 alpha", 0.4, 3.05),
        ("displace.png\nRG = x/y 位移", 0.4, 2.0),
        ("light.png\n灰度光影", 0.4, 0.95),
    ]
    for t, x, y in assets:
        box(x, y, 2.2, 0.85, t, NAVY)

    # user input
    box(0.4, 0.0 - 0.1, 2.2, 0.6, "用户图案 PNG", AMBER, text_color=INK)
    ax.text(0.4 + 1.1, -0.45, "（运行时输入）", ha="center", va="center", color=SLATE, fontsize=9)

    # middle: shader
    box(3.6, 1.6, 3.6, 2.6,
        "GLSL Fragment Shader\n\n"
        "1. 采样 displace → 位移 UV\n"
        "2. 采样 graphic（变形后）\n"
        "3. 采样 light 做 multiply\n"
        "4. 按 mask 与 base mix",
        TEAL)

    # right: outputs
    box(8.4, 3.4, 2.3, 1.3, "实时预览\n≥30 fps", CORAL)
    box(8.4, 1.7, 2.3, 1.3, "高清导出\n4K PNG ≤1s", CORAL)
    box(8.4, 0.0, 2.3, 1.3, "PDF / 多色版\n（可选）", SLATE)

    # arrows from assets to shader
    for _, x, y in assets:
        arrow(x + 2.2, y + 0.42, 3.6, 2.9)
    arrow(0.4 + 2.2, 0.2, 3.6, 2.9)

    # arrows from shader to outputs
    arrow(7.2, 3.4, 8.4, 4.05)
    arrow(7.2, 2.9, 8.4, 2.35)
    arrow(7.2, 2.4, 8.4, 0.65)

    # title
    ax.text(5.5, 5.1, "PSD Displacement 渲染管线（pixi.js v8 / three.js）",
            ha="center", fontsize=15, fontweight="bold", color=NAVY)

    out = IMG / "pipeline.png"
    plt.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close()
    return out

# --------------------------------------------------------- IMAGE 4: timeline

def draw_timeline():
    tasks = [
        ("KR1.1 模板交付（≥8 套）",        1, 4, TEAL),
        ("KR1.2 渲染管线 / 性能",         1, 3, TEAL),
        ("KR1.3 编辑器交互 + 用户测试",   2, 3, TEAL),
        ("KR2.1 MediaPipe + 3D Plane",    1, 2, AMBER),
        ("KR2.2 SD Inpaint 调研报告",     2, 2, AMBER),
        ("KR2.3 对外可演示 Demo",         3, 2, AMBER),
    ]
    fig, ax = plt.subplots(figsize=(10.5, 4.6), dpi=170)
    for i, (name, start, span, color) in enumerate(tasks):
        ax.barh(i, span, left=start, height=0.55, color=color,
                edgecolor="white", linewidth=1.5)
        ax.text(start + span/2, i, name, ha="center", va="center",
                color="white" if color != AMBER else INK, fontsize=10.5, fontweight="bold")
    ax.set_yticks(range(len(tasks)))
    ax.set_yticklabels([])
    ax.invert_yaxis()
    ax.set_xticks([1, 2, 3, 4, 5])
    ax.set_xticklabels(["W1\n5/1–5/7", "W2\n5/8–5/14", "W3\n5/15–5/21",
                        "W4\n5/22–5/28", "W5\n5/29–5/31"])
    ax.set_xlim(0.7, 5)
    ax.tick_params(left=False)
    for sp in ["left", "right", "top"]:
        ax.spines[sp].set_visible(False)
    ax.spines["bottom"].set_color("#cccccc")
    ax.grid(axis="x", color="#eeeeee", linewidth=1)
    ax.set_axisbelow(True)
    # legend
    o1 = mpatches.Patch(color=TEAL, label="O1 · MVP 主路线")
    o2 = mpatches.Patch(color=AMBER, label="O2 · 通用方案探路")
    ax.legend(handles=[o1, o2], loc="lower right", frameon=False, fontsize=10)
    plt.suptitle("2026-05 月度里程碑甘特图",
                 fontsize=15, fontweight="bold", color=NAVY, y=0.99)
    plt.tight_layout()
    out = IMG / "timeline.png"
    plt.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close()
    return out

# --------------------------------------------------------- IMAGE 5: tradeoff

def draw_tradeoff():
    # (x, y, size, color, label_dx, label_dy, label_align)
    routes = {
        "A 叠加":        (5.3, 1.2, 60,  "#cfd8dc",  0.00, -0.22, "top"),
        "B Mesh Warp":   (4.2, 2.0, 60,  "#cfd8dc",  0.00, -0.22, "top"),
        "C PSD Displ":   (1.6, 4.5, 220, TEAL,       0.00,  0.30, "bottom"),
        "D 自动位移":     (5.0, 3.4, 110, AMBER,      0.30,  0.00, "left"),
        "E 全 3D":        (2.2, 3.2, 110, "#cfd8dc",  0.00, -0.25, "top"),
        "F 3D Plane":     (4.0, 3.4, 160, AMBER,    -0.30,  0.00, "right"),
        "G SMPL":         (4.5, 4.2, 90,  CORAL,    -0.30,  0.00, "right"),
        "H SD Inpaint":   (5.5, 5.3, 200, CORAL,     0.00,  0.30, "bottom"),
        "I VTON":         (4.0, 5.0, 110, CORAL,    -0.30,  0.00, "right"),
        "J 商业 API":     (1.6, 3.3, 90,  "#cfd8dc", 0.00, -0.25, "top"),
    }
    fig, ax = plt.subplots(figsize=(9, 6.4), dpi=170)
    align_map = {"top": ("center", "top"), "bottom": ("center", "bottom"),
                 "left": ("left", "center"), "right": ("right", "center")}
    for name, (x, y, s, c, dx, dy, pos) in routes.items():
        ax.scatter(x, y, s=s*4, color=c, edgecolor="white", linewidth=1.8,
                   alpha=0.92, zorder=3)
        ha, va = align_map[pos]
        ax.text(x + dx, y + dy, name, ha=ha, va=va, fontsize=10.5,
                color=INK, fontweight="bold", zorder=4)

    ax.axhline(3.0, color="#dddddd", linewidth=1, zorder=1)
    ax.axvline(3.5, color="#dddddd", linewidth=1, zorder=1)
    ax.text(0.55, 6.05, "前端友好 · 高真实", color=SLATE, fontsize=9.5)
    ax.text(6.25, 6.05, "通用性高 · 高真实", color=SLATE, fontsize=9.5, ha="right")
    ax.text(0.55, 0.7, "前端友好 · 真实感弱", color=SLATE, fontsize=9.5)
    ax.text(6.25, 0.7, "通用性高 · 真实感弱", color=SLATE, fontsize=9.5, ha="right")

    ax.set_xlim(0.4, 6.4)
    ax.set_ylim(0.5, 6.4)
    ax.set_xlabel("通用性（任意输入图）→", fontsize=11)
    ax.set_ylabel("真实感 →", fontsize=11)
    for sp in ax.spines.values():
        sp.set_color("#cccccc")
    ax.tick_params(left=False, bottom=False, labelleft=False, labelbottom=False)
    legend_elems = [
        mpatches.Patch(color=TEAL, label="MVP 推荐"),
        mpatches.Patch(color=AMBER, label="可前端探索"),
        mpatches.Patch(color=CORAL, label="需后端"),
        mpatches.Patch(color="#cfd8dc", label="备选"),
    ]
    ax.legend(handles=legend_elems, loc="upper center", bbox_to_anchor=(0.5, -0.08),
              frameon=False, fontsize=10, ncol=4)
    plt.suptitle("路线权衡：通用性 × 真实感（气泡=综合推荐度）",
                 fontsize=14, fontweight="bold", color=NAVY, y=0.97)
    plt.tight_layout()
    out = IMG / "route-tradeoff.png"
    plt.savefig(out, bbox_inches="tight", facecolor="white")
    plt.close()
    return out

# ------------------------------------------------------------ docx helpers

CHINESE_FONT = "PingFang SC"
WESTERN_FONT = "Calibri"


def _set_run_fonts(run, size=None, bold=None, color=None):
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:ascii"), WESTERN_FONT)
    rFonts.set(qn("w:hAnsi"), WESTERN_FONT)
    rFonts.set(qn("w:eastAsia"), CHINESE_FONT)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color.lstrip("#"))


def _shade_cell(cell, color_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color_hex.lstrip("#"))
    tcPr.append(shd)


def style_doc(doc):
    style = doc.styles["Normal"]
    style.font.name = WESTERN_FONT
    style.font.size = Pt(11)
    rPr = style.element.get_or_add_rPr()
    rFonts = OxmlElement("w:rFonts")
    rFonts.set(qn("w:eastAsia"), CHINESE_FONT)
    rPr.append(rFonts)
    for level, size, color in [(1, 20, NAVY), (2, 16, NAVY), (3, 13, NAVY)]:
        s = doc.styles[f"Heading {level}"]
        s.font.name = WESTERN_FONT
        s.font.size = Pt(size)
        s.font.color.rgb = RGBColor.from_string(color.lstrip("#"))
        s.font.bold = True
        rPr2 = s.element.get_or_add_rPr()
        rFonts2 = OxmlElement("w:rFonts")
        rFonts2.set(qn("w:eastAsia"), CHINESE_FONT)
        rPr2.append(rFonts2)


def add_para(doc, text, *, bold=False, italic=False, size=11, color=None,
             align=None, space_after=4):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(space_after)
    if align:
        p.alignment = align
    run = p.add_run(text)
    _set_run_fonts(run, size=size, bold=bold, color=color)
    run.font.italic = italic
    return p


def add_bullet(doc, text, level=0):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.left_indent = Cm(0.6 + level * 0.6)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(text)
    _set_run_fonts(run)
    return p


def add_table(doc, header, rows, col_widths=None, header_color=NAVY,
              zebra="#f5f7fa"):
    table = doc.add_table(rows=1 + len(rows), cols=len(header))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    if col_widths:
        for col, w in zip(table.columns, col_widths):
            for cell in col.cells:
                cell.width = Cm(w)
    for j, h in enumerate(header):
        cell = table.rows[0].cells[j]
        cell.text = ""
        _shade_cell(cell, header_color)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(h)
        _set_run_fonts(run, size=10.5, bold=True, color="ffffff")
    for i, row in enumerate(rows):
        for j, value in enumerate(row):
            cell = table.rows[i + 1].cells[j]
            cell.text = ""
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            if zebra and i % 2 == 1:
                _shade_cell(cell, zebra)
            p = cell.paragraphs[0]
            run = p.add_run(str(value))
            _set_run_fonts(run, size=10)
    return table


def add_image(doc, path, width_cm=15.5, caption=None):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.add_run().add_picture(str(path), width=Cm(width_cm))
    if caption:
        cap = doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.paragraph_format.space_after = Pt(8)
        run = cap.add_run(caption)
        _set_run_fonts(run, size=9.5, color=SLATE)
        run.font.italic = True


def add_callout(doc, title, text, color=TEAL):
    table = doc.add_table(rows=1, cols=1)
    cell = table.rows[0].cells[0]
    _shade_cell(cell, "f1f8f6" if color == TEAL else "fff7e6")
    cell.text = ""
    p1 = cell.paragraphs[0]
    r1 = p1.add_run(title)
    _set_run_fonts(r1, size=11, bold=True, color=color)
    p2 = cell.add_paragraph()
    r2 = p2.add_run(text)
    _set_run_fonts(r2, size=10.5)
    doc.add_paragraph()


# ------------------------------------------------------------ build research

def build_research_doc(images):
    doc = Document()
    style_doc(doc)

    # Title block
    add_para(doc, "服装图形 Mockup 技术路线调研", bold=True, size=24,
             color=NAVY, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
    add_para(doc, "Mock-Research Project · 2026-04",
             italic=True, size=11, color=SLATE,
             align=WD_ALIGN_PARAGRAPH.CENTER, space_after=14)

    add_callout(doc, "需求一句话",
                "输入一张模特图片 + 一张平面图案，输出一张图：图案"
                "「印」在模特身上的衣服上，要求贴合形状、褶皱与光影。")

    # 1. 问题拆解
    doc.add_heading("1. 问题拆解", level=1)
    add_para(doc, "把「图形贴合衣服」拆成 5 个独立子问题，后续所有方案都是这 5 个子问题的不同组合。")
    add_table(doc, ["子问题", "技术名词", "难度"], [
        ["① 衣服在图中的位置 / 边界", "image segmentation / mask", "中"],
        ["② 衣服表面形状（褶皱、起伏）", "displacement / normal / depth map", "高"],
        ["③ 图案随衣服形状变形", "UV warp / mesh deformation", "中-高"],
        ["④ 图案受衣服光影影响", "multiply / overlay blend、PBR lighting", "低-中"],
        ["⑤ 图案位置缩放可交互调整", "2D/3D transform editor", "低"],
    ], col_widths=[6.5, 6.5, 2.5])

    # 2. 决策矩阵
    doc.add_heading("2. 技术路线决策矩阵", level=1)
    add_para(doc, "10 条候选路线、5 个评估维度。下图按星级展示，星越多越好；"
             "末列「纯前端」越高表示越接近「纯前端可实现」。")
    add_image(doc, images["matrix"], width_cm=15.8,
              caption="图 1 · 技术路线决策矩阵（A–J 共 10 条路线 × 5 个维度）")

    add_image(doc, images["tradeoff"], width_cm=15.8,
              caption="图 2 · 通用性 × 真实感象限图（颜色=分类，气泡大小=综合推荐度）")

    # 3. 详细方案
    doc.add_heading("3. 详细方案", level=1)

    doc.add_heading("3.1 2D 路线", level=2)
    for title, body in [
        ("A · 纯透明叠加",
         "PNG 透明图直接叠加，不处理透视、不处理光影。栈：HTML+CSS / Canvas2D，0 依赖。"
         "适用于极简风格、卡通贴纸场景。"),
        ("B · 2D Mesh Warp（手动锚点）",
         "在衣服区域预设 4–9 个控制点，对图案做 perspective transform 或 thin-plate-spline 变形。"
         "解决了透视，但没有褶皱与光影。栈：pixi.js v8 PerspectiveMesh / three.js PlaneGeometry / fabric.js / konva.js。"),
        ("C · ★ 2D Displacement + Light Map（PSD Smart Object 工作流，推荐）",
         "把「褶皱」与「光影」一次性烘焙成两张贴图：displace（RG=x/y 像素位移）+ light（灰度乘法层）。"
         "运行时只需把图案当贴图替换。这就是 Photoshop「智能对象 + 置换滤镜」的程序化版本，"
         "也是 Printful / Placeit / Smartmockups 行业标准做法。"),
        ("D · 2D + AI 分割 + 自动 Displacement",
         "对任意上传照片，用 U²-Net / MODNet 自动分割衣服，用 MiDaS / Depth Anything 估深度生成 displacement。"
         "通用性高但模型体积大、首次体验慢；可纯前端（onnxruntime-web）也可放后端。"),
    ]:
        doc.add_heading(title, level=3)
        add_para(doc, body)

    add_callout(doc, "C 方案推荐说明",
                "真实感与商用级方案对齐、纯前端、性能好。一次性资产烘焙成本可控（一件衣服 30 分钟–1 小时美工），"
                "适合电商 / 印刷打样器场景。", color=TEAL)

    add_image(doc, images["pipeline"], width_cm=16.5,
              caption="图 3 · PSD Displacement 渲染管线（pixi.js v8 / three.js）")

    doc.add_heading("3.2 3D 路线", level=2)
    for title, body in [
        ("E · 全 3D 渲染（无真实模特照片）",
         "场景里就是 3D 模特 + 3D T-shirt，把图案作为 albedo / decal texture 贴到 UV，"
         "three.js 直接渲染。视角姿势完全可控；缺点是失去真实摄影感。"
         "栈：three.js + react-three-fiber + drei（Decal / Environment / useGLTF）。"),
        ("F · ★ 简化 3D：3D Plane + Pose 估计（任意照片场景推荐）",
         "保留真实照片背景，前面摆一个朝向相机的 3D 平面贴用户图案，靠 MediaPipe Pose 的 33 个 landmark 定位胸部位置，"
         "加 procedural noise 模拟褶皱。中等真实感、纯前端、任意照片可用，是任意输入场景的折中方案。"),
        ("G · 真实照片 + 3D 体型重建（SMPL / SMPL-X）",
         "从 2D 照片反推 SMPL 参数，3D 衣服 drape 到身上后渲染回原图。研究界主流路线（TryOnDiffusion、"
         "StableVITON、DressCode 等），但需 GPU 与训练好的拟合网络，前端基本不可行，必须 hybrid。"),
    ]:
        doc.add_heading(title, level=3)
        add_para(doc, body)

    doc.add_heading("3.3 AI 路线（基本必需后端）", level=2)
    for title, body in [
        ("H · ★ Stable Diffusion + ControlNet + IP-Adapter（Inpainting）",
         "最通用、效果最自然。SAM 自动 mask + ControlNet（Canny / Depth / Pose）保构图 + "
         "IP-Adapter 把图案作 reference + SDXL Inpaint 在 mask 区域生成。"
         "RTX 3090 一张图 5–15s，A100 < 5s。可走 Replicate / Fal / RunPod / Modal 等 API；"
         "或自托管 ComfyUI server。文字与精细 logo 易扭曲是已知短板。"),
        ("I · 专用虚拟试穿模型",
         "IDM-VTON（开源 SOTA）/ CatVTON / OOTDiffusion / OutfitAnyone（阿里）/ Kling Try-On。"
         "为「换衣服」设计，输入是完整服装图。要做「印花」需先合成印好图案的平铺衣服再喂给 VTON。"),
        ("J · 商业 Mockup API",
         "DynamicMockups / Printful Mockup Generator / Pacdora / Smartmockups。"
         "1–2 天即可上线 MVP，月费 $20–200，缺点是模板与模特受限，无法满足品牌定制场景。"),
    ]:
        doc.add_heading(title, level=3)
        add_para(doc, body)

    # 4. coverage
    doc.add_heading("4. 各方案对子问题的覆盖度", level=1)
    add_para(doc, "深绿 = 完全解决，浅橙 = 部分 / 手动，灰 = 不解决。")
    add_image(doc, images["coverage"], width_cm=15.5,
              caption="图 4 · 10 条路线 × 5 个子问题覆盖度")

    # 5. selection
    doc.add_heading("5. 推荐选型（按业务目标）", level=1)
    add_table(doc, ["业务场景", "推荐路线", "理由"], [
        ["电商 / 印刷打样器（已知 SKU）", "C · PSD Displacement",
         "纯前端、商用真实感、1-2 周可 MVP；行业主流"],
        ["用户上传任意模特照片", "短期 F + 长期 H",
         "F 纯前端兜底，H 后端给「高质量」按钮"],
        ["3D 可视化 / 产品配置器", "E · 全 3D + R3F",
         "视角姿势全可控；适合定制化深的品类"],
        ["最快上线、不在乎自有资产", "J · 商业 API",
         "1–2 天接入，月费可控"],
    ], col_widths=[5.5, 4.5, 6.5])

    # 6. stack
    doc.add_heading("6. 推荐技术栈（前端优先）", level=1)
    add_table(doc, ["层级", "选型", "用途"], [
        ["项目脚手架", "React 18 + TypeScript + Vite", "符合工程标准"],
        ["渲染层", "pixi.js v8", "2D Displacement 主力"],
        ["渲染层 / 3D", "three.js + @react-three/fiber + drei", "复杂 shader / 3D 路线"],
        ["编辑器交互", "konva.js 或 fabric.js + leva", "图层、拖拽、缩放、参数面板"],
        ["输入处理", "@mediapipe/tasks-vision (Pose)", "任意照片姿态 landmark"],
        ["输入处理", "onnxruntime-web + U²-Net", "衣服分割（可选）"],
        ["资产管线", "Photoshop / Affinity / Blender bake", "base / mask / displace / light"],
        ["导出", "Canvas.toBlob / pdf-lib", "PNG / JPG / 高分辨率 PDF"],
        ["后端（可选）", "Node + sharp / Python + ComfyUI / Replicate", "高清离屏合成或 SD 推理"],
    ], col_widths=[3.0, 6.5, 6.5])

    # 7. roadmap
    doc.add_heading("7. 实施路线建议", level=1)
    add_table(doc, ["阶段", "时间", "内容", "交付"], [
        ["MVP", "1–2 周", "1–2 个预制模板 + pixi.js DisplacementFilter + 上传/拖拽/缩放/导出", "可演示 demo"],
        ["质量化", "2–3 周", "模板扩到 10–20 个；自定义 GLSL；可视化模板编辑器", "内测版"],
        ["通用化", "2–4 周", "MediaPipe Pose + 3D Plane（方案 F）", "升级版"],
        ["高真实", "视情况", "接 Replicate / Fal SD inpainting workflow，作为「高质量」按钮", "商业版"],
    ], col_widths=[2.2, 2.2, 7.5, 4.0])

    # 8. concl
    doc.add_heading("8. 一句话结论", level=1)
    add_callout(doc, "前端优先 · 已知 SKU 场景",
                "用 pixi.js + PSD Displacement（方案 C），纯前端、商用级效果、1–2 周可上线 MVP。",
                color=TEAL)
    add_callout(doc, "任意照片场景",
                "短期上 MediaPipe + 3D Plane（F），长期接后端 SD Inpainting（H）作为「高质量」按钮。",
                color=AMBER)

    out = DOCS / "技术调研报告.docx"
    doc.save(out)
    return out

# ------------------------------------------------------------ build okr

def build_okr_doc(images):
    doc = Document()
    style_doc(doc)

    add_para(doc, "Mock-Research 项目 OKR", bold=True, size=24,
             color=NAVY, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
    add_para(doc, "2026 年 5 月 · 周期 2026-05-01 ~ 2026-05-31",
             italic=True, size=11, color=SLATE,
             align=WD_ALIGN_PARAGRAPH.CENTER, space_after=14)

    add_callout(doc, "OKR 制定原则",
                "≤ 2 个 O、≤ 8 个 KR；KR 全部带数字（可量化、可验证）；产出导向、不写 todo；"
                "满分 = 目标太低，60–70% 完成度 = 有挑战的健康线。")

    doc.add_heading("写作思路", level=1)
    for t in [
        "核心矛盾：已知 SKU 电商场景（路线 C）vs 任意模特照场景（路线 F+H）哪条先跑通。",
        "决策：O1 主攻 C 路线 MVP（70% 精力），O2 探路 F + 调研 H（30% 精力）。",
        "长短期并重：5 月只交付 MVP + 通用方案 demo；模板规模化、SD 后端落地放到 6 月。",
    ]:
        add_bullet(doc, t)

    # O1
    doc.add_heading("O1 · 验证 PSD Displacement 路线的商用可行性，上线 Mockup 编辑器 MVP", level=1)
    add_para(doc, "为什么做：路线 C 是行业商用主流（Printful / Placeit / Smartmockups 都在用），"
             "真实感够、纯前端、无 GPU 依赖。一个月内必须用真实用户验证它能不能成为产品主路线，"
             "否则后面所有工作没有锚点。", italic=True, color=SLATE)
    add_para(doc, "Owner：1 名前端工程师 + 1 名美工配合 · 预期评分 0.6 ~ 0.7", bold=True)

    add_table(doc, ["#", "KR", "量化指标", "验收方式"], [
        ["KR1.1", "交付高质量预制 mockup 模板，覆盖核心服装品类",
         "≥ 8 个模板，覆盖 ≥ 4 个品类（T 恤 / 卫衣 / 帆布袋 / 马克杯或海报）；"
         "每模板含 base / mask / displace / light 四件资产",
         "美工 + 工程双方 5 分制，平均 ≥ 4.0"],
        ["KR1.2", "pixi.js v8 + DisplacementFilter 渲染管线达到商用性能门槛",
         "2K 分辨率实时预览 ≥ 30 fps；导出 4K PNG 单张 ≤ 1 s；首屏主 bundle ≤ 500 KB gzip",
         "Chrome Performance + Lighthouse 报告"],
        ["KR1.3", "完成上传 / 拖拽 / 缩放 / 旋转 / 导出全交互闭环并通过真实用户验收",
         "≥ 5 位真实用户（设计师 / 电商运营）问卷 ≥ 4.0 / 5；"
         "≥ 3 条可执行反馈合并入 backlog",
         "录屏 + 问卷 + 反馈表归档"],
    ], col_widths=[1.6, 4.5, 5.5, 4.0])

    # O2
    doc.add_heading("O2 · 打通任意模特照片场景的最简通用方案，并完成后端 AI 路线的可行性结论", level=1)
    add_para(doc, "为什么做：MVP 模板路线天花板就是「已有 SKU」，要做有市场竞争力的产品就必须支持"
             "「用户上传任意模特照」。这一个月不要求生产级，但必须给出两条路线（前端 3D Plane / "
             "后端 SD Inpaint）的明确取舍依据，否则 6 月会卡在选型上。",
             italic=True, color=SLATE)
    add_para(doc, "Owner：1 名前端 / 算法兼职 · 预期评分 0.5 ~ 0.6（探索性，挑战度更高）",
             bold=True)

    add_table(doc, ["#", "KR", "量化指标", "验收方式"], [
        ["KR2.1", "跑通 MediaPipe Pose + three.js 3D Plane 端到端方案",
         "处理耗时 ≤ 3 s（含模型加载）；正面站姿测试集 10 张图，肉眼判定「贴合 OK」≥ 8 张",
         "测试集图像评审会，3 人盲评打分"],
        ["KR2.2", "输出 SD Inpaint 后端方案的对比调研报告",
         "≥ 2 套 workflow（IP-Adapter+ControlNet 组合）跑通；对比 ≥ 4 项（latency / 显存 / 真实感 / 单图成本）；"
         "给出「上 / 不上 / 何时上」明确建议",
         "报告 ≥ 2 页 + 样例图 ≥ 6 张 + 团队评审通过"],
        ["KR2.3", "产出对外可演示成果",
         "1 段 ≥ 60 s Demo 视频 或 1 个公开可访问页面；展示「任意上传照 → 印花生成」完整链路",
         "团队 ≥ 2 人验收通过 + Demo 链接归档"],
    ], col_widths=[1.6, 4.5, 5.5, 4.0])

    # Timeline
    doc.add_heading("月度里程碑", level=1)
    add_image(doc, images["timeline"], width_cm=16.5,
              caption="图 · 2026-05 周维度甘特图，O1（主路线）与 O2（探路）并行")

    # Risks
    doc.add_heading("风险与应对", level=1)
    add_table(doc, ["风险", "应对"], [
        ["美工资产产出速度跟不上 KR1.1 的 8 个模板",
         "W1 内确认美工 SLA；如不达标，模板数下调到 5，把工程精力转向编辑器质量"],
        ["MediaPipe 在侧身 / 多人 / 遮挡场景识别失败（影响 KR2.1）",
         "5 月只承诺正面站姿；非正面用例明确写进「已知限制」"],
        ["SD 后端方案显存 / 成本不可控",
         "KR2.2 结论可以是「暂不上线」，这本身就是有效产出"],
        ["同时跑两条线带来上下文切换",
         "严格按 7:3 投入；周会用 KR 进度表对齐，超过 50/50 立刻调整"],
    ], col_widths=[7.0, 8.5])

    # Cadence
    doc.add_heading("节奏与汇报", level=1)
    for t in [
        "周会（每周一）：每个 KR 列百分比进度 + 本周关键产出 + 下周计划，重点是「上周相对上上周前进了多少」。",
        "双周复盘（5/15、5/29）：盘点是否需要调整目标 / 砍 KR / 加资源。",
        "月会（5/30 或 6/2）：按 KR 给最终评分（百分比制），输出「做对了什么 / 做错了什么 / 下个月怎么办」三段式总结。",
    ]:
        add_bullet(doc, t)

    # Scoring expectation
    doc.add_heading("评分预期", level=1)
    add_table(doc, ["维度", "预期", "说明"], [
        ["O1 总评分", "0.6 ~ 0.7",
         "8 个模板做出 5–6 个、性能基本达标、真实用户测试有结论"],
        ["O2 总评分", "0.5 ~ 0.6",
         "3D Plane 跑通但精度有限、SD 报告交付、Demo 能演示"],
        ["月度总评分", "≈ 0.6", "符合「健康挑战线」；如真的拿到 0.9+，下月 OKR 必须更激进"],
    ], col_widths=[3.5, 3.5, 8.5])

    out = DOCS / "OKR-2026-05.docx"
    doc.save(out)
    return out


# ------------------------------------------------------------ main

def main():
    images = {
        "matrix":   draw_decision_matrix(),
        "coverage": draw_coverage_matrix(),
        "pipeline": draw_pipeline(),
        "timeline": draw_timeline(),
        "tradeoff": draw_tradeoff(),
    }
    research = build_research_doc(images)
    okr = build_okr_doc(images)
    print("Generated:")
    for k, v in images.items():
        print(f"  image:{k:>9}  ->  {v.relative_to(ROOT)}")
    print(f"  doc       ->  {research.relative_to(ROOT)}")
    print(f"  doc       ->  {okr.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
