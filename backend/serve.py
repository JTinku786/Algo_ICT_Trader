import os

from waitress import serve

from rest_api import app


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8765"))
    serve(app, host="127.0.0.1", port=port)
