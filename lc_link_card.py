"""
LC Note link cards: GET /lc123/link_card?url=...

Reads a web page's title, description and picture (Open Graph / Twitter tags, falling back to <title>) so an LC Note
can show `@[card](https://...)` as a card. Only http(s) pages on the public internet: addresses on this machine or
the local network are refused, including after a redirect. The page is read up to a size limit with a timeout, and
results are cached for the session.
"""

import html
import ipaddress
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

MAX_BYTES = 400_000
YOUTUBE_BYTES = 3_000_000  # YouTube puts its page details deep in a very large page
TIMEOUT = 6
MAX_REDIRECTS = 4
OK_TTL = 24 * 3600
FAIL_TTL = 10 * 60
# an honest link-preview identity: sites that hide details from browsers (Instagram) hand them to preview bots
UA = "Mozilla/5.0 (compatible; LC123-LinkCard/1.0; +https://github.com/lonecatone23/ComfyUI_LC123_nodes)"
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}

_cache = {}
_lock = threading.Lock()


class LinkCardError(Exception):
    pass


def _public_host(host):
    """True only if every address the host resolves to is a public one."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or getattr(ip, "is_site_local", False)):
            return False
    return True


def _check_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https"):
        raise LinkCardError("only http and https links can be cards")
    if not _public_host(p.hostname):
        raise LinkCardError("that address is not on the public internet")
    return p


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # redirects are followed by hand so every hop is checked


_opener = urllib.request.build_opener(_NoRedirect)


def _fetch(url):
    for _ in range(MAX_REDIRECTS + 1):
        _check_url(url)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
                                                   "Accept-Language": "en;q=0.9,*;q=0.5"})
        try:
            resp = _opener.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise LinkCardError(f"the site answered {e.code}")
        with resp:
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype.lower():
                raise LinkCardError("not a web page")
            host = (urllib.parse.urlsplit(url).hostname or "").lower()
            raw = resp.read(YOUTUBE_BYTES if host in YOUTUBE_HOSTS else MAX_BYTES)
            charset = resp.headers.get_content_charset() or "utf-8"
            return url, raw.decode(charset, errors="replace")
    raise LinkCardError("too many redirects")


class _Meta(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.title = ""
        self.icon = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "title":
            self._in_title = True
        elif tag == "link" and not self.icon and "icon" in a.get("rel", "").lower() and a.get("href"):
            self.icon = a["href"]
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


def _clean(s, n):
    s = re.sub(r"\s+", " ", html.unescape(s or "")).strip()
    return s[:n]


def _youtube_video(url):
    """YouTube videos, Shorts and live: YouTube's public oEmbed address, made for previews."""
    p = urllib.parse.urlsplit(url)
    host = (p.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return None
    if not (host == "youtu.be" or p.path.startswith(("/watch", "/shorts/", "/live/"))):
        return None
    api = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe="")
    req = urllib.request.Request(api, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with _opener.open(req, timeout=TIMEOUT) as resp:
            import json

            d = json.loads(resp.read(200_000).decode("utf-8", errors="replace"))
    except Exception:
        return None
    return {
        "ok": True,
        "url": url,
        "final_url": url,
        "title": _clean(d.get("title"), 200),
        "description": _clean(("by " + d["author_name"]) if d.get("author_name") else "", 300),
        "site": "YouTube",
        "image": d.get("thumbnail_url") or "",
        "icon": "",
    }


def read_card(url):
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            return hit[1]
    try:
        _check_url(url)
        yt = _youtube_video(url)
        if yt:
            with _lock:
                _cache[url] = (now + OK_TTL, yt)
            return yt
        final, page = _fetch(url)
        p = _Meta()
        try:
            p.feed(page)
        except Exception:
            pass
        m = p.meta
        image = m.get("og:image") or m.get("og:image:url") or m.get("twitter:image") or m.get("twitter:image:src") or ""
        card = {
            "ok": True,
            "url": url,
            "final_url": final,
            "title": _clean(m.get("og:title") or m.get("twitter:title") or p.title, 200),
            "description": _clean(m.get("og:description") or m.get("twitter:description") or m.get("description"), 300),
            "site": _clean(m.get("og:site_name"), 80) or re.sub(r"^www\.", "", urllib.parse.urlsplit(final).hostname or ""),
            "image": urllib.parse.urljoin(final, image) if image else "",
            "icon": urllib.parse.urljoin(final, p.icon) if p.icon else "",
        }
        for k in ("image", "icon"):  # only real web addresses (no data: or javascript: values)
            if card[k] and urllib.parse.urlsplit(card[k]).scheme not in ("http", "https"):
                card[k] = ""
        ttl = OK_TTL
    except Exception as e:
        card = {"ok": False, "url": url, "error": str(e)[:200], "site": urllib.parse.urlsplit(url).hostname or ""}
        ttl = FAIL_TTL
    with _lock:
        _cache[url] = (now + ttl, card)
        if len(_cache) > 500:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                _cache.pop(k, None)
    return card


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc123/link_card")
    async def _lc123_link_card(request):
        import asyncio

        url = (request.query.get("url") or "").strip()
        if not url or len(url) > 2000:
            return web.json_response({"ok": False, "error": "no link"}, status=400)
        # the page is read in a worker thread so ComfyUI keeps running meanwhile
        card = await asyncio.get_running_loop().run_in_executor(None, read_card, url)
        return web.json_response(card)

except Exception:
    pass
