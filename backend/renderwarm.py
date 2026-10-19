"""预热渲染机（turn Lambda 每轮开工时异步调用）。

渲染机是 AgentCore Runtime 的 GPU 实例，第一次调用要现开机、拉镜像，约 2 分钟。
开工时先调一次 warm，Agent 读资料、写稿、写第一镜代码的这几分钟里机器就开好了。
"""
import json

from lib import common as c


def handler(event, context):
    for sid in event.get("sessions") or []:
        try:
            r = c.agent.invoke_agent_runtime(agentRuntimeArn=c.RENDER_RUNTIME_ARN, runtimeSessionId=sid, payload=b'{"op": "warm"}',
                                             contentType="application/json", accept="application/json")
            print(json.dumps({"session": sid, "warm": json.loads(r["response"].read())}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"session": sid, "error": str(e)[:300]}, ensure_ascii=False))
