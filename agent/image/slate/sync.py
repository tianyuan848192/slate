"""slate-sync pull|push：在 S3 和会话之间同步任务文件（只能访问本任务的前缀）。

pull：下载用户上传的 input/；本地没有工作区时，从 work.tar.gz 恢复（会话被回收后的续跑）。
push：把工作区打包成 work.tar.gz 上传（不含 input/、clips/*.mp4、out/，这些在 S3 上另有存放）。
长片的章节会话：存档是 chapters/<章号>/work.tar.gz；还没有本章存档时（第一次开工），从主会话的存档恢复总纲、讲稿和共用组件。
"""
import argparse, io, json, os, sys, tarfile

from .common import TASK, chapter, ctx, die, key, path, s3

EXCLUDE_DIRS = {"input", "out"}


def work_key():
    ch = chapter()
    return key("chapters", ch, "work.tar.gz") if ch else key("work.tar.gz")


def pull(force=False):
    c, cli = ctx(), s3()
    if not cli:
        die("没有本任务的凭证（/root/.slate/credentials），无法同步")
    os.makedirs(TASK, exist_ok=True)
    got = 0
    pref = key("input") + "/"
    root = os.path.realpath(path("input"))
    for page in cli.get_paginator("list_objects_v2").paginate(Bucket=c["bucket"], Prefix=pref):
        for o in page.get("Contents", []):
            rel = o["Key"][len(pref):]
            if not rel or rel.endswith("/"):
                continue
            dst = os.path.realpath(path("input", rel))
            if not dst.startswith(root + os.sep):  # 键里带 ../ 之类的，不能落到 input/ 外面
                print(f"跳过路径不对的文件：{rel}", file=sys.stderr)
                continue
            if os.path.isfile(dst) and os.path.getsize(dst) == o["Size"]:
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            cli.download_file(c["bucket"], o["Key"], dst); got += 1
    restored = False
    # 本地没有工作区才恢复：做片看 storyboard.json、scenes/，风格创建看 style/、writing/（只要写作方法时没有 scenes/）
    if force or not any(os.path.exists(path(x)) for x in ("storyboard.json", "scenes", "style", "writing")):
        for k in dict.fromkeys([work_key(), key("work.tar.gz")]):  # 章节会话：先找本章存档，没有再用主会话的
            try:
                body = cli.get_object(Bucket=c["bucket"], Key=k)["Body"].read()
            except cli.exceptions.NoSuchKey:
                continue
            with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as tf:
                tf.extractall(TASK, filter="data")
            restored = k.rsplit("/", 2)[-2] if k != key("work.tar.gz") else "main"
            break
    print(json.dumps({"input_files": got, "restored_workdir": restored}, ensure_ascii=False))


def _keep(ti):
    if ti.name.startswith("clips/") and ti.name.endswith(".mp4"):
        return None
    return ti


def push():
    c, cli = ctx(), s3()
    if not cli:
        die("没有本任务的凭证，无法同步")
    if not os.path.isdir(TASK):
        print(json.dumps({"pushed": False}))
        return
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name in sorted(os.listdir(TASK)):
            if name not in EXCLUDE_DIRS:
                tf.add(path(name), arcname=name, filter=_keep)
    cli.put_object(Bucket=c["bucket"], Key=work_key(), Body=buf.getvalue())
    print(json.dumps({"pushed": True, "bytes": len(buf.getvalue())}))


def main():
    ap = argparse.ArgumentParser(prog="slate-sync", description="同步任务文件")
    ap.add_argument("action", choices=["pull", "push"])
    ap.add_argument("--force", action="store_true", help="pull 时强制用 S3 上的工作区覆盖本地")
    a = ap.parse_args()
    pull(a.force) if a.action == "pull" else push()


if __name__ == "__main__":
    main()
