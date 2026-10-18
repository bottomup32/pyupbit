FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HVAC_DB=/data/crm.sqlite3 PORT=8080
COPY server.py storage.py online.py ./
COPY static/ ./static/
COPY assets/ ./assets/
RUN chmod -R a+rX /app && mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD python -c "import os, urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/api/health', timeout=3)"
CMD ["python", "online.py"]
