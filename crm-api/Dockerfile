# Mirrors ai-brain-service/Dockerfile deliberately: same base image, same layout, same uvicorn
# invocation. Two Python services on one box that are built and run differently is two things to
# learn instead of one.
#
# No libreoffice here - that image needs it for docx->pdf rendering and this one does not.
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 5002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5002"]
