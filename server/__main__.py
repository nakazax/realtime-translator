import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "server.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("DATABRICKS_APP_PORT", os.environ.get("PORT", "8000"))),
    )


if __name__ == "__main__":
    main()
