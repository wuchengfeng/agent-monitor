"""
mitmproxy addon: captures /chat/completions requests and forwards to agent-monitor.

Usage:
  mitmdump --mode reverse:http://ai-service.tal.com --listen-port 8888 -s llm_capture.py --set flow_detail=0
"""

import json
import time
import threading
from urllib.request import Request, urlopen
from mitmproxy import http

MONITOR_URL = "http://localhost:4000/api/llm-capture"


def _post_capture(payload: dict):
    """POST capture to agent-monitor in background thread."""
    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = Request(
            MONITOR_URL,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=5) as resp:
            pass
    except Exception as e:
        print(f"[llm_capture] POST failed: {e}")


class LLMCapture:
    def __init__(self):
        self._request_times: dict[str, float] = {}

    def request(self, flow: http.HTTPFlow):
        if "/chat/completions" not in flow.request.path:
            return
        self._request_times[flow.id] = time.time()

    def response(self, flow: http.HTTPFlow):
        if "/chat/completions" not in flow.request.path:
            return

        request_started = self._request_times.pop(flow.id, None)
        now = time.time()
        duration_ms = int((now - request_started) * 1000) if request_started else 0

        # Parse request body
        req_body = {}
        req_size = 0
        try:
            raw = flow.request.get_text()
            req_size = len(raw.encode("utf-8")) if raw else 0
            if raw:
                req_body = json.loads(raw)
        except Exception:
            req_body = {"_raw": flow.request.get_text()[:2000]}

        # Parse response body (may be SSE stream or JSON)
        resp_body = {}
        resp_size = 0
        content_type = flow.response.headers.get("content-type", "")
        try:
            raw_resp = flow.response.get_text()
            resp_size = len(raw_resp.encode("utf-8")) if raw_resp else 0

            if "text/event-stream" in content_type:
                # Parse SSE: extract the last data chunk with usage info
                usage = None
                last_content = []
                for line in raw_resp.split("\n"):
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            chunk = json.loads(line[6:])
                            # Collect usage from final chunk
                            if chunk.get("usage"):
                                usage = chunk["usage"]
                            # Collect content deltas
                            choices = chunk.get("choices", [])
                            for c in choices:
                                delta = c.get("delta", {})
                                if delta.get("content"):
                                    last_content.append(delta["content"])
                        except json.JSONDecodeError:
                            pass
                resp_body = {
                    "streaming": True,
                    "usage": usage,
                    "reconstructed_content": "".join(last_content)[:500],
                }
            else:
                resp_body = json.loads(raw_resp)
        except Exception:
            resp_body = {"_raw": (flow.response.get_text() or "")[:2000]}

        # Build capture payload
        messages = req_body.get("messages", [])
        tools = req_body.get("tools", [])

        payload = {
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now)),
            "requestStartedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(request_started or now)
            ),
            "durationMs": duration_ms,
            "url": flow.request.pretty_url,
            "request": req_body,
            "response": resp_body,
            "requestSize": req_size,
            "responseSize": resp_size,
            "messageCount": len(messages),
            "toolCount": len(tools),
            "model": req_body.get("model", "unknown"),
        }

        # POST in background thread
        threading.Thread(target=_post_capture, args=(payload,), daemon=True).start()
        print(
            f"[llm_capture] {req_body.get('model','?')} | "
            f"{len(messages)} msgs, {len(tools)} tools | "
            f"{req_size // 1024}KB req, {resp_size // 1024}KB resp | "
            f"{duration_ms}ms"
        )


addons = [LLMCapture()]
