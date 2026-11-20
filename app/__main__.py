"""`python -m app` – startar servern med host/port från config.toml."""
import uvicorn

from .config import load_config

cfg = load_config()
uvicorn.run("app.main:app", host=cfg.server.host, port=cfg.server.port)
