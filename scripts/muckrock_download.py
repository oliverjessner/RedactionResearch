#!/usr/bin/env python3
# /// script
# requires-python = ">=3.7,<3.13"
# dependencies = [
#     "python-muckrock==2.3.0",
#     "requests>=2.32,<3",
# ]
# ///
"""Download public MuckRock PDF files into output/pdfs/2."""

import argparse
import os
import re
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPOSITORY_ROOT / "output" / "pdfs" / "2"
USER_AGENT = "RedactionResearch-MuckRock-Downloader/1.0"
UV_BOOTSTRAP_MARKER = "REDACTION_MUCKROCK_UV_BOOTSTRAPPED"


def restart_with_uv(reason: str):
    uv = shutil.which("uv")

    if uv and os.environ.get(UV_BOOTSTRAP_MARKER) != "1":
        print(f"{reason}; restarting with Python 3.12 through uv...", flush=True)
        environment = os.environ.copy()
        environment[UV_BOOTSTRAP_MARKER] = "1"
        os.execve(
            uv,
            [
                uv,
                "run",
                "--python",
                "3.12",
                str(Path(__file__).resolve()),
                *sys.argv[1:],
            ],
            environment,
        )


def require_dependencies():
    if sys.version_info >= (3, 13):
        restart_with_uv("python-muckrock requires Python < 3.13")
        raise SystemExit(
            "python-muckrock requires Python < 3.13.\n"
            "Install uv or run this downloader with Python 3.12."
        )

    try:
        import requests
        from muckrock import MuckRock
        from squarelet.exceptions import CredentialsFailedError
    except ModuleNotFoundError as error:
        restart_with_uv(f"Missing Python dependency: {error.name}")
        raise SystemExit(
            f"Missing Python dependency: {error.name}\n"
            "Install uv or install the dependencies for Python 3.12."
        ) from error

    return requests, MuckRock, CredentialsFailedError


def safe_filename(name: str) -> str:
    name = unquote(name or "")
    name = name.replace("\x00", "")
    name = re.sub(r'[<>:"/\\|?*\r\n\t]+', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:220] or "document.pdf"


def filename_from_url(url: str, file_id) -> str:
    name = safe_filename(Path(urlparse(url).path).name)

    if not name.lower().endswith(".pdf"):
        name += ".pdf"

    return f"{file_id}_{name}"


def is_pdf_url(url: str) -> bool:
    return urlparse(url).path.lower().endswith(".pdf")


def is_pdf_file(path: Path) -> bool:
    try:
        with path.open("rb") as file_handle:
            return file_handle.read(5) == b"%PDF-"
    except FileNotFoundError:
        return False


def iter_api_results(results):
    """Iterate over every page returned by python-muckrock."""
    page = results

    while page is not None:
        yield from page

        try:
            page = page.next
        except (AttributeError, StopIteration):
            page = None


def download_pdf(session, url: str, destination: Path, retries: int = 4) -> bool:
    if is_pdf_file(destination):
        print(f"SKIP  {destination.name}")
        return True

    temporary = destination.with_suffix(destination.suffix + ".part")

    for attempt in range(1, retries + 1):
        try:
            with session.get(url, stream=True, timeout=(20, 180)) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "").lower()

                with temporary.open("wb") as file_handle:
                    first_chunk = True

                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue

                        if first_chunk:
                            looks_like_pdf = chunk.lstrip().startswith(b"%PDF-")
                            first_chunk = False

                            if "application/pdf" not in content_type and not looks_like_pdf:
                                raise ValueError(
                                    "Response does not look like a PDF "
                                    f"(Content-Type: {content_type or 'unknown'})"
                                )

                        file_handle.write(chunk)

            if not is_pdf_file(temporary):
                raise ValueError("Downloaded response is not a PDF")

            temporary.replace(destination)
            print(f"OK    {destination.name}")
            return True
        except Exception as error:
            temporary.unlink(missing_ok=True)
            print(
                f"ERROR attempt {attempt}/{retries}: "
                f"{url} -> {type(error).__name__}: {error}"
            )

            if attempt < retries:
                time.sleep(min(30, 2**attempt))

    return False


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Download public MuckRock PDFs into output/pdfs/2."
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.25,
        help="Delay between downloads in seconds (default: 0.25)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Stop after this many saved or existing PDFs",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check the runtime and dependencies without connecting or downloading",
    )
    return parser.parse_args()


def main():
    args = parse_arguments()

    if args.delay < 0:
        raise SystemExit("--delay must not be negative")
    if args.limit is not None and args.limit < 1:
        raise SystemExit("--limit must be a positive integer")

    requests, muckrock_client, credentials_failed_error = require_dependencies()

    if args.check:
        print("MuckRock downloader is ready.")
        print(f"Python: {sys.version.split()[0]}")
        print(f"Output: {DEFAULT_OUTPUT}")
        return

    username = os.environ.get("MUCKROCK_USER")
    password = os.environ.get("MUCKROCK_PASSWORD")

    if not username or not password:
        raise SystemExit(
            "Missing MuckRock credentials. Set them only in your shell:\n"
            '  export MUCKROCK_USER="your_username"\n'
            '  export MUCKROCK_PASSWORD="your_password"\n'
            "Then run:\n"
            "  npm run download:muckrock"
        )

    output = DEFAULT_OUTPUT
    output.mkdir(parents=True, exist_ok=True)

    print("MuckRock PDF Downloader")
    print("-----------------------")
    print(f"Output:     {output}")
    print("Connecting to MuckRock...")

    try:
        client = muckrock_client(username, password)
    except credentials_failed_error as error:
        raise SystemExit(
            "MuckRock login failed. MUCKROCK_USER or MUCKROCK_PASSWORD is incorrect.\n"
            "MUCKROCK_USER must contain your current MuckRock username.\n"
            "Replace both values in the current shell and try again."
        ) from error
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    files = client.files.list()

    seen = 0
    pdf_candidates = 0
    downloaded_or_existing = 0
    failed = 0

    for file_object in iter_api_results(files):
        seen += 1
        url = getattr(file_object, "ffile", None)
        file_id = getattr(file_object, "id", "unknown")

        if not url or not is_pdf_url(url):
            continue

        pdf_candidates += 1
        destination = output / filename_from_url(url, file_id)

        if download_pdf(session, url, destination):
            downloaded_or_existing += 1
        else:
            failed += 1

        if args.limit is not None and downloaded_or_existing >= args.limit:
            print(f"Reached --limit {args.limit}.")
            break

        if args.delay > 0:
            time.sleep(args.delay)

        if seen % 100 == 0:
            print(
                f"Progress: files={seen}, pdfs={pdf_candidates}, "
                f"saved/existing={downloaded_or_existing}, failed={failed}"
            )

    print()
    print("Finished.")
    print(f"API file records scanned: {seen}")
    print(f"PDF candidates:           {pdf_candidates}")
    print(f"Saved/already present:    {downloaded_or_existing}")
    print(f"Failed:                   {failed}")
    print(f"Directory:                {output}")

    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
