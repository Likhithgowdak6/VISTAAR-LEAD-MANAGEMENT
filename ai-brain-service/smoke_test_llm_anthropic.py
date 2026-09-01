"""
Proves llm.py's Anthropic branch does what the OpenAI branch does, against a stub client -
no network, no key, no cost.

This exists because the Anthropic path was the untested one for as long as Groq was the
provider: it had no latency logging, no rate-limit classification, no empty-answer retry, and
no handling for a JSON answer cut off at max_tokens (which can never parse, so the caller saw
"invalid JSON" and no hint that the budget was the cause). All four are covered below.

Run it the same way as the other smoke tests:

    python smoke_test_llm_anthropic.py
"""
import os, sys, types
os.environ.update(LLM_PROVIDER="anthropic", LLM_API_KEY="test", LLM_MODEL="claude-haiku-4-5-20251001")
sys.path.insert(0, ".")

from app import llm

class Block:
    def __init__(self, text): self.type, self.text = "text", text
class Resp:
    def __init__(self, text, stop="end_turn"):
        self.content = [Block(text)] if text else []
        self.stop_reason = stop

class StubMessages:
    def __init__(self, script): self.script, self.calls = list(script), []
    def create(self, **kw):
        self.calls.append(kw)
        return self.script.pop(0)
class StubClient:
    def __init__(self, script): self.messages = StubMessages(script)

def use(script):
    c = StubClient(script); llm._client = c; return c

fails = []
def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: fails.append(name)

print("complete()")
c = use([Resp("Hello there")])
check("returns text", llm.complete("sys", "usr") == "Hello there")
check("sends system separately", c.messages.calls[0]["system"] == "sys")
check("passes temperature", "temperature" in c.messages.calls[0])

c = use([Resp(""), Resp("second try")])
check("retries an empty answer with a bigger budget", llm.complete("s", "u", max_tokens=100) == "second try")
check("  budget tripled on retry", c.messages.calls[1]["max_tokens"] == 300,
      str([k["max_tokens"] for k in c.messages.calls]))

c = use([Resp(""), Resp("")])
try:
    llm.complete("s", "u"); check("raises after two empty answers", False)
except RuntimeError as e:
    check("raises after two empty answers", "no text twice" in str(e))

print("complete_json()")
c = use([Resp('"decision": "ask"}')])
out = llm.complete_json("sys", "usr", "{}")
check("reassembles the prefilled brace", out == {"decision": "ask"}, str(out))
check("prefills the assistant turn with {", c.messages.calls[0]["messages"][-1] == {"role": "assistant", "content": "{"})

c = use([Resp('"a": 1, "b": [', stop="max_tokens"), Resp('"a": 1, "b": [2]}')])
out = llm.complete_json("s", "u", "{}", max_tokens=50)
check("retries TRUNCATED json instead of failing to parse", out == {"a": 1, "b": [2]}, str(out))
check("  budget doubled on retry", c.messages.calls[1]["max_tokens"] == 100)

print("rate limiting")
class RateLimitError(Exception):
    status_code = 429
check("a 429 is classified as a rate limit", llm._is_rate_limit(RateLimitError()))
check("an ordinary error is not", not llm._is_rate_limit(ValueError("nope")))
check("reasoning-only extras are off for claude", llm._extra() == {})
check("_is_anthropic true", llm._is_anthropic())

print()
print("FAILED: " + ", ".join(fails) if fails else "ALL CHECKS PASSED")
sys.exit(1 if fails else 0)
