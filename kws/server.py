#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「小云小云」语音唤醒 HTTP 服务（FunASR cFSMN KWS）。

接收 Node 后端 /v1/kws/check 转发的 16kHz 单声道音频字节，用
iic/speech_charctc_kws_phone-xiaoyun 模型检测唤醒词「小云小云」，
返回 {detected, keyword, score, latency_ms}。

零第三方 HTTP 依赖（stdlib http.server）；FunASR 首次请求时惰性加载模型，
避免服务进程启动即因模型下载/初始化失败而退出。

运行：python3 kws/server.py            # 默认 127.0.0.1:8901
      KWS_HOST=0.0.0.0 KWS_PORT=8901 python3 kws/server.py
"""

import io
import json
import subprocess
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http import HTTPStatus

MODEL_ID = "iic/speech_charctc_kws_phone-xiaoyun"
KEYWORD = "小云小云"
HOST = "127.0.0.1"
PORT = 8901

_model = None
_model_loaded = False


def load_model():
    """惰性加载 FunASR 模型；失败抛异常由请求层降级为 503。"""
    global _model, _model_loaded
    if _model_loaded:
        return _model
    from funasr import AutoModel
    _model = AutoModel(
        model=MODEL_ID,
        keywords=KEYWORD,
        device="cpu",
    )
    _model_loaded = True
    return _model


def check_wake_word(raw: bytes):
    """对一段音频做唤醒检测，返回 FunASR 结果。

    注意：funasr 1.4.2 的 FsmnKWS.inference 无条件访问 self.writer，
    但只在 output_dir 非空时创建——必须传 output_dir，否则报
    'NoneType' object has no attribute 'token_list' / writer 缺失。
    """
    wav = to_wav_16k(raw)
    if wav is None:
        return {"detected": False, "keyword": KEYWORD, "score": None, "source": "python-kws", "error": "decode_failed"}
    model = load_model()
    res = model.generate(
        input=wav,
        cache={},
        output_dir="/tmp/kws_out",
    )
    # 结果形如 [{'key': '...', 'text': 'detected 小云小云 0.9954...'}]
    detected = False
    score = None
    for item in res or []:
        if not isinstance(item, dict):
            continue
        text = item.get("text") or ""
        if text.startswith("detected"):
            detected = True
            score = float(text.split()[-1]) if len(text.split()) >= 3 else None
            break
    return {"detected": detected, "keyword": KEYWORD, "score": score, "source": "python-kws"}


def to_wav_16k(raw: bytes):
    """把任意音频字节（webm/opus/ogg/mp4/wav）用 ffmpeg 转成 16kHz 单声道 WAV。

    前端 MediaRecorder 产的是 webm/opus，FunASR 只认 wav/pcm；不转码会解析失败
    导致唤醒永远不响。ffmpeg 转码失败（非音频）返回 None，调用方判未命中。
    """
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"],
            input=raw, capture_output=True, timeout=15,
        )
        if proc.returncode != 0 or not proc.stdout:
            return None
        return proc.stdout
    except Exception:  # noqa: BLE001 - 转码失败降级未命中
        return None


class KwsHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/kws":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "empty body"})
            return
        try:
            t0 = time.time()
            result = check_wake_word(raw)
            result["latency_ms"] = int((time.time() - t0) * 1000)
            self._json(HTTPStatus.OK, result)
        except Exception as exc:  # noqa: BLE001 - 服务边界：模型加载/推理失败 → 503
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": str(exc)})

    def do_GET(self):
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok", "keyword": KEYWORD, "model": MODEL_ID})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静默，避免刷屏
        pass


def main():
    import os
    host = os.environ.get("KWS_HOST", HOST)
    port = int(os.environ.get("KWS_PORT", PORT))
    server = ThreadingHTTPServer((host, port), KwsHandler)
    print(f"KWS 唤醒服务监听 {host}:{port}（模型 {MODEL_ID}，唤醒词「{KEYWORD}」）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
