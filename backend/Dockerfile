FROM python:3.12-slim

WORKDIR /app

# Install system deps for PyMuPDF, OCR, antiword (.doc support), etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender-dev libgl1 \
    antiword \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

COPY . .

EXPOSE 8900

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8900", "--reload"]
