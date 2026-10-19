"""渲染机上的工作进程：在自己的工作目录（SLATE_TASK_DIR）里渲染或自检几镜。

server.py 为每个请求单独启动一个，长片的几章同时用一台渲染机也互不干扰。
标准输入是任务（JSON），标准输出最后一行是结果（JSON）。S3 用环境变量里本任务范围的临时凭证读写，只能碰这个任务的目录。

  {"op": "render", "bundle": "<场景包>", "prefix": "<任务前缀>", "run": "<请求号>", "scenes": ["01", "02"], "concurrency": 2, "max_shards": 4}
  {"op": "qa", ...}
  {"op": "model", "model": {"job": {...}, "size": 768, "glb": false}, ...}   3D 图片：scenes/M3D/ 的多角度图或转台视频（slate.model3d）
"""
import asyncio, json, os, re, sys, tarfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import localbrowser  # noqa: E402

localbrowser.install()
import boto3  # noqa: E402

from slate import model3d  # noqa: E402
from slate import qa as qa_mod  # noqa: E402
from slate import render as rd  # noqa: E402
from slate.common import TASK, path  # noqa: E402

# 浏览器报出这些错误时，这一镜改用 CPU 软件绘制重渲（显卡上下文丢失会画出空白帧）
GPU_ERROR = re.compile(r"context lost|CONTEXT_LOST|GPU process|gpu.*(crash|fail)|WebGL.*(lost|fail)", re.I)


async def render_all(ids, conc):
    sem = asyncio.Semaphore(conc)

    async def one(sid):
        async with sem:
            t0 = time.time()
            try:
                r = await rd.render_scene(sid, force=True)
                if any(GPU_ERROR.search(e) for e in r.get("page_errors", [])):
                    token = localbrowser.MODE.set("cpu")
                    try:
                        r = await rd.render_scene(sid, force=True)
                    finally:
                        localbrowser.MODE.reset(token)
                    r["gpu_fallback"] = True
            except Exception as e:
                r = {"scene": sid, "error": str(e)[:800]}
            r["wall_s"] = round(time.time() - t0, 2)
            return r

    return await asyncio.gather(*[one(s) for s in ids])


def main():
    job = json.load(sys.stdin)
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    bucket, prefix, run = job["bucket"], job["prefix"].rstrip("/"), job["run"]
    os.makedirs(TASK, exist_ok=True)
    t0 = time.time()
    local = os.path.join(TASK, "bundle.tgz")
    s3.download_file(bucket, job["bundle"], local)
    with tarfile.open(local) as tf:
        tf.extractall(TASK, filter="data")
    os.remove(local)
    fetch = time.time() - t0
    rd.MAX_SHARDS = int(job.get("max_shards", 4))
    rd.MAX_SHARDS_HEAVY = int(job.get("max_shards_heavy", job.get("max_shards", 4)))
    out = {"fetch_s": round(fetch, 2), "scenes": []}
    if job["op"] == "render":
        for r in asyncio.run(render_all(job["scenes"], int(job.get("concurrency", 2)))):
            clip = path("clips", f"{r['scene']}.mp4")
            if "error" not in r and os.path.isfile(clip):
                r["key"] = f"{prefix}/clips/{r['hash']}.mp4"
                s3.upload_file(clip, bucket, r["key"], ExtraArgs={"ContentType": "video/mp4"})
            out["scenes"].append(r)
    elif job["op"] == "qa":
        for sid in job["scenes"]:
            q0 = time.time()
            try:
                asyncio.run(qa_mod.check(sid))
                res = json.load(open(path("qa", f"{sid}.json"), encoding="utf-8"))
                k = f"{prefix}/render/qa/{run}/{sid}.png"
                s3.upload_file(path("qa", f"{sid}.png"), bucket, k, ExtraArgs={"ContentType": "image/png"})
                out["scenes"].append({"scene": sid, "result": res, "sheet": k, "qa_s": round(time.time() - q0, 2)})
            except Exception as e:
                out["scenes"].append({"scene": sid, "error": str(e)[:800]})
    elif job["op"] == "model":
        m = job.get("model") or {}
        size = max(256, min(1600, int(m.get("size") or 768)))
        mjob = m.get("job") or {}
        # 页面参数在会话里写进了 scenes/M3D/index.html；这里只用来定帧数和文件名
        mjob = {"angles": [int(x) for x in (mjob.get("angles") or model3d.ANGLES)][:12], "explode": float(mjob.get("explode") or 0), "explodeAnim": min(30, float(mjob.get("explodeAnim") or 0)),
                "factory": str(mjob.get("factory") or "")}
        local = path("render", "m3d")
        try:
            res = asyncio.run(model3d.capture(mjob, local, size=size, glb=bool(m.get("glb")), extract=bool(m.get("extract"))))
        except Exception as e:
            res = {"error": str(e)[:800]}
        if "error" not in res:
            out["files"] = {}
            for root, _, names in os.walk(local):
                for n in names:
                    p = os.path.join(root, n); rel = os.path.relpath(p, local)
                    k = f"{prefix}/render/model/{run}/{rel}"
                    ctype = {".png": "image/png", ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".gz": "application/gzip"}.get(os.path.splitext(n)[1], "application/octet-stream")
                    s3.upload_file(p, bucket, k, ExtraArgs={"ContentType": ctype})
                    out["files"][rel] = k
            out.update(info=res["info"], errors=res["errors"], print_check=res["print_check"])
        else:
            out["error"] = res["error"]
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
