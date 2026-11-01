import os

from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/healthz")
def healthz():
    return "ok"


@app.get("/")
def index():
    return jsonify(message="Hello from Flask on NAV", service=os.environ.get("NAV_SERVICE_NAME"), commit=os.environ.get("NAV_GIT_COMMIT"))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
