"""3D 打印导出（docs/library-3d-design.md 第六节），只用标准库。会话（slate-model export）和 api Lambda 共用这一份
（部署时 backend-code.ts 复制到 backend/lib/）。

1. prepare(raw)：页面取出的网格（世界坐标，three.js 的 Y 轴朝上）按零件、颜色分组，焊接顶点，判断每块网格封不封闭。
   结果是"打印源数据"，导出时存进 model/v<n>/print-src.json.gz。
2. check(src)：给 Agent 的问题清单（没有封闭的网格、三角形太多）。
3. build(src, …)：按机型、高度、出法、颜色数生成 3MF 或 STL，返回 (文件内容, 文件名, 报告)。
   3MF：单位毫米，Z 轴朝上，每个零件和颜色一个部件，颜色写成 basematerials。Bambu Studio 2.5 起导入时能把颜色对应到 AMS 耗材。
"""
import io, json, math, re, struct, zipfile

# 打印范围（毫米，宽 × 深 × 高），来自 Bambu Studio 的机型配置（resources/profiles/BBL/machine）
PRINTERS = {"a1mini": ("A1 mini", (180, 180, 180)), "a1": ("A1 / P1 / X1 / P2S", (256, 256, 256)),
            "h2d": ("H2D", (350, 320, 325)), "h2s": ("H2S", (340, 320, 340))}
MIN_FEATURE_MM = 0.8   # 0.4 毫米喷嘴：两条线宽，再细就打不出来
GAP_MM = 5             # 零件分开时，零件之间的间距
MAX_TRIANGLES = 600000
MAX_SRC_BYTES = 64 << 20  # 打印源文件解压后最大 64 MB：压缩比可以上千倍，不限量解压会撑爆内存
MAX_COLORS = 256          # 颜色归并的耗时随颜色数近似平方增长
NEAR = 24              # RGB 距离小于这个的两种颜色，肉眼几乎分不出，打印时并成一种


# ---------------------------------------------------------------- 打印源数据

def _weld(pos, idx, tol):
    """按坐标焊接顶点（同一位置的重复顶点合成一个），去掉退化三角形。返回 (顶点, 三角形)"""
    key_of, verts, remap = {}, [], []
    q = 1.0 / tol
    for i in range(0, len(pos), 3):
        k = (round(pos[i] * q), round(pos[i + 1] * q), round(pos[i + 2] * q))
        j = key_of.get(k)
        if j is None:
            j = key_of[k] = len(verts) // 3
            verts += [round(pos[i], 6), round(pos[i + 1], 6), round(pos[i + 2], 6)]
        remap.append(j)
    order = idx if idx else range(len(remap))
    tris = []
    it = iter(order)
    for a, b, c in zip(it, it, it):
        a, b, c = remap[a], remap[b], remap[c]
        if a != b and b != c and a != c:
            tris += [a, b, c]
    return verts, tris


def closed(tris):
    """每条边恰好被两个三角形共用，就是封闭的（不封闭的网格切片时会出错）"""
    edges = {}
    for i in range(0, len(tris), 3):
        a, b, c = tris[i:i + 3]
        for e in ((a, b), (b, c), (c, a)):
            k = (e[0], e[1]) if e[0] < e[1] else (e[1], e[0])
            edges[k] = edges.get(k, 0) + 1
    return bool(edges) and all(n == 2 for n in edges.values())


def prepare(raw):
    """raw：{"meshes": [{"part", "color", "name", "pos": [x, y, z, …], "idx": [..] 或 null}]}（页面里的 window.__printSource()）"""
    meshes = raw.get("meshes") or []
    allp = [v for m in meshes for v in m["pos"]]
    if not allp:
        raise ValueError("模型里没有可以打印的网格")
    lo = [min(allp[i::3]) for i in range(3)]
    hi = [max(allp[i::3]) for i in range(3)]
    diag = math.dist(lo, hi) or 1.0
    parts = {}
    for m in meshes:
        verts, tris = _weld(m["pos"], m.get("idx"), diag * 1e-5)
        if not tris:
            continue
        vol = {"color": m.get("color") or "#cccccc", "name": m.get("name") or "", "verts": verts, "tris": tris, "closed": closed(tris)}
        parts.setdefault(m.get("part") or "body", []).append(vol)
    return {"version": 1, "bbox": [lo, hi], "parts": [{"id": k, "volumes": v} for k, v in parts.items()]}


def check(src):
    """导出时给 Agent 看的问题"""
    out = []
    open_ = [f"{p['id']}/{v['name'] or '未命名'}" for p in src["parts"] for v in p["volumes"] if not v["closed"]]
    if open_:
        out.append(f"有 {len(open_)} 块网格不封闭（零厚度的面片、没封口的管子或车削体），3D 打印切片时会出错："
                   f"{'、'.join(open_[:12])}{' 等' if len(open_) > 12 else ''}。面片改成有厚度的薄板，管子两头加盖，车削的轮廓从轴线起到轴线止")
    n = sum(len(v["tris"]) // 3 for p in src["parts"] for v in p["volumes"])
    if n > MAX_TRIANGLES:
        out.append(f"三角形一共 {n} 个，超过 {MAX_TRIANGLES}，导出的打印文件会很大，降低细分段数")
    return out


def dumps(src):
    import gzip
    return gzip.compress(json.dumps(src, separators=(",", ":")).encode())


def loads(data):
    import zlib
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)  # gzip 格式，限量解压
    raw = d.decompress(data, MAX_SRC_BYTES)
    if d.unconsumed_tail or not d.eof:
        raise ValueError("打印源文件太大")
    return json.loads(raw)


# ---------------------------------------------------------------- 颜色

def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _hex(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(x))) for x in c)


def cluster_colors(colors, n):
    """把模型的颜色归并成最多 n 种，返回 {原颜色: 归并后的颜色}"""
    weight = {}
    for c, w in colors:
        weight[c.lower()] = weight.get(c.lower(), 0) + w
    # 几乎一样的颜色（RGB 距离不到 NEAR）先并到面积大的那个：肉眼分不出，不值得多占一个 AMS 料位
    merged = {}
    for c in sorted(weight, key=lambda c: -weight[c]):
        host = next((h for h, to in merged.items() if to == h and math.dist(_rgb(c), _rgb(h)) < NEAR), None)
        if host:
            weight[host] += weight.pop(c); merged[c] = host
        else:
            merged[c] = c
    uniq = list(weight)
    out = cluster(uniq, weight, n)
    return {c: out[merged[c]] for c in merged}


def cluster(uniq, weight, n):
    """按面积加权的 k-means。起点按"面积 × 和已选颜色距离的平方"挑（面积大、颜色又不一样的优先），结果是确定的"""
    if n <= 1:
        avg = [sum(_rgb(c)[i] * weight[c] for c in uniq) / sum(weight.values()) for i in range(3)]
        return {c: _hex(avg) for c in uniq}
    if len(uniq) <= n:
        return {c: c for c in uniq}
    pts = {c: _rgb(c) for c in uniq}
    centers = [pts[max(uniq, key=lambda c: weight[c])]]
    while len(centers) < n:
        centers.append(pts[max(uniq, key=lambda c: weight[c] * min(math.dist(pts[c], k) for k in centers) ** 2)])
    for _ in range(20):
        groups = [[] for _ in centers]
        for c in uniq:
            groups[min(range(len(centers)), key=lambda i: math.dist(pts[c], centers[i]))].append(c)
        new = [tuple(sum(pts[c][i] * weight[c] for c in g) / sum(weight[c] for c in g) for i in range(3)) if g else centers[k]
               for k, g in enumerate(groups)]
        if new == centers:
            break
        centers = new
    return {c: _hex(centers[min(range(len(centers)), key=lambda i: math.dist(pts[c], centers[i]))]) for c in uniq}


# ---------------------------------------------------------------- 生成文件

def _area(verts, tris):
    s = 0.0
    for i in range(0, len(tris), 3):
        a, b, c = (verts[3 * j:3 * j + 3] for j in tris[i:i + 3])
        u = [b[k] - a[k] for k in range(3)]; v = [c[k] - a[k] for k in range(3)]
        s += 0.5 * math.sqrt((u[1] * v[2] - u[2] * v[1]) ** 2 + (u[2] * v[0] - u[0] * v[2]) ** 2 + (u[0] * v[1] - u[1] * v[0]) ** 2)
    return s


def _to_print(verts, scale):
    """three.js（Y 轴朝上）→ 打印坐标（Z 轴朝上，毫米）：绕 X 轴转 90 度，(x, y, z) → (x, -z, y)，是旋转所以三角形朝向不变"""
    out = []
    for i in range(0, len(verts), 3):
        out += [verts[i] * scale, -verts[i + 2] * scale, verts[i + 1] * scale]
    return out


def _bounds(vs):
    return [min(vs[i::3]) for i in range(3)], [max(vs[i::3]) for i in range(3)]


def _shift(vs, d):
    return [v + d[i % 3] for i, v in enumerate(vs)]


def build(src, printer="a1", height=120, mode="whole", colors=4, fmt="3mf", names=None):
    """生成打印文件。names：零件 id → 中文名（素材卡），用在文件里的零件名和报告里"""
    if printer not in PRINTERS:
        raise ValueError("不认识这个机型")
    label, (bw, bd, bh) = PRINTERS[printer]
    names = names or {}
    lo, hi = src["bbox"]
    model_h = hi[1] - lo[1]
    if model_h <= 0:
        raise ValueError("模型的高度不对，没法缩放")
    if not 10 <= height <= bh:
        raise ValueError(f"{label} 最高能打 {bh} 毫米，高度要在 10 到 {bh} 毫米之间")
    scale = height / model_h
    n = sum(len(v["tris"]) // 3 for p in src["parts"] for v in p["volumes"])
    if n > MAX_TRIANGLES:
        raise ValueError(f"模型有 {n} 个三角形，超过 {MAX_TRIANGLES}，没法导出打印文件")
    if len({str(v["color"]).lower() for p in src["parts"] for v in p["volumes"]}) > MAX_COLORS:
        raise ValueError(f"模型的颜色超过 {MAX_COLORS} 种，没法导出打印文件")
    weights = [(v["color"], _area(v["verts"], v["tris"])) for p in src["parts"] for v in p["volumes"]]
    cmap = cluster_colors(weights, colors)
    parts = []
    for p in src["parts"]:
        vols = [{**v, "verts": _to_print(v["verts"], scale), "color": cmap[v["color"].lower()]} for v in p["volumes"]]
        parts.append({"id": p["id"], "name": names.get(p["id"], p["id"]), "volumes": vols})
    warnings = []
    # 整体：保持装配位置，整体放到热床中间、底面贴床；零件分开：每个零件底面贴床，一排一排摆开
    allv = [x for p in parts for v in p["volumes"] for x in v["verts"]]
    (x0, y0, z0), (x1, y1, z1) = _bounds(allv)
    size = [x1 - x0, y1 - y0, z1 - z0]
    if mode == "whole":
        if size[0] > bw or size[1] > bd:
            raise ValueError(f"按 {height:g} 毫米高缩放后，底面是 {size[0]:.0f} × {size[1]:.0f} 毫米，放不下 {label} 的热床（{bw} × {bd}），把高度调小一些")
        d = [bw / 2 - (x0 + x1) / 2, bd / 2 - (y0 + y1) / 2, -z0]
        for p in parts:
            for v in p["volumes"]:
                v["verts"] = _shift(v["verts"], d)
    else:
        cx, cy, row = GAP_MM, GAP_MM, 0.0
        for p in parts:
            pv = [x for v in p["volumes"] for x in v["verts"]]
            (px0, py0, pz0), (px1, py1, _) = _bounds(pv)
            w, dpt = px1 - px0, py1 - py0
            if w > bw or dpt > bd:
                warnings.append(f"零件「{p['name']}」底面 {w:.0f} × {dpt:.0f} 毫米，比热床还大，要调小高度或在 Bambu Studio 里转个方向")
            if cx + w > bw and cx > GAP_MM:
                cx, cy, row = GAP_MM, cy + row + GAP_MM, 0.0
            d = [cx - px0, cy - py0, -pz0]
            for v in p["volumes"]:
                v["verts"] = _shift(v["verts"], d)
            cx += w + GAP_MM
            row = max(row, dpt)
        if cy + row > bd:
            warnings.append("零件太多，一块热床放不下，在 Bambu Studio 里按 A 自动排版会分到几块热床上")
    for p in parts:
        for v in p["volumes"]:
            (a0, b0, c0), (a1, b1, c1) = _bounds(v["verts"])
            thin = min(a1 - a0, b1 - b0, c1 - c0)
            if thin < MIN_FEATURE_MM:
                warnings.append(f"零件「{p['name']}」有一块最薄处约 {thin:.2f} 毫米，0.4 毫米喷嘴打不出来，可以调大高度或者打印时去掉")
                break
    if any(not v["closed"] for p in parts for v in p["volumes"]):
        warnings.append("有的网格不封闭，Bambu Studio 导入时如果提示修复模型，点修复即可")
    by_color = {}
    for p in parts:
        for v in p["volumes"]:
            by_color.setdefault(v["color"], [])
            if p["name"] not in by_color[v["color"]]:
                by_color[v["color"]].append(p["name"])
    report = {"printer": label, "sizeMm": [round(x, 1) for x in size], "scale": round(scale, 4), "parts": len(parts),
              "objects": 1 if mode == "whole" else len(parts), "colors": [{"hex": h, "parts": ps} for h, ps in by_color.items()],
              "warnings": warnings[:20]}
    if fmt == "stl":
        data, fname = _stl_files(parts, mode)
    else:
        data, fname = _3mf(parts, mode, list(by_color)), "model.3mf"
    return data, fname, report


def _stl(vols):
    tris = []
    for v in vols:
        vs = v["verts"]
        for i in range(0, len(v["tris"]), 3):
            a, b, c = (vs[3 * j:3 * j + 3] for j in v["tris"][i:i + 3])
            u = [b[k] - a[k] for k in range(3)]; w = [c[k] - a[k] for k in range(3)]
            nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
            ln = math.sqrt(sum(x * x for x in nrm)) or 1
            tris.append(struct.pack("<12fH", *(x / ln for x in nrm), *a, *b, *c, 0))
    return b"Slate 3D".ljust(80, b" ") + struct.pack("<I", len(tris)) + b"".join(tris)


def _safe(name):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("_") or "part"


def _stl_files(parts, mode):
    if mode == "whole":
        return _stl([v for p in parts for v in p["volumes"]]), "model.stl"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, p in enumerate(parts, 1):
            z.writestr(f"{i:02d}-{_safe(p['name'])}.stl", _stl(p["volumes"]))
    return buf.getvalue(), "parts-stl.zip"


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _3mf(parts, mode, palette):
    """标准 3MF：每个零件和颜色一块网格（mesh 物体，用 basematerials 标颜色）；整体是一个带 components 的物体，零件分开时每个零件一个"""
    cidx = {h: i for i, h in enumerate(palette)}
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
           '<metadata name="Application">Slate</metadata><resources>',
           '<basematerials id="1">' + "".join(f'<base name="颜色 {i + 1}" displaycolor="{h.upper()}FF"/>' for i, h in enumerate(palette)) + "</basematerials>"]
    oid, groups = 2, []
    for p in parts:
        ids = []
        for k, v in enumerate(p["volumes"]):
            vs, ts = v["verts"], v["tris"]
            vx = "".join(f'<vertex x="{vs[i]:.4f}" y="{vs[i + 1]:.4f}" z="{vs[i + 2]:.4f}"/>' for i in range(0, len(vs), 3))
            tx = "".join(f'<triangle v1="{ts[i]}" v2="{ts[i + 1]}" v3="{ts[i + 2]}"/>' for i in range(0, len(ts), 3))
            out.append(f'<object id="{oid}" type="model" name="{_esc(p["name"])}{"-" + str(k + 1) if len(p["volumes"]) > 1 else ""}" '
                       f'pid="1" pindex="{cidx[v["color"]]}"><mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh></object>')
            ids.append(oid)
            oid += 1
        groups.append((p["name"], ids))
    items = []
    if mode == "whole":
        comp = "".join(f'<component objectid="{i}"/>' for _, ids in groups for i in ids)
        out.append(f'<object id="{oid}" type="model" name="模型"><components>{comp}</components></object>')
        items.append(oid)
    else:
        for name, ids in groups:
            comp = "".join(f'<component objectid="{i}"/>' for i in ids)
            out.append(f'<object id="{oid}" type="model" name="{_esc(name)}"><components>{comp}</components></object>')
            items.append(oid)
            oid += 1
    out.append("</resources><build>" + "".join(f'<item objectid="{i}"/>' for i in items) + "</build></model>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", "".join(out))
    return buf.getvalue()
