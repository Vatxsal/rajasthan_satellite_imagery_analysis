# VHR ingest image: GDAL + numpy + requests, runs the Bhoonidhi pipeline.
# Build:  docker build -t rse-vhr vhr
# Run:    docker run --rm -e BHOONIDHI_USER -e BHOONIDHI_PASSWORD \
#               -e SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY \
#               -v "$PWD:/work" -w /work rse-vhr search --aoi aoi.geojson ...
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        gdal-bin \
        python3 \
        python3-gdal \
        python3-numpy \
        python3-pip \
        python3-venv \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --break-system-packages -r /app/requirements.txt

COPY *.py /app/
WORKDIR /work
ENTRYPOINT ["python3", "/app/ingest.py"]
CMD ["--help"]
