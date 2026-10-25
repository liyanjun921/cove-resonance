FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py login_once.py verify_share.py setup.py setup.html ./
ENV PORT=8000
CMD ["python", "app.py"]
