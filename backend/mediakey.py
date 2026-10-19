"""CloudFormation 自定义资源：给视频 CDN 生成签名用的密钥对。

部署时调用：Secrets Manager 里还没有私钥就生成一对 RSA 2048，私钥写进 Secret，公钥返回给 CloudFront 的 PublicKey 资源。
已经有私钥时只返回它的公钥，重复部署不会换密钥。私钥不出现在模板里，也不经过部署机。
"""
import hashlib

import boto3
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

sm = boto3.client("secretsmanager")


def _load(arn):
    try:
        pem = sm.get_secret_value(SecretId=arn)["SecretString"]
    except sm.exceptions.ResourceNotFoundException:
        return None
    if "PRIVATE KEY" not in pem:  # 刚建好的 Secret 里是随机字符串
        return None
    return serialization.load_pem_private_key(pem.encode(), password=None)


def handler(event, context):
    props = event["ResourceProperties"]
    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": event.get("PhysicalResourceId") or "media-key"}
    key = _load(props["secretArn"])
    if key is None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        sm.put_secret_value(SecretId=props["secretArn"], SecretString=pem)
    pub = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return {"PhysicalResourceId": "media-key-" + hashlib.sha256(pub.encode()).hexdigest()[:12], "Data": {"PublicKey": pub}}
