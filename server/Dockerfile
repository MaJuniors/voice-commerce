FROM python:3.11-slim

WORKDIR /app

# install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# copy source
COPY . .

# Cloud Run listens on $PORT
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
