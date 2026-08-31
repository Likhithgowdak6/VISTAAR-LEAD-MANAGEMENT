FROM python:3.11-slim

# libreoffice is only needed for the docx -> pdf step in /v1/proposals/render.
# If you'd rather keep the image small, drop this line and proposals will
# still render as .docx, just without an automatic PDF.
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8091
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
