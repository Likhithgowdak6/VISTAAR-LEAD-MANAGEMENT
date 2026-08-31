import base64

from fastapi.testclient import TestClient

from app import proposals

FAKE_CONTENT = {
    "title": "Wedding Photography Proposal",
    "client_name": "Priya",
    "intro": "Thanks for sharing the details of your big day.",
    "understanding": "You're looking for full-day coverage in Bangalore this December.",
    "approach": "Two photographers, one videographer, same-day highlights.",
    "sections": [{"heading": "What's included", "body": "150 edited photos, a 2-minute highlight film."}],
    "deliverables": ["150 edited photos", "2-minute highlight film", "20-page album"],
    "timeline": [{"phase": "Shoot day", "duration": "1 day", "detail": "Full coverage from morning to reception."}],
    "pricing": [{"item": "Photography + Video", "amount": 185000, "note": "Suggested"}],
    "total_amount": 185000,
    "terms": ["50% advance to confirm the date"],
    "next_step": "Confirm the date with an advance payment.",
}


def fake_generate(*a, **k):
    return FAKE_CONTENT


proposals.generate = fake_generate

from app.main import app  # noqa: E402

client = TestClient(app)

with open("templates/proposal_wedding.docx", "rb") as f:
    template_b64 = base64.b64encode(f.read()).decode()

print("== proposal generate ==")
r = client.post("/v1/proposals/generate", json={
    "category": "event_photography",
    "facts": {"event_date": "2026-12-12", "city": "Bangalore"},
    "transcript": [{"role": "lead", "text": "It's a wedding, Dec 12, Bangalore"}],
    "pricing_json": "[]",
    "client_name": "Priya",
})
print(r.status_code, list(r.json().keys()))
assert r.status_code == 200

print("== proposal render (docx + pdf) ==")
r = client.post("/v1/proposals/render", json={
    "content": FAKE_CONTENT,
    "template_base64": template_b64,
    "version": 1,
})
print(r.status_code)
assert r.status_code == 200
out = r.json()
docx_bytes = base64.b64decode(out["docx_base64"])
print("docx bytes:", len(docx_bytes))
assert len(docx_bytes) > 1000

if out["pdf_base64"]:
    pdf_bytes = base64.b64decode(out["pdf_base64"])
    print("pdf bytes:", len(pdf_bytes))
    with open("/tmp/ai-brain-service/test_output.pdf", "wb") as f:
        f.write(pdf_bytes)
    assert pdf_bytes[:4] == b"%PDF"
    print("PDF generated and verified.")
else:
    print("No PDF produced (LibreOffice not available in this run) - docx-only path still verified.")

with open("/tmp/ai-brain-service/test_output.docx", "wb") as f:
    f.write(docx_bytes)

print("\nPROPOSAL SMOKE TEST PASSED")
