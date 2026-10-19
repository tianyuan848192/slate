"""渲染机相关的两个部署期自定义资源（CDK 的 Provider 框架调用：onEvent 发起，isComplete 轮询到完成）。

- 构建渲染机镜像：渲染机是 x86 的 GPU 实例，部署机是 arm64，所以放到 CodeBuild 上构建。
  构建上下文变了就重新构建，镜像标签就是上下文的指纹。
- 删栈时等网卡释放：渲染机终止要约 10 分钟，这期间网卡还挂在安全组上，安全组删不掉。
  这个资源夹在容量提供方和安全组之间：容量提供方删掉（会停掉所有渲染机）以后，在这里等网卡都释放了，再删安全组。
"""
import boto3

cb = boto3.client("codebuild")
ec2 = boto3.client("ec2")


def build_event(event, context):
    p = event["ResourceProperties"]
    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": event.get("PhysicalResourceId") or "render-image"}
    b = cb.start_build(projectName=p["project"], environmentVariablesOverride=[{"name": "IMAGE_TAG", "value": p["tag"], "type": "PLAINTEXT"}])["build"]
    uri = f"{p['repo']}:{p['tag']}"
    return {"PhysicalResourceId": uri, "Data": {"BuildId": b["id"], "ImageUri": uri}}


def build_complete(event, context):
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}
    bid = event["Data"]["BuildId"]
    st = cb.batch_get_builds(ids=[bid])["builds"][0]["buildStatus"]
    if st == "IN_PROGRESS":
        return {"IsComplete": False}
    if st != "SUCCEEDED":
        raise RuntimeError(f"渲染机镜像构建失败（{st}），在 CodeBuild 里看构建 {bid} 的日志")
    return {"IsComplete": True, "Data": {"ImageUri": event["Data"]["ImageUri"]}}


def enis_event(event, context):
    return {"PhysicalResourceId": event.get("PhysicalResourceId") or f"render-enis-{event['ResourceProperties']['securityGroup']}"}


def enis_complete(event, context):
    if event["RequestType"] != "Delete":
        return {"IsComplete": True}
    sg = event["ResourceProperties"]["securityGroup"]
    left = ec2.describe_network_interfaces(Filters=[{"Name": "group-id", "Values": [sg]}])["NetworkInterfaces"]
    if left:
        print(f"还有 {len(left)} 块网卡挂在 {sg} 上：{[n['NetworkInterfaceId'] + ' ' + n['Status'] for n in left]}")
    return {"IsComplete": not left}
