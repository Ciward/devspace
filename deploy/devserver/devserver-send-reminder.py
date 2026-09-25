#!/usr/bin/env python3
"""Send one reminder using host-local TokenLab SMTP settings; never print secrets."""
import hashlib
import json
import re
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage
from email.utils import formatdate


def send(recipient, workspace, session, age, incident):
    if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", recipient):
        raise ValueError("invalid recipient")
    query = "SELECT json_object_agg(key,value)::text FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_username','smtp_password','smtp_from')"
    result = subprocess.run(
        ["docker", "--host", "unix:///var/run/docker.sock", "exec", "sub2api-postgres",
         "psql", "-U", "sub2api", "-d", "sub2api", "-At", "-c", query],
        capture_output=True, text=True, timeout=15, check=True,
    )
    settings = json.loads(result.stdout)
    sender = "ciwardauto@163.com"
    if settings.get("smtp_from") != sender or settings.get("smtp_username") != sender:
        raise ValueError("sender mismatch")
    if settings.get("smtp_host") != "smtp.163.com" or int(settings.get("smtp_port", 0)) != 465:
        raise ValueError("expected existing 163 implicit TLS configuration")
    message = EmailMessage()
    message["From"] = f"DevServer <{sender}>"
    message["To"] = recipient
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = f"<devserver-{hashlib.sha256(incident.encode()).hexdigest()}@163.com>"
    testing = incident.startswith("test-")
    message["Subject"] = "[DevServer] 邮件提醒通道测试" if testing else "[DevServer] 任务结果等待续接，请发送“继续”"
    message.set_content(
        "这是通道测试，不代表任务发生中断。\n" if testing else
        f"后台命令仍在运行，但至少 {age} 秒没有收到网页续接请求。\n"
        f"工作区：{workspace}\n进程 session：{session}\n"
        "检查时 DevServer 和公网入口正常。请回到对应网页对话发送：继续。\n"
        "请发送“继续”让网页继续轮询，必要时再检查任务输出。\n"
    )
    with smtplib.SMTP_SSL("smtp.163.com", 465, context=ssl.create_default_context(), timeout=20) as client:
        client.login(sender, settings["smtp_password"])
        if client.send_message(message):
            raise RuntimeError("recipient refused")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 6:
            raise ValueError("expected recipient workspace session age incident")
        send(*sys.argv[1:])
        print("SMTP_ACCEPTED")
    except Exception as error:
        print(f"SMTP_UNCONFIRMED:{type(error).__name__}", file=sys.stderr)
        sys.exit(1)
